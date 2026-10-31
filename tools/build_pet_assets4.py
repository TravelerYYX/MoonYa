# -*- coding: utf-8 -*-
"""
芙宁娜桌宠素材构建（第五批·修正版）
修正要点：
- 正面底图：仅对「头层完全不透明」的区域做修补，半透明过渡区保留原图
  → 底+头合成与原图逐像素一致，无灰线无拖影。
- 侧图走路帧：腿部蒙版硬边（膝部无渐隐），旋转采用「预乘 alpha 旋转」，
  消除半透明灰斑；前/后小腿 ±16° 交替，两帧循环。
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


def vertical_fade(mask, y_from, y_to):
    arr = np.asarray(mask).astype(np.float32)
    ramp = np.clip((y_to - np.arange(H)) / max(1, (y_to - y_from)), 0.0, 1.0)
    ramp = np.where(np.arange(H) <= y_from, 1.0, ramp)
    arr *= ramp[:, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


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


def content_bbox(img_f):
    ys, xs = np.where(img_f[..., 3] > 0.04)
    return xs.min(), ys.min(), xs.max(), ys.max()


def shift_image(img_f, dx, dy):
    out = np.zeros_like(img_f)
    x0, x1 = max(0, dx), min(W, W + dx)
    y0, y1 = max(0, dy), min(H, H + dy)
    sx0, sx1 = max(0, -dx), min(W, W - dx)
    sy0, sy1 = max(0, -dy), min(H, H - dy)
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = img_f[sy0:sy1, sx0:sx1]
    return out


def rotate_layer(layer_f, angle_deg, pivot):
    """预乘 alpha 旋转（WPF 顺时针为正），避免透明黑像素污染边缘"""
    a = layer_f[..., 3:4]
    prem = np.concatenate([layer_f[..., :3] * a, a], axis=2)
    pil = Image.fromarray((np.clip(prem, 0, 1) * 255).astype(np.uint8), "RGBA")
    rot = pil.rotate(angle_deg, resample=Image.BICUBIC, center=pivot)
    rf = np.asarray(rot).astype(np.float32) / 255.0
    ra = rf[..., 3:4]
    rgb = rf[..., :3] / np.maximum(ra, 1e-6)
    return np.concatenate([np.clip(rgb, 0, 1), ra], axis=2)


# ═══════════ 1. 正面底+头 ═══════════
def split_exact(img, mask_f):
    """无损拆分：head = img*mask，base 调整 alpha 使 head OVER base == img（逐像素）。
    alpha-over 下简单按比例拆两层会丢失不透明度（f=0.5 时合成 alpha 只有 0.75），
    透出色在桌面上就是灰痕；正确解：ba = a(1-f)/(1-f*a)。"""
    a = img[..., 3]
    ha = mask_f * a
    ba = np.where(ha > 0.999, 0.0, a * (1 - mask_f) / np.maximum(1 - ha, 1e-6))
    base = img.copy()
    base[..., 3] = np.clip(ba, 0, 1)
    head = img.copy()
    head[..., 3] = ha
    return base, head


def build_front():
    head_ellipse = ellipse_mask(470, 360, 435, 385)
    strip_l = vertical_fade(rrect_mask(228, 640, 400, 830, 40), 740, 830)
    strip_r = vertical_fade(rrect_mask(548, 640, 720, 830, 40), 740, 830)
    head_mask = blur(union(head_ellipse, strip_l, strip_r))
    head_f = to_f(head_mask)

    img = load("main.png")
    base, head = split_exact(img, head_f)
    save(base, "pet_base.png")
    save(head, "pet_head.png")
    # 闭眼/闭嘴头层：同一蒙版、同一 alpha，颜色取自对应立绘
    for src_name, out_name in (("闭眼.png", "pet_head_ec.png"), ("闭嘴.png", "pet_head_mc.png")):
        hv = load(src_name)
        hv[..., 3] = head[..., 3]
        save(hv, out_name)

    comp = over(over(np.zeros_like(img), base), head)
    white = np.ones_like(img); white[..., :3] = 1
    comp_w = over(white, comp)
    orig_w = over(white, img)
    diff = np.abs(comp_w[..., :3] - orig_w[..., :3]).mean()
    adiff = np.abs(comp_w[..., 3] - orig_w[..., 3]).mean()
    print(f"front composite diff: rgb={diff:.6f} alpha={adiff:.6f}")

    box = (280, 720, 660, 940)
    p1 = Image.fromarray((np.clip(orig_w, 0, 1) * 255).astype(np.uint8), "RGBA").crop(box)
    p2 = Image.fromarray((np.clip(comp_w, 0, 1) * 255).astype(np.uint8), "RGBA").crop(box)
    canvas = Image.new("RGBA", (p1.width * 2 + 10, p1.height), (245, 246, 250, 255))
    canvas.paste(p1, (0, 0), p1)
    canvas.paste(p2, (p1.width + 10, 0), p2)
    canvas.save(CHECK_DIR / "chest_recheck2.png")
    print("chest recheck saved")


# ═══════════ 2. 侧面图 + 走路帧 ═══════════
TARGET_CX, TARGET_BOTTOM = 472, 1522
PIVOT_Y = 1205         # 髋部支点（裙摆下缘之下，整条腿从这里摆）
LEG_TOP, LEG_BOT = 1205, 1565


def leg_column_range(img_f, y0, y1):
    band = img_f[y0:y1, :, 3] > 0.12
    cols = np.where(band.any(axis=0))[0]
    return (cols.min(), cols.max()) if len(cols) else None


def build_side(src_name, stem, facing):
    s = load(src_name)
    x0, y0, x1, y1 = content_bbox(s)
    dx = int(round(TARGET_CX - (x0 + x1) / 2))
    dy = int(round(TARGET_BOTTOM - y1))
    s = shift_image(s, dx, dy)

    ar, ag, ab, aa = s[..., 0], s[..., 1], s[..., 2], s[..., 3]

    # 裙摆下缘：整行深蓝像素数 > 200 的最后一行（吊袜带/鞋子太窄不会被误判），
    # 切口紧贴裙摆下缘，摆腿接缝藏在裙摆线处
    navy = ((ab - ar) > 0.25) & (aa > 0.5)
    row_cnt = navy[:, x0:x1].sum(axis=1)
    skirt_rows = np.where((row_cnt > 200) & (np.arange(H) < 1300))[0]
    skirt_bottom = int(skirt_rows.max()) if len(skirt_rows) else 1100
    cut_y = min(skirt_bottom + 2, 1180)
    pivot_y = cut_y + 12

    rng = leg_column_range(s, cut_y, 1530)
    if rng is None:
        print(f"  !! {src_name} 未找到腿部像素，只输出静态图")
        save(s, f"{stem}.png")
        return None
    lx0, lx1 = rng
    mid = (lx0 + lx1) // 2
    pad = 14
    if facing == 'R':
        front_box = (mid - 6, cut_y, lx1 + pad, LEG_BOT)
        back_box = (lx0 - pad, cut_y, mid + 6, LEG_BOT)
    else:
        front_box = (lx0 - pad, cut_y, mid + 6, LEG_BOT)
        back_box = (mid - 6, cut_y, lx1 + pad, LEG_BOT)

    # 皮肤(白袜)/鞋袜判定：皮肤与白袜 R 高，鞋子吊袜带深蓝 B-R 大
    solid_rule = (aa > 0.9) & ((ar > 0.8) | ((ab - ar) > 0.25))

    def leg_mask(box):
        m = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(m)
        d.rectangle(box, fill=255)
        solid = (solid_rule * 255).astype(np.uint8)
        solid = np.asarray(Image.fromarray(solid).filter(ImageFilter.MaxFilter(3)))
        m = Image.fromarray(np.minimum(np.asarray(m), solid))
        return blur(m, 1.5)

    fm = to_f(leg_mask(front_box))
    bm = to_f(leg_mask(back_box))
    fm_eff = np.clip(fm - bm, 0, 1)

    leg_f = s * fm_eff[..., None]
    leg_b = s * bm[..., None]

    base = s * (1.0 - np.clip(fm_eff + bm, 0, 1)[..., None])
    # 注意：腿洞不做颜色修补！膝下全是透明背景，腿移开后露出的就应该是透明，
    # 修补反而会在两腿之间留下灰糊色块。
    # 两腿之间的灰蓝薄纱碎屑从底图抹掉（不切进腿层的内容也不留在原地）
    tulle_zone = np.zeros((H, W), bool)
    tulle_zone[cut_y:1530, lx0 - pad:lx1 + pad] = True
    tulle = tulle_zone & (base[..., 3] > 0.04) & ~solid_rule
    base[tulle] = 0

    knee_front = ((front_box[0] + front_box[2]) // 2, pivot_y)
    knee_back = ((back_box[0] + back_box[2]) // 2, pivot_y)

    SWING = 12
    frames = []
    for fa, ba in ((SWING, -SWING), (-SWING, SWING)):
        canvas = base.copy()
        canvas = over(canvas, rotate_layer(leg_b, ba, knee_back))
        canvas = over(canvas, rotate_layer(leg_f, fa, knee_front))
        frames.append(canvas)

    save(frames[0], f"{stem}_a.png")
    save(frames[1], f"{stem}_b.png")
    save(s, f"{stem}.png")
    print(f"  {src_name}: legs x{lx0}-{lx1} mid={mid} shift=({dx},{dy}) skirt_bottom={skirt_bottom} cut_y={cut_y}")
    return frames


def main():
    build_front()
    fr = build_side("侧面-右.png", "pet_side_r", 'R')
    fl = build_side("侧面-左.png", "pet_side_l", 'L')

    if fr and fl:
        box = (330, 1150, 660, 1600)
        panels = []
        for f in (fr[0], fr[1], fl[0], fl[1]):
            arr = (np.clip(over(np.ones_like(f) * np.array([1, 1, 1, 1], np.float32), f), 0, 1) * 255).astype(np.uint8)
            panels.append(Image.fromarray(arr, "RGBA").crop(box))
        Wp = sum(p.width for p in panels) + 30
        Hp = panels[0].height
        canvas = Image.new("RGBA", (Wp, Hp), (245, 246, 250, 255))
        x = 0
        for p in panels:
            canvas.paste(p, (x, 0), p)
            x += p.width + 10
        canvas.save(CHECK_DIR / "walk_frames_check.png")
        print("walk frames check saved")


if __name__ == "__main__":
    main()
