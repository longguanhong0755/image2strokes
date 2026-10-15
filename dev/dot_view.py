# 把"小点"放大出来看：每个坐标给出 原图 / 成品 的 48x48 放大对比（成品上红框标出该点）
# 用法: python dev/dot_view.py dev/s1.raw dev/aa.rgb dev/s1-dots.png 279,617 267,502 ...
import sys, struct
from PIL import Image, ImageDraw

raw_p, rgb_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
spots = []
for a in sys.argv[4:]:
    x, y = a.split(',')
    spots.append((int(x), int(y)))

with open(raw_p, 'rb') as f:
    w = struct.unpack('<i', f.read(4))[0]; h = struct.unpack('<i', f.read(4))[0]
    px = f.read(w * h * 4)
tgt = Image.frombytes('RGBA', (w, h), px).convert('RGB')
res = Image.frombytes('RGB', (w, h), open(rgb_p, 'rb').read())

R = 24; Z = 8
tiles = []
for (cx, cy) in spots:
    x0 = max(0, min(w - 2 * R, cx - R)); y0 = max(0, min(h - 2 * R, cy - R))
    t = tgt.crop((x0, y0, x0 + 2 * R, y0 + 2 * R)).resize((2 * R * Z, 2 * R * Z), Image.NEAREST)
    r = res.crop((x0, y0, x0 + 2 * R, y0 + 2 * R)).resize((2 * R * Z, 2 * R * Z), Image.NEAREST)
    d = ImageDraw.Draw(r)
    bx = (cx - x0) * Z; by = (cy - y0) * Z
    d.rectangle([bx - Z, by - Z, bx + 2 * Z, by + 2 * Z], outline=(255, 0, 0), width=2)
    d.text((6, 6), f'{cx},{cy}', fill=(255, 0, 0))
    tiles.append((t, r))

W = 2 * R * Z + 8
H = (2 * R * Z) * 2 + 24
sheet = Image.new('RGB', (W * len(tiles), H), (30, 30, 30))
for i, (t, r) in enumerate(tiles):
    sheet.paste(t, (i * W, 16))
    sheet.paste(r, (i * W, 16 + 2 * R * Z + 16))
sheet.save(out_p)
print(out_p, sheet.size, len(tiles), '个点（上=原图，下=成品）')
