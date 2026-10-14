"""把任意图片转成 dev/*.raw（给 node 测速台用）：前 8 字节 W,H(int32)，其后 RGBA。"""
import sys
from pathlib import Path
import numpy as np, cv2

src, out = sys.argv[1], sys.argv[2]
MAX = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
img = cv2.imdecode(np.fromfile(src, np.uint8), cv2.IMREAD_COLOR)
h, w = img.shape[:2]
if max(h, w) > MAX:
    s = MAX / max(h, w)
    img = cv2.resize(img, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
img = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
with open(out, 'wb') as f:
    f.write(np.array([img.shape[1], img.shape[0]], np.int32).tobytes())
    f.write(img.tobytes())
print(out, img.shape)
