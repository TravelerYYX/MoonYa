# -*- coding: utf-8 -*-
"""
芙宁娜桌宠素材构建（第二批）
输入：资源/new_assets/{main,闭眼,闭嘴,侧面-左,侧面-右}.png （均 941x1672）
输出到 MoonYa/Assets：
  pet_base/pet_head/pet_arm_l/pet_arm_r/pet_leg_l/pet_leg_r —— 由 main.png 切割
  pet_head_ec.png —— 闭眼版头层（眨眼帧切换）
  pet_head_mc.png —— 闭嘴版头层（说话帧切换）
  pet_side_l.png / pet_side_r.png —— 侧面全身（内容重新居中、脚底对齐 main 基线）
校验图输出到 资源/：pet_layers_check.png / pet_face_states.png / pet_side_check.png
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


def dilate(mask_bool, px):
    m = Image.fromarray((mask_bool * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(px * 2 + 1))
    return np.asarray(m) > 127


def smooth_zone(img_f, zone_bool, blur_r=6.0, margin=12):
    zone = dilate(zone_bool, margin)
    arr = (np.clip(img_f, 0, 1) * 255).astype(np.uint8)
    blurred = np.asarray(Image.fromarray(arr, "RGBA").filter(ImageFilter.GaussianBlur(blur_r))).astype(np.float32) / 255.0
    return np.where(zone[..., None], blurred, img_f)


def apply_mask(img_f, mask_f):
    return img_f * mask_f[..., None]


def remove_mask(img_f, mask_f):
    return img_f * (1.0 - mask_f[..., None])


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


def content_bbox(img_f):
    ys, xs = np.where(img_f[..., 3] > 0.04)
    return xs.min(), ys.min(), xs.max(), ys.max()


def shift_image(img_f, dx, dy):
    """平移（透明填充）。dx>0 右移，dy>0 下移。"""
    out = np.zeros_like(img_f)
    x0, x1 = max(0, dx), min(W, W + dx)
    y0, y1 = max(0, dy), min(H, H + dy)
    sx0, sx1 = max(0, -dx), min(W, W - dx)
    sy0, sy1 = max(0, -dy), min(H, H - dy)
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = img_f[sy0:sy1, sx0:sx1]
    return out


def main():
    # ── 蒙版（与第一版切割一致）──
    head_ellipse = ellipse_mask(470, 360, 435, 385)
    head_strip_l = rrect_mask(228, 640, 400, 800, 40)
    head_strip_r = rrect_mask(548, 640, 720, 800, 40)
    neck_zone = rrect_mask(415, 690, 550, 798, 28)
    head_mask = blur(union(head_ellipse, head_strip_l, head_strip_r))
    head_inpaint_zone = blur(union(head_strip_l, head_strip_r, neck_zone), 3)
    head_inpaint_zone = Image.fromarray(
        np.minimum(np.asarray(head_inpaint_zone), np.asarray(head_mask)))

    arm_l_mask = blur(rrect_mask(55, 690, 300, 1140, 35))
    arm_r_mask = blur(rrect_mask(578, 690, 820, 1140, 35))
    leg_l_mask = blur(rrect_mask(320, 1130, 458, 1662, 25))
    leg_r_mask = blur(rrect_mask(480, 1130, 618, 1662, 25))
    head_f = to_f(head_mask)

    # ── 1. main.png → 六层 ──
    img = load("main.png")
    arm_l = apply_mask(img, to_f(arm_l_mask))
    arm_r = apply_mask(img, to_f(arm_r_mask))
    leg_l = apply_mask(img, to_f(leg_l_mask))
    leg_r = apply_mask(img, to_f(leg_r_mask))
    head = apply_mask(img, head_f)

    base = remove_mask(img, head_f)
    base = remove_mask(base, to_f(arm_l_mask))
    base = remove_mask(base, to_f(arm_r_mask))
    base = remove_mask(base, to_f(leg_l_mask))
    base = remove_mask(base, to_f(leg_r_mask))
    arm_hole = (np.maximum(to_f(arm_l_mask), to_f(arm_r_mask)) > 0.02)
    base = inpaint(base, arm_hole)
    base = smooth_zone(base, arm_hole, blur_r=8.0, margin=12)
    head_zone_hole = (to_f(head_inpaint_zone) > 0.02)
    base = inpaint(base, head_zone_hole)
    base = smooth_zone(base, head_zone_hole, blur_r=8.0, margin=12)
    spill = (head_f - to_f(head_inpaint_zone)) > 0.5
    base[spill] *= np.asarray([1, 1, 1, 0], dtype=np.float32)
    base = remove_mask(base, to_f(leg_l_mask))
    base = remove_mask(base, to_f(leg_r_mask))

    save(base, "pet_base.png")
    save(head, "pet_head.png")
    save(arm_l, "pet_arm_l.png")
    save(arm_r, "pet_arm_r.png")
    save(leg_l, "pet_leg_l.png")
    save(leg_r, "pet_leg_r.png")

    # 复原校验
    comp = np.zeros_like(img)
    for layer in (leg_l, leg_r, base, arm_l, arm_r, head):
        comp = over(comp, layer)
    white = np.ones_like(img); white[..., :3] = 1
    comp_w = over(white, comp)
    orig_w = over(white, img)
    diff = np.abs(comp_w[..., :3] - orig_w[..., :3]).mean()
    print(f"composite vs main mean abs diff: {diff:.5f}")
    side = np.concatenate([
        (np.clip(orig_w, 0, 1) * 255).astype(np.uint8),
        (np.clip(comp_w, 0, 1) * 255).astype(np.uint8)], axis=1)
    Image.fromarray(side, "RGBA").save(CHECK_DIR / "pet_layers_check.png")

    # ── 2. 闭眼 / 闭嘴头层（帧切换用，只切头层，四肢保持 main 版）──
    head_ec = apply_mask(load("闭眼.png"), head_f)
    head_mc = apply_mask(load("闭嘴.png"), head_f)
    save(head_ec, "pet_head_ec.png")
    save(head_mc, "pet_head_mc.png")

    # 面部三态预览（合成到 main 的身体上，裁头部区域）
    face_box = (100, 80, 840, 900)
    previews = []
    for hv in (head, head_ec, head_mc):
        comp2 = np.zeros_like(img)
        for layer in (leg_l, leg_r, base, arm_l, arm_r, hv):
            comp2 = over(comp2, layer)
        cw = over(np.ones_like(img) * np.array([1, 1, 1, 1], np.float32), comp2)
        arr = (np.clip(cw, 0, 1) * 255).astype(np.uint8)
        previews.append(Image.fromarray(arr, "RGBA").crop(face_box))
    pw = sum(p.width for p in previews) + 20
    ph = previews[0].height
    canvas = Image.new("RGBA", (pw, ph), (240, 244, 252, 255))
    x = 0
    for p in previews:
        canvas.paste(p, (x, 0), p)
        x += p.width + 10
    canvas.save(CHECK_DIR / "pet_face_states.png")

    # ── 3. 侧面图重居中（中心 x → 472，脚底 → 1522）──
    TARGET_CX, TARGET_BOTTOM = 472, 1522
    side_out = {}
    for src_name, out_name in (("侧面-左.png", "pet_side_l.png"), ("侧面-右.png", "pet_side_r.png")):
        s = load(src_name)
        x0, y0, x1, y1 = content_bbox(s)
        dx = int(round(TARGET_CX - (x0 + x1) / 2))
        dy = int(round(TARGET_BOTTOM - y1))
        s2 = shift_image(s, dx, dy)
        side_out[out_name] = s2
        save(s2, out_name)
        print(f"  {src_name} bbox=({x0},{y0},{x1},{y1}) shift=({dx},{dy})")

    # 侧图校验（与 main 并排）
    mains = (np.clip(over(np.ones_like(img) * np.array([1, 1, 1, 1], np.float32), img), 0, 1) * 255).astype(np.uint8)
    panels = [Image.fromarray(mains, "RGBA")]
    for k in ("pet_side_l.png", "pet_side_r.png"):
        sw = over(np.ones_like(img) * np.array([1, 1, 1, 1], np.float32), side_out[k])
        panels.append(Image.fromarray((np.clip(sw, 0, 1) * 255).astype(np.uint8), "RGBA"))
    pw = W * 3 + 20
    canvas = Image.new("RGBA", (pw, H), (240, 244, 252, 255))
    x = 0
    for p in panels:
        canvas.paste(p, (x, 0), p)
        x += W + 10
    canvas.resize((pw // 2, H // 2), Image.LANCZOS).save(CHECK_DIR / "pet_side_check.png")
    print("check images saved to", CHECK_DIR)


if __name__ == "__main__":
    main()
