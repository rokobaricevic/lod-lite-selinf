"""lod.py's simplification: what counts as a seam, what stays pinned, the error budget, a leaf's second index list.
    uv run --no-project --with numpy --with scipy --with numba --with xatlas --with meshoptimizer --with pillow --with pytest pytest test_lod.py
"""
import json
import struct

import numpy as np

import lod


def grid(n, height=None):
    """An n x n grid of quads in the z = 0 plane (or z = height(x, y)): positions and triangles."""
    x, y = np.meshgrid(np.arange(n + 1, dtype=np.float32), np.arange(n + 1, dtype=np.float32))
    z = np.zeros_like(x) if height is None else height(x, y).astype(np.float32)
    q = (np.arange(n)[None, :] + (n + 1) * np.arange(n)[:, None]).ravel()
    a, b, c, d = q, q + 1, q + n + 1, q + n + 2
    return np.stack([x.ravel(), y.ravel(), z.ravel()], 1), np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, d], 1)]).astype(np.uint32)


def test_outside_is_the_vertices_faces_elsewhere_also_use():
    pos, faces = grid(4)
    G = {"fp": faces, "uses": np.bincount(faces.ravel())}
    left = np.flatnonzero(pos[faces].mean(1)[:, 0] < 2)
    assert np.array_equal(lod.outside(left, G), np.flatnonzero(pos[:, 0] == 2))


def test_outside_of_the_whole_mesh_is_nothing():
    pos, faces = grid(4)
    G = {"fp": faces, "uses": np.bincount(faces.ravel())}
    assert len(lod.outside(np.arange(len(faces)), G)) == 0


def test_only_locked_vertices_are_pinned():
    pos, faces = grid(20)
    lock = pos[:, 0] == 10  # the seam; the grid's outer edge is a free border, like a hole in the scan
    dst, _ = lod.simplify(pos, faces, lock, 1, 1e6)
    assert np.flatnonzero(lock).tolist() == sorted(set(dst.tolist()) & set(np.flatnonzero(lock).tolist()))
    assert len(dst) / 3 < 150  # of 800: only the seam's fan is left to hold


def test_simplify_stops_at_the_error_budget():
    pos, faces = grid(20, lambda x, y: 0.5 * np.sin(x * 1.3) * np.cos(y * 0.9))
    none = np.zeros(len(pos), bool)
    tight, e_tight = lod.simplify(pos, faces, none, 1, 0.02)
    loose, e_loose = lod.simplify(pos, faces, none, 1, 0.3)
    assert e_tight <= 0.02 and e_loose <= 0.3
    assert len(tight) > len(loose)


def test_simplify_stops_at_the_triangle_count():
    pos, faces = grid(20, lambda x, y: 0.5 * np.sin(x * 1.3) * np.cos(y * 0.9))
    dst, _ = lod.simplify(pos, faces, np.zeros(len(pos), bool), 100, 1e6)
    assert len(dst) / 3 <= 100


def test_attributes_count_in_metres():
    pos, faces = grid(20)  # flat: only the attribute can cost anything; it wobbles by 0.1 m
    rng = np.random.default_rng(1)
    attr = pos[:, :2] + rng.uniform(-0.1, 0.1, (len(pos), 2))
    none = np.zeros(len(pos), bool)
    held, e_held = lod.simplify(pos, faces, none, 1, 0.01, attr)
    free, _ = lod.simplify(pos, faces, none, 1, 1.0, attr)
    assert e_held <= 0.01 and len(held) / 3 > 400
    assert len(free) / 3 < 20


def glb_json(path):
    b = path.read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20:20 + n])


def test_glb_holds_the_simplified_list_after_the_full_one(tmp_path):
    pos, faces = grid(10)
    lite = faces[:40]
    lod.write_glb(tmp_path / "a.glb", pos, pos[:, :2] / 10, faces, b"\0" * 8, lite, 0.002)
    g = glb_json(tmp_path / "a.glb")
    p = g["meshes"][0]["primitives"][0]
    assert p["extras"]["fullCount"] == faces.size
    assert abs(p["extras"]["liteErr"] - 0.002) < 1e-9
    assert g["accessors"][p["indices"]]["count"] == faces.size + lite.size


def test_glb_without_a_simplified_list_has_no_extras(tmp_path):
    pos, faces = grid(10)
    lod.write_glb(tmp_path / "a.glb", pos, pos[:, :2] / 10, faces, b"\0" * 8)
    g = glb_json(tmp_path / "a.glb")
    p = g["meshes"][0]["primitives"][0]
    assert "extras" not in p
    assert g["accessors"][p["indices"]]["count"] == faces.size
