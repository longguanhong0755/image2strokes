"""rgb → png。带 W,H 头的直接用；不带的按同名 .raw 的尺寸。用法: python dev/raw2png.py a.rgb b.png [...]"""
import sys, struct, os
from PIL import Image
for i in range(1, len(sys.argv), 2):
    src, dst = sys.argv[i], sys.argv[i+1]
    d = open(src, 'rb').read()
    w, h = struct.unpack('<ii', d[:8])
    if len(d) == 8 + w*h*3:
        body = d[8:]
    else:
        cand = src.replace('.rgb', '.raw')
        if os.path.exists(cand):
            r = open(cand, 'rb').read(8)
            w, h = struct.unpack('<ii', r)
            body = d
        else:
            raise SystemExit('need size: ' + src)
    Image.frombytes('RGB', (w, h), body).save(dst)
    print(dst, w, h)
