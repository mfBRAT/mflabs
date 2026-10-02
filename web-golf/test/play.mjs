// Auto-plays Web Golf on a page and screenshots it.
// usage: node play.mjs <url> <outDir> [width] [height]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [url, outDir = 'shots', w = '1280', h = '800'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const golf = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../golf.js');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.route('**/*', (r) => (r.request().url().startsWith('http://localhost') ? r.continue() : r.abort()));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.addScriptTag({ path: golf });
await page.waitForTimeout(300);
console.log(JSON.stringify(await page.evaluate(() => window.__webGolf.stats()), null, 1));
console.log('screenshotting'); await page.screenshot({ path: `${outDir}/hole1-start.png`, timeout: 15000 }); console.log('shot ok');

const T0 = Date.now();
const shot = async (name) => { await page.waitForTimeout(120); await page.screenshot({ path: `${outDir}/${name}.png` }); };

const summary = [];
for (let guard = 0; guard < 120; guard++) {
  const st = await page.evaluate(() => ({ idx: window.__webGolf.game.idx, done: window.__webGolf.game.done, strokes: window.__webGolf.game.strokes }));
  if (st.done) break;
  if (st.strokes >= 10) { console.log(`hole ${st.idx + 1}: giving up at 10 strokes`); break; }
  const best = await page.evaluate(() => {
    const g = window.__webGolf;
    let best = null;
    for (let a = 0; a < 360; a += 3) for (let p = 0.12; p <= 1.001; p += 0.08) {
      const r = g.simulate(a * Math.PI / 180, p);
      const score = r.sunk ? -1 + p * 0.01 : r.d;
      if (!best || score < best.score) best = { a, p, score, r };
    }
    return best;
  });
  await page.evaluate(({ a, p }) => window.__webGolf.shoot(a * Math.PI / 180, p), best);
  // let it animate a bit for a mid-flight screenshot on the first shot of each hole
  if (st.strokes === 0) { await page.waitForTimeout(350); await shot(`hole${st.idx + 1}-flight`); }
  const res = await page.evaluate(() => window.__webGolf.fastForward(20));
  console.log(`[${((Date.now()-T0)/1000).toFixed(0)}s] hole ${st.idx + 1} stroke ${st.strokes + 1}: angle ${best.a} power ${best.p.toFixed(2)} -> ${best.r.sunk ? 'SUNK' : 'd=' + Math.round(best.r.d)}`);
  if (res.hole !== st.idx || res.done) {
    summary.push({ hole: st.idx + 1, strokes: st.strokes + 1 });
    await page.waitForTimeout(400);
    await shot(`hole${res.hole + 1}-start`);
  }
}
const fin = await page.evaluate(() => ({ scores: window.__webGolf.game.scores, pars: window.__webGolf.game.pars, done: window.__webGolf.game.done }));
console.log('FINAL', JSON.stringify(fin));
await page.waitForTimeout(500);
await shot('scorecard');
await browser.close();
