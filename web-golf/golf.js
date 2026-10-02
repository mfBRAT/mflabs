/*
 * Web Golf — turns the page you're on into a top-down mini-golf course.
 *
 *   headings / big text  -> walls
 *   body text            -> rough (slows the ball)
 *   images / svg         -> bumpers
 *   small boxes / tags   -> blocks
 *   ASCII art            -> rails and pegs, glyph by glyph
 *   inputs, BUY / ABORT  -> water (+1 stroke)
 *   CTA buttons          -> the cups, one hole each
 *
 * Load it on any page (bookmarklet or <script>) and drag anywhere to shoot.
 */
(function () {
  'use strict';

  if (window.__webGolf && window.__webGolf.alive) { window.__webGolf.focus(); return; }

  // ---- tuning ---------------------------------------------------------------
  const BALL_R = 7;
  const CUP_R = 11;
  const MAX_SPEED = 1700;     // px/s at full power
  const MAX_PULL = 170;       // screen px of drag for full power
  const DT = 1 / 240;
  const FLOOR_DECEL = 260;    // px/s^2
  const ROUGH_DECEL = 1050;
  const GREEN_DECEL = 360;
  const DAMP = 0.45;          // linear drag, 1/s
  const SINK_SPEED = 560;
  const STOP_SPEED = 7;
  const MAX_HOLES = 9;
  const HASH = 64;
  const PX_PER_M = 100;

  const CTA_RE = /^(launch( app)?|play( now)?|start( now| free)?|get started|sign ?up|join( now| free)?|try( it)?( now| free| for free)?|download|buy now|subscribe|book( now)?|shop now|open app|get the app|enter|create account|get access)\b/i;
  const HAZARD_RE = /^[^a-z0-9]*(buy|abort|delete|cancel|unsubscribe|log ?out|sign ?out|sell|remove|reject)\b/i;
  const HAZARD_MSG = {
    buy: 'You bought it. Gas fees: +1 stroke',
    sell: 'Sold the bottom. +1 stroke',
    abort: 'Mission aborted. +1 stroke',
    delete: 'Deleted. +1 stroke',
    remove: 'Removed. +1 stroke',
    cancel: 'Cancelled. +1 stroke',
    unsubscribe: 'Unsubscribed from the course. +1 stroke',
    reject: 'Rejected. +1 stroke',
  };
  const ASCII_SYMBOLS = /[|_\/\\\-=+*#()\[\]{}<>'`".,:;~^]/;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const html = document.documentElement;

  // ---- DOM measurement ------------------------------------------------------
  function docSize() {
    const b = document.body;
    return {
      w: Math.max(html.scrollWidth, b ? b.scrollWidth : 0, innerWidth),
      h: Math.max(html.scrollHeight, b ? b.scrollHeight : 0, innerHeight),
    };
  }
  const toDoc = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });

  function alphaOf(c) {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (p.length < 4) return 1;
    return p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
  }

  function hasBox(cs) {
    if (alphaOf(cs.backgroundColor) > 0.12) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.includes('url(')) return true;
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    return sides.every((s) => parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && alphaOf(cs['border' + s + 'Color']) > 0.15);
  }

  // ---- spatial hash ---------------------------------------------------------
  function makeHash() { return new Map(); }
  const hkey = (cx, cy) => (cy + 64) * 16384 + (cx + 64);
  function hashInsert(h, item, x0, y0, x1, y1) {
    const ax = Math.floor(x0 / HASH), bx = Math.floor(x1 / HASH);
    const ay = Math.floor(y0 / HASH), by = Math.floor(y1 / HASH);
    for (let cy = ay; cy <= by; cy++) for (let cx = ax; cx <= bx; cx++) {
      const k = hkey(cx, cy);
      let arr = h.get(k);
      if (!arr) h.set(k, (arr = []));
      arr.push(item);
    }
  }
  let stamp = 1;
  function hashQuery(h, x, y, r, out) {
    stamp++;
    out.length = 0;
    const ax = Math.floor((x - r) / HASH), bx = Math.floor((x + r) / HASH);
    const ay = Math.floor((y - r) / HASH), by = Math.floor((y + r) / HASH);
    for (let cy = ay; cy <= by; cy++) for (let cx = ax; cx <= bx; cx++) {
      const arr = h.get(hkey(cx, cy));
      if (!arr) continue;
      for (const it of arr) if (it._s !== stamp) { it._s = stamp; out.push(it); }
    }
    return out;
  }
  function boundsOf(s) {
    if (s.t === 'rect') return [s.x, s.y, s.x + s.w, s.y + s.h];
    if (s.t === 'seg') return [Math.min(s.x1, s.x2) - s.th, Math.min(s.y1, s.y2) - s.th, Math.max(s.x1, s.x2) + s.th, Math.max(s.y1, s.y2) + s.th];
    return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
  }

  // ---- course scan ----------------------------------------------------------
  function shortText(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim() || (el.children.length === 0 ? '' : '');
  }

  function cupLabel(el) {
    let e = el.parentElement;
    for (let i = 0; i < 4 && e && e !== document.body; i++, e = e.parentElement) {
      const h = e.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i]');
      if (h && !h.contains(el)) {
        const t = shortText(h);
        if (t && t.length <= 40) return t;
      }
    }
    return '';
  }

  function findCups(root) {
    const out = [];
    const els = document.body.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]');
    for (const el of els) {
      if (root.contains(el)) continue;
      const text = (el.value && el.tagName === 'INPUT' ? el.value : shortText(el)).trim();
      if (!text || text.length > 24 || !CTA_RE.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 10) continue;
      if (inFixed(el)) continue;
      out.push({ el, text });
    }
    if (!out.length) {
      // Fallback: anything that looks like a button.
      for (const el of els) {
        if (root.contains(el)) continue;
        const text = shortText(el);
        if (!text || text.length > 24) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 14 || inFixed(el)) continue;
        if (!hasBox(getComputedStyle(el))) continue;
        out.push({ el, text });
      }
    }
    const cups = out.map(({ el, text }) => {
      const d = toDoc(el.getBoundingClientRect());
      return { el, text, label: cupLabel(el), ...d };
    }).sort((a, b) => a.y - b.y || a.x - b.x);

    // drop nested / overlapping duplicates
    const uniq = [];
    for (const c of cups) {
      if (uniq.some((u) => Math.abs(u.x - c.x) < 20 && Math.abs(u.y - c.y) < 20)) continue;
      uniq.push(c);
    }
    if (uniq.length <= MAX_HOLES) return uniq;
    const picked = [];
    for (let i = 0; i < MAX_HOLES; i++) picked.push(uniq[Math.round(i * (uniq.length - 1) / (MAX_HOLES - 1))]);
    return picked;
  }

  const fixedCache = new Map();
  function inFixed(el) {
    const chain = [];
    let e = el, res = false;
    while (e && e !== document.body && e !== html) {
      if (fixedCache.has(e)) { res = fixedCache.get(e); break; }
      chain.push(e);
      const p = getComputedStyle(e).position;
      if (p === 'fixed' || p === 'sticky') { res = true; break; }
      e = e.parentElement;
    }
    for (const c of chain) fixedCache.set(c, res);
    return res;
  }

  function glyphShapes(ch, r, out) {
    const { x, y, w, h } = r;
    const cx = x + w / 2, cy = y + h / 2, th = 1.4;
    const seg = (x1, y1, x2, y2) => out.push({ t: 'seg', k: 'rail', x1, y1, x2, y2, th });
    const peg = (px, py, pr) => out.push({ t: 'circle', k: 'peg', x: px, y: py, r: pr });
    switch (ch) {
      case '|': case '!': seg(cx, y + h * 0.08, cx, y + h * 0.92); break;
      case '_': seg(x, y + h * 0.9, x + w, y + h * 0.9); break;
      case '-': case '~': case '=': case '+': seg(x, cy, x + w, cy); break;
      case '/': seg(x + w * 0.92, y + h * 0.08, x + w * 0.08, y + h * 0.92); break;
      case '\\': seg(x + w * 0.08, y + h * 0.08, x + w * 0.92, y + h * 0.92); break;
      case '(': case '[': case '{': case '<':
        seg(x + w * 0.75, y + h * 0.1, x + w * 0.3, cy); seg(x + w * 0.3, cy, x + w * 0.75, y + h * 0.9); break;
      case ')': case ']': case '}': case '>':
        seg(x + w * 0.25, y + h * 0.1, x + w * 0.7, cy); seg(x + w * 0.7, cy, x + w * 0.25, y + h * 0.9); break;
      case '.': case ',': peg(cx, y + h * 0.8, 1.6); break;
      case '\'': case '`': case '"': peg(cx, y + h * 0.2, 1.6); break;
      case ':': case ';': peg(cx, y + h * 0.35, 1.5); peg(cx, y + h * 0.75, 1.5); break;
      default: peg(cx, cy, Math.max(1.6, Math.min(w, h) * 0.3));
    }
  }

  // Deterministic 0..1 from a position, so fences keep their gaps across rescans.
  function seeded(x, y, salt) {
    let h = Math.imul(Math.round(x) * 73856093 ^ Math.round(y) * 19349663 ^ salt * 83492791, 2654435761) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  // A straight fence from (x1,y1) to (x2,y2) with one or two gaps cut into it.
  function fence(out, x1, y1, x2, y2, salt) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const GAP = 64;
    const n = len >= 700 ? 2 : 1;
    const gaps = [];
    for (let i = 0; i < n; i++) {
      const lo = (i / n) * len + GAP, hi = ((i + 1) / n) * len - GAP;
      gaps.push(lo + seeded(x1, y1, salt + i) * Math.max(0, hi - lo));
    }
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    let t = 0;
    for (const g of gaps) {
      const a = g - GAP / 2;
      if (a - t > 6) out.push({ t: 'seg', k: 'fence', x1: x1 + ux * t, y1: y1 + uy * t, x2: x1 + ux * a, y2: y1 + uy * a, th: 2 });
      t = g + GAP / 2;
    }
    if (len - t > 6) out.push({ t: 'seg', k: 'fence', x1: x1 + ux * t, y1: y1 + uy * t, x2: x2, y2: y2, th: 2 });
  }

  function sideVisible(cs, s) {
    return parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && alphaOf(cs['border' + s + 'Color']) > 0.15;
  }

  // Dividers (partial borders, <hr>) and big framed boxes become fences.
  function addFences(el, cs, r, solids) {
    if (el.tagName === 'HR') { if (r.w >= 160) fence(solids, r.x, r.y + r.h / 2, r.x + r.w, r.y + r.h / 2, 1); return; }
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((s) => sideVisible(cs, s));
    if (!sides.length) return;
    const framed = sides.length === 4;
    if (framed && (r.w < 240 || r.h < 120)) return;
    for (const s of sides) {
      const hz = s === 'Top' || s === 'Bottom';
      if (hz ? r.w < 240 : r.h < 160) continue;
      const salt = { Top: 11, Right: 23, Bottom: 37, Left: 41 }[s];
      if (s === 'Top') fence(solids, r.x, r.y, r.x + r.w, r.y, salt);
      else if (s === 'Bottom') fence(solids, r.x, r.y + r.h, r.x + r.w, r.y + r.h, salt);
      else if (s === 'Left') fence(solids, r.x, r.y, r.x, r.y + r.h, salt);
      else fence(solids, r.x + r.w, r.y, r.x + r.w, r.y + r.h, salt);
    }
  }

  function scan(root, holes, holeIdx) {
    fixedCache.clear();
    const solids = [], zones = [];
    const consumed = new Set();
    const isConsumed = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) if (consumed.has(e)) return true;
      return false;
    };
    const vpArea = innerWidth * innerHeight;
    const cupEls = new Set(holes.map((h) => h.el));
    const current = holes[holeIdx];

    // Refresh cup rects (layout may have moved since the last hole).
    for (const h of holes) {
      if (!h.el.isConnected) continue;
      Object.assign(h, toDoc(h.el.getBoundingClientRect()));
    }

    for (const el of document.body.querySelectorAll('*')) {
      if (root === el || root.contains(el)) continue;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'BR') continue;
      if (cupEls.has(el)) { consumed.add(el); continue; }
      if (isConsumed(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
      if (inFixed(el)) { consumed.add(el); continue; }
      const r = toDoc(rect);
      addFences(el, cs, r, solids);

      // water: form fields and destructive / buy buttons
      if ((tag === 'INPUT' && !/^(hidden|submit|button|checkbox|radio|range|color|file|image|reset)$/i.test(el.type)) || tag === 'TEXTAREA' || tag === 'SELECT') {
        zones.push({ t: 'rect', k: 'water', ...r, msg: 'Splash! +1 stroke' });
        consumed.add(el);
        continue;
      }
      const txt = ownText(el) || (el.children.length <= 1 ? shortText(el) : '');
      if (txt && txt.length <= 24 && HAZARD_RE.test(txt) && r.w <= 440 && r.h <= 90 &&
          (hasBox(cs) || tag === 'BUTTON' || tag === 'A')) {
        const word = txt.match(HAZARD_RE)[1].toLowerCase().replace(/\s/g, '');
        zones.push({ t: 'rect', k: 'water', ...r, msg: HAZARD_MSG[word] || 'Splash! +1 stroke' });
        consumed.add(el);
        continue;
      }

      // bumpers: media
      if (tag === 'IMG' || tag === 'SVG' || tag === 'svg' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE') {
        consumed.add(el);
        if (r.w < 10 || r.h < 10 || r.w > 600 || r.h > 600 || r.w * r.h > vpArea * 0.25) continue;
        const round = parseFloat(cs.borderRadius) >= Math.min(r.w, r.h) * 0.4;
        if (round) solids.push({ t: 'circle', k: 'bumper', x: r.x + r.w / 2, y: r.y + r.h / 2, r: Math.min(r.w, r.h) / 2 });
        else solids.push({ t: 'rect', k: 'bumper', ...r });
        continue;
      }

      // blocks: small boxed leaf-ish elements (tags, chips, pills, dots)
      if (r.w <= 170 && r.h <= 72 && r.w * r.h >= 30 && el.children.length <= 3 && hasBox(cs) &&
          !el.querySelector('a, button, input, textarea, select') && ![...cupEls].some((c) => el.contains(c))) {
        solids.push({ t: 'rect', k: 'block', ...r });
        consumed.add(el);
        continue;
      }
    }

    // text pass
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let glyphBudget = 2500;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue;
      if (!v || !v.trim()) continue;
      const p = n.parentElement;
      if (!p || root.contains(p) || isConsumed(p)) continue;
      const ptag = p.tagName;
      if (ptag === 'SCRIPT' || ptag === 'STYLE' || ptag === 'NOSCRIPT' || ptag === 'TEMPLATE') continue;
      if (inFixed(p)) continue;
      const cs = getComputedStyle(p);
      if (cs.visibility === 'hidden' || alphaOf(cs.color) < 0.15) continue;
      const fs = parseFloat(cs.fontSize) || 16;

      const lines = v.split('\n').filter((l) => l.trim());
      const nonSpace = v.replace(/\s/g, '');
      let sym = 0;
      for (const ch of nonSpace) if (ASCII_SYMBOLS.test(ch)) sym++;
      const isAscii = cs.whiteSpace.startsWith('pre') && lines.length >= 3 && sym / nonSpace.length >= 0.45;

      if (isAscii && glyphBudget > 0) {
        for (let i = 0; i < v.length && glyphBudget > 0; i++) {
          const ch = v[i];
          if (/\s/.test(ch)) continue;
          range.setStart(n, i); range.setEnd(n, i + 1);
          const gr = range.getBoundingClientRect();
          if (gr.width < 1 || gr.height < 1) continue;
          glyphShapes(ch, toDoc(gr), solids);
          glyphBudget--;
        }
        continue;
      }

      range.selectNodeContents(n);
      const big = fs >= 24 || (fs >= 18 && p.closest('h1,h2,h3'));
      for (const lr of range.getClientRects()) {
        if (lr.width < 2 || lr.height < 2) continue;
        const d = toDoc(lr);
        if (big) {
          const gh = Math.min(d.h, fs * 0.78);
          solids.push({ t: 'rect', k: 'wall', x: d.x, y: d.y + (d.h - gh) / 2, w: d.w, h: gh });
        } else {
          zones.push({ t: 'rect', k: 'rough', x: d.x - 2, y: d.y, w: d.w + 4, h: d.h });
        }
      }
    }

    if (current) zones.push({ t: 'rect', k: 'green', x: current.x, y: current.y, w: current.w, h: current.h });

    const size = docSize();
    const solidHash = makeHash(), zoneHash = makeHash();
    for (const s of solids) { const b = boundsOf(s); hashInsert(solidHash, s, b[0], b[1], b[2], b[3]); }
    for (const z of zones) hashInsert(zoneHash, z, z.x, z.y, z.x + z.w, z.y + z.h);
    return { solids, zones, solidHash, zoneHash, w: size.w, h: size.h };
  }

  // ---- physics --------------------------------------------------------------
  const qbuf = [];
  function zoneAt(world, x, y) {
    let best = null;
    for (const z of hashQuery(world.zoneHash, x, y, 0, qbuf)) {
      if (x < z.x || x > z.x + z.w || y < z.y || y > z.y + z.h) continue;
      if (z.k === 'water') return z;
      if (z.k === 'green' || !best) best = z;
    }
    return best;
  }

  function isFree(world, x, y, pad) {
    const rr = BALL_R + pad;
    if (x < rr || y < rr || x > world.w - rr || y > world.h - rr) return false;
    for (const s of hashQuery(world.solidHash, x, y, rr + 4, qbuf)) if (hitTest(s, x, y, rr)) return false;
    const z = zoneAt(world, x, y);
    return !(z && z.k === 'water');
  }

  function hitTest(s, x, y, rr) {
    if (s.t === 'rect') {
      const cx = clamp(x, s.x, s.x + s.w), cy = clamp(y, s.y, s.y + s.h);
      return (x - cx) ** 2 + (y - cy) ** 2 < rr * rr;
    }
    if (s.t === 'circle') return (x - s.x) ** 2 + (y - s.y) ** 2 < (rr + s.r) ** 2;
    const c = closestOnSeg(s, x, y);
    return (x - c[0]) ** 2 + (y - c[1]) ** 2 < (rr + s.th) ** 2;
  }

  function closestOnSeg(s, x, y) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - s.x1) * dx + (y - s.y1) * dy) / l2, 0, 1);
    return [s.x1 + dx * t, s.y1 + dy * t];
  }

  const RESTITUTION = { wall: 0.72, block: 0.68, rail: 0.75, fence: 0.7, peg: 0.8, bumper: 1.3 };

  function collide(b, world, events) {
    for (const s of hashQuery(world.solidHash, b.x, b.y, BALL_R + 4, qbuf)) {
      let nx, ny, pen;
      if (s.t === 'rect') {
        const cx = clamp(b.x, s.x, s.x + s.w), cy = clamp(b.y, s.y, s.y + s.h);
        const dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          const l = b.x - s.x, r = s.x + s.w - b.x, t = b.y - s.y, bo = s.y + s.h - b.y;
          const m = Math.min(l, r, t, bo);
          if (m === l) { nx = -1; ny = 0; } else if (m === r) { nx = 1; ny = 0; } else if (m === t) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
          pen = m + BALL_R;
        } else if (d2 < BALL_R * BALL_R) {
          const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; pen = BALL_R - d;
        } else continue;
      } else {
        let px, py, rad;
        if (s.t === 'circle') { px = s.x; py = s.y; rad = BALL_R + s.r; }
        else { [px, py] = closestOnSeg(s, b.x, b.y); rad = BALL_R + s.th; }
        const dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= rad * rad) continue;
        const d = Math.sqrt(d2) || 0.0001;
        nx = d2 ? dx / d : 0; ny = d2 ? dy / d : -1; pen = rad - d;
      }
      b.x += nx * pen; b.y += ny * pen;
      const vn = b.vx * nx + b.vy * ny;
      if (vn >= 0) continue;
      const e = RESTITUTION[s.k] || 0.7;
      b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
      if (s.k === 'bumper') {
        let sp = Math.hypot(b.vx, b.vy);
        const target = clamp(sp, 280, MAX_SPEED * 0.9);
        b.vx *= target / sp; b.vy *= target / sp;
        if (events) events.push({ type: 'bump', s, v: -vn });
      } else if (events && -vn > 80) events.push({ type: 'hit', v: -vn, k: s.k });
    }
    // page edges
    const W = world.w, H = world.h;
    if (b.x < BALL_R) { b.x = BALL_R; if (b.vx < 0) b.vx *= -0.7; }
    if (b.x > W - BALL_R) { b.x = W - BALL_R; if (b.vx > 0) b.vx *= -0.7; }
    if (b.y < BALL_R) { b.y = BALL_R; if (b.vy < 0) b.vy *= -0.7; }
    if (b.y > H - BALL_R) { b.y = H - BALL_R; if (b.vy > 0) b.vy *= -0.7; }
  }

  // One fixed physics step. Returns 'water' | 'sink' | 'stop' | null.
  function step(b, world, cup, events) {
    let sp = Math.hypot(b.vx, b.vy);
    const z = zoneAt(world, b.x, b.y);
    if (z && z.k === 'water') { b.water = z; return 'water'; }

    const dc = Math.hypot(b.x - cup.cx, b.y - cup.cy);
    if (dc < CUP_R) {
      if (sp < SINK_SPEED) return 'sink';
      if (!b.lipped) {
        b.lipped = true;
        const a = (b.x - cup.cx) * b.vy - (b.y - cup.cy) * b.vx > 0 ? 0.45 : -0.45;
        const c = Math.cos(a), s = Math.sin(a);
        const vx = b.vx * c - b.vy * s, vy = b.vx * s + b.vy * c;
        b.vx = vx * 0.72; b.vy = vy * 0.72;
        if (events) events.push({ type: 'lip' });
      }
    } else if (dc > CUP_R + 4) b.lipped = false;
    if (dc < CUP_R + 9 && sp < 700) {
      const pull = 1400 * DT / (dc || 1);
      b.vx += (cup.cx - b.x) * pull; b.vy += (cup.cy - b.y) * pull;
    }

    const decel = z ? (z.k === 'rough' ? ROUGH_DECEL : GREEN_DECEL) : FLOOR_DECEL;
    sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const ns = Math.max(0, sp - decel * DT) * (1 - DAMP * DT);
      b.vx *= ns / sp; b.vy *= ns / sp;
      sp = ns;
    }
    b.x += b.vx * DT; b.y += b.vy * DT;
    collide(b, world, events);
    if (Math.hypot(b.vx, b.vy) < STOP_SPEED && dc > CUP_R + 9) { b.vx = 0; b.vy = 0; return 'stop'; }
    return null;
  }

  // ---- distance field (par + off-screen guidance) ---------------------------
  function distanceField(world, cup, tee) {
    const C = 12;
    const y0 = Math.max(0, Math.min(cup.cy, tee.y) - 600);
    const y1 = Math.min(world.h, Math.max(cup.cy, tee.y) + 600);
    const cols = Math.ceil(world.w / C), rows = Math.ceil((y1 - y0) / C);
    const cost = new Float32Array(cols * rows).fill(1);
    const mark = (x0, ya, x1, yb, v) => {
      const ax = clamp(Math.floor(x0 / C), 0, cols - 1), bx = clamp(Math.floor(x1 / C), 0, cols - 1);
      const ay = clamp(Math.floor((ya - y0) / C), 0, rows - 1), by = clamp(Math.floor((yb - y0) / C), 0, rows - 1);
      if (yb < y0 || ya > y1) return;
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
        const i = y * cols + x;
        if (v === Infinity || cost[i] !== Infinity) cost[i] = Math.max(cost[i], v);
      }
    };
    for (const z of world.zones) if (z.k === 'rough') mark(z.x, z.y, z.x + z.w, z.y + z.h, 1.8);
    for (const z of world.zones) if (z.k === 'water') mark(z.x - BALL_R, z.y - BALL_R, z.x + z.w + BALL_R, z.y + z.h + BALL_R, Infinity);
    for (const s of world.solids) {
      if (s.t === 'seg') {
        const n = Math.ceil(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) / 4) + 1;
        for (let i = 0; i <= n; i++) {
          const px = s.x1 + (s.x2 - s.x1) * i / n, py = s.y1 + (s.y2 - s.y1) * i / n;
          mark(px - BALL_R + 3, py - BALL_R + 3, px + BALL_R - 3, py + BALL_R - 3, Infinity);
        }
      } else {
        const b = boundsOf(s);
        mark(b[0] - BALL_R + 3, b[1] - BALL_R + 3, b[2] + BALL_R - 3, b[3] + BALL_R - 3, Infinity);
      }
    }
    const dist = new Float64Array(cols * rows).fill(Infinity);
    const heap = [];
    const push = (d, i) => {
      heap.push([d, i]);
      let k = heap.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
        }
      }
      return top;
    };
    const sx = clamp(Math.floor(cup.cx / C), 0, cols - 1), sy = clamp(Math.floor((cup.cy - y0) / C), 0, rows - 1);
    dist[sy * cols + sx] = 0;
    push(0, sy * cols + sx);
    const N = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    while (heap.length) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      const x = i % cols, y = (i / cols) | 0;
      for (const [dx, dy, w] of N) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx;
        if (cost[j] === Infinity) continue;
        const nd = d + w * C * cost[j];
        if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
      }
    }
    return {
      at(x, y) {
        const cx = Math.floor(x / C), cy = Math.floor((y - y0) / C);
        let best = Infinity;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          best = Math.min(best, dist[ny * cols + nx]);
        }
        return best === Infinity ? Math.hypot(x - cup.cx, y - cup.cy) * 2.5 : best;
      },
    };
  }

  function parFor(d) { return clamp(2 + Math.round(d / 750), 2, 5); }

  // ---- UI -------------------------------------------------------------------
  const root = document.createElement('div');
  root.id = '__webgolf_root';
  root.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483646;';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; touch-action: none; cursor: crosshair; }
      .hud { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 2px; align-items: stretch;
        font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .06em; color: #f4f4f0;
        background: rgba(12, 14, 12, .88); border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 4px;
        box-shadow: 0 8px 30px rgba(0,0,0,.35); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); user-select: none; max-width: calc(100vw - 24px); }
      .cell { padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: center; white-space: nowrap; }
      .cell b { font-size: 15px; font-weight: 800; letter-spacing: .02em; }
      .cell small { font-size: 9px; opacity: .6; letter-spacing: .14em; }
      .brand { font-size: 13px; padding: 8px 12px; color: #9fe870; }
      button { all: unset; cursor: pointer; padding: 8px 10px; border-radius: 8px; font-size: 14px; display: flex; align-items: center; }
      button:hover { background: rgba(255,255,255,.1); }
      .toast { position: fixed; left: 50%; top: 84px; transform: translateX(-50%) translateY(-6px); opacity: 0; transition: opacity .2s, transform .2s;
        font: 700 14px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #fff; background: rgba(12,14,12,.9);
        padding: 10px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14); pointer-events: none; text-align: center; max-width: calc(100vw - 32px); }
      .toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
      .toast em { font-style: normal; color: #9fe870; }
      .card { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.55); }
      .card.on { display: flex; }
      .panel { font: 500 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #f4f4f0; background: #101210; border: 1px solid rgba(255,255,255,.16);
        border-radius: 16px; padding: 22px; width: min(420px, calc(100vw - 32px)); box-shadow: 0 20px 60px rgba(0,0,0,.5); }
      .panel h2 { margin: 0 0 4px; font-size: 20px; letter-spacing: .04em; }
      .panel .site { opacity: .6; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin-bottom: 14px; }
      td, th { padding: 6px 4px; text-align: center; border-bottom: 1px solid rgba(255,255,255,.08); }
      th { font-size: 10px; opacity: .55; letter-spacing: .12em; font-weight: 600; }
      td:first-child, th:first-child { text-align: left; }
      .big { font-size: 28px; font-weight: 800; margin: 6px 0 2px; }
      .emoji { font-size: 20px; letter-spacing: 2px; margin: 8px 0 16px; }
      .row { display: flex; gap: 8px; }
      .row button { flex: 1; justify-content: center; background: #9fe870; color: #0b1a05; font-weight: 800; padding: 11px; }
      .row button.alt { background: rgba(255,255,255,.1); color: #fff; }
      .help { opacity: .6; font-size: 11px; position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); color: #fff;
        font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(12,14,12,.8); padding: 8px 12px; border-radius: 8px; pointer-events: none; white-space: nowrap; transition: opacity .4s; }
      @media (max-width: 520px) { .cell { padding: 6px 7px; } .brand { display: none; } .cell b { font-size: 13px; } }
    </style>
    <canvas></canvas>
    <div class="hud">
      <div class="cell brand">⛳ WEB GOLF</div>
      <div class="cell"><small>HOLE</small><b data-k="hole">1/1</b></div>
      <div class="cell"><small>PAR</small><b data-k="par">3</b></div>
      <div class="cell"><small>STROKES</small><b data-k="strokes">0</b></div>
      <div class="cell"><small>TOTAL</small><b data-k="total">E</b></div>
      <button data-a="sound" title="Sound">🔊</button>
      <button data-a="quit" title="Quit (Esc)">✕</button>
    </div>
    <div class="toast"></div>
    <div class="help">drag anywhere to aim · release to shoot · esc to quit</div>
    <div class="card"><div class="panel"></div></div>
  `;
  const canvas = shadow.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const hud = {};
  for (const el of shadow.querySelectorAll('[data-k]')) hud[el.dataset.k] = el;
  const toastEl = shadow.querySelector('.toast');
  const helpEl = shadow.querySelector('.help');
  const cardEl = shadow.querySelector('.card');
  const panelEl = shadow.querySelector('.panel');

  // ---- sound ----------------------------------------------------------------
  let audio = null, muted = false;
  function tone(freq, dur, type, vol, slide) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol || 0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* audio unavailable */ }
  }
  const sfx = {
    hit: (p) => tone(180 + p * 220, 0.08, 'triangle', 0.22),
    bump: () => tone(880, 0.12, 'square', 0.06, 1320),
    tap: () => tone(320, 0.04, 'triangle', 0.08),
    sink: () => { tone(523, 0.12, 'sine', 0.2); setTimeout(() => tone(659, 0.12, 'sine', 0.2), 110); setTimeout(() => tone(784, 0.25, 'sine', 0.2), 220); },
    splash: () => tone(400, 0.35, 'sawtooth', 0.06, 60),
    lip: () => tone(260, 0.1, 'square', 0.05, 200),
  };

  // ---- game state -----------------------------------------------------------
  const host = location.hostname.replace(/^www\./, '') || 'this page';
  const holes = findCups(root);
  const game = {
    holes, idx: 0, world: null, field: null,
    ball: { x: 0, y: 0, vx: 0, vy: 0 }, moving: false, sinking: 0,
    strokes: 0, scores: [], pars: [], tee: null, lastPos: null,
    aim: null, particles: [], flashes: [], trail: [], done: false,
  };
  if (!holes.length) {
    // No buttons at all: put a single cup near the bottom of the page.
    const s = docSize();
    holes.push({ el: document.body, text: 'the footer', label: '', x: s.w / 2 - 40, y: s.h - 140, w: 80, h: 40 });
  }
  for (const h of holes) { h.cx = h.x + h.w / 2; h.cy = h.y + h.h / 2; }

  function findTee(world) {
    const near = holes[0];
    const xs = [], ys = [];
    for (let y = 110; y < Math.min(world.h, near.y - 60, 900); y += 14) ys.push(y);
    if (!ys.length) ys.push(Math.max(40, near.y - 200));
    for (let x = 56; x < Math.min(world.w - 20, 700); x += 14) xs.push(x);
    for (const y of ys) for (const x of xs) {
      if (!isFree(world, x, y, 6)) continue;
      const z = zoneAt(world, x, y);
      if (z) continue;
      return { x, y };
    }
    return { x: 40, y: 60 };
  }

  function nudgeFree(world, x, y) {
    if (isFree(world, x, y, 1)) return { x, y };
    for (let r = 8; r < 240; r += 6) for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (isFree(world, px, py, 1)) return { x: px, y: py };
    }
    return { x, y };
  }

  function cupOf(i) { const h = holes[i]; h.cx = h.x + h.w / 2; h.cy = h.y + h.h / 2; return h; }

  function startHole(i) {
    game.idx = i;
    game.world = scan(root, holes, i);
    const cup = cupOf(i);
    let tee;
    if (i === 0) tee = findTee(game.world);
    else {
      const prev = holes[i - 1];
      tee = nudgeFree(game.world, prev.x + prev.w / 2, prev.y + prev.h / 2);
    }
    Object.assign(game.ball, { x: tee.x, y: tee.y, vx: 0, vy: 0, lipped: false });
    game.tee = tee; game.lastPos = { ...tee };
    game.field = distanceField(game.world, cup, tee);
    holes[i].pathLen = Math.round(game.field.at(tee.x, tee.y));
    game.pars[i] = parFor(holes[i].pathLen);
    game.strokes = 0; game.moving = false; game.sinking = 0; game.trail = [];
    updateHud();
    const what = cup.label ? `<em>${esc(cup.text)}</em> · ${esc(cup.label)}` : `<em>${esc(cup.text)}</em>`;
    toast(`Hole ${i + 1} · Par ${game.pars[i]}<br>${what}`, 2600);
    follow(true);
  }

  function rescan() {
    if (!game.world || game.done) return;
    game.world = scan(root, holes, game.idx);
    const cup = cupOf(game.idx);
    game.field = distanceField(game.world, cup, game.ball);
    const p = nudgeFree(game.world, game.ball.x, game.ball.y);
    game.ball.x = p.x; game.ball.y = p.y;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  let toastTimer = 0;
  function toast(msg, ms) {
    toastEl.innerHTML = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms || 1800);
  }

  function totalVsPar() {
    let s = 0, p = 0;
    game.scores.forEach((v, i) => { s += v; p += game.pars[i]; });
    return { s, p, d: s - p };
  }
  const fmtDiff = (d) => (d === 0 ? 'E' : d > 0 ? '+' + d : String(d));

  function updateHud() {
    hud.hole.textContent = `${game.idx + 1}/${holes.length}`;
    hud.par.textContent = game.pars[game.idx] || '-';
    hud.strokes.textContent = game.strokes;
    hud.total.textContent = fmtDiff(totalVsPar().d);
  }

  function scoreName(strokes, par) {
    if (strokes === 1) return 'HOLE IN ONE!';
    const d = strokes - par;
    return d <= -3 ? 'Albatross!' : d === -2 ? 'Eagle!' : d === -1 ? 'Birdie!' : d === 0 ? 'Par' : d === 1 ? 'Bogey' : d === 2 ? 'Double bogey' : `+${d}`;
  }
  function scoreEmoji(strokes, par) {
    if (strokes === 1) return '⛳';
    const d = strokes - par;
    return d <= -2 ? '🦅' : d === -1 ? '🐦' : d === 0 ? '🟩' : d === 1 ? '🟨' : '🟥';
  }

  function shareText() {
    const t = totalVsPar();
    return `⛳ Web Golf — ${host}\n${holes.length} hole${holes.length > 1 ? 's' : ''} · ${t.s} strokes (par ${t.p}, ${fmtDiff(t.d)})\n` +
      game.scores.map((s, i) => scoreEmoji(s, game.pars[i])).join('');
  }

  function showCard() {
    const t = totalVsPar();
    const rows = holes.map((h, i) =>
      `<tr><td>${i + 1}. ${esc(h.label || h.text)}</td><td>${game.pars[i]}</td><td>${game.scores[i]}</td><td>${scoreEmoji(game.scores[i], game.pars[i])}</td></tr>`).join('');
    panelEl.innerHTML = `
      <h2>⛳ COURSE COMPLETE</h2>
      <div class="site">${esc(host)}</div>
      <div class="big">${t.s} <span style="font-size:15px;opacity:.6">strokes · ${fmtDiff(t.d)}</span></div>
      <div class="emoji">${game.scores.map((s, i) => scoreEmoji(s, game.pars[i])).join('')}</div>
      <table><tr><th>HOLE</th><th>PAR</th><th>SCORE</th><th></th></tr>${rows}</table>
      <div class="row"><button data-a="copy">Copy score</button><button class="alt" data-a="again">Play again</button><button class="alt" data-a="quit">Close</button></div>`;
    cardEl.classList.add('on');
  }

  // ---- input ----------------------------------------------------------------
  function onDown(e) {
    if (game.done || game.moving || game.sinking) return;
    e.preventDefault();
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    game.aim = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    helpEl.style.opacity = '0';
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function onMove(e) {
    if (!game.aim) return;
    game.aim.x1 = e.clientX; game.aim.y1 = e.clientY;
  }
  function onUp() {
    const a = game.aim;
    game.aim = null;
    if (!a) return;
    const dx = a.x0 - a.x1, dy = a.y0 - a.y1, len = Math.hypot(dx, dy);
    if (len < 8) return;
    shoot(Math.atan2(dy, dx), Math.min(1, len / MAX_PULL));
  }

  function shoot(angle, power) {
    if (game.moving || game.sinking || game.done) return false;
    const sp = power * MAX_SPEED;
    game.lastPos = { x: game.ball.x, y: game.ball.y };
    game.ball.vx = Math.cos(angle) * sp; game.ball.vy = Math.sin(angle) * sp;
    game.ball.lipped = false;
    game.moving = true;
    game.strokes++;
    game.trail = [{ x: game.ball.x, y: game.ball.y }];
    updateHud();
    sfx.hit(power);
    return true;
  }

  function onKey(e) {
    if (e.key === 'Escape') { quit(); e.stopPropagation(); }
  }

  shadow.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('[data-a]');
    if (!a) return;
    const act = a.dataset.a;
    if (act === 'quit') quit();
    else if (act === 'sound') { muted = !muted; a.textContent = muted ? '🔇' : '🔊'; }
    else if (act === 'again') { cardEl.classList.remove('on'); game.scores = []; game.pars = []; game.done = false; startHole(0); }
    else if (act === 'copy') {
      const text = shareText();
      const ok = () => { a.textContent = 'Copied!'; setTimeout(() => (a.textContent = 'Copy score'), 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text, ok));
      else fallbackCopy(text, ok);
    }
  });
  function fallbackCopy(text, ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    shadow.appendChild(ta); ta.select();
    try { document.execCommand('copy'); ok(); } catch (e) { prompt('Copy your score:', text); }
    ta.remove();
  }

  // ---- camera ---------------------------------------------------------------
  function follow(snap) {
    const b = game.ball;
    const mx = innerWidth * 0.28, my = innerHeight * 0.3;
    let tx = scrollX, ty = scrollY;
    if (b.x - scrollX < mx) tx = b.x - mx;
    else if (b.x - scrollX > innerWidth - mx) tx = b.x - (innerWidth - mx);
    if (b.y - scrollY < my) ty = b.y - my;
    else if (b.y - scrollY > innerHeight - my) ty = b.y - (innerHeight - my);
    if (snap) { tx = b.x - innerWidth / 2; ty = b.y - innerHeight * 0.45; }
    const k = snap ? 1 : 0.18;
    const nx = scrollX + (tx - scrollX) * k, ny = scrollY + (ty - scrollY) * k;
    if (Math.abs(nx - scrollX) > 0.5 || Math.abs(ny - scrollY) > 0.5) window.scrollTo({ left: nx, top: ny, behavior: 'instant' });
  }

  // ---- particles ------------------------------------------------------------
  function burst(x, y, n, colors, speed, life, grav) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      game.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (grav ? speed * 0.5 : 0), life, t: 0, c: colors[i % colors.length], g: grav || 0, r: 1.5 + Math.random() * 2.5 });
    }
  }

  // ---- loop -----------------------------------------------------------------
  let last = performance.now(), acc = 0, raf = 0;
  const events = [];
  function tick(now) {
    raf = requestAnimationFrame(tick);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (game.moving) {
      acc += dt;
      while (acc >= DT && game.moving) {
        acc -= DT;
        events.length = 0;
        const res = step(game.ball, game.world, cupOf(game.idx), events);
        handleEvents();
        if (res) settle(res);
      }
      const tl = game.trail[game.trail.length - 1];
      if (!tl || Math.hypot(tl.x - game.ball.x, tl.y - game.ball.y) > 6) game.trail.push({ x: game.ball.x, y: game.ball.y });
      follow(false);
    } else acc = 0;
    if (game.sinking) {
      game.sinking += dt;
      if (game.sinking > 1.5) finishHole();
    }
    for (const p of game.particles) { p.t += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98; p.vy *= 0.98; }
    game.particles = game.particles.filter((p) => p.t < p.life);
    for (const f of game.flashes) f.t += dt;
    game.flashes = game.flashes.filter((f) => f.t < 0.35);
    draw(now / 1000);
  }

  function handleEvents() {
    for (const ev of events) {
      if (ev.type === 'bump') {
        sfx.bump();
        game.flashes.push({ s: ev.s, t: 0 });
        burst(game.ball.x, game.ball.y, 10, ['#ff3ea5', '#ffd166', '#fff'], 260, 0.4);
      } else if (ev.type === 'hit') { if (ev.v > 160) sfx.tap(); }
      else if (ev.type === 'lip') { sfx.lip(); toast('Lipped out!', 900); }
    }
  }

  function settle(res) {
    const b = game.ball;
    if (res === 'stop') { game.moving = false; return; }
    if (res === 'water') {
      game.moving = false;
      sfx.splash();
      burst(b.x, b.y, 18, ['#4cc9f0', '#90e0ef', '#fff'], 220, 0.6);
      game.strokes++;
      updateHud();
      toast(`💦 ${esc(b.water.msg)}`, 1800);
      b.x = game.lastPos.x; b.y = game.lastPos.y; b.vx = b.vy = 0;
      return;
    }
    if (res === 'sink') {
      game.moving = false;
      const cup = cupOf(game.idx);
      b.vx = b.vy = 0; b.x = cup.cx; b.y = cup.cy;
      game.sinking = 0.0001;
      sfx.sink();
      burst(cup.cx, cup.cy, game.strokes === 1 ? 90 : 40, ['#9fe870', '#ffd166', '#ff3ea5', '#4cc9f0', '#fff'], game.strokes === 1 ? 520 : 340, 1.2, 500);
      toast(`<em>${scoreName(game.strokes, game.pars[game.idx])}</em> · ${game.strokes} stroke${game.strokes > 1 ? 's' : ''}`, 1500);
    }
  }

  function finishHole() {
    game.sinking = 0;
    game.scores[game.idx] = game.strokes;
    updateHud();
    if (game.idx + 1 < holes.length) startHole(game.idx + 1);
    else { game.done = true; updateHud(); showCard(); }
  }

  // ---- render ---------------------------------------------------------------
  let dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }

  let roughPattern = null;
  function getRoughPattern() {
    if (roughPattern) return roughPattern;
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(64, 170, 72, 0.22)';
    g.fillRect(0, 0, 8, 8);
    g.strokeStyle = 'rgba(40, 140, 50, 0.55)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.stroke();
    roughPattern = ctx.createPattern(c, 'repeat');
    return roughPattern;
  }

  function outlineRect(r, fill, inner, w) {
    ctx.fillStyle = fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = (w || 1.5) + 2; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = w || 1.5; ctx.strokeStyle = inner; ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  function draw(t) {
    const W = innerWidth, H = innerHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!game.world) return;
    const vx0 = scrollX - 40, vy0 = scrollY - 40, vx1 = scrollX + W + 40, vy1 = scrollY + H + 40;
    const vis = (x0, y0, x1, y1) => x1 > vx0 && x0 < vx1 && y1 > vy0 && y0 < vy1;
    ctx.setTransform(dpr, 0, 0, dpr, -scrollX * dpr, -scrollY * dpr);

    // zones
    ctx.fillStyle = getRoughPattern();
    for (const z of game.world.zones) if (z.k === 'rough' && vis(z.x, z.y, z.x + z.w, z.y + z.h)) ctx.fillRect(z.x, z.y, z.w, z.h);
    for (const z of game.world.zones) {
      if (!vis(z.x, z.y, z.x + z.w, z.y + z.h)) continue;
      if (z.k === 'water') {
        ctx.fillStyle = 'rgba(30, 144, 255, 0.55)';
        ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.strokeStyle = 'rgba(200, 240, 255, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.save(); ctx.beginPath(); ctx.rect(z.x, z.y, z.w, z.h); ctx.clip();
        for (let y = z.y + 5; y < z.y + z.h; y += 7) {
          ctx.beginPath();
          for (let x = z.x; x <= z.x + z.w; x += 4) ctx.lineTo(x, y + Math.sin(x * 0.25 + t * 4 + y) * 1.5);
          ctx.stroke();
        }
        ctx.restore();
        ctx.lineWidth = 2; ctx.strokeStyle = '#1e90ff'; ctx.strokeRect(z.x, z.y, z.w, z.h);
      } else if (z.k === 'green') {
        ctx.fillStyle = 'rgba(80, 220, 120, 0.45)';
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(z.x - 6, z.y - 6, z.w + 12, z.h + 12, 10) : ctx.rect(z.x - 6, z.y - 6, z.w + 12, z.h + 12); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#3ddc84'; ctx.stroke();
      }
    }

    // solids
    for (const s of game.world.solids) {
      const bb = boundsOf(s);
      if (!vis(bb[0], bb[1], bb[2], bb[3])) continue;
      const flash = game.flashes.find((f) => f.s === s);
      if (s.k === 'wall' || s.k === 'block') {
        outlineRect(s, s.k === 'wall' ? 'rgba(255,255,255,0.10)' : 'rgba(255, 209, 102, 0.18)', s.k === 'wall' ? '#ffffff' : '#ffd166');
      } else if (s.k === 'bumper') {
        const glow = flash ? 1 - flash.t / 0.35 : 0;
        ctx.save();
        ctx.shadowColor = '#ff3ea5'; ctx.shadowBlur = 8 + glow * 24;
        ctx.lineWidth = 3 + glow * 3; ctx.strokeStyle = '#ff3ea5';
        if (s.t === 'circle') { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke(); }
        else ctx.strokeRect(s.x, s.y, s.w, s.h);
        ctx.restore();
      } else if (s.k === 'rail') {
        ctx.lineCap = 'round';
        ctx.lineWidth = s.th * 2 + 2; ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.lineWidth = s.th * 2; ctx.strokeStyle = '#ffd166';
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      } else if (s.k === 'fence') {
        ctx.lineCap = 'round';
        ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.lineWidth = 3; ctx.strokeStyle = '#f4f4f0';
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.fillStyle = '#9fe870';
        for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) { ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill(); }
      } else if (s.k === 'peg') {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      }
    }

    // tee
    if (game.tee) {
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath(); ctx.arc(game.tee.x, game.tee.y, 3, 0, Math.PI * 2); ctx.fill();
    }

    // cup + flag
    const cup = cupOf(game.idx);
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath(); ctx.arc(cup.cx, cup.cy, CUP_R, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    const wave = Math.sin(t * 3) * 3;
    ctx.lineWidth = 2; ctx.strokeStyle = '#f4f4f0';
    ctx.beginPath(); ctx.moveTo(cup.cx, cup.cy); ctx.lineTo(cup.cx, cup.cy - 48); ctx.stroke();
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath(); ctx.moveTo(cup.cx, cup.cy - 48); ctx.quadraticCurveTo(cup.cx + 14, cup.cy - 44 + wave, cup.cx + 26, cup.cy - 40 + wave); ctx.lineTo(cup.cx, cup.cy - 32); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 9px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillText(String(game.idx + 1), cup.cx + 9, cup.cy - 37 + wave * 0.5);

    // trail
    if (game.trail.length > 1) {
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(game.trail[0].x, game.trail[0].y);
      for (const p of game.trail) ctx.lineTo(p.x, p.y);
      ctx.lineTo(game.ball.x, game.ball.y);
      ctx.stroke(); ctx.setLineDash([]);
    }

    // aim
    const b = game.ball;
    if (game.aim) {
      const dx = game.aim.x0 - game.aim.x1, dy = game.aim.y0 - game.aim.y1;
      const len = Math.hypot(dx, dy), p = Math.min(1, len / MAX_PULL);
      if (len > 4) {
        const ux = dx / len, uy = dy / len;
        const col = p < 0.5 ? `hsl(${110 - p * 80}, 90%, 60%)` : `hsl(${70 - (p - 0.5) * 140}, 95%, 58%)`;
        const L = 30 + p * 230;
        for (let d = 14; d < L; d += 10) {
          ctx.fillStyle = col; ctx.globalAlpha = 1 - (d / L) * 0.7;
          ctx.beginPath(); ctx.arc(b.x + ux * d, b.y + uy * d, 2.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R + 7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
      }
    }

    // ball
    let scale = 1;
    if (game.sinking) scale = Math.max(0, 1 - game.sinking * 2.2);
    if (scale > 0) {
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.ellipse(b.x + 2.5, b.y + 3.5, BALL_R * scale, BALL_R * 0.8 * scale, 0, 0, Math.PI * 2); ctx.fill();
      const g = ctx.createRadialGradient(b.x - 2.5, b.y - 2.5, 1, b.x, b.y, BALL_R * scale);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d9d9d2');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R * scale, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.stroke();
    }

    // particles
    for (const p of game.particles) {
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
    }
    ctx.globalAlpha = 1;

    // off-screen pointers: cup (and ball while aiming from afar)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pointer(cup.cx, cup.cy, '#ff4d4d', `⛳ ${Math.round(Math.hypot(cup.cx - b.x, cup.cy - b.y) / PX_PER_M)}m`);
    pointer(b.x, b.y, '#ffffff', '●');
  }

  function pointer(x, y, color, label) {
    const sx = x - scrollX, sy = y - scrollY, W = innerWidth, H = innerHeight, m = 34;
    if (sx > 0 && sx < W && sy > 0 && sy < H) return;
    const cx = W / 2, cy = H / 2;
    const dx = sx - cx, dy = sy - cy;
    const k = Math.min((W / 2 - m) / Math.abs(dx || 1e-6), (H / 2 - m) / Math.abs(dy || 1e-6));
    const px = cx + dx * k, py = cy + dy * k, a = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(px, py); ctx.rotate(a);
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-6, -9); ctx.lineTo(-6, 9); ctx.closePath(); ctx.stroke(); ctx.fill();
    ctx.restore();
    ctx.font = '700 11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    const lx = px - Math.cos(a) * 26, ly = py - Math.sin(a) * 22 + 4;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(label, lx, ly);
    ctx.fillStyle = color; ctx.fillText(label, lx, ly);
  }

  // ---- lifecycle ------------------------------------------------------------
  let resizeTimer = 0;
  function onResize() { resize(); clearTimeout(resizeTimer); resizeTimer = setTimeout(rescan, 200); }

  function quit() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    html.style.scrollBehavior = prevScrollBehavior;
    root.remove();
    api.alive = false;
  }

  const prevScrollBehavior = html.style.scrollBehavior;
  html.style.scrollBehavior = 'auto';
  document.body.appendChild(root);
  resize();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => (game.aim = null));
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey, true);
  setTimeout(() => (helpEl.style.opacity = '0'), 7000);

  // Test / tooling hooks.
  const api = {
    alive: true,
    game,
    focus() { follow(true); },
    quit,
    shoot,
    // Run the physics synchronously until the ball settles.
    fastForward(maxSec) {
      let t = 0;
      while (game.moving && t < (maxSec || 20)) {
        events.length = 0;
        const res = step(game.ball, game.world, cupOf(game.idx), events);
        if (res) settle(res);
        t += DT;
      }
      if (game.sinking) finishHole();
      return { x: game.ball.x, y: game.ball.y, hole: game.idx, strokes: game.strokes, done: game.done };
    },
    // Dry-run a shot from the current ball position without changing the game.
    simulate(angle, power) {
      const b = { x: game.ball.x, y: game.ball.y, vx: Math.cos(angle) * power * MAX_SPEED, vy: Math.sin(angle) * power * MAX_SPEED, lipped: false };
      const cup = cupOf(game.idx);
      for (let t = 0; t < 20; t += DT) {
        const r = step(b, game.world, cup, null);
        if (r === 'sink') return { sunk: true, x: cup.cx, y: cup.cy, d: 0 };
        if (r === 'water') return { water: true, x: b.x, y: b.y, d: Infinity };
        if (r === 'stop') break;
      }
      return { x: b.x, y: b.y, d: game.field.at(b.x, b.y) };
    },
    distToCup() { return game.field.at(game.ball.x, game.ball.y); },
    stats() {
      const w = game.world, count = (arr, k) => arr.filter((s) => s.k === k).length;
      return {
        holes: holes.map((h, i) => ({ text: h.text, label: h.label, x: Math.round(h.cx), y: Math.round(h.cy), par: game.pars[i], pathLen: h.pathLen })),
        walls: count(w.solids, 'wall'), blocks: count(w.solids, 'block'), bumpers: count(w.solids, 'bumper'),
        rails: count(w.solids, 'rail'), fences: count(w.solids, 'fence'), pegs: count(w.solids, 'peg'),
        rough: count(w.zones, 'rough'), water: w.zones.filter((z) => z.k === 'water').map((z) => z.msg),
        tee: game.tee,
      };
    },
  };
  window.__webGolf = api;

  startHole(0);
  raf = requestAnimationFrame(tick);
})();
