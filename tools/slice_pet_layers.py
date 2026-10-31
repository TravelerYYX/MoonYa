# -*- coding: utf-8 -*-
"""
芙宁娜桌宠立绘分层切割脚本
将 fnn-q.png (941x1672) 切割为可独立做骨骼动画的图层：
  pet_base  —— 身体+裙子+长头发（挖掉头/手/腿）
  pet_head  —— 头+帽子+脸周短发（挖掉眼睛/嘴巴并扩散修补）
  pet_eye_l / pet_eye_r —— 眼睛（眨眼动画）
  pet_mouth —— 嘴巴（说话动画）
  pet_arm_l / pet_arm_r —— 手臂袖子（散步摆手）
  pet_leg_l / pet_leg_r —— 腿+靴子（散步踏步）
所有图层与原图同尺寸 (941x1672)，直接等比堆叠即可完美复原。
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

SRC = Path(r"D:\Project\Project\MoonYa\MoonYa-Win\MoonYa-Solution\MoonYa\Assets\fnn-q.png")
OUT_DIR = SRC.parent
CHECK_DIR = Path(r"D:\Project\Project\MoonYa\资源")

W, H = 941, 1672
FEATHER = 2  # 蒙版边缘羽化像素


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


def subtract(a, b):
    return Image.fromarray(np.clip(np.asarray(a).astype(int) - np.asarray(b).astype(int), 0, 255).astype(np.uint8))


def blur(m, r=FEATHER):
    return m.filter(ImageFilter.GaussianBlur(r))


def to_f(mask):
    return np.asarray(mask).astype(np.float32) / 255.0


def inpaint(img_f, hole_bool, iters=400):
    """扩散修补：用洞外邻近像素迭代填充洞内颜色/透明度（预乘 alpha 加权）。
    洞外所有像素（含透明背景）都视为 known，使靠近背景的洞缘自然过渡到透明。
    img_f: HxWx4 float32 (0..1)，hole_bool: HxW bool (True=洞)"""
    a = img_f[..., 3:].copy()
    rgb = img_f[..., :3] * a  # 预乘（透明像素自动贡献 0）
    hole = hole_bool.copy()
    known = ~hole
    ys, xs = np.where(hole)
    if len(ys) == 0:
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
    out_rgb = rgb / np.maximum(a, 1e-6)  # 反预乘
    out = np.concatenate([np.clip(out_rgb, 0, 1), a], axis=2)
    return out


def dilate(mask_bool, px):
    m = Image.fromarray((mask_bool * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(px * 2 + 1))
    return np.asarray(m) > 127


def smooth_zone(img_f, zone_bool, blur_r=6.0, margin=12):
    """在指定区域内（含外扩 margin 的过渡环）做局部高斯模糊，消除修补色调接缝。"""
    zone = dilate(zone_bool, margin)
    arr = (np.clip(img_f, 0, 1) * 255).astype(np.uint8)
    blurred = np.asarray(Image.fromarray(arr, "RGBA").filter(ImageFilter.GaussianBlur(blur_r))).astype(np.float32) / 255.0
    return np.where(zone[..., None], blurred, img_f)


def offset_fill(img_f, mask_l, dy, dx=0, feather=4):
    """平移填补：洞内像素取自偏移 (dx, dy) 处的同形区域（保持皮肤纹理/色调连续）。
    mask_l: PIL 灰度蒙版（硬边），dy>0 取下方内容，dx>0 取右方内容。"""
    m = to_f(mask_l.filter(ImageFilter.GaussianBlur(feather)))
    shifted = np.roll(np.roll(img_f, -dy, axis=0), -dx, axis=1)
    return img_f * (1 - m[..., None]) + shifted * m[..., None]


def apply_mask(img_f, mask_f):
    return img_f * mask_f[..., None]


def remove_mask(img_f, mask_f):
    return img_f * (1.0 - mask_f[..., None])


def save(img_f, name):
    arr = (np.clip(img_f, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(arr, "RGBA").save(OUT_DIR / name)
    print(f"  saved {name}")


def main():
    src = Image.open(SRC).convert("RGBA").resize((W, H))
    img = np.asarray(src).astype(np.float32) / 255.0
    print(f"source: {SRC} {src.size}")

    # ── 蒙版定义（基于 941x1672 原图坐标）──
    head_ellipse = ellipse_mask(470, 360, 435, 385)          # 帽子+脸
    head_strip_l = rrect_mask(228, 640, 400, 800, 40)        # 左侧脸周头发
    head_strip_r = rrect_mask(548, 640, 720, 800, 40)        # 右侧脸周头发
    neck_zone = rrect_mask(415, 690, 550, 798, 28)           # 脖子
    head_mask = blur(union(head_ellipse, head_strip_l, head_strip_r))
    # 头洞在 base 中的修补区（头发条+脖子，扩散填实）∩ 头蒙版；其余头洞区域留透明
    head_inpaint_zone = blur(union(head_strip_l, head_strip_r, neck_zone), 3)
    head_inpaint_zone = Image.fromarray(
        np.minimum(np.asarray(head_inpaint_zone), np.asarray(head_mask)))

    arm_l_mask = blur(rrect_mask(55, 690, 300, 1140, 35))
    arm_r_mask = blur(rrect_mask(578, 690, 820, 1140, 35))

    leg_l_mask = blur(rrect_mask(320, 1130, 458, 1662, 25))
    leg_r_mask = blur(rrect_mask(480, 1130, 618, 1662, 25))

    # ── 切出各部件 ──
    arm_l = apply_mask(img, to_f(arm_l_mask))
    arm_r = apply_mask(img, to_f(arm_r_mask))
    leg_l = apply_mask(img, to_f(leg_l_mask))
    leg_r = apply_mask(img, to_f(leg_r_mask))

    # 头层 = 完整头部（保留原版眼睛与嘴巴，面部动画改由用户提供素材后再做）
    head = apply_mask(img, to_f(head_mask))

    # base = 原图 - 头 - 手 - 腿
    base = remove_mask(img, to_f(head_mask))
    base = remove_mask(base, to_f(arm_l_mask))
    base = remove_mask(base, to_f(arm_r_mask))
    base = remove_mask(base, to_f(leg_l_mask))
    base = remove_mask(base, to_f(leg_r_mask))
    # 手臂洞：扩散修补（周围头发/裙子颜色填实，摆手时不露洞）
    arm_hole = (np.maximum(to_f(arm_l_mask), to_f(arm_r_mask)) > 0.02)
    base = inpaint(base, arm_hole)
    base = smooth_zone(base, arm_hole, blur_r=8.0, margin=12)
    # 头洞：仅头发条+脖子区域扩散修补，脸/帽区域保持透明（脑后无内容）
    head_zone_hole = (to_f(head_inpaint_zone) > 0.02)
    base = inpaint(base, head_zone_hole)
    base = smooth_zone(base, head_zone_hole, blur_r=8.0, margin=12)
    # 清掉修补溢出到头洞透明区（脸/帽背后）与腿洞的颜色
    spill = (to_f(head_mask) - to_f(head_inpaint_zone)) > 0.5
    base[spill] *= np.asarray([1, 1, 1, 0], dtype=np.float32)
    base = remove_mask(base, to_f(leg_l_mask))
    base = remove_mask(base, to_f(leg_r_mask))

    # ── 保存 ──
    save(base, "pet_base.png")
    save(head, "pet_head.png")
    save(arm_l, "pet_arm_l.png")
    save(arm_r, "pet_arm_r.png")
    save(leg_l, "pet_leg_l.png")
    save(leg_r, "pet_leg_r.png")
    # 清理已弃用的面部图层
    for old in ("pet_eye_l.png", "pet_eye_r.png", "pet_lid_l.png", "pet_lid_r.png", "pet_mouth.png"):
        p = OUT_DIR / old
        if p.exists():
            p.unlink()
            print(f"  removed old {old}")

    # ── 验证：按 WPF 层序叠加，与原图对比 ──
    def over(dst, src_):
        # alpha over
        sa = src_[..., 3:] 
        da = dst[..., 3:]
        out_a = sa + da * (1 - sa)
        out_rgb = (src_[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(out_a, 1e-6)
        return np.concatenate([out_rgb, out_a], axis=2)

    comp = np.zeros_like(img)
    for layer in (leg_l, leg_r, base, arm_l, arm_r, head):
        comp = over(comp, layer)
    white = np.ones_like(img)
    white[..., :3] = 1
    comp_w = over(white, comp)
    orig_w = over(white, img)
    diff = np.abs(comp_w[..., :3] - orig_w[..., :3]).mean()
    print(f"composite vs original mean abs diff: {diff:.5f}")

    CHECK_DIR.mkdir(exist_ok=True)
    side = np.concatenate([
        (np.clip(orig_w, 0, 1) * 255).astype(np.uint8),
        (np.clip(comp_w, 0, 1) * 255).astype(np.uint8),
    ], axis=1)
    Image.fromarray(side, "RGBA").save(CHECK_DIR / "pet_layers_check.png")
    print(f"check image: {CHECK_DIR / 'pet_layers_check.png'}")


if __name__ == "__main__":
    main()
