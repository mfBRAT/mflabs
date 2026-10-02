import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.route('**/*', (r) => (r.request().url().startsWith('http://localhost') ? r.continue() : r.abort()));
await page.goto('http://localhost:8765/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.addScriptTag({ path: '../golf.js' });
await page.waitForTimeout(300);
const before = await page.evaluate(() => ({ ...window.__webGolf.game.ball }));
// slingshot: press, pull up-right, release => ball goes down-left
await page.mouse.move(640, 400); await page.mouse.down();
await page.mouse.move(700, 330, { steps: 8 });
await page.screenshot({ path: process.argv[2] + '/aiming.png' });
await page.mouse.up();
await page.waitForTimeout(2500);
const after = await page.evaluate(() => ({ b: { ...window.__webGolf.game.ball }, strokes: window.__webGolf.game.strokes, moving: window.__webGolf.game.moving, scrollY }));
console.log(JSON.stringify({ before: { x: before.x, y: before.y }, after }));
// a page link underneath must not navigate while playing
await page.mouse.click(110, 532); await page.waitForTimeout(300);
console.log('url after click:', page.url(), 'strokes', await page.evaluate(() => window.__webGolf.game.strokes));
await page.keyboard.press('Escape'); await page.waitForTimeout(100);
console.log('quit ->', await page.evaluate(() => ({ alive: window.__webGolf.alive, root: !!document.getElementById('__webgolf_root') })));
await browser.close();
