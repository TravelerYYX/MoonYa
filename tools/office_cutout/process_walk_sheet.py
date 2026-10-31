from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from PIL import Image

CHROMA_HELPER = Path(r"C:\Users\Administrator\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = Path(args.input)
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    targets: list[Path] = []
    with Image.open(source) as image:
        rgba = image.convert("RGBA")
        frame_width = rgba.width // 4
        for index in range(4):
            left = index * frame_width
            # Image generation may return a canvas whose width is not exactly
            # divisible by four. Keep every runtime frame byte-for-byte the
            # same size and discard only the trailing 1-3 px of chroma matte.
            right = (index + 1) * frame_width
            frame = rgba.crop((left, 0, right, rgba.height))
            chroma = output / f"{args.agent}-{index + 1}-chroma.png"
            target = output / f"{args.agent}-{index + 1}.png"
            frame.save(chroma, format="PNG", optimize=True)
            subprocess.run(
                [
                    sys.executable,
                    str(CHROMA_HELPER),
                    "--input", str(chroma),
                    "--out", str(target),
                    "--auto-key", "corners",
                    "--soft-matte",
                    "--transparent-threshold", "18",
                    "--opaque-threshold", "110",
                    "--spill-cleanup",
                    "--edge-contract", "1",
                    "--edge-feather", "0.6",
                    "--force",
                ],
                check=True,
            )
            targets.append(target)

    # Generated poses can differ by a few transparent pixels at the bottom.
    # Align the visible heel baseline without changing the runtime canvas size.
    processed: list[Image.Image] = []
    bottoms: list[int] = []
    for target in targets:
        with Image.open(target) as frame:
            processed_frame = frame.convert("RGBA")
        processed.append(processed_frame)
        bbox = processed_frame.getchannel("A").getbbox()
        bottoms.append(bbox[3] if bbox else processed_frame.height)
    baseline = max(bottoms)
    for target, frame, bottom in zip(targets, processed, bottoms):
        offset_y = baseline - bottom
        if offset_y:
            aligned = Image.new("RGBA", frame.size, (0, 0, 0, 0))
            aligned.alpha_composite(frame, (0, offset_y))
            aligned.save(target, format="PNG", optimize=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
