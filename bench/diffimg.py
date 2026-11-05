"""diffimg.py DIR A:B[,A:B...] VIEW[,VIEW...]: per pair and view, how DIR/A__VIEW.png and DIR/B__VIEW.png differ
(max channel difference; pixels off by > 2, > 16, > 64), and DIR/diff_A_B__VIEW.png (|a - b| x 8) where they differ."""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

d, pairs, views = Path(sys.argv[1]), sys.argv[2].split(","), sys.argv[3].split(",")
for pair in pairs:
    a, b = pair.split(":")
    for v in views:
        pa, pb = d / f"{a}__{v}.png", d / f"{b}__{v}.png"
        if not (pa.exists() and pb.exists()):
            print(f"{a} vs {b} {v}: missing"); continue
        x = np.asarray(Image.open(pa).convert("RGB"), dtype=np.int16)
        y = np.asarray(Image.open(pb).convert("RGB"), dtype=np.int16)
        e = np.abs(x - y).max(axis=2)
        n = e.size
        print(f"{a:>6} vs {b:<6} {v:<6} max {int(e.max()):3d}  >2: {np.count_nonzero(e > 2) / n * 100:7.4f} %  "
              f">16: {np.count_nonzero(e > 16) / n * 100:7.4f} %  >64: {np.count_nonzero(e > 64)} px")
        if e.max() > 2:
            Image.fromarray(np.clip(e * 8, 0, 255).astype(np.uint8)).save(d / f"diff_{a}_{b}__{v}.png")
