"""lod_appstore.py FOUND_DIR OUT_DIR [COPIES]: a stand-in for the app's damage store (damage.py's damage.json + damage.bin)
made of the finds, for timing the app's path while its real store is empty: one item per find (and per copy), grouped by
class; copy k > 0 is the find moved by k * 3 mm in x and y (distinct points over the same damage, as a denser store).
No photos. Load it with ?damage=<OUT_DIR relative to the page>/&found=none/."""
import json, sys
from pathlib import Path
import numpy as np

src, dst, copies = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 1
found = json.loads((src / "found.json").read_text())["items"]
names = ["Crack", "Rust"]
pts, items, classes, start = [], [], [], 0
for c, name in enumerate(names):
    mine = [f for f in found if f["class"] == name]
    c0 = start
    for f in mine:
        a = np.fromfile(src / f"{f['id']}.bin", np.float32).reshape(-1, 3).astype(np.float64)
        for k in range(copies):
            p = a + np.array([k * 0.003, k * 0.003, 0.0])
            items.append({"c": c, "id": len(items) + 1, "s": start, "n": len(p), "m": f.get("m"),
                          "b": [round(float(v), 3) for v in (*p.min(0), *p.max(0))], "p": []})
            pts.append(p); start += len(p)
    classes.append({"name": name, "voxel": 0.005 if name == "Crack" else 0.01, "measure": "length" if name == "Crack" else "area",
                    "start": c0, "count": start - c0, "items": len(mine) * copies, "total": 0})
P = np.concatenate(pts)
lo, hi = P.min(0) - 0.001, P.max(0) + 0.001
q = np.round((P - lo) / (hi - lo) * 65535).clip(0, 65535).astype("<u2")
dst.mkdir(parents=True, exist_ok=True)
(dst / "damage.bin").write_bytes(q.tobytes())
doc = {"format": 1, "box": [float(v) for v in (*lo, *hi)], "points": int(len(P)), "classes": classes, "photos": [], "items": items}
(dst / "damage.json").write_text(json.dumps(doc, separators=(",", ":")))
print(f"{len(P):,} points, {len(items)} items -> {dst}")
