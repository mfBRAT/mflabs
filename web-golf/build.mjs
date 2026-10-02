// Builds dist/: minified script, bookmarklet, and the demo page.
import fs from 'node:fs';
import { minify } from 'terser';

const src = fs.readFileSync('golf.js', 'utf8');
const start = src.indexOf('(function () {');
const end = src.lastIndexOf('})();');
if (start < 0 || end < 0) throw new Error('golf.js must be a single IIFE');
const asFunction = 'function webGolf() {' + src.slice(start + '(function () {'.length, end) + '}';

const { code: fn } = await minify(asFunction, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
const script = `(${fn})();`;
const bookmarklet = 'javascript:' + encodeURIComponent(script);

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/golf.min.js', script + '\n');
fs.writeFileSync('dist/bookmarklet.txt', bookmarklet + '\n');

// The demo page defines window.webGolf and builds the bookmarklet from its source at runtime.
const body = fs.readFileSync('demo/page.html', 'utf8').replace('/*__WEBGOLF__*/', `window.webGolf = ${fn};`);
fs.writeFileSync('dist/demo.html', body);
fs.writeFileSync('dist/index.html', `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`);

console.log(`golf.js ${(src.length / 1024).toFixed(1)}KB -> golf.min.js ${(script.length / 1024).toFixed(1)}KB, bookmarklet ${(bookmarklet.length / 1024).toFixed(1)}KB`);
