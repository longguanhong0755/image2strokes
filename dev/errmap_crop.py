import sys, struct
from PIL import Image
# 用法: python dev/errmap_crop.py src.raw out.rgb x y w h scale out.png
src, fin, x, y, w, h, sc, out = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:8]), sys.argv[8]
with open(src, 'rb') as f:
    W = struct.unpack('<i', f.read(4))[0]; H = struct.unpack('<i', f.read(4))[0]
    data = f.read()
a = Image.frombytes('RGBA', (W, H), data[:W*H*4]).convert('RGB')
b = Image.frombytes('RGB', (W, H), open(fin, 'rb').read()[:W*H*3])
pa, pb = a.load(), b.load()
err = Image.new('RGB', (W, H), (255, 255, 255))
pe = err.load()
n8 = n20 = 0
for yy in range(y, y+h):
    for xx in range(x, x+w):
        d = max(abs(pa[xx,yy][k]-pb[xx,yy][k]) for k in range(3))
        if d > 8: n8 += 1
        if d > 20: n20 += 1
        pe[xx,yy] = (255,0,0) if d > 20 else ((255,170,0) if d > 8 else (235,235,235))
box = (x, y, x+w, y+h)
imgs = [a.crop(box).resize((w*sc,h*sc), Image.NEAREST),
        b.crop(box).resize((w*sc,h*sc), Image.NEAREST),
        err.crop(box).resize((w*sc,h*sc), Image.NEAREST)]
sheet = Image.new('RGB', (w*sc*3+16, h*sc), (255,0,255))
for i,im in enumerate(imgs): sheet.paste(im, (i*(w*sc+8), 0))
sheet.save(out)
print(out, '原图 | 成品 | 误差(红>20 橙>8)  err>8:', n8, ' err>20:', n20, ' 占', round(n8/(w*h)*100,2), '%')
