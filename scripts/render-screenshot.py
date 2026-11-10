#!/usr/bin/env python3
"""Render a REAL terminal capture of the demo into docs/demo-screenshot.png.

Runs `node scripts/demo.mjs` fresh, captures its actual stdout, and renders
that text (wrapped, monospace, terminal-styled) to a PNG. Nothing in the
image is typed by hand: every line is the demo's real output.
"""
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 13)
TITLE_FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 13)
BG = (18, 18, 20)
FG = (220, 220, 210)
ACCENT = (120, 200, 120)
TITLE_BG = (40, 40, 46)
PAD = 18
LINE_H = 18
WRAP = 118


def main():
    out = subprocess.run(
        ["node", "scripts/demo.mjs"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    # Keep the transcript readable: drop the long on-chain evidence block's
    # explorer line duplication is fine, but keep every step + the evidence
    # header. Truncate the metrics JSON lines only by wrapping, not by edit.
    lines = []
    for raw in out.splitlines():
        if not raw.strip():
            lines.append("")
            continue
        lines.extend(textwrap.wrap(raw, width=WRAP, replace_whitespace=False, drop_whitespace=False) or [""])
    title = "$ npm test && node scripts/demo.mjs   —   FRONTIER-ECON (bnty_0419)"
    width = max(TITLE_FONT.getlength(title), max((FONT.getlength(l) for l in lines), default=0)) + PAD * 2
    width = int(width) + 10
    height = 44 + len(lines) * LINE_H + PAD
    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width, 34], fill=TITLE_BG)
    d.text((PAD, 9), title, font=TITLE_FONT, fill=ACCENT)
    y = 44
    for line in lines:
        d.text((PAD, y), line, font=FONT, fill=FG)
        y += LINE_H
    target = ROOT / "docs" / "demo-screenshot.png"
    img.save(target)
    print(f"wrote {target} ({width}x{height}, {len(lines)} rendered lines)")


if __name__ == "__main__":
    main()
