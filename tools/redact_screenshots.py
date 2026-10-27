"""Redact private regions of the dsh2phone documentation screenshots.

Every GUI screenshot in docs/ was taken against a real desktop:
  - the sidebar leaks workspace and session names,
  - the sidebar foot shows the account phone number,
  - the pairing dialog shows a QR code that encodes the public pairing URL
    (and a live pairing code).
The sidebar is blurred (keeps the layout recognisable) and the QR area is
covered with the dialog's own background colour plus a "redacted" label, so the
screenshot still documents the flow without leaking anything.

usage: python tools/redact_screenshots.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# GUI screenshots share the 1400x900 layout: sidebar is the left 270 px.
SIDEBAR = (0, 0, 270, None)
BLUR_RADIUS = 16

# The pairing dialog is centred; the QR card sits at a fixed offset in it.
QR_BOX = (566, 328, 834, 620)
# Empty spot inside the dialog, used to sample the surface colour to cover with.
SURFACE_SAMPLE = (905, 262)

GUI_SHOTS = [
    DOCS / "plugin-gui-menu.png",
    DOCS / "plugin-gui-pair.png",
    DOCS / "plugin-gui-devices.png",
    DOCS / "theme" / "pair-light.png",
    DOCS / "theme" / "pair-dark.png",
    DOCS / "theme" / "confirm-light.png",
    DOCS / "theme" / "confirm-dark.png",
    DOCS / "theme" / "devices-light.png",
    DOCS / "theme" / "devices-dark.png",
]

QR_SHOTS = {"plugin-gui-pair.png", "pair-light.png", "pair-dark.png"}

FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/msyhl.ttc"),
    Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
]


def blur_box(img: Image.Image, box: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = box
    right = min(right, img.width)
    bottom = min(bottom, img.height)
    if right <= left or bottom <= top:
        return
    region = img.crop((left, top, right, bottom)).filter(ImageFilter.GaussianBlur(BLUR_RADIUS))
    img.paste(region, (left, top))


def font(size: int) -> ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                continue
    return ImageFont.load_default()


def cover_box(img: Image.Image, box: tuple[int, int, int, int], label: str) -> None:
    """Fill the box with the dialog surface colour and label it."""
    surface = img.getpixel(SURFACE_SAMPLE)
    draw = ImageDraw.Draw(img)
    draw.rectangle(box, fill=surface)
    text_font = font(15)
    width = box[2] - box[0]
    height = box[3] - box[1]
    # Muted grey reads on both the light (#fff) and dark (#232324) dialog.
    draw.text((box[0] + width / 2, box[1] + height / 2), label, font=text_font, fill="#8a9099", anchor="mm")


def main() -> int:
    changed = 0
    for path in GUI_SHOTS:
        if not path.exists():
            print(f"skip (missing): {path.relative_to(ROOT)}")
            continue
        img = Image.open(path).convert("RGB")
        actions = ["sidebar"]
        blur_box(img, (SIDEBAR[0], SIDEBAR[1], SIDEBAR[2], img.height))
        if path.name in QR_SHOTS:
            actions.append("qr")
            cover_box(img, QR_BOX, "二维码已脱敏")
        img.save(path, "PNG", optimize=True)
        changed += 1
        print(f"redacted {path.relative_to(ROOT)}: {', '.join(actions)}")
    print(f"wrote {changed} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
