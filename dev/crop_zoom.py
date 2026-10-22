import sys, struct, os
from PIL import Image
# 用法: python dev/crop_zoom.py src.raw out.rgb x y w h scale out.png
src, fin, x, y, w, h, sc, out = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:8]), sys.argv[8]
with open(src, 'rb') as f:
    W = struct.unpack('<i', f.read(4))[0]; H = struct.unpack('<i', f.read(4))[0]
    data = f.read()
a = Image.frombytes('RGBA', (W, H), data[:W*H*4]).convert('RGB')   # 源 raw 是 RGBA
fb = open(fin, 'rb').read()
b = Image.frombytes('RGB', (W, H), fb[:W*H*3])                     # 成品是 RGB
box = (x, y, x + w, y + h)
ca = a.crop(box).resize((w*sc, h*sc), Image.NEAREST)
cb = b.crop(box).resize((w*sc, h*sc), Image.NEAREST)
sheet = Image.new('RGB', (w*sc*2 + 8, h*sc), (255, 0, 255))
sheet.paste(ca, (0, 0)); sheet.paste(cb, (w*sc + 8, 0))
sheet.save(out)
print(out, sheet.size, 'left=原图 right=成品')
