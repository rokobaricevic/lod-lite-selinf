"""faces_core.element on the real bake mesh: one PNG per probe click, and a table. A dev tool, not a test.

    ./test.sh test        # builds faces_core (for the worker venv's CPython 3.11)
    uv run -q -p 3.11 --no-project --with numpy --with matplotlib python probe_faces.py build/bake/mesh.obj out-probes/

The mesh is the PC's bake mesh (RealityScan OBJ, bake frame, git-ignored). Each PNG shows the section (the surfels
coloured by candidate segment, every candidate line with its key -- on solid, off dashed --, the chosen profile in
bold with its corners), and the swept faces over the triangle centres near them, seen along e2 (a plan, for a
horizontal axis) and along e1. The probes are clicks on Petrinja's bridge (Most Volontera): a point on the surface
and the view ray, the surface's inward normal. `--only name,...` runs some of them.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

import faces_core

# name: (point, dir), bake frame. Found with slices of the mesh along and across the bridge: L = (0.918, 0.396, 0)
# is its long axis, T = (-0.396, 0.918, 0) across, the deck's top at z ~ 0.6.
PROBES = {
    "fascia_left": ((3.269, -5.415, 0.500), (-0.398, 0.916, 0.054)),         # the edge beams' outer faces
    "fascia_right": ((-2.353, 7.514, 0.500), (0.426, -0.902, 0.064)),
    "edge_top_left": ((3.227, -5.319, 0.860), (0.005, 0.017, -1.000)),       # their tops
    "edge_top_right": ((-2.316, 7.429, 0.863), (-0.023, -0.017, -1.000)),
    "sidewalk_top": ((2.749, -4.218, 0.788), (-0.009, 0.017, -1.000)),
    "deck_top": ((0.755, 0.367, 0.606), (0.003, 0.005, -1.000)),             # the road
    "soffit": ((0.755, 0.367, -0.009), (-0.095, 0.049, 0.994)),              # under the deck, between two cross-beams
    "rib_bottom": ((-0.465, -0.163, -0.486), (0.168, -0.006, 0.986)),        # a cross-beam (transverse rib)
    "rib_side": ((-0.489, -0.174, -0.300), (0.944, 0.331, -0.001)),
    "girder_outer": ((2.077, -2.674, -0.200), (-0.397, 0.918, -0.009)),     # the left main girder
    "girder_inner": ((2.051, -2.614, -0.200), (0.405, -0.914, -0.031)),
    "girder_bottom": ((2.091, -2.705, -0.500), (0.115, 0.001, 0.993)),
    "girder_top": ((2.091, -2.705, 1.714), (-0.001, -0.000, -1.000)),
    "duct_bottom": ((-3.388, 1.619, -1.646), (-0.020, 0.045, 0.999)),       # the duct under the deck
    "bank_left": ((-8.173, -2.424, -4.216), (-0.256, -0.056, -0.965)),       # the river channel's banks, under the deck
    "bank_right": ((3.291, 2.560, -4.826), (0.471, 0.202, -0.859)),
    "abutment_left": ((-17.283, -8.566, -1.500), (-0.917, -0.400, 0.005)),  # the abutments' front walls
    "abutment_right": ((14.716, 5.347, -1.500), (0.921, 0.388, -0.024)),
}


def read_obj(path):
    """V float64 (n, 3) and F int64 (m, 3) of a triangle OBJ: the whole file read at once and parsed by numpy (a Python
    loop over its 1.5 M lines takes ~10 s, this ~0.4 s)."""
    lines = Path(path).read_bytes().split(b"\n")
    V = np.fromstring(b" ".join(ln[2:] for ln in lines if ln[:2] == b"v "), sep=" ").reshape(-1, 3)
    f = [ln[2:] for ln in lines if ln[:2] == b"f "]
    if len(f[0].split()) != 3:
        raise ValueError("only triangles")
    per = len(f[0].split()[0].replace(b"//", b"/").split(b"/"))   # numbers per corner: v, v/t, v//n, v/t/n
    F = np.fromstring(b" ".join(f).replace(b"//", b" ").replace(b"/", b" "), dtype=np.int64, sep=" ")
    return V, F.reshape(len(f), 3 * per)[:, ::per] - 1


def mesh_arrays(V, F):   # per triangle: unit normal, area, centre
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a)
    ar = np.linalg.norm(n, axis=1) / 2
    return n / np.maximum(2 * ar, 1e-12)[:, None], ar, (a + b + c) / 3


def draw(r, name, mesh, path, slab_m=1.5, angle_deg=15):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    N, A, C = mesh
    o, ax, e1, e2 = (np.array(r[k]) for k in ("origin", "axis", "e1", "e2"))
    d = C - o
    u, v, s = d @ e1, d @ e2, d @ ax
    nu, nv, na = N @ e1, N @ e2, N @ ax
    segs = r["segments"]
    uv = np.array([q for pc in r["pieces"] for q in pc["uv"]] or [[0.0, 0.0]])
    lo, hi = uv.min(0) - 1.0, uv.max(0) + 1.0
    span = max(hi[0] - lo[0], hi[1] - lo[1], 2.0)
    mid = (lo + hi) / 2
    lo, hi = mid - span / 2, mid + span / 2
    sl = (np.abs(s) <= slab_m) & (np.abs(na) < np.sin(np.radians(25))) & (u > lo[0]) & (u < hi[0]) & (v > lo[1]) & (v < hi[1])
    m2 = np.c_[nu[sl], nv[sl]]
    m2 /= np.linalg.norm(m2, axis=1)[:, None]
    q = np.c_[u[sl], v[sl]]
    seg_of = np.full(len(q), -1)
    best = np.full(len(q), 0.05)
    for g in segs:   # each surfel to the nearest candidate line it lies on (within 5 cm and angle_deg, along its span)
        n, c, (t0, t1) = np.array(g["n"]), g["c"], g["t"]
        dist, t = np.abs(q @ n - c), q @ np.array([-n[1], n[0]])
        ok = (dist < best) & (m2 @ n > np.cos(np.radians(angle_deg))) & (t > t0 - 0.05) & (t < t1 + 0.05)
        seg_of[ok], best[ok] = g["key"], dist[ok]
    cmap = plt.get_cmap("tab20")
    fig = plt.figure(figsize=(26, 13))
    gs = fig.add_gridspec(2, 2, width_ratios=[1.0, 1.0])
    a0 = fig.add_subplot(gs[:, 0])
    a0.scatter(q[seg_of < 0, 0], q[seg_of < 0, 1], s=4, c="0.75", lw=0)
    a0.scatter(q[seg_of >= 0, 0], q[seg_of >= 0, 1], s=7, c=[cmap(k % 20) for k in seg_of[seg_of >= 0]], lw=0)
    for g in segs:
        n, c, (t0, t1) = np.array(g["n"]), g["c"], g["t"]
        dd = np.array([-n[1], n[0]])
        ts = np.linspace(t0, t1, 64)
        pts = c * n + ts[:, None] * dd
        vis = np.all((pts > lo) & (pts < hi), axis=1)
        if not vis.any():
            continue
        a0.plot(*pts[[0, -1]].T, ls="-" if g["on"] else "--", lw=1.6 if g["on"] else 1.0, color=cmap(g["key"] % 20))
        m = pts[vis].mean(0)
        a0.annotate("", m + 0.1 * span / 4 * n, m, arrowprops=dict(arrowstyle="->", color=cmap(g["key"] % 20), lw=0.8))
        a0.text(*(m + 0.04 * span / 4 * n), str(g["key"]), fontsize=9, color="k" if g["on"] else "0.35",
                fontweight="bold" if g["seed"] or g["on"] else "normal", clip_on=True)
    for pc in r["pieces"]:
        p = np.array(pc["uv"])
        if pc["closed"]:
            p = np.r_[p, p[:1]]
        a0.plot(p[:, 0], p[:, 1], "-", color="k", lw=3, alpha=0.8)
        a0.plot(p[:, 0], p[:, 1], "o", color="r", ms=5)
    a0.plot(0, 0, "*", color="m", ms=16, mec="k")
    a0.set_xlim(lo[0], hi[0]), a0.set_ylim(lo[1], hi[1]), a0.set_aspect("equal"), a0.grid(True, alpha=0.4)
    a0.set_xlabel("u (e1)  [m]"), a0.set_ylabel("v (e2)  [m]")
    a0.set_title(f"{name}: the section (+-{slab_m} m along the axis); seed {[g['key'] for g in segs if g['seed']]}, "
                 f"pieces {[pc['edges'] for pc in r['pieces']]}", fontsize=10)
    s0, s1 = r["s0"], r["s1"]
    near = (u > uv[:, 0].min() - 1.5) & (u < uv[:, 0].max() + 1.5) & (v > uv[:, 1].min() - 1.5) & (v < uv[:, 1].max() + 1.5)
    near &= (s > s0 - 6) & (s < s1 + 6)
    pick = np.flatnonzero(near)
    if len(pick) > 60000:
        pick = np.random.default_rng(0).choice(pick, 60000, replace=False)
    for row, (w, wn, lab) in enumerate(((u, 0, "u (e1)"), (v, 1, "v (e2)"))):
        a1 = fig.add_subplot(gs[row, 1])
        a1.scatter(s[pick], w[pick], s=1, c=(v if wn == 0 else u)[pick], cmap="viridis", lw=0, alpha=0.5)
        for k, fc in enumerate(r["faces"]):
            P = np.array(fc["points"]) - o
            ps, pw = P @ ax, P @ (e1 if wn == 0 else e2)
            if fc["key"].startswith("cap"):
                a1.plot(ps, pw, "-", color="r", lw=2)
                continue
            quad = np.array([0, 1, 3, 2, 0])
            a1.fill(ps[quad], pw[quad], alpha=0.25, color=cmap(fc["seg"] % 20) if fc["seg"] is not None else "0.3")
            a1.plot(ps[quad], pw[quad], "-", color="k", lw=0.8)
        a1.axvline(0, color="m", lw=1)
        a1.axvline(r["auto"][0], color="b", ls=":", lw=1), a1.axvline(r["auto"][1], color="b", ls=":", lw=1)
        a1.set_xlim(s0 - 6, s1 + 6), a1.grid(True, alpha=0.4)
        a1.set_xlabel("s (axis) [m]"), a1.set_ylabel(lab + " [m]")
        a1.set_title(f"the faces seen along {'e2' if wn == 0 else 'e1'} over the triangle centres near them "
                     f"(colour: {'v' if wn == 0 else 'u'}); extent [{s0}, {s1}]", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=70)
    plt.close(fig)


def axis_name(a, frame):   # the nearest of the global L, T, Z and the angle to it: "L 0.2"
    k = int(np.argmax([abs(np.dot(a, g)) for g in frame]))
    return f"{'LTZ'[k]} {np.degrees(np.arccos(min(1.0, abs(np.dot(a, frame[k]))))):.1f}"


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    only = None
    if "--only" in argv:
        i = argv.index("--only")
        only, argv = set(argv[i + 1].split(",")), argv[:i] + argv[i + 2:]
    t = time.perf_counter()
    V, F = read_obj(argv[0])
    print(f"{argv[0]}: {len(V)} vertices, {len(F)} triangles read in {time.perf_counter() - t:.1f} s")
    faces, mesh = faces_core.Faces(V, F), mesh_arrays(V, F)
    out = Path(argv[1])
    out.mkdir(parents=True, exist_ok=True)
    print(f"{'probe':24} {'axis':6} {'extent':>17} {'cover':>5} {'rms mm':>6} {'ms':>5}  faces (width x length, m)")
    for name, (point, view) in PROBES.items():
        if only and name not in only:
            continue
        try:
            r = json.loads(faces.element(point, view))
        except LookupError as exc:
            print(f"{name:24} LookupError: {exc}")
            continue
        side = [fc for fc in r["faces"] if not fc["key"].startswith("cap")]
        cover = sum(fc["coverage"] * fc["area"] for fc in side) / max(sum(fc["area"] for fc in side), 1e-9)
        print(f"{name:24} {axis_name(r['axis'], faces.frame):6} [{r['s0']:7.2f}, {r['s1']:6.2f}] {cover:5.2f} "
              f"{r['rms'] * 1000:6.1f} {r['ms']:5.1f}  {len(r['faces'])}: " +
              ", ".join(f"{fc['key']} {fc['width']:.2f}x{fc['length']:.1f}" for fc in r["faces"]))
        draw(r, name, mesh, out / f"{name}.png")


if __name__ == "__main__":
    main(sys.argv[1:])
