"""faces_core.element on the real bake mesh: one PNG per probe click, and a table. A dev tool, not a test.

    ./test.sh test        # builds faces_core (for the worker venv's CPython 3.11)
    uv run -q -p 3.11 --no-project --with numpy --with matplotlib python probe_faces.py build/bake/mesh.obj out-probes/

The mesh is the PC's bake mesh (RealityScan OBJ, bake frame, git-ignored). Each PNG shows the section (the surfels
coloured by candidate segment, every candidate line with its key -- on solid, off dashed --, the chosen profile in
bold with its corners), and the swept faces over the triangle centres near them, seen along e2 (a plan, for a
horizontal axis) and along e1. The probes are clicks on Petrinja's bridge (Most Volontera): a point on the surface
and the view ray, the surface's inward normal. `--only name,...` runs some of them.

`--clicks` asks instead what the owner gets: ~220 rays cast from cameras beside, below and above the bridge, at its
ends, at the main girders above the deck (from the road and the sidewalks) and at the cross-beams' sides (under the
deck, along it both ways), each hit labelled by the element it lands on (a main girder is one element, any part of it),
and per element how many different profiles element gives (side faces' widths within 2 cm, extent within 0.5 m), the
main one's share of the clicks and how many fail; then how many structural elements have at most 2 profiles, the main
one at 75 % of their clicks or more. The PNGs are the minority profiles'.
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


# --clicks: clicks as the owner makes them -- rays from cameras beside, below and above the bridge and at its ends,
# through a grid of screen directions, onto the mesh -- each labelled by the element it lands on. Bridge frame: x along
# L from the triangle centres' median, y along T from theirs, z up. A camera: name, eye, look-at, (columns, rows, half
# field of view in degrees). Then (2026-11-05): the main girders above the deck from the road and from the sidewalks,
# and the cross-beams' sides from under the deck, looking along the bridge both ways; the last four: the right girder's
# top flange from above and its bottom flange from below outside, the cross-beams near either girder from under the deck.
CAMERAS = (("beside_left", (-4, -16, 1.0), (-4, -5, 0.0), (5, 3, 22)), ("beside_left_far", (9, -16, 0.4), (9, -5, -0.3), (5, 3, 22)),
           ("beside_right", (-4, 15, 1.0), (-4, 5, 0.0), (5, 3, 22)), ("beside_right_far", (9, 15, 0.4), (9, 5, -0.3), (5, 3, 22)),
           ("below", (-3, -1, -4.4), (-3, -1, 0), (5, 3, 35)), ("below_far", (7, 1.5, -4.3), (7, 1.5, 0), (5, 3, 35)),
           ("below_girder", (2, -6.5, -3.0), (2, -4.4, -0.5), (5, 3, 25)), ("above", (0, -12, 7), (0, 0, 0.0), (5, 3, 25)),
           ("abutment_left", (-9, 0, -1.5), (-17, 0, -1.5), (4, 3, 25)), ("abutment_right", (12, 0, -1.5), (19, 0, -1.5), (4, 3, 25)),
           ("bank_left", (-4.5, 10, -2.5), (-4.5, 0, -4.2), (4, 3, 25)), ("bank_right", (7.5, 10, -2.5), (7.5, 0, -4.8), (4, 3, 25)),
           ("road_left", (-7, 0, 1.6), (-2, -4.3, 1.3), (5, 3, 20)), ("road_right", (7, -0.5, 1.6), (2, 3.8, 1.3), (5, 3, 20)),
           ("walk_left", (-3, -6.3, 1.8), (3, -4.4, 1.25), (5, 3, 18)), ("walk_right", (3, 6.0, 1.8), (-3, 3.9, 1.25), (5, 3, 18)),
           ("under_ribs_a", (-9, -1, -1.3), (-1, -1, -0.3), (5, 3, 18)), ("under_ribs_b", (11, 0.5, -1.3), (3, 0.5, -0.3), (5, 3, 18)),
           ("above_girder_right", (-3, 2.0, 4.5), (1, 3.8, 1.7), (5, 3, 12)), ("below_girder_right", (2, 6.5, -3.0), (2, 3.9, -0.5), (5, 3, 25)),
           ("under_ribs_c", (-9, 2.3, -1.3), (-1, 2.3, -0.3), (5, 3, 18)), ("under_ribs_d", (11, -2.5, -1.3), (3, -2.5, -0.3), (5, 3, 18)))
GIRDERS = (("left", -4.335, 0.0035), ("right", 3.775, 0.006))   # a girder's web centre: y = y0 + k x (they run off L)


def label(x, y, z, n):   # the element at a point of the bridge frame, its normal n along (L, T, Z): from the slices
    nl, nt, nz = n
    if -2.8 < z < -0.4 and abs(nl) > 0.7 and (-17.6 < x < -15.3 or 18.8 < x < 19.8):
        return "abutment_" + ("left" if x < 0 else "right")
    if z < -2.0:
        if z < -5.8 and -1.6 < x < 4.8:
            return "channel"
        return "bank_left" if -8 < x < -1.5 else "bank_right" if 4.8 < x < 10.5 else "ground"
    if x < -17.5 or x > 20.5:
        return "approach"
    if 1.2 < y < 2.4 and -0.6 < z < -0.15:
        return "pipe"
    if -7.7 < y < -6.95 or 6.45 < y < 7.2:
        return ("railing_" if z > 1.0 else "edge_") + ("left" if y < 0 else "right")
    if abs(y) > 7.2:
        return "other"
    if 1.3 < y < 2.8 and z < -0.6:
        return "duct"
    for side, y0, k in GIRDERS:   # a main girder, any part: its flanges (+-30 cm), their fillets, its web's two skins
        dy = abs(y - y0 - k * x)
        if (dy < 0.3 and (z > 1.6 or z < -0.4)) or (dy < 0.3 and z > 1.35 and nz < 0.3) or (dy < 0.1 and abs(nt) > 0.7):
            return "girder_" + side
    if z > 0.1 and (y < -4.6 or y > 4.1):   # the sidewalks: their tops, their undersides
        return ("walk_" if nz > 0.7 else "walk_under_") + ("left" if y < 0 else "right")
    if -3.5 < y < 3.0 and z > 0.4 and nz > 0.7:
        return "road"
    if z < 0.25 and -4.0 < y < 3.5:
        if nz < -0.7 and z > -0.2:
            return "soffit"
        k = round((x - 2.95) / 2.8)
        if abs(x - (2.95 + 2.8 * k)) < 0.35 and z > -0.65:
            return f"rib_{k}"
    return "other"


STRUCTURAL = ("edge_", "walk_left", "walk_right", "girder_", "road", "abutment_", "bank_", "channel", "soffit", "rib_")


def cast(o, d, V, F, mesh):   # the triangle the ray o + t d hits first, facing it: (point, its normal), or None
    N, _, C = mesh
    w = C - o
    t = w @ d
    k = np.flatnonzero((t > 0) & (np.einsum("ij,ij->i", w, w) - t * t < 1.5 ** 2) & (N @ d < 0))
    a, e1, e2 = V[F[k, 0]], V[F[k, 1]] - V[F[k, 0]], V[F[k, 2]] - V[F[k, 0]]
    p = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, p)
    inv = 1 / np.where(np.abs(det) > 1e-12, det, np.inf)
    s = o - a
    u = np.einsum("ij,ij->i", s, p) * inv
    q = np.cross(s, e1)
    v, tt = (q @ d) * inv, np.einsum("ij,ij->i", e2, q) * inv
    hit = (u >= 0) & (v >= 0) & (u + v <= 1) & (tt > 0)
    if not hit.any():
        return None
    j = int(np.argmin(np.where(hit, tt, np.inf)))
    return o + tt[j] * d, N[k[j]]


def clicks(faces, V, F, mesh, out):
    """Clicks from CAMERAS, each answered and labelled; per element: the distinct profiles element gives (the side
    faces' widths within 2 cm, the extent's ends within 0.5 m) and the failures (no answer, shorter than 1 m, narrower
    than 5 cm, covered under 25 %, an axis over 3 deg off L / T / Z). Writes the minority profiles' PNGs to out."""
    L, T, Z = (np.array(g) for g in faces.frame)
    C = mesh[2]
    o = np.median(C @ L) * L + np.median(C @ T) * T   # the bridge frame's origin (z = 0 stays the bake frame's)
    world = lambda x, y, z: o + x * L + y * T + z * Z  # noqa: E731
    rows = []
    for name, eye, at, (nx, ny, fov) in CAMERAS:
        e, f = world(*eye), world(*at) - world(*eye)
        f /= np.linalg.norm(f)
        r = np.cross(f, Z)
        r = r / np.linalg.norm(r) if np.linalg.norm(r) > 1e-6 else L
        u = np.cross(r, f)
        for ax in np.linspace(-fov, fov, nx):
            for ay in np.linspace(-fov * 0.6, fov * 0.6, ny):
                d = f + np.tan(np.radians(ax)) * r + np.tan(np.radians(ay)) * u
                d /= np.linalg.norm(d)
                hit = cast(e, d, V, F, mesh)
                if hit is None:
                    continue
                p, n = hit
                x, y = (p - o) @ L, (p - o) @ T
                rows.append((label(x, y, p[2], (n @ L, n @ T, n @ Z)), f"{name} {ax:+.0f} {ay:+.0f}", p, d))
    stats, failures, ms = {}, 0, []
    for lab, tag, p, d in rows:
        try:
            r = json.loads(faces.element(p, d))
        except LookupError as exc:
            stats.setdefault(lab, []).append((tag, p, d, None, f"no element: {exc}"))
            failures += lab not in ("ground", "approach", "other")
            continue
        side = [fc for fc in r["faces"] if fc["key"][0] != "c"]
        widths = sorted(fc["width"] for fc in side)
        cover = sum(fc["coverage"] * fc["area"] for fc in side) / max(sum(fc["area"] for fc in side), 1e-9)
        a, org = np.array(r["axis"]), np.array(r["origin"])
        g = max((L, T, Z), key=lambda g: abs(a @ g))
        ends = sorted(((org + s * a) - o) @ g for s in (r["s0"], r["s1"]))
        off = np.degrees(np.arccos(min(1.0, abs(a @ g))))
        why = ("shorter than 1 m" if r["s1"] - r["s0"] < 1 else "narrower than 5 cm" if sum(widths) < 0.05 else
               "covered under 25 %" if cover < 0.25 else f"axis {off:.1f} deg off" if off > 3 and not lab.startswith(("bank", "ground", "channel", "other", "approach")) else "")
        failures += bool(why)
        stats.setdefault(lab, []).append((tag, p, d, (widths, ends, r), why))
        ms.append(r["ms"])
    print(f"\n{len(rows)} clicks; {failures} failures ({100 * failures / max(len(rows), 1):.0f} %); ms median {np.median(ms):.1f}, "
          f"90 % {np.percentile(ms, 90):.1f}, max {max(ms):.1f}")
    print(f"{'element':24} {'clicks':>6} {'profiles':>8} {'main':>5} {'fail':>4}  the main profile: widths (m), extent ends along its axis (m)")
    out.mkdir(parents=True, exist_ok=True)
    met, structural = [], []
    for lab in sorted(stats):
        groups = []   # [(widths, ends, [results])]
        for tag, p, d, res, why in stats[lab]:
            if res is None:
                continue
            for gw, ge, members in groups:
                if len(gw) == len(res[0]) and all(abs(x - y) <= 0.02 for x, y in zip(gw, res[0])) and \
                        all(abs(x - y) <= 0.5 for x, y in zip(ge, res[1])):
                    members.append((tag, p, d, res))
                    break
            else:
                groups.append((res[0], res[1], [(tag, p, d, res)]))
        groups.sort(key=lambda gr: -len(gr[2]))
        fails = [why for *_, why in stats[lab] if why]
        top = groups[0] if groups else ((), (0, 0), [])
        share = len(top[2]) / len(stats[lab])   # the main profile's share of the clicks (failures count against it)
        if lab.startswith(STRUCTURAL):
            structural.append(lab)
            if len(groups) <= 2 and share >= 0.75:
                met.append(lab)
        print(f"{lab:24} {len(stats[lab]):6} {len(groups):8} {100 * share:4.0f}% {len(fails):4}  " +
              (f"{[round(w, 2) for w in top[0]]} [{top[1][0]:.1f}, {top[1][1]:.1f}]" if groups else "") +
              (f"   other: {', '.join(str([round(w, 2) for w in gr[0]]) + f'x{len(gr[2])}' for gr in groups[1:4])}" if len(groups) > 1 else "") +
              (f"   fail: {'; '.join(sorted(set(fails)))[:90]}" if fails else ""))
        if lab not in ("ground", "approach", "other"):
            for k, (gw, ge, members) in enumerate(groups[1:3], 1):   # a minority profile, drawn
                tag, p, d, res = members[0]
                draw(res[2], f"{lab} {tag}", mesh, out / f"{lab}_{k}.png")
    print(f"structural elements with <= 2 profiles and the main one >= 75 % of their clicks: {len(met)} of {len(structural)}"
          f" (not: {', '.join(lab for lab in structural if lab not in met)})")


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    only, many = None, "--clicks" in argv
    if "--only" in argv:
        i = argv.index("--only")
        only, argv = set(argv[i + 1].split(",")), argv[:i] + argv[i + 2:]
    argv = [a for a in argv if a != "--clicks"]
    t = time.perf_counter()
    V, F = read_obj(argv[0])
    print(f"{argv[0]}: {len(V)} vertices, {len(F)} triangles read in {time.perf_counter() - t:.1f} s")
    faces, mesh = faces_core.Faces(V, F), mesh_arrays(V, F)
    out = Path(argv[1])
    if many:
        return clicks(faces, V, F, mesh, out)
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
