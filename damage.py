# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""lynceus's damage store -> out/damage/, the static files the viewer's damage panel loads: the points the app shows,
one item per (class, cluster) with its crack length or area, and JPEG crops of each item's 1-3 best photos.

    python damage.py [content_dir] [photos_json]   # defaults: SELINF_REPO's content of WORK/job_params.json's project

damage.bin: uint16 LE xyz per point, p = box_min + v / 65535 * (box_max - box_min), metres, source frame (Z-up),
  grouped by class, then item. damage.json: box, classes (start, count, items, total), photos, items (c class, id
  cluster, s start, n count, m metres | m², b box, p [[photo, x0, y0, x1, y1], ...] = the damage's box in its crop,
  fractions). img/<item>_<pick>.jpg: the crops. Built in out/damage.tmp, swapped in when complete.
"""
import gzip, hashlib, json, os, shutil, struct, sys, time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
REPO = Path(os.environ.get("SELINF_REPO", "C:/dev/lynceus"))
WORK = Path(os.environ.get("SELINF_WORK", ROOT / "job"))
OUT = ROOT / "out" / "damage"
COLORS = {"Crack": "#FF2D2D", "ExposedRebars": "#FF8A00", "Rust": "#FF2DAF", "Spalling": "#FFD60A",   # lynceus
          "Wetspot": "#00E5FF", "Cavity": "#7CFF00", "Efflorescence": "#C42DFF"}                     # theme.ts
RECORD = np.dtype([("asset", "<u4"), ("px", "<f4"), ("py", "<f4"), ("conf", "<f4")])   # points_sources.bin
PICKS, MIN_GAIN = 3, 0.10              # photos per item; a later pick must add >= 10 % of the item's points
PAD, MIN_PAD, MIN_CROP, MAX_SIDE = 0.25, 48, 384, 1024   # crop: padding (of the longer side, px), size (px)
Image.MAX_IMAGE_PIXELS = None


def voxel_of(head, name):
    return float(head.get("bake_voxel_size_m_by_class", {}).get(name, head["bake_voxel_size_m"]))


def load(content):
    head = json.loads((content / "points.json").read_text())
    n, raw = head["point_count"], np.memmap(content / "points.bin", np.uint8, "r")
    arr = {k: np.frombuffer(raw, a["dtype"], int(np.prod(a["shape"])), a["offset"]).reshape(a["shape"])
           for k, a in head["arrays"].items()}
    bits = np.unpackbits(np.fromfile(content / "point_rejected.bin", np.uint8), bitorder="little")[:n]
    hidden = np.zeros(n, bool)   # what the app hides: rejected + unattributed
    hidden[:bits.size] = bits
    return head, arr, hidden


def items_of(head, arr, hidden, viewer):
    """The visible points' indices grouped by item ((class, cluster) ascending, index order inside), and per item
    its class, cluster, start and count in that order."""
    cls, cl = arr["class_id"], arr["cluster_id"]
    by = viewer.get("min_votes_by_class", {})
    votes = np.array([by.get(c, viewer.get("min_votes", 0)) for c in head["class_names"]])
    vis = ~hidden & (cl >= 0) & (arr["votes"] >= votes[cls]) & (arr["confidence"] >= viewer.get("min_confidence", 0))
    idx = np.flatnonzero(vis)
    key = cls[idx].astype(np.int64) << 32 | cl[idx]
    order = np.argsort(key, kind="stable")
    uk, starts, counts = np.unique(key[order], return_index=True, return_counts=True)
    return idx[order], uk >> 32, uk & 0xFFFFFFFF, starts, counts


def crack_lengths(head, arr, hidden, content):
    """{cluster: metres | None} from lynceus's piece table (crack_lengths.piece_key: the cluster's not-hidden points as
    stored, not y-negated, in index order)."""
    path = content / "crack_lengths.json"
    if "Crack" not in head["class_names"] or not path.exists():
        return {}
    table = json.loads(path.read_text())
    tag, voxel = f"v{table['algo_version']}|", voxel_of(head, "Crack")
    idx = np.flatnonzero((arr["class_id"] == head["class_names"].index("Crack")) & (arr["cluster_id"] >= 0) & ~hidden)
    idx = idx[np.argsort(arr["cluster_id"][idx], kind="stable")]
    u, s = np.unique(arr["cluster_id"][idx], return_index=True)
    out = {}
    for cid, a, b in zip(u.tolist(), s.tolist(), np.append(s[1:], idx.size).tolist()):
        pos = np.ascontiguousarray(arr["position"][idx[a:b]], np.float32)
        key = f"{tag}{voxel:.9f}|{b - a}|".encode("ascii") + pos.tobytes()
        out[cid] = table["pieces"].get(hashlib.sha1(key).hexdigest())
    return out


def sources(content, pts, photo_of):
    """The provenance records of points `pts`, in that order: (position in pts, photos.json index, px, py, conf);
    records of photos not in photos.json are dropped."""
    raw = np.memmap(content / "points_sources.bin", np.uint8, "r")
    magic, version, count, nrec, tlen = struct.unpack_from("<4sIIII", raw, 0)
    assert magic == b"LYPS" and version == 1, (magic, version)
    lut = np.array([photo_of.get(a, -1) for a in json.loads(bytes(raw[20:20 + tlen]))] + [-1])
    off = np.frombuffer(raw, "<u4", count + 1, 20 + tlen).astype(np.int64)
    off = np.append(off, np.full(max(0, pts.max(initial=0) + 1 - count), off[-1]))   # pen points past its end: none
    lo, k = off[pts], off[pts + 1] - off[pts]
    first = np.repeat(np.cumsum(k) - k, k)
    rec = np.frombuffer(raw, RECORD, nrec, 20 + tlen + 4 * (count + 1))[np.repeat(lo, k) + np.arange(k.sum()) - first]
    owner, ph = np.repeat(np.arange(pts.size), k), lut[np.minimum(rec["asset"], lut.size - 1)]
    keep = ph >= 0
    return owner[keep], ph[keep], rec["px"][keep], rec["py"][keep], rec["conf"][keep]


def picks(owner, ph, px, py, conf, starts, counts):
    """Per item [(photo, x0, y0, x1, y1)]: the photo that sourced most of its points (ties: summed conf), then the
    one adding the most uncovered points, while it adds >= MIN_GAIN of them; boxes = its records' pixel bbox."""
    rs, re = np.searchsorted(owner, starts), np.searchsorted(owner, starts + counts)
    out = []
    for s, n, a, b in zip(starts, counts, rs, re):
        u, inv = np.unique(ph[a:b], return_inverse=True)
        if not u.size:
            out.append([])
            continue
        pair = np.unique((owner[a:b] - s) * u.size + inv)   # (point, photo), once each
        pp, pf = pair // u.size, pair % u.size
        sel = [np.lexsort((np.bincount(inv, conf[a:b], u.size), np.bincount(pf, minlength=u.size)))[-1]]
        covered = np.zeros(n, bool)
        while True:
            covered[pp[pf == sel[-1]]] = True
            gain = np.bincount(pf[~covered[pp]], minlength=u.size)
            if len(sel) == PICKS or gain.max() < MIN_GAIN * n:
                break
            sel.append(gain.argmax())
        x, y = px[a:b], py[a:b]
        out.append([(int(u[g]), float(x[inv == g].min()), float(y[inv == g].min()), float(x[inv == g].max()),
                     float(y[inv == g].max())) for g in sel])
    return out


def crop_box(b, W, H):
    """The damage's pixel box padded, grown to MIN_CROP (centred), shifted into the photo where it fits, clipped."""
    pad, box = max(PAD * max(b[2] - b[0], b[3] - b[1]), MIN_PAD), []
    for a0, a1, L in ((b[0], b[2], W), (b[1], b[3], H)):
        grow = max(0, MIN_CROP - (a1 - a0 + 2 * pad)) / 2 + pad
        a0, a1 = a0 - grow, a1 + grow
        shift = max(0, -a0) - max(0, a1 - L)
        box.append((max(0, round(a0 + shift)), min(L, round(a1 + shift))))
    return box[0][0], box[1][0], box[0][1], box[1][1]


def crop_photo(job):
    """One photo's crops, decoded once (at 1/2, 1/4 or 1/8 when every crop shrinks at least that much) ->
    ([the damage's box in each crop, fractions], missing, EXIF-rotated)."""
    path, crops = job
    try:
        im = Image.open(path)
    except FileNotFoundError:
        im = None
    W, H = im.size if im else (1 << 30, 1 << 30)   # missing: the boxes as if the photo had no edges
    boxes = [crop_box(b, W, H) for _, b in crops]
    fracs = [[round(min(1, max(0, (v - c[i % 2]) / (c[2 + i % 2] - c[i % 2]))), 4) for i, v in enumerate(b)]
             for (_, b), c in zip(crops, boxes)]
    if im is None:
        return fracs, True, False
    shrink = min(max(c[2] - c[0], c[3] - c[1]) for c in boxes) / MAX_SIDE
    s = max(s for s in (1, 2, 4, 8) if s <= max(shrink, 1))
    if s > 1:
        im.draft("RGB", (-(-W // s), -(-H // s)))
    sx, sy = W / im.size[0], H / im.size[1]
    rotated = im.getexif().get(0x0112, 1) != 1   # px/py are raw pixels; a rotated photo would need its turn
    im = im.convert("RGB")
    for (out, _), c in zip(crops, boxes):
        w, h = c[2] - c[0], c[3] - c[1]
        k = min(1, MAX_SIDE / max(w, h))
        im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS,
                  box=(c[0] / sx, c[1] / sy, c[2] / sx, c[3] / sy)).save(out, quality=80, optimize=True)
    return fracs, False, rotated


def main():
    t, clock = {}, time.perf_counter()

    def phase(name):
        nonlocal clock
        t[name], clock = time.perf_counter() - clock, time.perf_counter()

    if len(sys.argv) > 1:
        content = Path(sys.argv[1])
    else:
        params = json.loads((WORK / "job_params.json").read_text())
        content = REPO / "data" / "projects" / params["project_id"] / "content"
    photos = json.loads(Path(sys.argv[2] if len(sys.argv) > 2 else WORK / "photos.json").read_text())
    photo_of = {p["sha256"]: i for i, p in enumerate(photos)}
    head, arr, hidden = load(content)
    viewer = json.loads((content / "viewer.json").read_text())
    names = head["class_names"]
    phase("load")

    idx, ic, icl, starts, counts = items_of(head, arr, hidden, viewer)
    lengths = crack_lengths(head, arr, hidden, content)
    src = arr["position"][idx].astype(np.float64)
    if head.get("handedness_fix") == "negate_y":
        src[:, 1] *= -1
    lo, hi = np.floor(src.min(0) * 1000) / 1000, np.ceil(src.max(0) * 1000) / 1000   # the mm box, quantised against
    q = np.round((src - lo) / np.maximum(hi - lo, 1e-9) * 65535).astype("<u2")
    bmin, bmax = np.minimum.reduceat(src, starts), np.maximum.reduceat(src, starts)
    phase("items")

    best = picks(*sources(content, idx, photo_of), starts, counts)
    used = sorted({p[0] for ps in best for p in ps})
    slot = {ph: j for j, ph in enumerate(used)}
    phase("picks")

    tmp = OUT.with_name("damage.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    (tmp / "img").mkdir(parents=True)
    jobs = {}
    for i, ps in enumerate(best):
        for k, (ph, *b) in enumerate(ps):
            jobs.setdefault(ph, []).append((i, k, b))
    order = list(jobs)
    with ProcessPoolExecutor(min(os.cpu_count() or 1, 61)) as ex:   # Windows caps a pool at 61
        res = list(ex.map(crop_photo, [(content / f"{photos[ph]['sha256']}_full.jpg",
                                        [(tmp / "img" / f"{i}_{k}.jpg", b) for i, k, b in jobs[ph]]) for ph in order],
                          chunksize=2))
    frac = {(i, k): f for ph, (fs, _, _) in zip(order, res) for (i, k, _), f in zip(jobs[ph], fs)}
    missing, rotated = sum(r[1] for r in res), sum(r[2] for r in res)
    phase("crops")

    items, exact = [], np.zeros(len(starts))   # the class totals sum the unrounded measures
    for i, (c, cl, s, n) in enumerate(zip(ic.tolist(), icl.tolist(), starts.tolist(), counts.tolist())):
        crack = names[c] == "Crack"
        m = lengths.get(cl) if crack else n * voxel_of(head, names[c]) ** 2
        exact[i] = m or 0
        items.append({"c": c, "id": cl, "s": s, "n": n, "m": None if m is None else round(m, 3 if crack else 4),
                      "b": [round(float(v), 3) for v in (*bmin[i], *bmax[i])],
                      "p": [[slot[ph], *frac[i, k]] for k, (ph, *_) in enumerate(best[i])]})
    classes = []
    for c, name in enumerate(names):
        mine = [it for it in items if it["c"] == c]
        classes.append({"name": name, "color": COLORS.get(name, "#828A92"), "voxel": voxel_of(head, name),
                        "measure": "length" if name == "Crack" else "area",
                        "start": int(counts[ic < c].sum()),
                        "count": sum(it["n"] for it in mine), "items": len(mine),
                        "total": round(float(exact[ic == c].sum()), 3)})
    doc = {"format": 1, "box": [round(float(v), 3) for v in (*lo, *hi)], "points": int(idx.size), "classes": classes,
           "photos": [photos[p]["name"] for p in used], "items": items}
    blob, text = q.tobytes(), json.dumps(doc, separators=(",", ":")).encode()
    (tmp / "damage.bin").write_bytes(blob)
    (tmp / "damage.json").write_bytes(text)
    old = OUT.with_name("damage.old")
    shutil.rmtree(old, ignore_errors=True)
    if OUT.exists():
        OUT.rename(old)
    tmp.rename(OUT)
    shutil.rmtree(old, ignore_errors=True)
    phase("write")

    ref = content / "damage_summary.json"
    ref = {c["name"]: c for c in json.loads(ref.read_text())["summary"]["classes"]} if ref.exists() else {}
    print(f"{'class':14} {'items':>6} {'points':>9} {'total':>9}   lynceus: clusters, points, total")
    for c in classes:
        r = ref.get(c["name"], {})
        lr = r.get("length_m" if c["measure"] == "length" else "area_m2")
        print(f"{c['name']:14} {c['items']:6} {c['count']:9,} {c['total']:9.3f}" +
              (f"   {r['cluster_count']:6} {r['point_count']:9,} {lr:9.3f}" if r else ""))
    imgs = list((OUT / "img").iterdir())
    print(f"{idx.size:,} points, {len(items)} items, {sum(map(len, best))} picks from {len(used)} photos; warnings: "
          f"{sum(it['m'] is None for it in items)} crack-length misses, {missing} missing photos, "
          f"{rotated} EXIF-rotated photos")
    gz = lambda b: f"gzip {len(gzip.compress(b, 6)) / len(b):.2f}"
    print(f"damage.bin {len(blob):,} B ({gz(blob)}), damage.json {len(text):,} B ({gz(text)}), "
          f"img/ {sum(p.stat().st_size for p in imgs):,} B in {len(imgs)} files")
    print("time: " + ", ".join(f"{k} {v:.1f} s" for k, v in t.items()) + f", total {sum(t.values()):.1f} s")


if __name__ == "__main__":
    main()
