"""Generate the original geometric icon set and Chrome Web Store small promo image.

All artwork is drawn from scratch with Pillow primitives (rounded rectangles,
polygons, ellipses) plus one hand-authored geometric SVG source. The mark is a
chat bubble with an archive/save tray inside it; brand blue is #365CE5.

Constraints honoured by this script:
  * no network access, no AI services, no shell commands, no file deletion;
  * no user images and no real data are read - only the bundled font file that
    already lives on the operating system (it is never copied into the project);
  * nothing outside the repository root is scanned or written;
  * output is limited to the six asset files listed in OUTPUTS;
  * generation is deterministic - running it twice yields identical files.

Usage:  python scripts/generate-store-assets.py
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "extension-tracker" / "icons"
STORE_DIR = ROOT / "store" / "assets"

BRAND = (0x36, 0x5C, 0xE5, 255)
BRAND_HEX = "#365CE5"
WHITE = (255, 255, 255, 255)
WHITE_HEX = "#FFFFFF"

ICON_SIZES = (16, 32, 48, 128)
SVG_SIZE = 512
PROMO_SIZE = (440, 280)

TITLE_TEXT = "求职沟通记录器"
SUBTITLE_TEXT = "本地归档 · 增量更新"
BADGE_TEXT = "非官方工具"

# System fonts only; index 0 of msyh.ttc / NotoSansCJK is a regular face.
FONT_REGULAR = (
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
    "/System/Library/Fonts/PingFang.ttc",
)
FONT_BOLD = (
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansSC-Bold.otf",
    "/usr/share/fonts/opentype/noto/NotoSansSC-Bold.otf",
    "/System/Library/Fonts/PingFang.ttc",
)


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Mark:
    """Normalised geometry of the chat-bubble + archive-tray mark."""

    size: float
    body: Tuple[float, float, float, float]
    body_radius: float
    tail: Tuple[Tuple[float, float], ...]
    lid: Tuple[float, float, float, float]
    lid_radius: float
    box: Tuple[float, float, float, float]
    box_radius: float
    notch: Tuple[Tuple[float, float], ...]


def mark_geometry(size: float) -> Mark:
    """Build the mark geometry for a square canvas of `size` units.

    The artwork keeps a 13% transparent margin on every side so that the
    silhouette stays clear at small sizes.
    """
    margin = size * 0.13
    x0 = y0 = margin
    x1 = y1 = size - margin
    w = x1 - x0
    h = y1 - y0

    body_bottom = y0 + h * 0.85
    body_h = body_bottom - y0
    body_radius = body_h * 0.26
    body = (x0, y0, x1, body_bottom)

    tail_top = body_bottom - h * 0.02
    tail = (
        (x0 + w * 0.17, tail_top),
        (x0 + w * 0.47, tail_top),
        (x0 + w * 0.20, y1),
    )

    inner_w = w * 0.56
    cx = (x0 + x1) / 2.0
    tx0 = cx - inner_w / 2.0
    tx1 = cx + inner_w / 2.0

    lid_h = h * 0.115
    gap = h * 0.055
    box_h = h * 0.245
    stack_h = lid_h + gap + box_h
    cy = (y0 + body_bottom) / 2.0
    ty0 = cy - stack_h / 2.0

    lid = (tx0, ty0, tx1, ty0 + lid_h)
    lid_radius = min(lid_h, box_h) * 0.35

    bx0 = tx0 + w * 0.035
    bx1 = tx1 - w * 0.035
    by0 = ty0 + lid_h + gap
    box = (bx0, by0, bx1, by0 + box_h)
    box_radius = box_h * 0.35

    bw = bx1 - bx0
    notch_top = by0 - box_h * 0.02
    notch_bottom = by0 + box_h * 0.45
    notch = (
        (cx - bw * 0.375, notch_top),
        (cx + bw * 0.375, notch_top),
        (cx + bw * 0.165, notch_bottom),
        (cx - bw * 0.165, notch_bottom),
    )

    return Mark(
        size=size,
        body=body,
        body_radius=body_radius,
        tail=tail,
        lid=lid,
        lid_radius=lid_radius,
        box=box,
        box_radius=box_radius,
        notch=notch,
    )


# --------------------------------------------------------------------------
# icons
# --------------------------------------------------------------------------

def render_icon(pixel_size: int, supersample: int = 4) -> Image.Image:
    """Render the mark at `pixel_size`, antialiased via supersampling."""
    factor = max(1, int(supersample))
    unit = pixel_size * factor
    g = mark_geometry(unit)

    canvas = Image.new("RGBA", (unit, unit), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle(g.body, radius=g.body_radius, fill=BRAND)
    draw.polygon(g.tail, fill=BRAND)
    draw.rounded_rectangle(g.lid, radius=g.lid_radius, fill=WHITE)
    draw.rounded_rectangle(g.box, radius=g.box_radius, fill=WHITE)
    draw.polygon(g.notch, fill=BRAND)

    if factor > 1:
        return canvas.resize((pixel_size, pixel_size), Image.LANCZOS)
    return canvas


def icon_svg(size: int = SVG_SIZE) -> str:
    """Emit the same geometry as a standalone, hand-authored SVG source."""

    def num(value: float) -> str:
        text = f"{value:.2f}".rstrip("0").rstrip(".")
        return text if text not in ("", "-0") else "0"

    def rect(box: Tuple[float, float, float, float], radius: float) -> str:
        x0, y0, x1, y1 = box
        return (
            f'<rect x="{num(x0)}" y="{num(y0)}" '
            f'width="{num(x1 - x0)}" height="{num(y1 - y0)}" '
            f'rx="{num(radius)}" />'
        )

    def points(items: Tuple[Tuple[float, float], ...]) -> str:
        return " ".join(f"{num(x)},{num(y)}" for x, y in items)

    g = mark_geometry(size)
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'width="{size}" height="{size}">',
        "  <title>Icon</title>",
        f'  <g fill="{BRAND_HEX}">',
        "    " + rect(g.body, g.body_radius),
        f'    <polygon points="{points(g.tail)}" />',
        "  </g>",
        f'  <g fill="{WHITE_HEX}">',
        "    " + rect(g.lid, g.lid_radius),
        "    " + rect(g.box, g.box_radius),
        "  </g>",
        f'  <polygon fill="{BRAND_HEX}" points="{points(g.notch)}" />',
        "</svg>",
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# fonts
# --------------------------------------------------------------------------

def resolve_font_path(bold: bool) -> str:
    for candidate in FONT_BOLD if bold else FONT_REGULAR:
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError(
        "no usable CJK font found; expected msyh.ttc on Windows or Noto Sans CJK on Linux"
    )


def load_font(size_px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = resolve_font_path(bold)
    try:
        return ImageFont.truetype(path, size_px, index=0)
    except OSError as exc:  # pragma: no cover - depends on host fonts
        raise RuntimeError(f"cannot load font {path}: {exc}") from exc


def fit_font(text: str, max_width: float, start_size: int, bold: bool = False):
    """Largest font size (<= start_size) whose rendering of `text` fits."""
    size = start_size
    while size > 8:
        font = load_font(size, bold)
        if font.getlength(text) <= max_width:
            return font
        size -= 2
    return load_font(8, bold)


# --------------------------------------------------------------------------
# small promo image
# --------------------------------------------------------------------------

SCALE = 2  # draw at 2x and downscale for smooth edges


def render_promo() -> Image.Image:
    base_w, base_h = PROMO_SIZE
    w, h = base_w * SCALE, base_h * SCALE

    def px(value: float) -> int:
        return int(round(value * SCALE))

    canvas = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    top = (0xF8, 0xF9, 0xFD)
    bottom = (0xE6, 0xEC, 0xFB)
    for y in range(h):
        t = y / (h - 1) if h > 1 else 0.0
        color = tuple(int(round(a + (b - a) * t)) for a, b in zip(top, bottom)) + (255,)
        draw.line(((0, y), (w - 1, y)), fill=color)

    # Soft, purely decorative brand-blue disc in the lower right corner.
    disc = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(disc).ellipse(
        (px(348), px(150), px(560), px(362)), fill=(BRAND[0], BRAND[1], BRAND[2], 26)
    )
    canvas = Image.alpha_composite(canvas, disc)

    icon_size = 144
    icon_x = 30
    icon_y = (base_h - icon_size) // 2
    icon = render_icon(px(icon_size))
    canvas.paste(icon, (px(icon_x), px(icon_y)), icon)

    draw = ImageDraw.Draw(canvas)
    text_x = icon_x + icon_size + 26
    max_text_w = px(base_w - text_x - 28)

    title_font = fit_font(TITLE_TEXT, max_text_w, px(28), bold=True)
    sub_font = fit_font(SUBTITLE_TEXT, max_text_w, px(15))
    badge_font = fit_font(BADGE_TEXT, max_text_w - px(28), px(13), bold=True)

    def bbox(text: str, font: ImageFont.FreeTypeFont):
        return draw.textbbox((0, 0), text, font=font)

    title_box = bbox(TITLE_TEXT, title_font)
    sub_box = bbox(SUBTITLE_TEXT, sub_font)

    badge_h = px(26)
    badge_pad = px(14)
    gap_title_sub = px(10)
    gap_sub_badge = px(18)

    stack_h = (
        (title_box[3] - title_box[1])
        + gap_title_sub
        + (sub_box[3] - sub_box[1])
        + gap_sub_badge
        + badge_h
    )
    y = (h - stack_h) / 2.0

    draw.text(
        (px(text_x) - title_box[0], y - title_box[1]),
        TITLE_TEXT,
        font=title_font,
        fill=(0x1E, 0x23, 0x33, 255),
    )
    y += (title_box[3] - title_box[1]) + gap_title_sub
    draw.text(
        (px(text_x) - sub_box[0], y - sub_box[1]),
        SUBTITLE_TEXT,
        font=sub_font,
        fill=(0x5A, 0x62, 0x72, 255),
    )
    y += (sub_box[3] - sub_box[1]) + gap_sub_badge

    badge_text_w = badge_font.getlength(BADGE_TEXT)
    badge_w = badge_text_w + badge_pad * 2
    badge_box = (px(text_x), y, px(text_x) + badge_w, y + badge_h)
    draw.rounded_rectangle(badge_box, radius=badge_h / 2.0, fill=BRAND)
    badge_box_text = bbox(BADGE_TEXT, badge_font)
    draw.text(
        (
            badge_box[0] + (badge_w - badge_text_w) / 2.0 - badge_box_text[0],
            badge_box[1] + (badge_h - (badge_box_text[3] - badge_box_text[1])) / 2.0
            - badge_box_text[1],
        ),
        BADGE_TEXT,
        font=badge_font,
        fill=(255, 255, 255, 255),
    )

    return canvas.resize(PROMO_SIZE, Image.LANCZOS).convert("RGB")


# --------------------------------------------------------------------------
# output + verification
# --------------------------------------------------------------------------

def verify_png(path: Path, expected: Tuple[int, int], expect_alpha: bool) -> str:
    with Image.open(path) as image:
        image.load()
        size = image.size
        mode = image.mode
    if size != expected:
        raise RuntimeError(f"{path} has size {size}, expected {expected}")
    if expect_alpha and "A" not in mode:
        raise RuntimeError(f"{path} has mode {mode}, expected an alpha channel")
    rel = path.relative_to(ROOT).as_posix()
    return f"{rel} {size[0]}x{size[1]}"


def main() -> int:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    STORE_DIR.mkdir(parents=True, exist_ok=True)

    written = []
    for size in ICON_SIZES:
        target = ICON_DIR / f"icon-{size}.png"
        render_icon(size).save(target, format="PNG", optimize=True)
        written.append((target, (size, size), True))

    svg_path = STORE_DIR / "icon.svg"
    svg_path.write_text(icon_svg(), encoding="utf-8", newline="\n")

    promo_path = STORE_DIR / "small-promo.png"
    render_promo().save(promo_path, format="PNG", optimize=True)
    written.append((promo_path, PROMO_SIZE, False))

    report = []
    for path, expected, expect_alpha in written:
        report.append(verify_png(path, expected, expect_alpha))

    svg_text = svg_path.read_text(encoding="utf-8")
    if not svg_text.startswith("<svg") or 'viewBox="0 0 512 512"' not in svg_text:
        raise RuntimeError(f"{svg_path} is not the expected geometric SVG source")
    report.append(f"{svg_path.relative_to(ROOT).as_posix()} {SVG_SIZE}x{SVG_SIZE}")

    for line in report:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
