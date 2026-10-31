# -*- coding: utf-8 -*-
"""
芙宁娜桌宠素材构建（第三批·精简化）
散步已改用侧身整图，四肢不再独立运动 → 只切「底图 + 头」两层：
  pet_base —— main.png 仅挖掉头（头洞扩散修补），身体/四肢完整保留，零涂抹
  pet_head / pet_head_ec / pet_head_mc —— 三张正面图的头层（帧切换）
删除旧的手/腿分层文件（pet_arm_*/pet_leg_*），消除修补涂抹异物。
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

SRC_DIR = Path(r"D:\Project\Project\MoonYa\资源\new_assets")
OUT_DIR = Path(r"D:\Project\Project\MoonYa\MoonYa-Win\MoonYa-Solution\MoonYa\Assets")
CHECK_DIR = Path(r"D:\Project\Project\MoonYa\资源")

W, H = 941, 1672
FEATHER = 2


def ellipse_mask(cx, cy, rx, ry):
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    return m


def rrect_mask(x0, y0, x1, y1, r):
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=255)
    return m


def union(*masks):
    out = np.zeros((H, W), dtype=np.uint8)
    for m in masks:
        out = np.maximum(out, np.asarray(m))
    return Image.fromarray(out)


def blur(m, r=FEATHER):
    return m.filter(ImageFilter.GaussianBlur(r))


def to_f(mask):
    return np.asarray(mask).astype(np.float32) / 255.0


def inpaint(img_f, hole_bool, iters=400):
    a = img_f[..., 3:].copy()
    rgb = img_f[..., :3] * a
    hole = hole_bool.copy()
    known = ~hole
    if not hole.any():
        return img_f

    def nbrs(m):
        p = np.pad(m, 1, mode="constant")
        return p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]

    for _ in range(iters):
        if not hole.any():
            break
        kf = known.astype(np.float32)
        ku, kd, kl, kr = nbrs(kf)
        cnt = ku + kd + kl + kr
        grow = hole & (cnt > 0)
        cnt_safe = np.maximum(cnt, 1)
        for ch in range(3):
            v = rgb[..., ch] * kf
            u, d, l, r = nbrs(v)
            rgb[..., ch] = np.where(grow, (u + d + l + r) / cnt_safe, rgb[..., ch])
        v = a[..., 0] * kf
        u, d, l, r = nbrs(v)
        a[..., 0] = np.where(grow, (u + d + l + r) / cnt_safe, a[..., 0])
        known = known | grow
        hole = hole & ~grow
    out_rgb = rgb / np.maximum(a, 1e-6)
    return np.concatenate([np.clip(out_rgb, 0, 1), a], axis=2)


def save(img_f, name):
    arr = (np.clip(img_f, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(arr, "RGBA").save(OUT_DIR / name)
    print(f"  saved {name}")


def load(name):
    im = Image.open(SRC_DIR / name).convert("RGBA")
    assert im.size == (W, H), f"{name} size {im.size}"
    return np.asarray(im).astype(np.float32) / 255.0


def over(dst, src_):
    sa = src_[..., 3:]
    da = dst[..., 3:]
    out_a = sa + da * (1 - sa)
    out_rgb = (src_[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(out_a, 1e-6)
    return np.concatenate([out_rgb, out_a], axis=2)


def main():
    # ── 头部蒙版（与之前一致）──
    head_ellipse = ellipse_mask(470, 360, 435, 385)
    head_strip_l = rrect_mask(228, 640, 400, 800, 40)
    head_strip_r = rrect_mask(548, 640, 720, 800, 40)
    neck_zone = rrect_mask(415, 690, 550, 798, 28)
    head_mask = blur(union(head_ellipse, head_strip_l, head_strip_r))
    head_inpaint_zone = blur(union(head_strip_l, head_strip_r, neck_zone), 3)
    head_inpaint_zone = Image.fromarray(
        np.minimum(np.asarray(head_inpaint_zone), np.asarray(head_mask)))
    head_f = to_f(head_mask)

    img = load("main.png")

    # ── 底图：仅挖头 + 头洞修补（头发条+脖子区域），四肢身体完整保留 ──
    base = img * (1.0 - head_f[..., None])
    head_zone_hole = (to_f(head_inpaint_zone) > 0.02)
    base = inpaint(base, head_zone_hole)
    # 修补溢出到脸/帽背后（透明区）的部分清掉
    spill = (head_f - to_f(head_inpaint_zone)) > 0.5
    base[spill] *= np.asarray([1, 1, 1, 0], dtype=np.float32)
    save(base, "pet_base.png")

    # ── 头层 ×3（帧切换）──
    head = img * head_f[..., None]
    save(head, "pet_head.png")
    save(load("闭眼.png") * head_f[..., None], "pet_head_ec.png")
    save(load("闭嘴.png") * head_f[..., None], "pet_head_mc.png")

    # ── 删除旧四肢分层 ──
    for old in ("pet_arm_l.png", "pet_arm_r.png", "pet_leg_l.png", "pet_leg_r.png"):
        p = OUT_DIR / old
        if p.exists():
            p.unlink()
            print(f"  removed {old}")

    # ── 校验：底+头 复原 vs 原图 ──
    comp = over(over(np.zeros_like(img), base), head)
    white = np.ones_like(img); white[..., :3] = 1
    comp_w = over(white, comp)
    orig_w = over(white, img)
    diff = np.abs(comp_w[..., :3] - orig_w[..., :3]).mean()
    print(f"composite vs main mean abs diff: {diff:.5f}")

    # 异物区域复检图（原异物区域 x0-340 y900-1300 的复原对比）
    box = (0, 900, 340, 1300)
    p1 = Image.fromarray((np.clip(orig_w, 0, 1) * 255).astype(np.uint8), "RGBA").crop(box)
    p2 = Image.fromarray((np.clip(comp_w, 0, 1) * 255).astype(np.uint8), "RGBA").crop(box)
    canvas = Image.new("RGBA", (p1.width * 2 + 10, p1.height), (245, 246, 250, 255))
    canvas.paste(p1, (0, 0), p1)
    canvas.paste(p2, (p1.width + 10, 0), p2)
    canvas.save(CHECK_DIR / "pet_blob_recheck.png")
    print("recheck image:", CHECK_DIR / "pet_blob_recheck.png")


if __name__ == "__main__":
    main()
