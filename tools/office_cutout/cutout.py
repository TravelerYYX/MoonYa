# -*- coding: utf-8 -*-
"""Build the nine transparent office character cutouts from the labelled source image."""
from __future__ import annotations

import argparse
import io
import os
import sys

from PIL import Image
from rembg import new_session, remove

SRC = r"C:\Users\Administrator\Desktop\T\哓觅资源\Agent头像\2.png"
OUT_DIR = r"D:\Project\Project\MoonYa\MoonYa-Backend\assets\office"
TARGET_HEIGHT = 768

# Labels in the supplied source, left to right.
AGENTS = ["image", "search", "file", "moonya", "voice", "app", "browser", "code", "computer"]
# Hand-measured source bounds. Dresses and hair are wider than the badge-based
# equal columns, so each character gets an overlapping crop before segmentation.
CROPS = {
    "image": (0, 250),
    "search": (205, 445),
    "file": (405, 625),
    "moonya": (570, 820),
    "voice": (760, 1015),
    "app": (950, 1170),
    "browser": (1110, 1345),
    "code": (1270, 1495),
    "computer": (1410, 1672),
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inset", type=float, default=0.015)
    parser.add_argument("--src", default=SRC)
    parser.add_argument("--out", default=OUT_DIR)
    parser.add_argument("--model", default="u2net")
    args = parser.parse_args()

    if not os.path.isfile(args.src):
        print(f"[ERR] source image does not exist: {args.src}")
        return 1
    os.makedirs(args.out, exist_ok=True)

    photo = Image.open(args.src).convert("RGBA")
    width, height = photo.size
    print(f"[INFO] source: {width}x{height}")
    session = new_session(args.model)

    for key in AGENTS:
        left, right = CROPS[key]
        left = max(0, left)
        right = min(width, right)
        block = photo.crop((left, 0, right, height))
        payload = io.BytesIO()
        block.save(payload, format="PNG")
        result = remove(
            payload.getvalue(),
            session=session,
            alpha_matting=True,
            alpha_matting_foreground_threshold=235,
            alpha_matting_background_threshold=20,
            alpha_matting_erode_size=8,
        )
        person = Image.open(io.BytesIO(result)).convert("RGBA")
        bbox = person.getbbox()
        if bbox:
            person = person.crop(bbox)
        ratio = TARGET_HEIGHT / max(1, person.height)
        person = person.resize((max(1, round(person.width * ratio)), TARGET_HEIGHT), Image.Resampling.LANCZOS)
        # Preserve soft hair/dress edges while dropping invisible RGB noise.
        alpha = person.getchannel("A")
        person.putalpha(alpha.point(lambda value: 0 if value < 3 else value))
        output = os.path.join(args.out, f"{key}.png")
        person.save(output, format="PNG", optimize=True)
        print(f"[OK] {key}: {person.width}x{person.height}")

    print(f"[DONE] {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
