"""生成一张扁平插画示例图（自绘，CC0）：1024x1024，纯色块 + 少量渐变 + 深色勾线。
用途：作为 demo 的"插画"示例，展示纯色平涂笔触的最佳效果。"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

S = 2                      # 超采样倍数
N = 1024
W = N * S

img = Image.new("RGB", (W, W), (255, 255, 255))
d = ImageDraw.Draw(img, "RGBA")

# 背景：柔和的圆形渐变（暖米色 → 淡粉）
bg = Image.new("RGB", (W, W), (255, 255, 255))
bd = ImageDraw.Draw(bg)
for r in range(W, 0, -2):
    t = r / W
    col = (int(252 - 6 * t), int(238 - 26 * t), int(230 - 30 * t))
    bd.ellipse([W / 2 - r / 2, W / 2 - r / 2, W / 2 + r / 2, W / 2 + r / 2], fill=col)
bg = bg.filter(ImageFilter.GaussianBlur(8))
img = Image.blend(img, bg, 1.0)
d = ImageDraw.Draw(img, "RGBA")

INK = (74, 52, 48)
CREAM = (253, 246, 236)
ORANGE = (238, 150, 96)
PINK = (244, 176, 168)
GREEN = (126, 176, 130)

cx, cy = W / 2, W * 0.54


def ell(box, fill, outline=None, width=0):
    d.ellipse([v * S if False else v for v in box], fill=fill, outline=outline, width=width)


# 身体
d.ellipse([cx - 250 * S, cy + 60 * S, cx + 250 * S, cy + 420 * S], fill=CREAM, outline=INK, width=3 * S)
# 耳朵
d.polygon([(cx - 210 * S, cy - 110 * S), (cx - 250 * S, cy - 265 * S), (cx - 78 * S, cy - 196 * S)],
          fill=CREAM, outline=INK, width=3 * S)
d.polygon([(cx + 210 * S, cy - 110 * S), (cx + 250 * S, cy - 265 * S), (cx + 78 * S, cy - 196 * S)],
          fill=CREAM, outline=INK, width=3 * S)
d.polygon([(cx - 196 * S, cy - 132 * S), (cx - 222 * S, cy - 224 * S), (cx - 118 * S, cy - 178 * S)], fill=PINK)
d.polygon([(cx + 196 * S, cy - 132 * S), (cx + 222 * S, cy - 224 * S), (cx + 118 * S, cy - 178 * S)], fill=PINK)
# 头
d.ellipse([cx - 250 * S, cy - 220 * S, cx + 250 * S, cy + 200 * S], fill=CREAM, outline=INK, width=3 * S)
# 额头斑纹
d.ellipse([cx - 120 * S, cy - 210 * S, cx - 20 * S, cy - 120 * S], fill=ORANGE)
d.ellipse([cx + 20 * S, cy - 210 * S, cx + 120 * S, cy - 120 * S], fill=ORANGE)
# 眼睛（闭眼弧线）
d.arc([cx - 170 * S, cy - 60 * S, cx - 40 * S, cy + 40 * S], 200, 340, fill=INK, width=7 * S)
d.arc([cx + 40 * S, cy - 60 * S, cx + 170 * S, cy + 40 * S], 200, 340, fill=INK, width=7 * S)
# 腮红
blush = Image.new("RGB", (W, W), (0, 0, 0))
bl = ImageDraw.Draw(blush)
bl.ellipse([cx - 210 * S, cy + 20 * S, cx - 96 * S, cy + 100 * S], fill=PINK)
bl.ellipse([cx + 96 * S, cy + 20 * S, cx + 210 * S, cy + 100 * S], fill=PINK)
blush = blush.filter(ImageFilter.GaussianBlur(9 * S))
img = Image.composite(Image.blend(img, Image.new("RGB", (W, W), PINK), 0.55), img,
                      blush.convert("L").point(lambda v: 255 if v > 40 else 0))
d = ImageDraw.Draw(img, "RGBA")
# 鼻子 + 嘴
d.polygon([(cx - 34 * S, cy + 62 * S), (cx + 34 * S, cy + 62 * S), (cx, cy + 108 * S)],
          fill=(232, 138, 132), outline=INK, width=2 * S)
d.arc([cx - 66 * S, cy + 96 * S, cx - 6 * S, cy + 156 * S], 350, 160, fill=INK, width=5 * S)
d.arc([cx + 6 * S, cy + 96 * S, cx + 66 * S, cy + 156 * S], 20, 190, fill=INK, width=5 * S)
# 胡须
for k, dy in enumerate((-10, 20, 50)):
    y = cy + 70 * S + dy * S
    d.line([cx - 120 * S, y, cx - 300 * S, y - (24 - k * 22) * S], fill=INK, width=3 * S)
    d.line([cx + 120 * S, y, cx + 300 * S, y - (24 - k * 22) * S], fill=INK, width=3 * S)
# 小装饰：心形、叶子、圆点
def heart(x, y, s, color):
    d.polygon([(x, y + s * 0.75), (x - s, y - s * 0.25), (x - s * 0.45, y - s),
               (x, y - s * 0.35), (x + s * 0.45, y - s), (x + s, y - s * 0.25)], fill=color)


heart(cx - 356 * S, cy - 168 * S, 52 * S, PINK)
heart(cx + 356 * S, cy - 168 * S, 52 * S, (240, 138, 128))
d.ellipse([cx + 250 * S, cy + 300 * S, cx + 430 * S, cy + 400 * S], fill=GREEN)
d.line([cx + 340 * S, cy + 340 * S, cx + 340 * S, cy + 470 * S], fill=(96, 140, 100), width=6 * S)
for (dx, dy, r) in ((-430, 300, 16), (-380, 380, 10), (420, 240, 12), (-300, -320, 14), (300, -330, 9)):
    d.ellipse([cx + (dx - r) * S, cy + (dy - r) * S, cx + (dx + r) * S, cy + (dy + r) * S], fill=ORANGE)

out = img.resize((N, N), Image.LANCZOS)
dest = Path(__file__).resolve().parent.parent / "samples/sample-1.jpg"
out.save(dest, quality=92)
print("wrote", dest, out.size)
