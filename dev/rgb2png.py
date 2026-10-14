import sys, struct
from PIL import Image
p, out = sys.argv[1], sys.argv[2]
w = h = None
# 尺寸从同名 raw 推
raw = p.replace('-base.rgb', '.raw').replace('-new.rgb', '.raw')
import os
if os.path.exists(raw):
    with open(raw,'rb') as f:
        w = struct.unpack('<i', f.read(4))[0]; h = struct.unpack('<i', f.read(4))[0]
else:
    raise SystemExit('need raw for size')
data = open(p,'rb').read()
im = Image.frombytes('RGB', (w,h), data)
im.save(out)
print(out, im.size)
