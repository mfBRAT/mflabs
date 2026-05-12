/**
 * MFmonitor — OpenSea Listing Monitor
 * Mac Mini / always-on script
 *
 * SETUP:
 *   1. Fill in API_KEY and DISCORD_WEBHOOK below
 *   2. npm install
 *   3. node opensea-monitor.js
 *
 * TO KEEP RUNNING PERMANENTLY:
 *   npm install -g pm2
 *   pm2 start opensea-monitor.js --name mfmonitor
 *   pm2 save && pm2 startup
 */

import { OpenSeaStreamClient, Network } from "@opensea/stream-js";
import { WebSocket } from "ws";
import { LocalStorage } from "node-localstorage";
import { execSync } from "child_process";

// ─── YOUR CREDENTIALS ────────────────────────────────────────────────────────
const API_KEY       = process.env.OPENSEA_API_KEY || "";
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1496133039720501501/EuyRR3Krx8oUvXEuhV6p58hM1qk2di1JYdGuxpgtX_VGRPwMj4fcRCfgjELvVQEMdEyT";
// ─────────────────────────────────────────────────────────────────────────────

// ─── COLLECTIONS TO MONITOR ──────────────────────────────────────────────────
// Add as many collections as you want. traitFilters: [] means notify on ALL listings.
// traitFilters match ANY entry in the array (OR logic).
const COLLECTIONS = [
  {
    slug:    "bad-guyz-536401159",
    name:    "Bad Guyz",
    minEth:  0,
    maxEth:  Infinity,
    traitFilters: [
      // { type: "Background", value: "Gold" },
      // { type: "Eyes", value: "Laser" },
      // Leave empty to get notified on every listing
    ],
  },
  // {
  //   slug:   "pizza-comrades",
  //   name:   "Pizza Comrades",
  //   minEth: 0,
  //   maxEth: Infinity,
  //   traitFilters: [],
  // },
];
// ─────────────────────────────────────────────────────────────────────────────

// ─── OPTIONS ─────────────────────────────────────────────────────────────────
const PLAY_SOUND      = true;
const SOUND_FILE      = "/System/Library/Sounds/Funk.aiff";
const MAC_NOTIF       = true;
const FLOOR_REFRESH   = 5 * 60 * 1000; // refresh floor price every 5 min
// ─────────────────────────────────────────────────────────────────────────────

if (API_KEY === "YOUR_OPENSEA_API_KEY" || DISCORD_WEBHOOK === "YOUR_DISCORD_WEBHOOK_URL") {
  console.error("❌  Fill in API_KEY and DISCORD_WEBHOOK before running.");
  process.exit(1);
}

// ─── FLOOR PRICE CACHE ───────────────────────────────────────────────────────
const floorCache = {}; // { slug: { price, symbol, updatedAt } }

async function fetchFloor(slug) {
  try {
    const res  = await fetch(`https://api.opensea.io/api/v2/collections/${slug}/stats`, {
      headers: { accept: "application/json", "x-api-key": API_KEY },
    });
    const data = await res.json();
    const price  = data?.total?.floor_price ?? null;
    const symbol = data?.total?.floor_price_symbol ?? "ETH";
    floorCache[slug] = { price, symbol, updatedAt: Date.now() };
    if (price !== null) {
      console.log(`📊  [${slug}] Floor: ${price} ${symbol}`);
    }
  } catch (err) {
    console.error(`⚠️   Floor fetch failed for ${slug}:`, err.message);
  }
}

async function refreshAllFloors() {
  for (const col of COLLECTIONS) await fetchFloor(col.slug);
}

// ─── TRAIT FETCH ─────────────────────────────────────────────────────────────
async function fetchTraits(nftId) {
  // nftId format: "ethereum/0xContract/TokenId"
  try {
    const parts    = nftId.split("/");
    const chain    = parts[0];
    const contract = parts[1];
    const tokenId  = parts[2];
    const res  = await fetch(
      `https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}/nfts/${tokenId}`,
      { headers: { accept: "application/json", "x-api-key": API_KEY } }
    );
    const data = await res.json();
    return data?.nft?.traits ?? [];
  } catch {
    return [];
  }
}

function traitsMatch(traits, filters) {
  if (!filters || filters.length === 0) return true; // no filter = always match
  return filters.some(f =>
    traits.some(t =>
      t.trait_type?.toLowerCase() === f.type?.toLowerCase() &&
      t.value?.toString().toLowerCase() === f.value?.toLowerCase()
    )
  );
}

function formatTraits(traits, filters) {
  if (!traits.length) return "—";
  // Highlight matched traits first, then show up to 4 total
  const matched   = traits.filter(t => filters.some(f =>
    f.type?.toLowerCase() === t.trait_type?.toLowerCase() &&
    f.value?.toLowerCase() === t.value?.toString().toLowerCase()
  ));
  const unmatched = traits.filter(t => !matched.includes(t)).slice(0, 4 - matched.length);
  const all = [...matched, ...unmatched];
  return all.map(t => `**${t.trait_type}**: ${t.value}`).join("\n") || "—";
}

// ─── DISCORD WEBHOOK ─────────────────────────────────────────────────────────
async function sendDiscord({ name, permalink, imageUrl, priceEth, priceStr, collectionName, traits, traitFilters, slug }) {
  const floor    = floorCache[slug];
  const floorEth = floor?.price ?? null;
  let floorField = "—";
  let deltaField = "—";
  let deltaColor = 0x2abfbf; // cyan default

  if (floorEth !== null && priceEth > 0) {
    floorField = `${floorEth} ${floor.symbol}`;
    const pct  = ((priceEth - floorEth) / floorEth * 100).toFixed(1);
    if (pct < 0) {
      deltaField = `🟢 ${Math.abs(pct)}% below floor`;
      deltaColor = 0x2abfbf; // cyan = good
    } else if (pct === "0.0") {
      deltaField = `⚪ At floor`;
    } else {
      deltaField = `🔴 +${pct}% above floor`;
      deltaColor = 0xd4457a; // pink = expensive
    }
  }

  const traitText = formatTraits(traits, traitFilters);

  const body = {
    username: "MFmonitor",
    avatar_url: "https://mfbrat.com/favicon.ico",
    embeds: [{
      title: `🆕 ${name}`,
      url:   permalink,
      color: deltaColor,
      thumbnail: imageUrl ? { url: imageUrl } : undefined,
      fields: [
        { name: "💰 Price",      value: priceStr,   inline: true },
        { name: "📊 Floor",      value: floorField, inline: true },
        { name: "📈 vs Floor",   value: deltaField, inline: true },
        { name: "🏷️ Traits",    value: traitText,  inline: false },
      ],
      footer: { text: `${collectionName} · mfbrat.com/mfmonitor` },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type:  2,
        style: 5,
        label: "🛒 Buy Now on OpenSea",
        url:   permalink,
      }],
    }],
  };

  try {
    await fetch(DISCORD_WEBHOOK, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.error("⚠️   Discord webhook failed:", err.message);
  }
}

// ─── MAC NOTIFICATION ────────────────────────────────────────────────────────
function macNotify(name, priceStr, permalink) {
  if (!MAC_NOTIF) return;
  try {
    const msg = `${name} · ${priceStr}`;
    execSync(`osascript -e 'display notification "${msg}" with title "🆕 New Listing"'`, { stdio: "ignore" });
  } catch {}
}

// ─── STREAM CLIENT ───────────────────────────────────────────────────────────
const client = new OpenSeaStreamClient({
  token:   API_KEY,
  network: Network.MAINNET,
  connectOptions: {
    transport:    WebSocket,
    sessionStorage: LocalStorage,
  },
  onError: (err) => console.error("Stream error:", err.message),
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
console.log("\n💀  MFmonitor starting...\n");
await refreshAllFloors();
setInterval(refreshAllFloors, FLOOR_REFRESH);

for (const col of COLLECTIONS) {
  console.log(`👁️   Watching: ${col.name} (${col.slug})`);
  if (col.traitFilters.length > 0) {
    console.log(`     Trait filters: ${col.traitFilters.map(f => `${f.type}:${f.value}`).join(", ")}`);
  }

  client.onItemListed(col.slug, async (event) => {
    try {
      const p         = event.payload;
      const nftId     = p.item?.nft_id ?? "";
      const name      = p.item?.metadata?.name ?? `#${nftId.split("/").pop()}`;
      const permalink = p.item?.permalink ?? `https://opensea.io/collection/${col.slug}`;
      const imageUrl  = p.item?.metadata?.image_url ?? null;
      const priceWei  = BigInt(p.base_price ?? "0");
      const priceEth  = Number(priceWei) / 1e18;
      const priceStr  = priceEth > 0 ? `${priceEth.toFixed(4)} ETH` : "—";
      const seller    = p.maker?.address ? p.maker.address.slice(0, 8) + "…" : "—";

      // Price filter
      if (priceEth < col.minEth || priceEth > col.maxEth) return;

      // Fetch traits
      const traits = nftId ? await fetchTraits(nftId) : [];

      // Trait filter
      if (!traitsMatch(traits, col.traitFilters)) return;

      const matchedTraits = col.traitFilters.length > 0
        ? traits.filter(t => col.traitFilters.some(f =>
            f.type?.toLowerCase() === t.trait_type?.toLowerCase() &&
            f.value?.toLowerCase() === t.value?.toString().toLowerCase()
          ))
        : [];

      // Log
      console.log(`\n🆕  [${col.name}] ${name}`);
      console.log(`    Price:  ${priceStr}`);
      console.log(`    Seller: ${seller}`);
      console.log(`    URL:    ${permalink}`);
      if (matchedTraits.length > 0) {
        console.log(`    🎯 Matched: ${matchedTraits.map(t => `${t.trait_type}:${t.value}`).join(", ")}`);
      }

      // Sound
      if (PLAY_SOUND) {
        try { execSync(`afplay "${SOUND_FILE}"`, { stdio: "ignore" }); } catch {}
      }

      // macOS notification
      macNotify(name, priceStr, permalink);

      // Discord
      await sendDiscord({
        name, permalink, imageUrl, priceEth, priceStr,
        collectionName: col.name,
        traits,
        traitFilters: col.traitFilters,
        slug: col.slug,
      });

    } catch (err) {
      console.error("Error handling listing event:", err.message);
    }
  });
}

console.log(`\n⚡  Live. Ctrl+C to stop.\n`);

process.on("SIGINT", () => {
  console.log("\n👋  MFmonitor stopped.");
  process.exit(0);
});
