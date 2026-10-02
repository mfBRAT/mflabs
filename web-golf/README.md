# web-golf

Turns the page you're on into a top-down mini-golf course. Each call-to-action button (Launch, Play, Sign up…) becomes a hole, and the rest of the page becomes the course:

| On the page | On the course |
|---|---|
| Headings, big type | Walls |
| Body text | Rough (slows the ball ~4×) |
| Images, SVG icons | Bumpers (add speed) |
| Small boxed elements (tags, chips) | Blocks |
| Divider lines, big framed boxes | Fences with a gap |
| ASCII art in `<pre>` | Rails and pegs, glyph by glyph |
| Inputs, Buy / Delete / Abort buttons | Water (+1 stroke) |
| CTA buttons | Cups |

Par is the shortest route around walls and water (weighted for rough), divided by ~one full-power putt, plus two.

Drag anywhere to aim, release to putt. Esc quits.

**Stack:** vanilla JS, canvas, no dependencies at runtime.

## Use

- **Bookmarklet:** `npm run build`, then make a bookmark whose URL is the contents of `dist/bookmarklet.txt`.
- **On your own site:** `<script src="golf.min.js"></script>` (or load it from a button click).
- **Demo page:** `dist/index.html` is a 4-hole course with an installer.

## Develop

```sh
npm install
npm run build                     # dist/golf.min.js, dist/bookmarklet.txt, dist/index.html
node test/play.mjs <url> <outDir> [width] [height]
```

`test/play.mjs` loads `golf.js` into a page, brute-forces every hole with the physics simulator, and screenshots each hole. It's a quick check that every hole on a page can be finished.
