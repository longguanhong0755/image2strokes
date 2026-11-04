"""生成更多示例图（全部自绘，CC0）。

产出（samples/）：
  sample-4.jpg  插画2：山湖日落（纯平涂色块）
  sample-5.jpg  插画3：窗台植物（平涂 + 深色勾线）
  sample-6.jpg  照片2：晨雾山谷（多层大气透视 + 雾 + 颗粒）
  sample-7.jpg  照片3：窗边静物（浅景深 + 柔光）
  sample-8.jpg  海报2：FLY（复古航空海报）
  sample-9.jpg  海报3：COFFEE（暗底几何海报）

用法：python -I dev/make_samples_more.py
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples")
FONT_DIR = "C:/Windows/Fonts"


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def vgrad(w, h, stops):
    """竖向渐变。stops = [(t, (r,g,b)), ...]，t=0 顶部。"""
    ys = np.linspace(0, 1, h, dtype=np.float32)
    pos = np.array([s[0] for s in stops], dtype=np.float32)
    col = np.array([s[1] for s in stops], dtype=np.float32)
    out = np.zeros((h, 3), dtype=np.float32)
    for c in range(3):
        out[:, c] = np.interp(ys, pos, col[:, c])
    img = np.repeat(out[:, None, :], w, axis=1)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def radial(w, h, cx, cy, rad, color, power=1.6, gain=1.0):
    """径向光晕（加到画面上）。"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / max(1.0, rad)
    a = np.clip(1 - d, 0, 1) ** power * gain
    layer = np.zeros((h, w, 3), dtype=np.float32)
    for c in range(3):
        layer[:, :, c] = color[c] * a
    return layer, a


def grain(img, amp=4.0, seed=1):
    rng = np.random.default_rng(seed)
    a = np.asarray(img, dtype=np.float32)
    n = rng.normal(0, amp, (a.shape[0], a.shape[1], 1))
    a = a + n
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def vignette(img, strength=0.28, power=2.2):
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx - w / 2) / (w / 2)
    ny = (yy - h / 2) / (h / 2)
    r = np.clip(np.sqrt(nx * nx + ny * ny) / 1.414, 0, 1)
    k = (1 - strength * r ** power)[:, :, None]
    a = np.asarray(img, dtype=np.float32) * k
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


# ---------------------------------------------------------------- 插画 2
def illustration_lake():
    W, H = 1024, 1024
    img = vgrad(W, H, [(0.0, (255, 214, 150)), (0.45, (255, 186, 138)),
                       (0.62, (246, 160, 132)), (0.63, (120, 96, 140)),
                       (1.0, (58, 62, 104))])
    d = ImageDraw.Draw(img, "RGBA")
    # 太阳
    d.ellipse([W / 2 - 150, 372 - 150, W / 2 + 150, 372 + 150], fill=(255, 226, 150))
    d.ellipse([W / 2 - 112, 372 - 112, W / 2 + 112, 372 + 112], fill=(255, 240, 186))
    # 云（平涂条）
    for (x, y, ww, hh, c) in [(120, 210, 260, 34, (255, 205, 172)),
                              (620, 160, 300, 30, (255, 198, 165)),
                              (330, 300, 220, 26, (255, 218, 186)),
                              (700, 330, 190, 22, (255, 208, 176))]:
        d.rounded_rectangle([x, y, x + ww, y + hh], radius=hh / 2, fill=c)
    # 远山（三层，颜色越远越浅）
    def ridge(base, peaks, color):
        pts = [(0, H)]
        for x, y in peaks:
            pts.append((x, y))
        pts += [(W, H)]
        d.polygon(pts, fill=color)

    ridge(0, [(-20, 560), (90, 486), (210, 540), (330, 470), (470, 532),
              (600, 452), (740, 520), (880, 474), (1044, 540)], (196, 138, 156))
    ridge(0, [(-20, 616), (120, 548), (250, 604), (390, 534), (520, 596),
              (660, 528), (800, 592), (950, 540), (1044, 588)], (150, 104, 132))
    ridge(0, [(-20, 664), (150, 612), (300, 656), (450, 596), (600, 650),
              (760, 600), (900, 646), (1044, 616)], (96, 72, 108))
    # 湖面（平涂横条 + 太阳倒影）
    for i, (y0, y1, c) in enumerate([(664, 730, (86, 88, 128)), (730, 812, (72, 78, 118)),
                                     (812, 902, (62, 68, 108)), (902, 1024, (50, 56, 94))]):
        d.rectangle([0, y0, W, y1], fill=c)
    for i in range(9):
        ww = 300 - i * 26
        yy = 690 + i * 26
        d.rounded_rectangle([W / 2 - ww / 2, yy, W / 2 + ww / 2, yy + 10],
                            radius=5, fill=(255, 214, 152, 190))
    for i in range(7):
        xx = 90 + i * 140
        yy = 760 + (i % 3) * 46
        d.rounded_rectangle([xx, yy, xx + 96, yy + 7], radius=3, fill=(120, 118, 152))
    # 前景岸与树
    d.polygon([(0, 940), (0, 1024), (300, 1024), (190, 962), (60, 936)], fill=(30, 36, 58))
    for (x, y, r) in [(120, 862, 64), (196, 892, 46), (60, 900, 40)]:
        d.polygon([(x - r * 0.7, y + r * 1.5), (x, y - r), (x + r * 0.7, y + r * 1.5)],
                  fill=(34, 44, 62))
    for (x, y) in [(410, 210), (448, 196), (486, 214), (760, 260), (792, 244)]:
        d.arc([x - 16, y - 8, x + 16, y + 12], 200, 340, fill=(92, 70, 96), width=4)
    img = grain(img, 2.2, 41)
    img.save(os.path.join(OUT, "sample-4.jpg"), quality=90)


# ---------------------------------------------------------------- 插画 3
def illustration_plant():
    W, H = 1024, 1024
    img = Image.new("RGB", (W, H), (246, 232, 214))
    d = ImageDraw.Draw(img, "RGBA")
    # 墙面装饰圆
    d.ellipse([-180, 120, 420, 720], fill=(240, 219, 198))
    d.ellipse([700, 60, 1180, 540], fill=(238, 216, 196))
    # 窗
    d.rectangle([96, 90, 560, 620], fill=(214, 236, 240), outline=(74, 60, 52), width=8)
    d.rectangle([320, 90, 336, 620], fill=(74, 60, 52))
    d.rectangle([96, 344, 560, 360], fill=(74, 60, 52))
    d.rectangle([120, 114, 300, 320], fill=(186, 222, 232))
    d.rectangle([356, 114, 536, 320], fill=(196, 228, 236))
    d.rectangle([120, 384, 300, 596], fill=(172, 214, 226))
    d.rectangle([356, 384, 536, 596], fill=(182, 220, 230))
    # 窗台
    d.rectangle([60, 620, 620, 668], fill=(232, 202, 170), outline=(74, 60, 52), width=7)
    # 桌面
    d.rectangle([0, 668, W, H], fill=(212, 170, 136))
    d.rectangle([0, 668, W, 692], fill=(226, 190, 156))
    # 书堆
    d.rectangle([640, 764, 940, 812], fill=(198, 94, 78), outline=(74, 60, 52), width=6)
    d.rectangle([664, 716, 916, 764], fill=(94, 132, 160), outline=(74, 60, 52), width=6)
    d.rectangle([686, 700, 894, 716], fill=(240, 226, 196), outline=(74, 60, 52), width=5)
    # 花盆
    d.polygon([(300, 690), (470, 690), (450, 850), (320, 850)], fill=(206, 122, 96),
              outline=(74, 60, 52), width=6)
    d.rectangle([288, 676, 482, 704], fill=(222, 140, 110), outline=(74, 60, 52), width=6)
    d.polygon([(320, 704), (450, 704), (444, 760), (326, 760)], fill=(232, 160, 128))
    # 植物（平涂叶片）
    stems = [(-10, -220), (-80, -180), (70, -200), (140, -150), (-150, -120), (200, -90)]
    for dx, dy in stems:
        x0, y0 = 385, 690
        x1, y1 = 385 + dx, 690 + dy
        d.line([x0, y0, x1, y1], fill=(70, 112, 76), width=8)
        ang = math.atan2(y1 - y0, x1 - x0)
        cxx, cyy = (x0 + x1) / 2, (y0 + y1) / 2
        L, Wd = 86, 40
        pts = []
        for t, hw in [(-0.5, 0), (-0.25, Wd / 2), (0.25, Wd / 2), (0.5, 0)]:
            pts.append((cxx + math.cos(ang) * L * t - math.sin(ang) * hw,
                        cyy + math.sin(ang) * L * t + math.cos(ang) * hw))
        pts.append((x1, y1))
        d.polygon(pts, fill=(118, 164, 116), outline=(70, 112, 76), width=5)
    for (x, y, r, c) in [(300, 470, 40, (226, 138, 120)), (420, 450, 32, (240, 196, 108)),
                         (500, 520, 26, (226, 138, 120)), (250, 540, 24, (240, 196, 108))]:
        d.ellipse([x - r, y - r, x + r, y + r], fill=c, outline=(74, 60, 52), width=5)
        d.ellipse([x - r * 0.35, y - r * 0.35, x + r * 0.35, y + r * 0.35], fill=(255, 240, 200))
    # 杯子
    d.rounded_rectangle([740, 640, 860, 700], radius=14, fill=(250, 246, 236), outline=(74, 60, 52), width=6)
    d.arc([852, 652, 900, 690], 270, 90, fill=(74, 60, 52), width=6)
    d.ellipse([740, 630, 860, 654], fill=(226, 216, 200), outline=(74, 60, 52), width=5)
    img = grain(img, 1.6, 7)
    img.save(os.path.join(OUT, "sample-5.jpg"), quality=90)


# ---------------------------------------------------------------- 照片 2
def _ridge_mask(W, H, base, amp, rng, phase):
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    pts = [(0, H)]
    x = -40
    y = H * base
    while x < W + 80:
        y = H * base + math.sin(x * 0.006 + phase) * amp + rng.normal(0, amp * 0.35)
        pts.append((x, y))
        x += rng.uniform(70, 150)
    pts += [(W + 80, H)]
    md.polygon(pts, fill=255)
    return m


def _shade(mask, W, H, top, bot, y0, y1, blur=1.4):
    """按 mask 铺一层竖向渐变（顶部 top → 底部 bot）。"""
    ys = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    k = np.clip((ys * H - y0) / max(1.0, y1 - y0), 0, 1)
    col = (np.array(top, np.float32)[None, None, :] * (1 - k[:, :, None]) +
           np.array(bot, np.float32)[None, None, :] * k[:, :, None])
    layer = Image.fromarray(np.clip(np.repeat(col, W, axis=1), 0, 255).astype(np.uint8), "RGB")
    m = mask.filter(ImageFilter.GaussianBlur(blur))
    return layer, m


def photo_misty_valley():
    W, H = 1024, 683
    img = vgrad(W, H, [(0.0, (88, 118, 162)), (0.30, (150, 170, 192)),
                       (0.48, (226, 202, 178)), (0.60, (244, 224, 196)),
                       (1.0, (198, 192, 184))])
    rng = np.random.default_rng(12)
    layers = [
        (0.43, (186, 196, 210), (150, 162, 184), 0.30, 26),
        (0.50, (170, 180, 198), (132, 144, 168), 0.52, 42),
        (0.58, (146, 156, 180), (104, 116, 144), 0.70, 60),
        (0.67, (112, 122, 148), (76, 86, 112), 0.84, 78),
        (0.77, (74, 82, 104), (44, 50, 70), 0.95, 96),
    ]
    for li, (base, ctop, cbot, _al, amp) in enumerate(layers):
        mask = _ridge_mask(W, H, base, amp, rng, li * 1.7)
        layer, m = _shade(mask, W, H, ctop, cbot, H * (base - 0.06), H * (base + 0.22), 1.2)
        img = Image.composite(layer, img, m)
        # 山脊前的雾带
        fog = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fog)
        fy = H * base + amp * 0.25
        for k in range(9):
            a = int(110 * (1 - k / 9))
            fd.rectangle([0, fy - 20 + k * 8, W, fy + 8 + k * 8], fill=(246, 238, 226, a))
        fog = fog.filter(ImageFilter.GaussianBlur(16))
        img = Image.alpha_composite(img.convert("RGBA"), fog).convert("RGB")
    # 太阳光晕（画在山脊之后、树之前）
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt((xx - W * 0.68) ** 2 + (yy - H * 0.44) ** 2) / (W * 0.5)
    a = np.clip(1 - d, 0, 1) ** 2.2 * 0.75
    arr = np.asarray(img, np.float32) + a[:, :, None] * np.array([150, 128, 96], np.float32)
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img, "RGBA")
    # 前景树影
    for (x, s) in [(80, 1.0), (150, 0.72), (930, 0.9), (870, 0.6)]:
        h0 = 150 * s
        d.rectangle([x - 4 * s, H - h0, x + 5 * s, H], fill=(32, 38, 50))
        for k in range(7):
            yy2 = H - h0 + k * h0 / 7
            ww = (70 - k * 8) * s
            d.ellipse([x - ww, yy2 - 18 * s, x + ww, yy2 + 20 * s], fill=(38, 46, 58, 235))
    # 空气感：轻微失焦 + 颗粒 + 暗角
    img = img.filter(ImageFilter.GaussianBlur(0.7))
    img = grain(img, 3.2, 21)
    img = vignette(img, 0.30, 2.0)
    img.save(os.path.join(OUT, "sample-6.jpg"), quality=90)


# ---------------------------------------------------------------- 照片 3
def photo_still_life():
    W, H = 1024, 768
    img = vgrad(W, H, [(0.0, (210, 194, 180)), (0.50, (190, 172, 158)),
                       (0.68, (154, 128, 110)), (1.0, (104, 84, 70))])
    # 窗光：斜向柔和光斑
    light = Image.new("L", (W, H), 0)
    ld = ImageDraw.Draw(light)
    ld.polygon([(120, 0), (430, 0), (700, H), (390, H)], fill=210)
    ld.polygon([(470, 0), (540, 0), (810, H), (740, H)], fill=150)
    light = light.filter(ImageFilter.GaussianBlur(64))
    arr = np.asarray(img, np.float32)
    lm = np.asarray(light, np.float32)[:, :, None] / 255.0
    arr = arr + lm * np.array([50, 38, 22], np.float32)
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    # 背景大形（强失焦）
    bg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    bd.rectangle([0, 470, W, 570], fill=(122, 98, 80, 255))
    bd.ellipse([600, 140, 1030, 630], fill=(82, 68, 60, 180))
    for (x, y, r, c) in [(700, 240, 78, (92, 108, 78)), (830, 190, 60, (104, 120, 86)),
                         (910, 310, 86, (86, 102, 74)), (760, 350, 64, (98, 114, 80))]:
        bd.ellipse([x - r, y - r, x + r, y + r], fill=c + (150,))
    bg = bg.filter(ImageFilter.GaussianBlur(26))
    img = Image.alpha_composite(img.convert("RGBA"), bg).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")
    # 桌面 + 桌布
    d.rectangle([0, 560, W, H], fill=(128, 94, 70))
    d.rectangle([0, 556, W, 572], fill=(156, 118, 88))
    d.polygon([(0, 612), (520, 600), (600, 768), (0, 768)], fill=(228, 216, 198))
    # 花瓶：mask + 渐变 + 高光
    vm = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vm)
    vd.ellipse([300, 330, 470, 620], fill=255)
    vd.rectangle([360, 300, 410, 380], fill=255)
    vd.ellipse([352, 282, 418, 318], fill=255)
    vmask = vm.filter(ImageFilter.GaussianBlur(0.8))
    ys = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    xs = np.linspace(0, 1, W, dtype=np.float32)[None, :]
    base = np.array([182, 164, 152], np.float32)
    shade = (0.78 + 0.30 * (1 - xs) - 0.18 * ys)
    varr = np.clip(base[None, None, :] * shade[:, :, None], 0, 255).astype(np.uint8)
    vimg = Image.fromarray(np.repeat(varr, 1, axis=0), "RGB")
    img = Image.composite(vimg, img, vmask)
    # 高光条
    hl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([334, 372, 372, 556], fill=(238, 228, 214, 120))
    hl = hl.filter(ImageFilter.GaussianBlur(7))
    img = Image.alpha_composite(img.convert("RGBA"), hl).convert("RGB")
    # 花与叶（柔边、多层）
    fl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fl)
    for (x, y, r, c) in [(338, 246, 54, (188, 78, 70)), (412, 206, 48, (212, 116, 92)),
                         (466, 274, 42, (172, 66, 66)), (372, 300, 36, (226, 152, 116)),
                         (298, 298, 32, (204, 100, 88))]:
        fd.ellipse([x - r, y - r, x + r, y + r], fill=c + (238,))
        fd.ellipse([x - r * 0.55, y - r * 0.6, x + r * 0.1, y - r * 0.1],
                   fill=tuple(min(255, v + 26) for v in c) + (150,))
    for (x, y, ww, hh) in [(296, 328, 96, 28), (438, 338, 100, 26), (348, 358, 74, 22)]:
        fd.ellipse([x, y, x + ww, y + hh], fill=(92, 120, 80, 225))
    fl = fl.filter(ImageFilter.GaussianBlur(2.6))
    img = Image.alpha_composite(img.convert("RGBA"), fl).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")
    # 杯与书（前景略实）
    d.ellipse([640, 556, 832, 640], fill=(226, 214, 196))
    d.rectangle([640, 600, 832, 700], fill=(216, 204, 186))
    d.ellipse([640, 678, 832, 722], fill=(204, 192, 174))
    d.arc([790, 608, 882, 692], 250, 110, fill=(204, 192, 174), width=18)
    d.rectangle([118, 598, 424, 662], fill=(138, 74, 66))
    d.rectangle([138, 556, 404, 602], fill=(162, 96, 84))
    # 柔焦 + 颗粒 + 暗角
    img = img.filter(ImageFilter.GaussianBlur(1.1))
    img = grain(img, 3.0, 33)
    img = vignette(img, 0.34, 1.9)
    img.save(os.path.join(OUT, "sample-7.jpg"), quality=90)


# ---------------------------------------------------------------- 海报 2
def poster_fly():
    W, H = 900, 1200
    img = Image.new("RGB", (W, H), (240, 226, 200))
    d = ImageDraw.Draw(img, "RGBA")
    # 纸纹
    img = grain(img, 2.6, 3)
    d = ImageDraw.Draw(img, "RGBA")
    # 深蓝天空块
    d.rectangle([56, 56, W - 56, 720], fill=(30, 58, 96))
    # 太阳
    d.ellipse([210, 300, 690, 780], fill=(226, 88, 60))
    d.ellipse([250, 340, 650, 740], fill=(238, 120, 78))
    # 飞机剪影
    plane = [(470, 250), (560, 330), (760, 372), (762, 404), (566, 396),
             (500, 470), (452, 470), (470, 396), (330, 392), (330, 366), (470, 360)]
    d.polygon(plane, fill=(24, 30, 36))
    # 尾翼
    d.polygon([(452, 470), (410, 512), (452, 512), (500, 470)], fill=(24, 30, 36))
    # 大标题
    f1 = font("ariblk.ttf", 210)
    d.text((W / 2, 900), "FLY", font=f1, fill=(30, 58, 96), anchor="mm")
    f2 = font("georgiab.ttf", 54)
    d.text((W / 2, 1030), "THE  SKY  MAIL", font=f2, fill=(146, 56, 44), anchor="mm")
    f3 = font("georgia.ttf", 30)
    d.text((W / 2, 1100), "FIRST TO ARRIVE  ·  FIRST TO BE READ", font=f3, fill=(70, 60, 48), anchor="mm")
    # 外框
    d.rectangle([30, 30, W - 30, H - 30], outline=(146, 56, 44), width=8)
    d.rectangle([46, 46, W - 46, H - 46], outline=(70, 60, 48), width=2)
    img.save(os.path.join(OUT, "sample-8.jpg"), quality=90)


# ---------------------------------------------------------------- 海报 3
def poster_coffee():
    W, H = 900, 1200
    img = Image.new("RGB", (W, H), (42, 30, 26))
    img = grain(img, 2.4, 9)
    d = ImageDraw.Draw(img, "RGBA")
    # 米色圆盘
    d.ellipse([110, 170, 790, 850], fill=(238, 222, 194))
    d.ellipse([140, 200, 760, 820], outline=(196, 138, 84), width=6)
    # 咖啡杯
    d.polygon([(330, 430), (570, 430), (540, 640), (360, 640)], fill=(96, 56, 40))
    d.ellipse([330, 406, 570, 458], fill=(226, 204, 172))
    d.ellipse([344, 414, 556, 450], fill=(62, 40, 30))
    d.arc([560, 470, 700, 590], 280, 100, fill=(96, 56, 40), width=26)
    # 热气
    for dx in (-40, 20, 80):
        d.arc([430 + dx - 22, 300, 430 + dx + 22, 400], 250, 40, fill=(196, 160, 120), width=7)
    # 标题
    f1 = font("impact.ttf", 168)
    d.text((W / 2, 940), "COFFEE", font=f1, fill=(238, 222, 194), anchor="mm")
    f2 = font("georgiab.ttf", 28)
    d.text((W / 2, 1050), "FRESHLY  ROASTED  EVERY  MORNING", font=f2, fill=(196, 138, 84), anchor="mm")
    # 装饰线
    d.rectangle([120, 1100, 780, 1106], fill=(196, 138, 84))
    for i in range(5):
        cx = 450 + (i - 2) * 62
        d.ellipse([cx - 7, 1136, cx + 7, 1150], fill=(196, 138, 84))
    d.rectangle([40, 40, W - 40, H - 40], outline=(196, 138, 84), width=4)
    img.save(os.path.join(OUT, "sample-9.jpg"), quality=90)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    illustration_lake()
    illustration_plant()
    photo_misty_valley()
    photo_still_life()
    poster_fly()
    poster_coffee()
    print("samples written to", OUT)
