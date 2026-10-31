# -*- coding: utf-8 -*-
"""模拟 WPF 渲染新步态：±14° 髋部摆动 + 前迈腿抬起 + ±10° 摆手 + 身体起伏"""
from PIL import Image
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "MoonYa-Win" / "MoonYa-Solution" / "MoonYa" / "Assets"
OUT = ROOT / "资源" / "pet_walk_check2.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = 941, 1672
SCALE = H / 200.0  # WPF 显示盒高 200 → 原图像素换算

# 支点（与 XAML RenderTransformOrigin 对应的原图坐标）
PIVOT_LEG_L = (390, 1140)
PIVOT_LEG_R = (548, 1140)
PIVOT_ARM_L = (180, 705)
PIVOT_ARM_R = (770, 705)

def transform(layer, angle_deg, pivot, ty_disp):
    """WPF: 绕 pivot 顺时针旋转 angle，再在画布空间平移 ty（显示单位）"""
    # WPF 顺时针 = PIL 逆时针取负
    img = layer.rotate(angle_deg, resample=Image.BICUBIC, center=pivot)
    if ty_disp:
        shifted = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shifted.paste(img, (0, int(ty_disp * SCALE)), img)
        img = shifted
    return img

def compose(s):
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    leg_l = transform(layers["pet_leg_l"],  s * 14, PIVOT_LEG_L, -s * 7 if s > 0 else 0)
    leg_r = transform(layers["pet_leg_r"], -s * 14, PIVOT_LEG_R,  s * 7 if s < 0 else 0)
    arm_l = transform(layers["pet_arm_l"], -s * 10, PIVOT_ARM_L, 0)
    arm_r = transform(layers["pet_arm_r"],  s * 10, PIVOT_ARM_R, 0)
    for img in (leg_l, leg_r, layers["pet_base"], arm_l, arm_r, layers["pet_head"]):
        canvas.alpha_composite(img)
    # PetTranslate.Y = -|s|*3（整体起伏）
    bob = int(-abs(s) * 3 * SCALE)
    final = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    final.paste(canvas, (0, bob), canvas)
    # PetTurnScale.ScaleX = 0.72（伪侧身，绕底部中心 0.5,1 压扁）
    sw = int(W * 0.72)
    squashed = final.resize((sw, H), Image.LANCZOS)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(squashed, ((W - sw) // 2, 0), squashed)
    return out

layers = {k: Image.open(ASSETS / f"{k}.png").convert("RGBA")
          for k in ("pet_leg_l", "pet_leg_r", "pet_base", "pet_arm_l", "pet_arm_r", "pet_head")}

frames = [("s=+1", compose(1)), ("s=0", compose(0)), ("s=-1", compose(-1))]

# 缩放到高 420 并横向拼接
th = 420
tw = int(W * th / H)
bg = Image.new("RGBA", (tw * 3 + 40, th + 60), (240, 244, 252, 255))
from PIL import ImageDraw
d = ImageDraw.Draw(bg)
for i, (label, im) in enumerate(frames):
    im = im.resize((tw, th), Image.LANCZOS)
    x = i * (tw + 10) + 10
    bg.paste(im, (x, 10), im)
    d.text((x + tw // 2 - 15, th + 25), label, fill=(40, 60, 120, 255))
bg.convert("RGB").save(OUT)
print("saved:", OUT)
