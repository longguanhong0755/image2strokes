import sys, struct
from PIL import Image
# 形状差异图：把源图和成品都按"是不是奶油色"二值化，看形状差在哪
# 用法: python dev/shapediff.py src.raw out.rgb x y w h scale out.png
src, fin, x, y, w, h, sc, out = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:8]), sys.argv[8]
with open(src, 'rb') as f:
    W = struct.unpack('<i', f.read(4))[0]; H = struct.unpack('<i', f.read(4))[0]
    data = f.read()
a = Image.frombytes('RGBA', (W, H), data[:W*H*4]).convert('RGB')
b = Image.frombytes('RGB', (W, H), open(fin, 'rb').read()[:W*H*3])
pa, pb = a.load(), b.load()
def iscream(c):
    return 1 if (c[0] > 150 and c[1] > 140 and c[2] > 110) else 0
out_im = Image.new('RGB', (W, H))
po = out_im.load()
nA = nB = 0
for yy in range(y, y+h):
    for xx in range(x, x+w):
        s = iscream(pa[xx,yy]); f2 = iscream(pb[xx,yy])
        if s and f2: po[xx,yy] = (215, 215, 215)
        elif not s and not f2: po[xx,yy] = (255, 255, 255)
        elif s and not f2: po[xx,yy] = (255, 0, 0); nA += 1      # 源是奶油、成品丢了 = 被啃掉
        else: po[xx,yy] = (0, 90, 255); nB += 1                  # 源不是奶油、成品是 = 画多了
box = (x, y, x+w, y+h)
sheet = Image.new('RGB', (w*sc*2+8, h*sc), (255,0,255))
sheet.paste(a.crop(box).resize((w*sc,h*sc), Image.NEAREST), (0,0))
sheet.paste(out_im.crop(box).resize((w*sc,h*sc), Image.NEAREST), (w*sc+8,0))
sheet.save(out)
print(out, '被啃掉(源奶油→成品丢)', nA, ' 画多了(源非奶油→成品奶油)', nB)
