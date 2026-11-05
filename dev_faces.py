"""dev_faces.py: the element tool (faces.js) on the Mac, without the PC. Serves this folder's viewer.html and scripts, a
tileset at /out/ (--out: the same bridge in the same frame), and POST /element: faces_core's Faces.element on the bake
mesh (--mesh) when faces_core imports (./test.sh test builds it next to this file), else a MOCK: a 0.6 x 1.2 m girder
along the bridge's axis at the click, six candidate faces (three in it; the deck soffits beside it, concave neighbours;
another girder's web), that honours axis / on / off / add / s0 / s1 and answers in the same shape. No login.

  ~/dev/lynceus/apps/worker/.venv/bin/python dev_faces.py [--port 8770] [--out DIR] [--mesh build/bake/mesh.obj]
  -> http://127.0.0.1:8770/viewer.html?faces
"""
import argparse
import json
import math
import os
import re
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = {"point", "dir", "axis", "on", "off", "add", "s0", "s1", "window_m", "slab_m", "angle_deg", "concave_max_m",
        "element_m", "presence", "gap_m"}   # POST /element's keys = Faces.element's arguments
L, Z = np.array([0.917, 0.399, 0.0]) / math.hypot(0.917, 0.399), np.array([0.0, 0.0, 1.0])   # the bridge's long axis, up


def load_obj(path):
    """An OBJ's v and f lines (triangles; f's /vt/vn parts dropped) -> V float64 (n, 3), F int64 (m, 3). ~1 s for 1 M."""
    with open(path, "rb") as fh:
        data = fh.read()
    v, f = re.findall(rb"^v +([^\r\n]+)", data, re.M), re.findall(rb"^f +([^\r\n]+)", data, re.M)
    V = np.fromstring(b" ".join(v), dtype=np.float64, sep=" ").reshape(len(v), -1)[:, :3]
    F = np.fromstring(re.sub(rb"/[^ ]*", b"", b" ".join(f)), dtype=np.int64, sep=" ").reshape(len(f), -1)[:, :3] - 1
    return np.ascontiguousarray(V), np.ascontiguousarray(F)


# ---------- the mock. Its girder in the section (x across, y up from the clicked face, the material at y > 0): the
# candidates as (normal, start, end); 0-2 the element (auto), 3-4 the deck soffit on both sides (concave and too long to
# take), 5 the next girder's web. COVER: each face's scan coverage; EXT: the automatic extent along the axis
SHAPE = [((0, -1), (-0.3, 0), (0.3, 0)), ((-1, 0), (-0.3, 0), (-0.3, 1.2)), ((1, 0), (0.3, 0), (0.3, 1.2)),
         ((0, -1), (-2.0, 1.2), (-0.3, 1.2)), ((0, -1), (0.3, 1.2), (2.0, 1.2)), ((-1, 0), (1.4, 0.2), (1.4, 1.2))]
AUTO, COVER, EXT = {0, 1, 2}, [0.93, 0.81, 0.77, 0.58, 0.49, 0.36], (-4.2, 3.1)


def num(x, name):
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise ValueError(f"{name}: not a number")
    return float(x)


def vec(x, name, unit=False):
    v = np.array([num(c, name) for c in x] if isinstance(x, (list, tuple)) else [])
    if v.shape != (3,) or (unit and np.linalg.norm(v) < 1e-9):
        raise ValueError(f"{name}: 3 numbers" + (", not all 0" if unit else ""))
    return v / np.linalg.norm(v) if unit else v


def frame(a):
    """The section frame (faces.cpp's step 3): e2 up made perpendicular to the axis, e1 = e2 x a (a near vertical: e1 = L)."""
    if abs(a[2]) < 0.9:
        e2 = Z - a * a[2]
        e2 /= np.linalg.norm(e2)
        return np.cross(e2, a), e2
    e1 = L - a * (L @ a)
    e1 /= np.linalg.norm(e1)
    return e1, np.cross(a, e1)


def ends(g):
    d = np.array([-g["n"][1], g["n"][0]])
    return [g["c"] * g["n"] + t * d for t in g["t"]]


def meet(g, h):   # the two lines' intersection; None when they are within 20 deg of parallel
    M = np.array([g["n"], h["n"]])
    return None if abs(np.linalg.det(M)) < math.sin(math.radians(20)) else np.linalg.solve(M, [g["c"], h["c"]])


def touch(g, h):  # adjacent: their lines meet within 0.25 m of an end of each
    X = meet(g, h)
    return X is not None and all(min(np.linalg.norm(X - e) for e in ends(s)) <= 0.25 for s in (g, h))


def seg_dist(g, q):
    d = np.array([-g["n"][1], g["n"][0]])
    t = min(max(d @ q, g["t"][0]), g["t"][1])
    return float(np.linalg.norm(q - g["c"] * g["n"] - t * d))


def mock(point, dir, axis=None, on=(), off=(), add=(), s0=None, s1=None, **tuning):
    t0 = time.perf_counter()
    p, d = vec(point, "point"), vec(dir, "dir", unit=True)
    a = L if axis is None else vec(axis, "axis", unit=True)
    for k, x in tuning.items():
        num(x, k)
    e1, e2 = frame(a)
    # the face the eye sees is the clicked one: from below the soffit, across a web; from above, the girder upside down
    du, dv = d @ e1, d @ e2
    seed, fy = ((1 if du > 0 else 2), 1.0) if abs(du) > abs(dv) else (0, 1.0 if dv > 0 else -1.0)
    shape = [(np.array([n[0], n[1] * fy], float), np.array([A[0], A[1] * fy]), np.array([B[0], B[1] * fy])) for n, A, B in SHAPE]
    mid = (shape[seed][1] + shape[seed][2]) / 2
    cand = []
    for i, (n, A, B) in enumerate(shape):
        dd = np.array([-n[1], n[0]])
        cand.append({"i": i, "n": n, "c": float(n @ (A - mid)), "t": sorted([float(dd @ (A - mid)), float(dd @ (B - mid))])})
    cand.sort(key=lambda g: (round(math.atan2(g["n"][1], g["n"][0]), 9), round(g["c"], 9), round(g["t"][0], 9)))  # keys
    key = {g["i"]: k for k, g in enumerate(cand)}

    def keys(xs, name):
        if not isinstance(xs, (list, tuple)) or not all(isinstance(k, int) and 0 <= k < len(cand) for k in xs):
            raise ValueError(f"{name}: segment keys 0..{len(cand) - 1}")
        return set(xs)
    want = ({key[i] for i in AUTO} | keys(on, "on")) - keys(off, "off")
    for q in add if isinstance(add, (list, tuple)) else [None]:   # the candidate nearest each shift-clicked point
        w = vec(q, "add") - p
        uv = np.array([w @ e1, w @ e2])
        k = min(range(len(cand)), key=lambda k: seg_dist(cand[k], uv))
        if seg_dist(cand[k], uv) <= 0.15:
            want.add(k)
    if not want:
        raise LookupError("no side faces at the click")
    S0, S1 = (EXT[0] if s0 is None else num(s0, "s0")), (EXT[1] if s1 is None else num(s1, "s1"))
    if S0 >= S1:
        raise ValueError("s0 >= s1")

    # the profile: chains of adjacent segments from an end, through their lines' intersections; the free ends measured
    adj = {k: [j for j in want if j != k and touch(cand[k], cand[j])] for k in want}
    pieces, seen = [], set()
    for k0 in sorted(want, key=lambda k: (len(adj[k]) != 1, k)):
        if k0 in seen:
            continue
        path = [k0]
        seen.add(k0)
        while nxt := [j for j in adj[path[-1]] if j not in seen]:
            path.append(nxt[0])
            seen.add(nxt[0])
        closed = len(path) > 2 and path[0] in adj[path[-1]]
        X = [meet(cand[x], cand[y]) for x, y in zip(path, path[1:] + path[:1] if closed else path[1:])]
        if closed:
            uv = X[-1:] + X[:-1]
        elif X:
            uv = [max(ends(cand[path[0]]), key=lambda e: np.linalg.norm(e - X[0]))] + X + \
                 [max(ends(cand[path[-1]]), key=lambda e: np.linalg.norm(e - X[-1]))]
        else:
            uv = ends(cand[k0])
        pieces.append((path, uv, closed))

    P = lambda q, s: (p + q[0] * e1 + q[1] * e2 + s * a).tolist()
    faces = []
    for path, uv, closed in pieces:
        for k, sk in enumerate(path):
            A, B, g = uv[k], uv[(k + 1) % len(uv)], cand[sk]
            w = float(np.linalg.norm(B - A))
            faces.append({"key": f"s{sk}", "seg": sk, "normal": (g["n"][0] * e1 + g["n"][1] * e2).tolist(),
                          "points": [P(A, S0), P(B, S0), P(A, S1), P(B, S1)], "area": w * (S1 - S0), "width": w,
                          "length": S1 - S0, "coverage": COVER[g["i"]]})
        if key[seed] in path and len(uv) >= 3:   # the end at s1 is scanned: the profile closed by its chord
            U = np.array(uv)
            area = 0.5 * abs(float(np.sum(U[:, 0] * np.roll(U[:, 1], 1) - np.roll(U[:, 0], 1) * U[:, 1])))
            faces.append({"key": "cap1", "seg": None, "normal": a.tolist(), "points": [P(q, S1) for q in uv], "area": area,
                          "width": float(np.ptp(U[:, 0])), "length": float(np.ptp(U[:, 1])), "coverage": 0.42})
    segments = [{"key": k, "on": k in want, "auto": g["i"] in AUTO, "seed": g["i"] == seed, "n": g["n"].tolist(), "c": g["c"],
                 "t": g["t"], "area": round((g["t"][1] - g["t"][0]) * 2.6 * COVER[g["i"]], 4), "rms": 0.004 + 0.001 * g["i"]}
                for k, g in enumerate(cand)]
    return json.dumps({"origin": p.tolist(), "axis": a.tolist(), "e1": e1.tolist(), "e2": e2.tolist(), "s0": S0, "s1": S1,
                       "auto": list(EXT), "segments": segments,
                       "pieces": [{"keys": path, "uv": [q.tolist() for q in uv], "closed": closed} for path, uv, closed in pieces],
                       "faces": faces, "rms": 0.006, "tris": 4210, "ms": 1000 * (time.perf_counter() - t0)}).encode()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".json": "application/json", ".glb": "model/gltf-binary", ".ktx2": "image/ktx2"}
    element, out, delay = staticmethod(mock), HERE, 0.0

    def translate_path(self, path):   # /out/... from the tileset, the rest from this folder; nothing above them, no dotfiles
        path = unquote(urlsplit(path).path)
        base, rel = (self.out, path[5:]) if path.startswith("/out/") else (HERE, path.lstrip("/"))
        full = os.path.realpath(os.path.join(base, rel))
        ok = full.startswith(os.path.realpath(base) + os.sep) and not any(s.startswith(".") for s in rel.split("/"))
        return full if ok else os.path.join(HERE, "-")   # no such file: 404

    def do_GET(self):
        if urlsplit(self.path).path == "/":
            self.send_response(302)
            self.send_header("Location", "/viewer.html?faces")
            return self.end_headers()
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):   # quiet: the tiles' GETs; POST /element prints its own line
        pass

    def do_POST(self):
        if urlsplit(self.path).path != "/element":
            return self.reply(404, {"error": "not found"})
        t, body = time.perf_counter(), None
        try:   # text/plain JSON, as selinf.py's routes; its keys are element()'s arguments
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
            if not isinstance(body, dict):
                raise ValueError("the body is not a JSON object")
            if bad := sorted(set(body) - KEYS):
                raise ValueError("unknown keys: " + ", ".join(bad))
            time.sleep(self.delay)
            code, out = 200, self.element(**body)
        except (ValueError, TypeError) as exc:
            code, out = 400, {"error": str(exc)}
        except LookupError as exc:
            code, out = 422, {"error": str(exc)}
        self.reply(code, out)
        keys = {k: body[k] for k in ("on", "off", "add", "s0", "s1") if k in body} if isinstance(body, dict) else {}
        print(f"POST /element {code} {1000 * (time.perf_counter() - t):.0f} ms {json.dumps(keys)}", flush=True)

    def reply(self, code, out):
        data = out if isinstance(out, bytes) else json.dumps(out).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description="the element tool on the Mac: the viewer, a tileset and POST /element")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--out", default=os.path.expanduser("~/dev/lod-lite-selinf/out-uastc-200k"), help="the tileset (served at /out/)")
    ap.add_argument("--mesh", help="the bake mesh (OBJ, bake frame) for faces_core; without it, or without faces_core: the mock")
    ap.add_argument("--delay", type=float, default=0.04, help="the mock's latency, s")
    args = ap.parse_args()
    Handler.out, why = os.path.abspath(args.out), "no --mesh"
    if args.mesh:
        try:   # faces_core from this folder (./test.sh test), or PYTHONPATH
            sys.path.insert(0, HERE)
            import faces_core
            if not hasattr(faces_core.Faces, "element"):
                raise ImportError("this faces_core has no Faces.element (an old build)")
            t = time.perf_counter()
            V, F = load_obj(args.mesh)
            t1 = time.perf_counter()
            Handler.element, why = staticmethod(faces_core.Faces(V, F).element), None
            print(f"faces_core: {len(F)} triangles (read {t1 - t:.1f} s, built {time.perf_counter() - t1:.1f} s)")
        except Exception as exc:   # no faces_core, an old one, an unreadable mesh: the mock instead
            why = repr(exc)
    if why:
        Handler.delay = args.delay
        print(f"POST /element: the MOCK ({why})")
    print(f"http://127.0.0.1:{args.port}/viewer.html?faces  (tiles: {Handler.out})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
