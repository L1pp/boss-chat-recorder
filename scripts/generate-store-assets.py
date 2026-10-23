"""Export the checked-in icon artwork to runtime extension PNG sizes.

The source artwork lives at docs/assets/icon.png. This script only writes the
four runtime extension icons; existing Chrome Web Store artwork stays as-is.
It uses Pillow locally and does not access the network or user data.

Usage: python scripts/generate-store-assets.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MASTER_ICON = ROOT / "docs" / "assets" / "icon.png"
ICON_DIR = ROOT / "extension-tracker" / "icons"

MASTER_SIZE = (1254, 1254)
ICON_SIZES = (16, 32, 48, 128)


def verify_png(path: Path, expected: tuple[int, int]) -> str:
    with Image.open(path) as image:
        image.load()
        size = image.size
        has_alpha = "A" in image.mode
    if size != expected:
        raise RuntimeError(f"{path} has size {size}, expected {expected}")
    if not has_alpha:
        raise RuntimeError(f"{path} has mode without alpha, expected transparency")
    return f"{path.relative_to(ROOT).as_posix()} {size[0]}x{size[1]}"


def main() -> int:
    if not MASTER_ICON.is_file():
        raise RuntimeError(f"missing icon artwork master: {MASTER_ICON.relative_to(ROOT)}")

    with Image.open(MASTER_ICON) as opened:
        opened.load()
        if opened.size != MASTER_SIZE:
            raise RuntimeError(
                f"{MASTER_ICON.relative_to(ROOT)} has size {opened.size}, expected {MASTER_SIZE}"
            )
        if "A" not in opened.mode:
            raise RuntimeError(f"{MASTER_ICON.relative_to(ROOT)} must include transparency")
        master = opened.convert("RGBA")

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in ICON_SIZES:
        target = ICON_DIR / f"icon-{size}.png"
        master.resize((size, size), Image.Resampling.LANCZOS).save(
            target, format="PNG", optimize=True
        )

    for size in ICON_SIZES:
        print(verify_png(ICON_DIR / f"icon-{size}.png", (size, size)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
