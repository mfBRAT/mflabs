#!/usr/bin/env python3
"""Recreate the Claude pixel art character as the menu bar icon."""

from PIL import Image, ImageDraw

SIZE   = 44
BG     = (0,   0,   0,   255)   # black background
BODY   = (200, 122, 85,  255)   # salmon #C87A55
TRANS  = (0,   0,   0,   0)

# Character defined on a 14-wide × 16-tall pixel grid.
# X = body color, . = transparent
GRID = [
    ".XXXXXXXXXXXX.",   # top of head
    ".XXXXXXXXXXXX.",
    ".XXXXXXXXXXXX.",
    ".XX..XXXX..XX.",   # eyes
    ".XX..XXXX..XX.",
    ".XXXXXXXXXXXX.",
    ".XXXXXXXXXXXX.",
    "XXXXXXXXXXXXXX",   # arms — widest row
    "XX..XXXXXX..XX",   # arm notch (symmetric step)
    ".XXXXXXXXXXXX.",
    "..XXXXXXXXXX..",
    "..XX.XX.XX.XX.",   # 4 legs
    "..XX.XX.XX.XX.",
    "..XX.XX.XX.XX.",
    "..XX.XX.XX.XX.",
]

GW = len(GRID[0])   # 14
GH = len(GRID)      # 15


def make_icon(path="icon.png"):
    scale = 4
    s     = SIZE * scale            # 176
    img   = Image.new("RGBA", (s, s), BG)
    draw  = ImageDraw.Draw(img)

    # pixel size in the scaled canvas
    pw = s / GW
    ph = s / GH

    # center the grid
    ox = (s - GW * pw) / 2
    oy = (s - GH * ph) / 2

    for row, line in enumerate(GRID):
        for col, ch in enumerate(line):
            if ch == "X":
                x0 = ox + col * pw
                y0 = oy + row * ph
                draw.rectangle([x0, y0, x0 + pw - 0.5, y0 + ph - 0.5], fill=BODY)

    img = img.resize((SIZE, SIZE), Image.NEAREST)   # keep pixel-art sharpness
    img.save(path)
    print(f"Saved {path} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    make_icon()
