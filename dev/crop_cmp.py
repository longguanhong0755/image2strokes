# 局部放大对照：原图 | 成品（最近邻放大，看像素级差别）
# 用法: python dev/crop_cmp.py dev/s3.raw canvas.rgb x0 y0 x1 y1 scale out.png
import sys, struct
from PIL import Image

raw, canvas = sys.argv[1], sys.argv[2]
x0, y0, x1, y1, scale = map(int, sys.argv[3:8])
out = sys.argv[8]

w, h = struct.unpack('<ii', open(raw, 'rb').read(8))
orig = Image.frombytes('RGBA', (w, h), open(raw, 'rb').read()[8:]).convert('RGB')
canv = Image.frombytes('RGB', (w, h), open(canvas, 'rb').read())

o = orig.crop((x0, y0, x1, y1)).resize(((x1 - x0) * scale, (y1 - y0) * scale), Image.NEAREST)
c = canv.crop((x0, y0, x1, y1)).resize(((x1 - x0) * scale, (y1 - y0) * scale), Image.NEAREST)
im = Image.new('RGB', (o.width * 2 + 10, o.height), (255, 255, 255))
im.paste(o, (0, 0))
im.paste(c, (o.width + 10, 0))
im.save(out)
print(out, im.size)
