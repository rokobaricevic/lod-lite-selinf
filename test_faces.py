"""faces_core (faces.cpp) on synthetic meshes built with numpy: a closed box beam, a noisy I-girder, coplanar and
parallel webs, an empty box; the answer decoded as the wire format says (and as faces.js reads it); POST /faces.

    ./test.sh test        (builds faces_core, then runs this file with the worker venv)
"""

import base64
import json
import threading
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
import pytest

import faces_core


def decode(body):
    """uint32 LE n, n bytes of JSON header (n % 4 == 0), then each face's w*h uint8 mask (rows along v), unpadded."""
    n = int.from_bytes(body[:4], "little")
    head, at, masks = json.loads(body[4:4 + n]), 4 + n, []
    assert n % 4 == 0
    for f in head.get("faces", []):
        masks.append(np.frombuffer(body, np.uint8, f["w"] * f["h"], at).reshape(f["h"], f["w"]))
        at += f["w"] * f["h"]
    assert at == len(body)
    return head, masks


def rect(p0, a, b, step):   # a grid of triangles over p0 + [0,1] a + [0,1] b, its normal along a x b
    na, nb = (max(1, round(np.linalg.norm(x) / step)) for x in (a, b))
    I, J = np.meshgrid(np.arange(na + 1), np.arange(nb + 1), indexing="ij")
    V = np.asarray(p0, float) + (I.ravel() / na)[:, None] * a + (J.ravel() / nb)[:, None] * b
    k = (I[:-1, :-1] * (nb + 1) + J[:-1, :-1]).ravel()
    q00, q10, q11, q01 = k, k + nb + 1, k + nb + 2, k + 1
    return V, np.r_[np.c_[q00, q10, q11], np.c_[q00, q11, q01]]


def join(*parts):
    Vs, Fs, at = [], [], 0
    for V, F in parts:
        Vs.append(V), Fs.append(F + at)
        at += len(V)
    return np.concatenate(Vs), np.concatenate(Fs).astype(np.int64)


def beam(size, step, R=np.eye(3), at=(0, 0, 0)):   # a closed box, outward normals, rotated by R, centred at `at`
    h, parts = np.asarray(size, float) / 2, []
    for k in range(3):
        e = np.eye(3)
        a, b = e[(k + 1) % 3] * 2 * h[(k + 1) % 3], e[(k + 2) % 3] * 2 * h[(k + 2) % 3]
        for sign in (1, -1):
            p0 = sign * h[k] * e[k] - h[(k + 1) % 3] * e[(k + 1) % 3] - h[(k + 2) % 3] * e[(k + 2) % 3]
            parts.append(rect(p0, a, b, step) if sign > 0 else rect(p0, b, a, step))
    V, F = join(*parts)
    return V @ R.T + at, F


def split(V, F, center, axes, half, **kw):
    return decode(faces_core.Faces(V, F).split(center, axes, half, **kw))


def rot_z(deg):
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def check_frame(f, m):   # unit u, v; u x v = normal; the origin on the plane; the mask's own bounding rectangle
    n, u, v, o = (np.array(f[k]) for k in ("normal", "u", "v", "origin"))
    assert np.allclose([n @ n, u @ u, v @ v, n @ u, n @ v, u @ v], [1, 1, 1, 0, 0, 0], atol=1e-9)
    assert np.allclose(np.cross(u, v), n, atol=1e-9) and abs(n @ o - f["d"]) < 2e-3
    assert m.shape == (f["h"], f["w"]) and set(np.unique(m)) <= {0, 1}
    assert m[0].any() and m[-1].any() and m[:, 0].any() and m[:, -1].any()


def cell_centres(f, m):   # the world centres of a mask's covered cells
    j, i = np.nonzero(m)
    return np.array(f["origin"]) + ((i + 0.5)[:, None] * np.array(f["u"]) + (j + 0.5)[:, None] * np.array(f["v"])) * f["cell"]


# ---------------------------------------------------------------- (a) a closed 10 x 1 x 2 m box beam
def test_a_box_beam_is_six_faces():
    R, at, size = rot_z(30), np.array([500000.0, 5000000.0, 100.0]), np.array([10.0, 1.0, 2.0])   # far from 0: float32 holds
    V, F = beam(size, 0.05, R, at)
    head, masks = split(V, F, at, R.T, size / 2 + 0.2)
    assert head["tris"] == len(F) and len(head["faces"]) == 6 and head["ms"] >= 0
    want = sorted(((sign * R[:, k], at + sign * R[:, k] * size[k] / 2, np.prod(np.delete(size, k)), k)
                   for k in range(3) for sign in (1, -1)), key=lambda w: -w[2])   # normal, face centre, area, axis
    assert [f["area"] for f in head["faces"]] == pytest.approx([w[2] for w in want], rel=1e-3)
    assert sum(f["tris"] for f in head["faces"]) == len(F)
    for f, m in zip(head["faces"], masks):
        check_frame(f, m)
        n, c, area, k = next(w for w in want if np.dot(w[0], f["normal"]) > 0.999)
        assert np.allclose(f["normal"], n, atol=1e-6) and np.dot(f["normal"], c) == pytest.approx(f["d"], abs=2e-3)
        assert f["area"] == pytest.approx(area, rel=1e-3) and f["cell"] == 0.05
        assert m.sum() * f["cell"] ** 2 == pytest.approx(area, rel=0.1)                    # the mask covers the face
        local = (cell_centres(f, m) - at) @ R                                                # back in the beam's frame
        assert (np.abs(local) <= size / 2 + f["cell"]).all() and np.allclose(local[:, k], np.sign(n @ R[:, k]) * size[k] / 2, atol=2e-3)


def test_a_slabs_thin_edges_are_faces_too():   # each edge is 0.5 % of the area: kept while it can make a face
    V, F = beam((10.0, 10.0, 0.1), 0.05)
    head, _ = split(V, F, (0, 0, 0), np.eye(3), (5.5, 5.5, 0.5))
    assert [f["area"] for f in head["faces"]] == pytest.approx([100, 100, 1, 1, 1, 1], rel=1e-3)


def test_a_box_cuts_the_beam_and_a_coarse_grid_is_enlarged():
    V, F = beam((10.0, 1.0, 2.0), 0.05)
    head, masks = split(V, F, (2.0, 0, 0), np.eye(3), (1.0, 1, 2))     # x in [1, 3]: the 4 long sides, 2 m of each
    assert sorted(round(f["area"], 1) for f in head["faces"]) == [2.0, 2.0, 4.0, 4.0]
    for f, m in zip(head["faces"], masks):                              # clipped to the box's shadow
        x = cell_centres(f, m)[:, 0]
        assert x.min() > 0.95 and x.max() < 3.05
    head, masks = split(V, F, (0, 0, 0), np.eye(3), (6.0, 1, 2), cell_m=0.001)
    assert max(max(f["w"], f["h"]) for f in head["faces"]) <= 1024                  # whole millimetres: 10 m and 2 m
    assert sorted(f["cell"] for f in head["faces"]) == [0.002, 0.002] + [0.01] * 4


# ---------------------------------------------------------------- (b) an I-girder, +-5 mm vertex noise
I_SECTION = [(-0.4, 0), (0.4, 0), (0.4, 0.15), (0.1, 0.15), (0.1, 1.35), (0.4, 1.35), (0.4, 1.5), (-0.4, 1.5),
             (-0.4, 1.35), (-0.1, 1.35), (-0.1, 0.15), (-0.4, 0.15)]   # (y, z), counter-clockwise seen from +x


def test_an_i_girder_with_noise_is_its_twelve_faces():
    L, P = 8.0, np.array(I_SECTION)
    parts = [rect((0, *p), np.r_[0, q - p], np.r_[L, 0, 0], 0.05) for p, q in zip(P, np.roll(P, -1, 0))]
    V, F = join(*parts)
    V = V + np.random.default_rng(1).uniform(-0.005, 0.005, V.shape)
    head, masks = split(V, F, (4.0, 0, 0.75), np.eye(3), (3.0, 0.6, 0.9))   # 6 m of it, not its ends
    want = []
    for p, q in zip(P, np.roll(P, -1, 0)):
        n = np.r_[0, q[1] - p[1], p[0] - q[0]] / np.linalg.norm(q - p)
        want.append((n, n @ np.r_[0, p], 6.0 * np.linalg.norm(q - p)))
    assert len(head["faces"]) == 12
    left = list(range(12))
    for f, m in zip(head["faces"], masks):                             # each face is one side of the section
        check_frame(f, m)
        near = [i for i in left if np.dot(want[i][0], f["normal"]) > np.cos(np.radians(3)) and abs(want[i][1] - f["d"]) < 0.01]
        i = min(near, key=lambda i: abs(want[i][2] - f["area"]))
        assert f["area"] == pytest.approx(want[i][2], rel=0.08), (f, want[i])
        left.remove(i)
    assert left == []


# ---------------------------------------------------------------- (c) parallel webs
def test_coplanar_webs_two_metres_apart_are_two_faces():
    V, F = join(rect((0, 0, 0), np.r_[0, 1.0, 0], np.r_[0, 0, 3.0], 0.05),
                rect((0, 3, 0), np.r_[0, 1.0, 0], np.r_[0, 0, 3.0], 0.05))
    head, masks = split(V, F, (0, 2, 1.5), np.eye(3), (0.5, 2.5, 2))
    assert [(f["normal"], f["d"], f["area"]) for f in head["faces"]] == [([1, 0, 0], 0, 3.0)] * 2
    assert sorted(round(cell_centres(f, m)[:, 1].mean(), 2) for f, m in zip(head["faces"], masks)) == [0.5, 3.5]


def test_parallel_webs_split_by_offset_only_past_the_gap():
    web = lambda x: rect((x, 0, 0), np.r_[0, 1.0, 0], np.r_[0, 0, 3.0], 0.05)   # noqa: E731
    V, F = join(web(0.0), web(2.0))
    head, _ = split(V, F, (1, 0.5, 1.5), np.eye(3), (1.5, 1, 2))
    assert [f["d"] for f in head["faces"]] in ([0, 2], [2, 0])
    V, F = join(web(0.0), web(0.03))                                   # 3 cm apart: one plane at gap_m = 5 cm
    head, _ = split(V, F, (0, 0.5, 1.5), np.eye(3), (1, 1, 2))
    assert len(head["faces"]) == 1 and head["faces"][0]["d"] == 0.015 and head["faces"][0]["area"] == pytest.approx(6)
    head, _ = split(V, F, (0, 0.5, 1.5), np.eye(3), (1, 1, 2), gap_m=0.02)
    assert len(head["faces"]) == 2


# ---------------------------------------------------------------- (d) nothing in the box, and bad arguments
def test_an_empty_box_is_no_faces():
    V, F = beam((10.0, 1.0, 2.0), 0.1)
    head, masks = split(V, F, (100, 0, 0), np.eye(3), (1, 1, 1))
    assert head["faces"] == [] and head["tris"] == 0 and masks == []
    head, _ = split(V, F, (0, 0, 0), np.eye(3), (0.3, 0.3, 0.3))         # inside the beam: no surface
    assert head["faces"] == [] and head["tris"] == 0
    head, _ = decode(faces_core.Faces(np.zeros((0, 3)), np.zeros((0, 3), np.int64)).split((0, 0, 0), np.eye(3), (1, 1, 1)))
    assert head["faces"] == [] and head["tris"] == 0
    head, _ = split(V, F, (0, 0, 0), np.eye(3), (6, 1, 2), min_area_m2=100)   # every face below min_area_m2
    assert head["faces"] == [] and head["tris"] == len(F)


def test_bad_arguments_raise_value_error():
    f = faces_core.Faces(*beam((1.0, 1.0, 1.0), 0.1))
    for args, kw in ((((0, 0), np.eye(3), (1, 1, 1)), {}), (((0, 0, 0), np.eye(3) * 2, (1, 1, 1)), {}),
                     (((0, 0, 0), np.eye(3), (1, 0, 1)), {}), (((0, 0, 0), np.eye(3), (1, 1, 1)), {"angle_deg": 0}),
                     (((0, 0, 0), np.eye(3), (1, 1, 1)), {"cell_m": -1}), (((np.nan, 0, 0), np.eye(3), (1, 1, 1)), {})):
        with pytest.raises(ValueError):
            f.split(*args, **kw)
    with pytest.raises(ValueError, match="vertex 3"):
        faces_core.Faces(np.zeros((3, 3)), np.array([[0, 1, 3]]))


# ---------------------------------------------------------------- speed
def test_a_million_noisy_triangles_in_the_box():
    V, F = beam((10.0, 1.0, 2.0), 0.0112)                              # 1.1 cm triangles, +-2 mm: ~6 % tilt past 20 deg
    V = V + np.random.default_rng(2).uniform(-0.002, 0.002, V.shape)   # and land as sparse noise faces: not kept
    assert len(F) > 1_000_000
    f = faces_core.Faces(V, F)
    head = min((decode(f.split((0, 0, 0), np.eye(3), (5.5, 1, 1.5)))[0] for _ in range(3)), key=lambda h: h["ms"])
    print(f"\nfaces: {head['tris']} triangles in the box, split in {head['ms']} ms")
    assert head["tris"] == len(F) and head["ms"] < 1000
    assert [f["area"] for f in head["faces"]] == pytest.approx([20, 20, 10, 10, 2, 2], rel=0.05)


# ---------------------------------------------------------------- POST /faces
def test_the_server_answers_faces(tmp_path):
    import selinf

    V, F = beam((10.0, 1.0, 2.0), 0.1)
    core = SimpleNamespace(names=[])
    on = selinf.server(core, None, [], tmp_path, port=0, auth="test:test", faces=faces_core.Faces(V, F))
    off = selinf.server(core, None, [], tmp_path, port=0, auth="test:test")
    for srv in (on, off):
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    def post(srv, body, login="test:test"):
        head = {"Authorization": "Basic " + base64.b64encode(login.encode()).decode(), "Content-Type": "text/plain"}
        try:
            with urlopen(Request(f"http://127.0.0.1:{srv.server_address[1]}/faces", body, head)) as r:
                return r.status, r.read()
        except HTTPError as e:
            return e.code, e.read()

    box = {"center": [0, 0, 0], "axes": np.eye(3).tolist(), "half": [6, 1, 2]}
    try:
        code, body = post(on, json.dumps(box).encode())
        (head, masks), (ref, ref_masks) = decode(body), decode(faces_core.Faces(V, F).split(**box))
        assert code == 200 and len(head["faces"]) == 6 and {**head, "ms": 0} == {**ref, "ms": 0}
        assert all(np.array_equal(a, b) for a, b in zip(masks, ref_masks))
        code, body = post(on, json.dumps({**box, "cell_m": 0.1, "min_area_m2": 5}).encode())
        assert code == 200 and [f["cell"] for f in decode(body)[0]["faces"]] == [0.1] * 4
        assert post(on, json.dumps(box).encode(), "test:wrong")[0] == 401
        for bad in (b"{", b"[]", json.dumps({"center": [0, 0, 0]}).encode(), json.dumps({**box, "angle": 5}).encode(),
                    json.dumps({**box, "half": [1, 1]}).encode(), json.dumps({**box, "axes": [[1, 1, 0]] * 3}).encode(),
                    json.dumps({**box, "cell_m": "x"}).encode()):
            code, body = post(on, bad)
            assert code == 400 and list(decode(body)[0]) == ["error"], bad
        code, body = post(off, json.dumps(box).encode())
        assert code == 503 and list(decode(body)[0]) == ["error"]
        (tmp_path / "faces.js").write_text("faces.js")                    # the viewer's half: served, never stored
        login = {"Authorization": "Basic " + base64.b64encode(b"test:test").decode()}
        with urlopen(Request(f"http://127.0.0.1:{on.server_address[1]}/faces.js", headers=login)) as r:
            assert r.read() == b"faces.js" and r.headers["Cache-Control"] == "no-store"
            assert r.headers["Content-Type"] == "text/javascript"
    finally:
        for srv in (on, off):
            srv.shutdown()
            srv.server_close()
