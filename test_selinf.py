"""selinf_core (selinf.cpp) against the pipeline's own Python, on a synthetic survey written as real files:
a box deck as an OBJ, COLMAP text with FULL_OPENCV distortion, an alignment meta, params / photos /
thresholds / classes, and a small points.json + points.bin. Both sides load the same files.

    ./test.sh test        (builds selinf_core, then runs this file with the worker venv)
"""

import base64
import hashlib
import json
import os
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(os.environ.get("SELINF_REPO", "C:/dev/lynceus"))
for _p in ("pipeline", "pipeline/training", "pipeline/cook", "apps/worker/src", "apps/server/src",
           "packages/protocol/python"):
    if str(REPO / _p) not in sys.path:
        sys.path.append(str(REPO / _p))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import pytest  # noqa: E402
import trimesh  # noqa: E402
from scipy.spatial.transform import Rotation  # noqa: E402

if sys.platform == "win32":   # the Embree DLLs the worker venv's embreex ships
    os.add_dll_directory(str(Path(np.__file__).parent.parent / "embreex.libs"))

import selinf_core as core  # noqa: E402
import bakeobj  # noqa: E402 -- needs the paths above
from cook.points_bin import _grid_cluster  # noqa: E402

OFF = np.array([100.0, 200.0, 50.0])


def make_survey(tmp, fx=300.0, W=400, H=300, values=None, grids=None, roi_m=1.0):
    root, work = Path(tmp) / "data", Path(tmp) / "work"
    job = root / "projects" / "P" / "pipeline" / "J"
    content = root / "projects" / "P" / "content"
    for d in (job / "bake" / "colmap", job / "inference", content, work):
        d.mkdir(parents=True)

    # mesh.obj, in the real file's shape: comments, mtllib, g, usemtl, one vn per v, an unreferenced v
    mesh = trimesh.creation.box(extents=(60, 30, 0.2))
    mesh.apply_translation((6, 0, -0.1))
    mesh = mesh.subdivide().subdivide()
    V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    mid = len(V) // 2
    lines = ["# synthetic deck", "# 2026", "mtllib x.mtl", "g default", "usemtl x"]
    for k, v in enumerate(V):
        if k == mid:
            lines.append("v 99 99 99")
        lines.append("v %.6f %.6f %.6f" % tuple(v))
    lines += ["vn 0 0 1"] * (len(V) + 1)
    for a, b, c in F:
        a, b, c = (int(k) + 1 + (k >= mid) for k in (a, b, c))
        lines.append(f"f {a}//{a} {b}//{b} {c}//{c}")
    (job / "bake" / "mesh.obj").write_text("\n".join(lines) + "\n")

    # cameras in the bake frame, and the COLMAP files that reproduce them
    S = bakeobj.AXIS["zup_to_yup"]
    R_c2w = np.diag([1.0, -1.0, -1.0])
    k1, k2, p1, p2, k3 = -0.03, 0.01, 0.0008, -0.0004, 0.002
    cams, img = [], ["# Image list", "# synthetic"]
    for i, x in enumerate(np.arange(-4.0, 16.01, 0.75)):
        for j, y in enumerate((-1.0, 0.0, 1.0)):
            cams.append(f"DJI_{i:02d}_{j}.JPG")
            origin_w = S.T @ np.array([x, y, 3.0]) + OFF
            R_wc = (S.T @ R_c2w).T
            qx, qy, qz, qw = Rotation.from_matrix(R_wc).as_quat()
            t = -R_wc @ origin_w
            img.append(" ".join([str(len(cams)), *(repr(float(v)) for v in (qw, qx, qy, qz, *t)), "1", cams[-1]]))
            img.append("" if len(cams) % 3 == 1 else "1.0 2.0 -1")
    (job / "bake" / "colmap" / "images.txt").write_text("\n".join(img) + "\n")
    (job / "bake" / "colmap" / "cameras.txt").write_text(
        "# Camera list\n" + f"1 FULL_OPENCV {W} {H} {fx} {fx} {W / 2} {H / 2} {k1} {k2} {p1} {p2} {k3} 0 0 0\n")

    # the bake's output, truncated after meta: only meta is ever read
    (job / "bake" / "damage_points.json").write_text(
        '{"meta": {"alignment": {"axis": "zup_to_yup", "offset": [100.0, 200.0, 50.0], "rotation": "direct"}, '
        r'"x": [1, -2.5e-3, true, false, null, "q\"\u00e9"]}, "classes": {"Crack": [{"pos": [')
    (job / "inference" / "classes.txt").write_text("Crack\nSpalling\n")
    (job / "inference" / "thresholds.json").write_text(
        '{"classes": {"Crack": {"threshold": 0.9}, "Spalling": {"threshold": 0.5}}}')

    # the full run, as the app shows it: points.json + points.bin, y stored negated
    pts = np.concatenate([np.stack([np.arange(241) * 0.05, np.zeros(241), np.zeros(241)], 1),
                          np.tile([40.0, 10.0, 0.0], (20, 1)), np.tile([6.0, 0.5, 0.0], (20, 1))])
    pts[:, 1] *= -1
    n = len(pts)
    cid = np.array([0] * 261 + [1] * 20, np.int32)
    clu = np.array([0] * 241 + [1] * 20 + [2] * 20, np.int32)
    arr = lambda dt, shape, off: {"dtype": dt, "shape": shape, "offset": off}
    (content / "points.json").write_text(json.dumps({
        "arrays": {"position": arr("float32", [n, 3], 0), "class_id": arr("int32", [n], n * 12),
                   "cluster_id": arr("int32", [n], n * 16)},
        "handedness_fix": "negate_y", "cluster_distance_m": 0.1, "min_cluster_points": 5,
        "class_names": ["Crack", "Spalling"]}))
    (content / "points.bin").write_bytes(pts.astype(np.float32).tobytes() + cid.tobytes() + clu.tobytes())

    # the job's frozen parameters and the photos
    (work / "job_params.json").write_text(json.dumps({"project_id": "P", "job_id": "J", "values": values or {}}))
    shas = {name: hashlib.sha256(name.encode()).hexdigest() for name in [*cams, "DJI_99_9.JPG"]}
    (work / "photos.json").write_text(json.dumps([{"name": k, "sha256": v} for k, v in shas.items()]))
    path_of = {k: str(root / "assets" / v[:2] / v[2:4] / v) for k, v in shas.items()}

    c = core.Survey(str(root), str(work), grids or {}, roi_m)
    index_of = {path_of[k]: c.names.index(Path(k).stem.lower()) for k in cams}
    return SimpleNamespace(core=c, root=root, job=job, work=work, path_of=path_of, index_of=index_of)


def ref_cameras(s):   # the cameras in the bake frame, by the bake's own functions
    return bakeobj.apply_world_to_mesh(bakeobj.load_cameras_colmap(s.job / "bake" / "colmap"), "zup_to_yup",
                                       np.array([100.0, 200.0, 50.0]))


class Ref:
    """Today's Python on the same files: base selinf.py's Survey.setup (the geometry part), and its cast,
    project and visible verbatim."""

    def __init__(self, s):
        mesh = bakeobj.load_mesh(s.job / "bake" / "mesh.obj", cache_dir=s.root.parent / "meshcache")
        cams = ref_cameras(s)
        self.rmi, self.normals, self.max_dist = bakeobj.make_intersector(mesh), np.asarray(mesh.face_normals), 30.0
        self.cams, self.names = cams, sorted(cams)
        c = [cams[n] for n in self.names]
        self.O, self.R = np.stack([x["origin"] for x in c]), np.stack([x["R_c2w"] for x in c])
        self.fx, self.fy, self.cx, self.cy, self.W, self.H = (np.array([x[k] for x in c], float)
                                                              for k in ("fx", "fy", "cx", "cy", "W", "H"))
        self.dist5 = np.stack([np.asarray(x["dist"], float) for x in c])

    def cast(self, o, d):
        if not len(o):
            return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0, int), np.zeros(0)
        tri, ray, loc = self.rmi.intersects_id(o, d, multiple_hits=False, return_locations=True)
        dist = np.linalg.norm(loc - o[ray], axis=1) if len(loc) else np.zeros(0)
        k = dist <= self.max_dist
        return loc[k], self.normals[tri[k]], ray[k], dist[k]

    def project(self, P, ci):
        """Points -> pixels (OpenCV distortion, = the bake's lens model), per camera."""
        pc = np.einsum("knj,kji->kni", P[None] - self.O[ci][:, None], self.R[ci])
        z = pc[..., 2]
        x, y = pc[..., 0] / np.where(z > 1e-6, z, 1), pc[..., 1] / np.where(z > 1e-6, z, 1)
        k1, k2, p1, p2, k3 = (self.dist5[ci, j][:, None] for j in range(5))
        r2 = x * x + y * y
        rad = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
        u = self.fx[ci][:, None] * (x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)) + self.cx[ci][:, None]
        v = self.fy[ci][:, None] * (y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y) + self.cy[ci][:, None]
        return np.stack([u, v], -1), z

    def visible(self, P, N, ci, margin=0.0):
        """(K,N): in frame (shrunk by margin), facing within 75 deg, <= ray distance, unoccluded."""
        ci = np.asarray(ci)
        uv, z = self.project(P, ci)
        W, H = self.W[ci][:, None], self.H[ci][:, None]
        rel = self.O[ci][:, None] - P[None]
        dist = np.linalg.norm(rel, axis=-1)
        cos = np.einsum("knj,nj->kn", rel, N) / np.maximum(dist, 1e-9)
        ok = ((z > 0) & (uv[..., 0] >= W * margin) & (uv[..., 0] < W * (1 - margin)) & (uv[..., 1] >= H * margin)
              & (uv[..., 1] < H * (1 - margin)) & (dist <= self.max_dist) & (cos > np.cos(np.radians(75))))
        kk, nn = np.nonzero(ok)
        if kk.size:
            o = self.O[ci][kk]
            _, _, ray, d = self.cast(o, (P[nn] - o) / dist[kk, nn][:, None])
            hit = np.full(kk.size, np.inf)
            hit[ray] = d
            bad = hit < dist[kk, nn] - 0.03
            ok[kk[bad], nn[bad]] = False
        return ok, uv, dist, cos


def test_mesh_is_bakeobjs(tmp_path):
    s = make_survey(tmp_path)
    ref = bakeobj.load_mesh(s.job / "bake" / "mesh.obj", cache_dir=tmp_path / "cache")
    V, F = s.core.mesh()
    assert V.dtype == np.float64 and np.array_equal(V, ref.vertices)   # unreferenced v dropped, file order
    assert np.array_equal(F, ref.faces)


def test_cameras_are_bakeobjs(tmp_path):
    s = make_survey(tmp_path)
    ref = ref_cameras(s)
    got = s.core.cameras()
    assert sorted(got) == sorted(ref) == s.core.names and len(got) == 81
    for k, c in ref.items():
        for f in ("origin", "R_c2w", "dist"):
            assert np.array_equal(got[k][f], c[f]), (k, f)
        assert [got[k][f] for f in ("fx", "fy", "cx", "cy", "W", "H")] == [c[f] for f in ("fx", "fy", "cx", "cy", "W", "H")]


def test_a_missing_input_names_the_file(tmp_path):
    s = make_survey(tmp_path)
    (s.job / "bake" / "mesh.obj").unlink()
    with pytest.raises(RuntimeError, match="mesh.obj"):
        core.Survey(str(s.root), str(s.work), {})


def test_an_alignment_the_bake_cannot_reproduce_is_refused(tmp_path):
    s = make_survey(tmp_path)
    p = s.job / "bake" / "damage_points.json"
    p.write_text(p.read_text().replace('"direct"', '"probed"'))
    with pytest.raises(RuntimeError, match="forced-axis"):
        core.Survey(str(s.root), str(s.work), {})


def test_a_cluster_id_shorter_than_the_positions_is_refused(tmp_path):
    s = make_survey(tmp_path)
    p = s.root / "projects" / "P" / "content" / "points.json"
    h = json.loads(p.read_text())
    h["arrays"]["cluster_id"]["shape"] = [h["arrays"]["cluster_id"]["shape"][0] - 1]
    p.write_text(json.dumps(h))
    with pytest.raises(RuntimeError, match=r"points.json.*one row per position row"):
        core.Survey(str(s.root), str(s.work), {})


def test_pixel_dirs_are_bakeobjs(tmp_path):
    s = make_survey(tmp_path)
    cams, rng = s.core.cameras(), np.random.default_rng(0)
    px = np.r_[rng.uniform(0, 400, 2000), 0.0, 399.5, 0.5, 200.0]
    py = np.r_[rng.uniform(0, 300, 2000), 0.0, 299.5, 150.0, 150.0]
    for i in (0, 40, 80):
        assert np.array_equal(s.core.pixel_dirs(i, px, py), bakeobj.pixel_dirs(cams[s.core.names[i]], px, py))


def test_cast_is_trimeshs(tmp_path):
    s, rng = make_survey(tmp_path), np.random.default_rng(1)
    ref = Ref(s)
    T = np.c_[rng.uniform(-20, 30, 3000), rng.uniform(-14, 14, 3000), np.zeros(3000)]   # deck top
    T[:300, 0] = -24 + 15 * np.round((T[:300, 0] + 24) / 15)     # on the subdivided top's grid lines (x = -24 + 15k)
    T[300:600, 1] = -15 + 7.5 * np.round((T[300:600, 1] + 15) / 7.5)                       # (y = -15 + 7.5k)
    o = np.r_[ref.O[rng.integers(0, 81, 3000)], np.tile([6.0, 0, 40.0], (50, 1)), np.tile([6.0, 0, 3.0], (200, 1))]
    d = np.r_[T - o[:3000], np.tile([0, 0, -1.0], (50, 1)), rng.normal(size=(200, 3)) * [1, 1, 0] + [0, 0, 1.0]]
    for a, b in zip(s.core.cast(o, d), ref.cast(o, d)):            # beyond 30 m; upwards = misses
        assert np.array_equal(a, b)


def test_project_and_visible_are_todays(tmp_path):
    s, rng = make_survey(tmp_path), np.random.default_rng(2)
    ref = Ref(s)
    P = np.r_[np.c_[rng.uniform(-6, 18, 500), rng.uniform(-3, 3, 500), np.zeros(500)],
              np.c_[rng.uniform(0, 12, 50), rng.uniform(-1, 1, 50), np.full(50, -0.2)]]   # under the deck: occluded
    N = np.tile([0, 0, 1.0], (len(P), 1))
    N[::7] = [0.0, np.sin(np.radians(80)), np.cos(np.radians(80))]                      # past 75 deg for some views
    ci = np.arange(81)
    for a, b in zip(s.core.project(P, ci), ref.project(P, ci)):
        assert np.array_equal(a, b)
    for margin in (0.0, 0.12):
        for a, b in zip(s.core.visible(P, N, ci, margin), ref.visible(P, N, ci, margin)):
            assert np.array_equal(a, b)


def test_bake_is_run_bakes(tmp_path):
    s = make_survey(tmp_path)
    px = np.arange(0, 400 * 300, 5)
    rays = [(i, px % 400, px // 400) for i in (40, 41, 44, 41)]   # overlapping views; one photo twice
    names = [f"{s.core.names[i]}.png" for i, _, _ in rays]
    (tmp_path / "m.json").write_text(json.dumps([{"photo": n, "layer": "Crack", "pixels": np.c_[x, y].tolist()}
                                                 for n, (_, x, y) in zip(names, rays)]))
    bakeobj.run_bake(mesh_path=s.job / "bake" / "mesh.obj", colmap_dir=s.job / "bake" / "colmap",
                     masks_path=tmp_path / "m.json", out_path=tmp_path / "p.json", classes=["Crack", "Spalling"],
                     voxel=0.01, min_observations=1, auto_align=False, force_axis="zup_to_yup",
                     force_offset=[100.0, 200.0, 50.0], mesh_cache_dir=tmp_path / "cache")
    ref = json.loads((tmp_path / "p.json").read_text())["classes"]["Crack"]
    P, bits = s.core.bake(rays, "Crack")
    assert len(P) > 1000 and bits.max() > 8
    assert P.tolist() == [p["pos"] for p in ref]                                  # the same points, in its order
    assert np.bitwise_count(bits).tolist() == [p["votes"] for p in ref]
    assert all({x["photo"] for x in p["sources"]} <= {names[j] for j in range(4) if int(b) >> j & 1}
               for p, b in zip(ref, bits))


def test_keeps_only_the_cluster_at_the_click():
    P = np.array([[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [3, 0, 0], [3.1, 0, 0], [0.4, 0, 0]], float)
    cluster = np.array([0, 0, 0, 1, 1, -1])            # -1 = dropped by the min-size filter
    assert core.at_click(P, cluster, np.array([0.05, 0, 0])).tolist() == [1, 1, 1, 0, 0, 0]
    assert core.at_click(P, cluster, np.array([3.4, 0, 0])).tolist() == [0, 0, 0, 1, 1, 0]   # nearest within 0.5 m
    assert not core.at_click(P, cluster, np.array([1.5, 0, 0])).any()                       # nothing near the click


def test_clusters_are_the_cooks():
    rng, n = np.random.default_rng(0), 0
    for t in (0.1, 0.3):
        b = np.round(rng.uniform(0, 3, (800, 3)), 4)
        for P in (rng.uniform(0, rng.uniform(0.5, 4), (3000, 3)),               # dense to sparse
                  np.round(rng.integers(0, 30, (3000, 3)) * t / 3, 4),          # on cell boundaries
                  np.concatenate([b, b + [t, 0, 0], b + [0, 0, t]])):           # pairs exactly t apart
            assert np.array_equal(core.clusters(P, t, 3), _grid_cluster(P, np.zeros(len(P), np.int32), t, 3))
    for t in (0.1, 0.3) * 10:                           # random walks with breaks of 0.6-1.4 x the gap
        steps = rng.normal(0, 0.01, (4000, 3)) * [1, 1, 0.1]
        jump = rng.random(4000) < 0.03
        steps[jump] *= 100 * t * rng.uniform(0.6, 1.4, (jump.sum(), 1))
        P = np.round(np.cumsum(steps, 0), 4)
        ref = _grid_cluster(P, np.zeros(len(P), np.int32), t, 5)
        assert np.array_equal(core.clusters(P, t, 5), ref)
        n += ref.max() + 1
    assert n > 100


def ref_kept(s, mask, cls, i, seed, q, rr, near):   # base Survey.kept + maxpool, verbatim, with cv2
    cam = s.core.cameras()[s.core.names[i]]
    O_i, fx_i = cam["origin"], cam["fx"]
    DS, LINK, GAP_M, floor = 4, 2, {"Crack": 0.3}, {"Crack": 229, "Spalling": 127}[cls]
    m = mask
    b = (cv2.dilate(m.view(np.uint8), np.ones((DS, DS), np.uint8), anchor=(0, 0))[:m.shape[0] // DS * DS:DS, :m.shape[1] // DS * DS:DS] >= floor).astype(np.uint8)
    r = LINK
    if cls in GAP_M:
        r = int(np.clip(GAP_M[cls] / 2 * fx_i / np.linalg.norm(O_i - seed) / DS, LINK, 80))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1,) * 2)
    _, lab = cv2.connectedComponents(cv2.dilate(b, k), connectivity=8)
    L = lab.copy() if near and cls in GAP_M else lab
    lab[b == 0] = 0
    d, (hh, ww) = np.arange(-rr, rr + 1), lab.shape
    keep = np.unique(L[np.clip(q[:, 1, None, None] + d[:, None], 0, hh - 1), np.clip(q[:, 0, None, None] + d, 0, ww - 1)])
    return np.isin(lab, keep[keep > 0])


def test_kept_is_todays(tmp_path):
    s, rng = make_survey(tmp_path, fx=600.0, W=800, H=600), np.random.default_rng(3)
    for trial in range(40):
        m = cv2.dilate((rng.random((600, 800)) < 0.003).astype(np.uint8), np.ones((5, 5), np.uint8)) * 250
        p1, p2 = (tuple(map(int, rng.integers(0, (800, 600)))) for _ in range(2))
        cv2.line(m, p1, p2, int(rng.choice([128, 228, 229, 250])), 2)   # values around the floors
        i, seed = trial % 81, np.array([rng.uniform(0, 12), rng.uniform(-1, 1), 0.0])
        q, rr = rng.integers(-3, (203, 153), (int(rng.integers(1, 6)), 2)), int(rng.integers(0, 4))   # some off the grid
        for cls in ("Crack", "Spalling"):
            for near in (False, True):
                assert np.array_equal(s.core.kept(m, cls, i, seed, q, rr, near), ref_kept(s, m, cls, i, seed, q, rr, near))


# ---------------------------------------------------------------- the follow loop: today's tests on the core
def back_project(s, i, px, py):   # base Survey.back_project: photo i's pixels cast from its origin
    d = s.core.pixel_dirs(i, np.asarray(px, float), np.asarray(py, float))
    return s.core.cast(np.broadcast_to(s.core.cameras()[s.core.names[i]]["origin"], d.shape).copy(), d)


def strip(s, i):   # a 12 m crack strip along x, 10 cm wide, as photo i sees it
    X, Y = np.meshgrid(np.arange(400) + .5, np.arange(300) + .5)
    pos, _, ray, _ = back_project(s, i, X.ravel(), Y.ravel())
    m = np.zeros(400 * 300, np.uint8)
    on = (np.abs(pos[:, 1]) < 0.05) & (pos[:, 0] > 0) & (pos[:, 0] < 12)
    m[ray[on]] = 250
    return m.reshape(300, 400)


def strip_infer(s, reads):
    def infer(path, classes, tiles):   # the whole photo, whatever tiles are asked for
        i = s.index_of[path]
        if classes == ["Crack"]:   # a read of the followed class (the first look asks for every class)
            reads.append(i)
        return {c: strip(s, i) if c == "Crack" else np.zeros((300, 400), np.uint8) for c in classes}
    return infer


def grid(H, W, tile, overlap):   # = sliding_window.tile_origins on both axes (no torch here)
    o = lambda n: sorted(set(range(0, n - tile + 1, tile - overlap)) | {n - tile})
    return [(y, x) for y in o(H) for x in o(W)]


def exact(run, grid, tile, H, W):   # base: the pixels whose grid tiles all ran
    ok = np.ones((H, W), bool)
    for y, x in set(grid) - set(run):
        ok[y:y + tile, x:x + tile] = False
    return ok


def roi_infer(s, G, calls):
    """= a tiled model: only the listed grid tiles run; a pixel counts once all its tiles ran."""
    def infer(path, classes, tiles):
        i = s.index_of[path]
        out = {c: np.zeros((300, 400), np.uint8) for c in classes}
        if "Crack" in classes:
            out["Crack"] = strip(s, i)
            if tiles is not None:
                calls.append((i, tiles))
                out["Crack"] = np.where(exact(tiles, G, 50, 300, 400), out["Crack"], 0)
        return out
    return infer


def net_infer(s, reads, recall, same=False):
    """Map cracking: 36 short cracks on a 25 cm lattice (within the 30 cm gap of each other); each
    photo's mask finds a random `recall` share of them (the one at the click always), as a real
    crack mask finds 17-66 %. same: every photo finds the same ones."""
    cams = s.core.cameras()

    def infer(path, classes, tiles):
        i = s.index_of[path]
        W, H = cams[s.core.names[i]]["W"], cams[s.core.names[i]]["H"]
        X, Y = np.meshgrid(np.arange(W) + .5, np.arange(H) + .5)
        pos, _, ray, _ = back_project(s, i, X.ravel(), Y.ravel())
        a, b = np.round(pos[:, 0] / 0.25).astype(int), np.round(pos[:, 1] / 0.25).astype(int)
        found = np.random.default_rng(0 if same else i).random(36) < recall
        found[2 * 6 + 3] = True
        on = ((np.abs(pos[:, 0] - 0.25 * a) < 0.06) & (np.abs(pos[:, 1] - 0.25 * b) < 0.02) & (a >= 10) & (a <= 15)
              & (b >= -3) & (b <= 2) & found[np.clip(a - 10, 0, 5) * 6 + np.clip(b + 3, 0, 5)])
        m = np.zeros(W * H, np.uint8)
        m[ray[on]] = 250
        reads.append(i)
        return {c: m.reshape(H, W) if c == "Crack" else np.zeros((H, W), np.uint8) for c in classes}
    return infer


def test_follows_the_strip_to_both_ends(tmp_path):
    s, reads = make_survey(tmp_path), []
    photos, cls, stop, tracked = s.core.follow(np.array([6.0, 0, 0]), np.array([0, 0, 1.0]), strip_infer(s, reads))
    grow = [p for p, ph in photos if ph == "grow"]
    assert (cls, stop) == ("Crack", "complete")
    assert tracked[:, 0].min() < 0.5 and tracked[:, 0].max() > 11.5
    assert 3 <= len(grow) <= 8 and len(photos) < len(s.core.names) / 4
    assert len(set(reads)) == len(reads) == len(photos)          # every photo inferred once


def test_extra_views_fill_the_holes_then_stop(tmp_path):
    s = make_survey(tmp_path, fx=600.0, W=800, H=600)     # 5 mm/px: holes of a few cm are resolved
    photos, cls, stop, tracked = s.core.follow(np.array([3.0, 0, 0]), np.array([0, 0, 1.0]), net_infer(s, [], 0.3))
    found = np.unique(np.round(tracked[:, :2] / 0.25).astype(int), axis=0)
    assert (cls, stop) == ("Crack", "complete") and len(photos) < core.MAX_PHOTOS
    assert len(found) >= 33                                       # 1 - 0.7^n: the holes are filled
    photos, _, _, _ = s.core.follow(np.array([3.0, 0, 0]), np.array([0, 0, 1.0]), net_infer(s, [], 0.3, same=True))
    assert [ph for _, ph in photos].count("confirm") == core.FILL_DRY   # views that add nothing: stop


def test_clean_click_costs_three_photos(tmp_path):
    s, reads = make_survey(tmp_path), []
    photos, cls, stop, _ = s.core.follow(np.array([6.0, 2.0, 0]), np.array([0, 0, 1.0]), strip_infer(s, reads))
    assert (cls, stop, len(photos)) == (None, "no damage at the click", 1 + core.RETRIES)


def test_roi_follows_the_strip_through_fewer_tiles(tmp_path):
    s = make_survey(tmp_path, grids={"Crack": (50, 10)}, roi_m=0.2)
    seed, up, G = np.array([6.0, 0, 0]), np.array([0, 0, 1.0]), grid(300, 400, 50, 10)
    ref = s.core.follow(seed, up, strip_infer(s, []))                      # tiles ignored = whole photos
    calls = []
    photos, cls, stop, tracked = s.core.follow(seed, up, roi_infer(s, G, calls))
    assert (photos, cls, stop) == ref[:3]                                   # the same photos
    assert tracked[:, 0].min() < 0.5 and tracked[:, 0].max() > 11.5
    assert all(t == sorted(t, key=G.index) and len(set(t)) == len(t) for _, t in calls)   # grid order
    last = dict(calls)                                                      # per photo: its final tile list
    assert set(last) == {i for i, _ in photos} and sum(map(len, last.values())) < 0.6 * len(G) * len(last)


def decode(body):   # as lod-lite's selinf.js reads it
    n = int.from_bytes(body[:4], "little")
    return n, json.loads(body[4:4 + n]), np.frombuffer(body, "<f4", offset=4 + n).reshape(-1, 3)


def test_click_answers_as_the_viewer_reads(tmp_path):
    s = make_survey(tmp_path)
    n, head, xyz = decode(s.core.click([6.0, 0.3, 3.0], [0.0, -0.3, -3.0], strip_infer(s, [])))   # onto (6, 0, 0)
    assert n % 4 == 0 and (head["class"], head["stop"]) == ("Crack", "complete")
    assert list(head) == ["seed", "class", "stop", "points", "photos", "full", "seconds"]
    assert all(p["name"].startswith("DJI_") and p["tiles"] is None for p in head["photos"])
    k, f = head["points"]["Crack"], head["full"]["Crack"]
    P, F = xyz[:k], xyz[k:]
    assert k > 1000 and len(xyz) == k + f
    assert (np.abs(P[:, 1]) < 0.08).all() and P[:, 0].min() < 0.5 and P[:, 0].max() > 11.5
    assert np.array_equal(P, np.round(P.astype(float), 3).astype("<f4"))
    assert f == 241 and (np.abs(F[:, 1]) < 1e-6).all()            # the full run's crack cluster at the click, y restored
    line = json.loads((s.work / "clicks.jsonl").read_text().splitlines()[-1])
    assert line["points"] == {"Crack": k} and line["photos"] == head["photos"]


def test_a_click_that_finds_nothing_says_why(tmp_path):
    s = make_survey(tmp_path)
    _, head, xyz = decode(s.core.click([6.0, 0, 3.0], [0, 0, 1.0], strip_infer(s, [])))        # upwards
    assert head == {"error": "the click missed the bake mesh"} and len(xyz) == 0
    _, head, xyz = decode(s.core.click([34.0, 14.0, 3.0], [0, 0, -1.0], strip_infer(s, [])))   # deck, no camera there
    assert (head["class"], head["stop"], head["points"], head["full"]) == (None, "no photo sees the click", {}, {})


def test_a_bad_mask_is_an_error_naming_the_photo(tmp_path):
    s = make_survey(tmp_path)
    for bad, msg in ((lambda p, c, t: {}, "no mask for"),
                     (lambda p, c, t: {x: np.zeros((300, 401), np.uint8) for x in c}, "not uint8")):
        with pytest.raises(RuntimeError, match=rf"DJI_\d\d_\d: infer.*{msg}"):
            s.core.click([6.0, 0.3, 3.0], [0.0, -0.3, -3.0], bad)
    with pytest.raises(KeyError):   # any exception infer raises crosses the released GIL as itself
        s.core.click([6.0, 0.3, 3.0], [0.0, -0.3, -3.0], lambda p, c, t: {}[p])
    _, head, _ = decode(s.core.click([6.0, 0.3, 3.0], [0.0, -0.3, -3.0], strip_infer(s, [])))   # and the Survey still answers
    assert "error" not in head


def test_a_clicks_log_that_cannot_be_written_is_an_error(tmp_path):
    s = make_survey(tmp_path)
    (s.work / "clicks.jsonl").mkdir()    # the append cannot open it
    with pytest.raises(RuntimeError, match="clicks.jsonl"):
        s.core.click([6.0, 0.3, 3.0], [0.0, -0.3, -3.0], strip_infer(s, []))


def test_the_server_wants_the_login_and_serves_only_the_viewer(tmp_path):
    import selinf

    s = make_survey(tmp_path)
    site = tmp_path / "site"
    (site / "out" / "tiles").mkdir(parents=True)
    for f in ("viewer.html", "selinf.js", "out/tileset.json", "out/tiles/0.glb", "selinf.py", "job_params.json"):
        (site / f).write_text(f)
    srv = selinf.server(s.core, strip_infer(s, []), ["Crack"], site, port=0, auth="test:test")
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def get(path, login="test:test", body=None):
        head = {"Authorization": "Basic " + base64.b64encode(login.encode()).decode()} if login else {}
        try:
            with urlopen(Request(f"http://127.0.0.1:{srv.server_address[1]}{path}", body, head)) as r:
                return r.status, r.read()
        except HTTPError as e:
            return e.code, e.headers.get("WWW-Authenticate") if e.code == 401 else e.read()

    click = json.dumps({"origin": [6.0, 0.3, 3.0], "direction": [0.0, -0.3, -3.0]}).encode()
    try:
        for path, body in (("/", None), ("/out/tiles/0.glb", None), ("/health", None), ("/click", click)):
            assert get(path, None, body) == (401, 'Basic realm="lod-lite-selinf"')
            assert get(path, "test:wrong", body)[0] == 401
        assert get("/") == get("/viewer.html") == (200, b"viewer.html")
        assert get("/selinf.js") == (200, b"selinf.js") and get("/out/tiles/0.glb?x=1") == (200, b"out/tiles/0.glb")
        for path, kind in (("/", "text/html"), ("/selinf.js", "text/javascript"), ("/out/tileset.json", "application/json"),
                           ("/out/tiles/0.glb", "model/gltf-binary")):   # not the Windows registry's (a module needs JS)
            req = Request(f"http://127.0.0.1:{srv.server_address[1]}{path}",
                          headers={"Authorization": "Basic " + base64.b64encode(b"test:test").decode()})
            with urlopen(req) as r:
                assert r.headers["Content-Type"] == kind, path
        for path in ("/selinf.py", "/job_params.json", "/quit", "/out/../selinf.py", "/out/tiles/", "/source/a.obj"):
            assert get(path)[0] == 404, path
        try:
            urlopen(Request(f"http://127.0.0.1:{srv.server_address[1]}/viewer.html", method="HEAD"))
        except HTTPError as e:
            assert e.code == 405
        else:
            raise AssertionError("HEAD answered")
        assert json.loads(get("/health")[1]) == {"ok": True, "photos": len(s.core.names), "classes": ["Crack"]}
        code, body = get("/click", body=click)
        assert code == 200 and decode(body)[1]["class"] == "Crack"
        code, body = get("/click", body=b"{}")
        assert code == 500 and "error" in decode(body)[1]
    finally:
        srv.shutdown()
        srv.server_close()
