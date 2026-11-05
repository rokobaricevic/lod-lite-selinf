"""faces_core (faces.cpp) on synthetic meshes made to look like the real bake mesh: triangles of 8-30 cm, +-5 mm vertex
noise, ~10 % of the surface missing in round patches (holes), unrelated clutter nearby. A deck slab on two girders with
a duct under it, a pier; the answer's JSON as the contract says; POST /element.

    ./test.sh test        (builds faces_core, then runs this file with the worker venv)

The real mesh is the judge: probe_faces.py clicks elements of the bridge and draws what element makes of them.
"""

import base64
import json
import threading
import time
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
import pytest

import faces_core

FAR = np.array([500000.0, 5000000.0, 100.0])   # the bake frame's large coordinates: float32 must still hold


def rect(p0, a, b, step):   # a grid of triangles over p0 + [0,1] a + [0,1] b, the normal along a x b
    a, b = np.asarray(a, float), np.asarray(b, float)
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


def quad(rng, p0, a, b, step=None):   # one face, of triangles of a random size in 8-30 cm (the bake mesh's)
    return rect(p0, a, b, step or rng.uniform(0.08, 0.30))


def box(rng, lo, hi, skip=(), step=None):   # an axis-aligned box's faces, outward; skip some: "x-", "z+"...
    lo, hi, parts = np.asarray(lo, float), np.asarray(hi, float), []
    for k in range(3):
        i, j = (k + 1) % 3, (k + 2) % 3
        a, b = np.eye(3)[i] * (hi[i] - lo[i]), np.eye(3)[j] * (hi[j] - lo[j])
        for sign, name in ((1, "+"), (-1, "-")):
            if "xyz"[k] + name not in skip:
                p0 = np.where(np.arange(3) == k, hi if sign > 0 else lo, lo)
                parts.append(quad(rng, p0, a, b, step) if sign > 0 else quad(rng, p0, b, a, step))
    return join(*parts)


def scanned(rng, V, F, holes=0.10, noise=0.005, R=np.eye(3)):
    """The mesh as the scan has it: vertices moved by up to +-noise, `holes` of its area deleted in round patches of
    20-60 cm, then turned by R and moved to FAR."""
    V = V + rng.uniform(-noise, noise, V.shape)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    area, cen = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2, (a + b + c) / 3
    keep, gone = np.ones(len(F), bool), 0.0
    while gone < holes * area.sum():
        r, p = rng.uniform(0.2, 0.6), cen[rng.integers(len(F))]
        hit = keep & (np.linalg.norm(cen - p, axis=1) < r)
        keep &= ~hit
        gone += area[hit].sum()
    return V @ R.T + FAR, F[keep]


def rot_z(deg):
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def angle(a, b):   # degrees between two axes (either way along them)
    return np.degrees(np.arccos(min(1.0, abs(np.dot(a, b)) / np.linalg.norm(a) / np.linalg.norm(b))))


# ---------------------------------------------------------------- the scenes (local frame: x along the bridge, z up)
GIRDERS = ((-2.25, -1.75), (1.75, 2.25))   # two 0.5 m girders, 0.8 m deep, under a 20 x 8 m slab 0.25 m thick
DUCT = ((0.5, 19.5), (0.4, 1.2), (-1.1, -0.5))   # a box duct hanging under the slab: x, y, z


def deck(rng):
    """The slab (x 0..20, y -4..4, z 0..0.25) on the girders (z -0.8..0, their ends hidden), the duct (its ends seen);
    clutter: railing posts, a pipe beside the left girder, a few loose boxes, the ground."""
    parts = [box(rng, (0, -4, 0), (20, 4, 0.25), skip=("z-",))]
    edges = [-4, GIRDERS[0][0], GIRDERS[0][1], GIRDERS[1][0], GIRDERS[1][1], 4]
    for y0, y1 in zip(edges[::2], edges[1::2]):   # the soffit between and beside the girders
        parts.append(quad(rng, (0, y0, 0), (0, y1 - y0, 0), (20, 0, 0)))
    for y0, y1 in GIRDERS:
        parts.append(box(rng, (0, y0, -0.8), (20, y1, 0), skip=("z+", "x-", "x+")))
    parts.append(box(rng, *zip(*DUCT)))
    for x in np.arange(1, 20, 1.5):                                                  # railing posts
        parts.append(box(rng, (x, -3.9, 0.25), (x + 0.08, -3.82, 1.25), step=0.04))
    parts.append(box(rng, (0, -3.2, -0.35), (20, -3.0, -0.15)))                      # a pipe beside the left girder
    for _ in range(6):                                                               # loose boxes on the ground
        p = rng.uniform((0, -6, -3), (20, 6, -2.5))
        parts.append(box(rng, p, p + rng.uniform(0.2, 0.6, 3)))
    parts.append(quad(rng, (-5, -10, -3), (30, 0, 0), (0, 20, 0)))                   # the ground
    return join(*parts)


def pier(rng):   # a 1.2 x 0.8 m pier, 5 m tall, between the ground and a cap; a lamp post beside it
    return join(box(rng, (-0.6, -0.4, 0), (0.6, 0.4, 5), skip=("z-", "z+")), box(rng, (-1.5, -1.5, 5), (1.5, 1.5, 5.6)),
                quad(rng, (-5, -5, 0), (10, 0, 0), (0, 10, 0)), box(rng, (2.0, 1.0, 0), (2.15, 1.15, 4), step=0.05))


class Scene:
    """A mesh in the bake frame, made in a local one: local = R^T (bake - FAR)."""

    def __init__(self, V, F, R):
        self.faces, self.R, self.V, self.F = faces_core.Faces(V, F), R, V, F

    def at(self, *p):
        return FAR + self.R @ np.array(p, float)

    def local(self, P):
        return (np.asarray(P, float) - FAR) @ self.R

    def element(self, p, d, **kw):
        return json.loads(self.faces.element(self.at(*p), self.R @ np.asarray(d, float), **kw))


@pytest.fixture(scope="module")
def slab():
    rng = np.random.default_rng(1)
    R = rot_z(23.5)   # the real bridge's long axis is 23.5 deg off x
    return Scene(*scanned(rng, *deck(rng), R=R), R)


GIRDER_BOTTOM = ((10, -2.0, -0.8), (0, 0, 1))   # a click on the left girder's bottom, looking up
SOFFIT = ((10, 0.0, 0.0), (0, 0, 1))


def side_faces(r):
    return [f for f in r["faces"] if f["key"][0] != "c"]


def check(r):
    """The answer as the contract says: the frame orthonormal, every candidate a line, the pieces' corners on their
    segments' lines, every side face a rectangle of edge x [s0, s1] on its segment's plane."""
    o, a, e1, e2 = (np.array(r[k]) for k in ("origin", "axis", "e1", "e2"))
    assert np.allclose([a @ a, e1 @ e1, e2 @ e2, a @ e1, a @ e2, e1 @ e2], [1, 1, 1, 0, 0, 0], atol=1e-9)
    assert np.allclose(np.cross(e1, e2), a, atol=1e-9) and r["s0"] < r["s1"] and r["auto"][0] < r["auto"][1]
    segs = r["segments"]
    assert [g["key"] for g in segs] == list(range(len(segs))) and sum(g["seed"] for g in segs) == 1
    for g in segs:
        assert np.linalg.norm(g["n"]) == pytest.approx(1, abs=1e-9) and g["t"][0] < g["t"][1] and g["area"] > 0
    keys = {}
    for pc in r["pieces"]:
        uv, edges = np.array(pc["uv"]), pc["edges"]
        assert len(edges) == (len(uv) if pc["closed"] else len(uv) - 1) and [int(k[1:]) for k in edges if k[0] == "s"] == pc["keys"]
        for i, k in enumerate(edges):
            p, q = uv[i], uv[(i + 1) % len(uv)]
            keys[k] = (p, q)
            if k[0] == "s":   # on its segment's line, within the rounding
                g = segs[int(k[1:])]
                assert g["on"] and abs(np.dot(g["n"], p) - g["c"]) < 3e-3 and abs(np.dot(g["n"], q) - g["c"]) < 3e-3
    for f in r["faces"]:
        P, n = np.array(f["points"]), np.array(f["normal"])
        assert np.linalg.norm(n) == pytest.approx(1, abs=1e-9)
        if f["key"][0] == "c":   # a cap: the closed profile at its end, facing out along the axis
            assert f["key"] in ("cap0", "cap1") and f["seg"] is None and len(P) >= 3
            assert np.allclose(P @ a - o @ a, r["s1"] if f["key"] == "cap1" else r["s0"], atol=2e-3)
            assert np.dot(n, a) == pytest.approx(1 if f["key"] == "cap1" else -1)
            continue
        assert abs(np.dot(n, a)) < 1e-9 and len(P) == 4
        p, q = keys[f["key"]]
        for k, (uv, s) in enumerate(((p, r["s0"]), (q, r["s0"]), (p, r["s1"]), (q, r["s1"]))):
            assert np.allclose(P[k], o + uv[0] * e1 + uv[1] * e2 + s * a, atol=2e-3)
        assert f["width"] == pytest.approx(np.linalg.norm(q - p), abs=2e-3) and f["length"] == pytest.approx(r["s1"] - r["s0"], abs=2e-3)
        assert f["area"] == pytest.approx(f["width"] * f["length"], rel=1e-3, abs=max(1e-3, 6e-4 * f["length"]))   # widths are to the mm
        assert 0 <= f["coverage"] <= 1
        if f["seg"] is not None:
            assert f["key"] == f"s{f['seg']}" and np.allclose(n, segs[f["seg"]]["n"][0] * e1 + segs[f["seg"]]["n"][1] * e2, atol=1e-9)
    return r


# ---------------------------------------------------------------- (a) a girder: its bottom and both webs
def test_a_a_girder_is_its_bottom_and_both_webs(slab):
    r = check(slab.element(*GIRDER_BOTTOM))
    assert angle(slab.R.T @ r["axis"], (1, 0, 0)) < 0.5 and len(slab.faces.frame) == 3
    assert angle(slab.faces.frame[0], slab.R[:, 0]) < 0.5                   # the global frame: L along the bridge
    faces = side_faces(r)
    assert len(faces) == 3 and len(r["faces"]) == 3 and len(r["pieces"]) == 1 and not r["pieces"][0]["closed"]
    normals = sorted(tuple(np.round(slab.R.T @ f["normal"]).astype(int)) for f in faces)
    assert normals == [(0, -1, 0), (0, 0, -1), (0, 1, 0)]                   # a web, the bottom, the other web
    o, e1, e2 = (np.array(r[k]) for k in ("origin", "e1", "e2"))
    corners = [slab.local(o + u * e1 + v * e2) for u, v in r["pieces"][0]["uv"]]
    want = {(-2.25, -0.8), (-1.75, -0.8)}   # where the webs meet the bottom: within 1 cm
    for y, z in want:
        assert min(np.hypot(c[1] - y, c[2] - z) for c in corners) < 0.01
    tops = [c for c in corners if c[2] > -0.5]   # the webs end at the soffit: those corners are concave, not followed
    assert len(tops) == 2 and all(abs(c[2]) < 0.06 for c in tops)
    assert r["s0"] == pytest.approx(-10, abs=0.3) and r["s1"] == pytest.approx(10, abs=0.3) and r["auto"] == [r["s0"], r["s1"]]
    assert all(f["coverage"] > 0.6 for f in faces) and r["rms"] < 0.01 and r["tris"] > 100 and r["ms"] >= 0


def test_a_a_click_on_a_web_gives_the_same_girder(slab):
    r = check(slab.element((10, -2.25, -0.4), (0, 1, 0)))
    faces = side_faces(r)
    assert len(faces) == 3 and angle(slab.R.T @ r["axis"], (1, 0, 0)) < 0.5
    assert sorted(round(f["width"], 1) for f in faces) == [0.5, 0.8, 0.8]


def test_a_the_click_is_where_the_view_ray_hits(slab):
    """The viewer's point comes from the LOD tile it shows, up to ~1 % of the distance off the bake mesh (7-12 cm at 7 m).
    A point 8 cm past the left girder's outer web along the view ray, 4 cm above its bottom edge -- inside the girder,
    nearer its bottom face than its web --: the ray hits the web, so the web is the seed and the origin is on it."""
    d = np.array((0, 1, 0.15)) / np.linalg.norm((0, 1, 0.15))
    for x in (4, 10, 16):
        hit = np.array((x, -2.25, -0.76))
        r = check(slab.element(hit + 0.08 * d, d))
        seed = next(g for g in r["segments"] if g["seed"])
        e1, e2 = np.array(r["e1"]), np.array(r["e2"])
        assert np.allclose(slab.R.T @ (seed["n"][0] * e1 + seed["n"][1] * e2), (0, -1, 0), atol=0.02)   # the web
        assert np.allclose(slab.local(r["origin"]), hit, atol=0.01)                                   # on it


WEB = 0.02   # half a steel web's thickness: its two skins 4 cm apart


def igirder(rng):
    """A riveted steel I-girder along x (0..20) as Petrinja's: web skins at y = -+WEB from z -0.45 to 1.64, flanges 0.5 x
    0.06. A deck slab 0.9 m thick joins its inner skin (y > 0) from z -0.1 to 0.8; a sidewalk slab its outer skin from 0.6
    to 0.95: the scan sees each skin in two parts, 0.9 and 0.35 m apart. rect's normal is along a x b."""
    q = lambda p0, a, b, step=None: quad(rng, p0, a, b, step)  # noqa: E731
    X, Y, Z = (20, 0, 0), (lambda w: (0, w, 0)), (lambda h: (0, 0, h))
    return join(q((0, -0.25, 1.70), X, Y(0.5)),                                      # the top flange: top, undersides, tips
                q((0, -0.25, 1.64), Y(0.25 - WEB), X), q((0, WEB, 1.64), Y(0.25 - WEB), X),
                q((0, -0.25, 1.64), X, Z(0.06), 0.04), q((0, 0.25, 1.64), Z(0.06), X, 0.04),
                q((0, -WEB, 0.95), X, Z(0.69)), q((0, -WEB, -0.45), X, Z(1.05)),      # the web's outer skin, the sidewalk's slab
                q((0, WEB, 0.8), Z(0.84), X), q((0, WEB, -0.45), Z(0.35), X),         # its inner skin, the deck between
                q((0, -0.25, -0.45), X, Y(0.25 - WEB)), q((0, WEB, -0.45), X, Y(0.25 - WEB)),   # the bottom flange: tops,
                q((0, -0.25, -0.51), Y(0.5), X),                                     # bottom, tips
                q((0, -0.25, -0.51), X, Z(0.06), 0.04), q((0, 0.25, -0.51), Z(0.06), X, 0.04),
                q((0, WEB, 0.8), X, Y(3 - WEB)), q((0, WEB, -0.1), Y(3 - WEB), X), q((0, 3, -0.1), Z(0.9), X),   # the deck
                q((0, -2, 0.95), X, Y(2 - WEB)), q((0, -2, 0.6), Y(2 - WEB), X), q((0, -2, 0.6), X, Z(0.35), 0.05),   # sidewalk
                q((-5, -6, -3), (30, 0, 0), (0, 12, 0)))                             # the ground


def test_a_an_i_girder_is_one_closed_i_from_anywhere_on_it():
    """Thin plates: a web's two skins 4 cm apart and a flange's are each one plate; the chain turns the I's concave
    corners (web to flange) and the collinear parts of a skin are one face across the slab joining it (0.9 and 0.35 m).
    Any click on the girder -- either skin above and below the slabs, the bottom -- gives the same closed I of 12 faces;
    a click on the deck or on the sidewalk gives that slab, not the girder."""
    rng = np.random.default_rng(5)
    scene = Scene(*scanned(rng, *igirder(rng), R=rot_z(23.5)), rot_z(23.5))
    want = [0.06] * 4 + [0.235] * 4 + [0.51] * 2 + [2.09] * 2   # tips, flanges' tops and undersides, top and bottom, webs
    for p, d in (((10, -WEB, 1.2), (0, 1, 0)), ((6, -WEB, 0.0), (0, 1, 0.1)), ((12, WEB, 1.2), (0, -1, 0)),
                 ((8, WEB, -0.25), (0, -1, 0.1)), ((14, WEB, -0.35), (0.2, -1, 0.1)), ((9, -0.1, -0.51), (0, 0, 1))):
        r = check(scene.element(p, d))
        assert angle(scene.R.T @ r["axis"], (1, 0, 0)) < 0.5 and len(r["pieces"]) == 1 and r["pieces"][0]["closed"], p
        assert np.allclose(sorted(f["width"] for f in side_faces(r)), want, atol=0.02), (p, sorted(f["width"] for f in side_faces(r)))
        assert r["s1"] - r["s0"] == pytest.approx(20, abs=0.3)
        o, e1, e2 = (np.array(r[k]) for k in ("origin", "e1", "e2"))
        corners = np.array([scene.local(o + u * e1 + v * e2)[1:] for u, v in r["pieces"][0]["uv"]])
        assert np.all(np.abs(corners[:, 0]) < 0.26) and corners[:, 1].min() == pytest.approx(-0.51, abs=0.01)
        assert corners[:, 1].max() == pytest.approx(1.70, abs=0.01)
    for p, y in (((10, 1.5, -0.1), (0.0, 3.01)), ((10, -1, 0.95), (-2.01, 0.0))):   # the deck's soffit, the sidewalk
        r = check(scene.element(p, (0, 0, 1 if p[2] < 0 else -1)))
        o, e1, e2 = (np.array(r[k]) for k in ("origin", "e1", "e2"))
        ys = [scene.local(o + u * e1 + v * e2)[1] for u, v in r["pieces"][0]["uv"]]
        assert y[0] <= min(ys) and max(ys) <= y[1] and len(side_faces(r)) == 3, (p, ys)   # its 3 faces, none the girder's


def half_girder(rng):
    """The right main girder of Petrinja's as the scan has it: a steel I along x (0..20) whose inner web skin (y = +WEB) is
    seen only between the deck's concrete top (z 0.95) and the top flange -- the deck hides it down to the bottom flange --
    and whose top flange's inner underside the scan drew as a fillet's chord, from the flange's tip down to the web at
    z 1.40, the web's skin running on 15 cm past where they meet (the union of the stations). Its outer skin is whole."""
    q = lambda p0, a, b, step=None: quad(rng, p0, a, b, step)  # noqa: E731
    X, Y, Z = (20, 0, 0), (lambda w: (0, w, 0)), (lambda h: (0, 0, h))
    return join(q((0, -0.25, 1.70), X, Y(0.5)), q((0, -0.25, 1.64), Y(0.25 - WEB), X),   # the top flange: top, outer underside,
                q((0, -0.25, 1.64), X, Z(0.06), 0.04), q((0, 0.25, 1.64), Z(0.06), X, 0.04),   # tips, the inner chord
                q((0, WEB, 1.40), (0, 0.25 - WEB, 0.24), X),
                q((0, -WEB, -0.45), X, Z(2.09)), q((0, WEB, 0.95), Z(0.60), X),      # the web's outer skin; its inner, above the deck
                q((0, -0.25, -0.45), X, Y(0.25 - WEB)), q((0, -0.25, -0.51), Y(0.5), X),   # the bottom flange: outer top, bottom,
                q((0, -0.25, -0.51), X, Z(0.06), 0.04), q((0, 0.25, -0.51), Z(0.06), X, 0.04),   # tips
                q((0, WEB, 0.95), X, Y(3 - WEB)), q((0, 0.25, -0.45), Y(2.75), X), q((0, 3, -0.45), Z(1.4), X),   # the deck
                q((-5, -6, -3), (30, 0, 0), (0, 12, 0)))                             # the ground


def test_a_a_plates_two_skins_are_one_element():
    """A thin plate's two skins are one element: the girder's inner web skin, clicked from the road, reaches neither the
    flange (its fillet's chord meets it 15 cm below its end: a T, not a corner) nor the deck (concrete), but its other
    skin reaches the whole girder; the element is grown from its largest face, the inner skin a piece of its own. The
    same faces from the road, from outside and from below; the deck is still the deck."""
    rng = np.random.default_rng(9)
    scene = Scene(*scanned(rng, *half_girder(rng), R=rot_z(23.5)), rot_z(23.5))
    got = []
    for p, d in (((10, WEB, 1.2), (0, -1, 0)), ((6, WEB, 1.3), (0.1, -1, 0.05)), ((12, -WEB, 1.2), (0, 1, 0)),
                 ((8, -WEB, 0.2), (0, 1, 0.1)), ((9, -0.1, -0.51), (0, 0, 1))):
        r = check(scene.element(p, d))
        widths = sorted(f["width"] for f in side_faces(r))
        assert angle(scene.R.T @ r["axis"], (1, 0, 0)) < 0.5 and len(widths) >= 6, (p, widths)
        assert min(abs(w - 2.09) for w in widths) < 0.03 and min(abs(w - 0.6) for w in widths) < 0.05, (p, widths)   # both skins
        got.append(widths)
    for w in got[1:]:
        assert len(w) == len(got[0]) and np.allclose(w, got[0], atol=0.02), got
    r = check(scene.element((10, 1.5, 0.95), (0, 0, -1)))   # the deck's top: not the girder
    assert all(abs(f["width"] - 2.09) > 0.1 for f in side_faces(r))


def test_a_a_face_across_a_hole_in_the_scan_is_one():
    """A beam's side with a strip 0.45 m tall missing along its whole length, where nothing joins it: one face, as tall as
    the side (JOIN_M). (A strip where something joins it is two: the soffit either side of a girder, test b.)"""
    rng = np.random.default_rng(6)
    side = join(quad(rng, (0, 0, 0), (20, 0, 0), (0, 0, 0.3)), quad(rng, (0, 0, 0.75), (20, 0, 0), (0, 0, 0.3)))   # -y, the hole
    V, F = join(side, box(rng, (0, 0, 0), (20, 0.6, 1.05), skip=("y-", "x-", "x+")), quad(rng, (-5, -5, -2), (30, 0, 0), (0, 10, 0)))
    scene = Scene(*scanned(rng, V, F, holes=0.02), np.eye(3))
    r = check(scene.element((10, 0, 0.15), (0, 1, 0)))
    side = next(f for f in side_faces(r) if np.allclose(f["normal"], (0, -1, 0), atol=1e-3))
    assert side["width"] == pytest.approx(1.05, abs=0.02) and len(side_faces(r)) == 4 and r["pieces"][0]["closed"]


def test_a_neighbouring_faces_are_made_exactly_square():
    """A box beam 0.6 x 0.4 turned 20 deg about its axis, +-5 mm noise: no face is on e1 / e2, and their normals, fitted
    each on its own off square by tenths of a degree, are made exactly square (linked faces within SQUARE_DEG)."""
    rng = np.random.default_rng(7)
    tilt = np.array([[1, 0, 0], [0, np.cos(0.35), -np.sin(0.35)], [0, np.sin(0.35), np.cos(0.35)]])
    V, F = box(rng, (0, -0.3, -0.2), (20, 0.3, 0.2), skip=("x-", "x+"))
    V, F = join(((V @ tilt.T) + (0, 0, 1.5), F), quad(rng, (-5, -5, 0), (30, 0, 0), (0, 10, 0)))
    scene = Scene(*scanned(rng, V, F, holes=0.03), np.eye(3))
    r = check(scene.element((10, *(tilt @ (0, 0, -0.2) + (0, 0, 1.5))[1:]), tilt @ (0, 0, 1.0)))
    assert len(r["pieces"]) == 1 and r["pieces"][0]["closed"] and len(side_faces(r)) == 4
    n = [np.array(r["segments"][k]["n"]) for k in r["pieces"][0]["keys"]]   # unrounded (the corners are to the mm)
    for k in range(4):
        assert abs(n[k] @ n[k - 1]) < 1e-9 and min(abs(n[k][0]), abs(n[k][1])) > 0.3   # square; 20 deg off e1 / e2


def test_f_the_same_element_either_side_of_an_occlusion():
    """A girder hidden for 3 m in the middle of its 20 m (behind something in front of it): its extent crosses the gap
    (gap_m 4), so a click either side gives the same element, end to end."""
    rng = np.random.default_rng(8)
    V, F = join(box(rng, (0, -0.25, -0.8), (20, 0.25, 0), skip=("x-", "x+")), quad(rng, (-5, -5, -3), (30, 0, 0), (0, 10, 0)))
    V, F = scanned(rng, V, F, holes=0.03)
    cen = (V[F[:, 0]] + V[F[:, 1]] + V[F[:, 2]]) / 3 - FAR
    F = F[~((cen[:, 0] > 8.5) & (cen[:, 0] < 11.5) & (cen[:, 2] > -1))]   # 3 m of it unseen
    scene = Scene(V, F, np.eye(3))
    a, b = (check(scene.element((x, -0.25, -0.4), (0, 1, 0))) for x in (4, 16))
    for r, x in ((a, 4), (b, 16)):
        assert r["s0"] + x == pytest.approx(0, abs=0.3) and r["s1"] + x == pytest.approx(20, abs=0.3)
    assert profile(a)[0] == pytest.approx(profile(b)[0], abs=0.02)


# ---------------------------------------------------------------- (b) the soffit between the girders
def test_b_the_soffit_between_the_girders_is_its_bay(slab):
    for p, d in (SOFFIT, ((14, -1.2, 0.0), (0.3, 0.2, 1))):   # an oblique view too
        r = check(slab.element(p, d))
        faces = side_faces(r)
        assert len(faces) == 1 and angle(slab.R.T @ r["axis"], (1, 0, 0)) < 0.5
        f = faces[0]
        assert np.allclose(slab.R.T @ f["normal"], (0, 0, -1), atol=1e-6)
        ys = sorted(slab.local(f["points"][:2])[:, 1])
        assert ys[0] == pytest.approx(-1.75, abs=0.05) and ys[1] == pytest.approx(1.75, abs=0.05)   # web to web
        assert r["s0"] == pytest.approx(-p[0], abs=0.3) and r["s1"] == pytest.approx(20 - p[0], abs=0.3)


# ---------------------------------------------------------------- (c) a pier seen all round
def test_c_a_pier_is_a_closed_loop_of_four_faces_up_its_height():
    rng = np.random.default_rng(2)
    scene = Scene(*scanned(rng, *pier(rng)), np.eye(3))
    for p, d in (((0.6, 0.1, 2.5), (-1, 0, 0)), ((0.2, -0.4, 1.2), (0.2, 1, 0.1))):
        r = check(scene.element(p, d))
        assert angle(r["axis"], (0, 0, 1)) < 0.5 and len(r["pieces"]) == 1 and r["pieces"][0]["closed"]
        faces = side_faces(r)
        assert len(faces) == 4 and sorted(round(f["width"], 1) for f in faces) == [0.8, 0.8, 1.2, 1.2]
        o, e1, e2 = (np.array(r[k]) for k in ("origin", "e1", "e2"))
        corners = np.array([scene.local(o + u * e1 + v * e2)[:2] for u, v in r["pieces"][0]["uv"]])
        for x, y in ((0.6, 0.4), (-0.6, 0.4), (-0.6, -0.4), (0.6, -0.4)):
            assert np.hypot(*(corners - (x, y)).T).min() < 0.01
        z0 = scene.local(o)[2]   # from the ground up to the cap; no end faces there, only others looking back
        assert r["s0"] + z0 == pytest.approx(0, abs=0.3) and r["s1"] + z0 == pytest.approx(5, abs=0.3) and len(r["faces"]) == 4


# ---------------------------------------------------------------- (d) a box duct under the slab
def test_d_a_duct_under_the_slab_is_a_closed_box_capped_where_it_ends(slab):
    (x0, x1), (y0, y1), (z0, z1) = DUCT
    r = check(slab.element((10, 0.8, z0), (0, 0, 1)))
    assert angle(slab.R.T @ r["axis"], (1, 0, 0)) < 0.5 and r["pieces"][0]["closed"]
    faces = side_faces(r)
    assert len(faces) == 4 and sorted(round(f["width"], 1) for f in faces) == [0.6, 0.6, 0.8, 0.8]
    o, e1, e2 = (np.array(r[k]) for k in ("origin", "e1", "e2"))
    corners = np.array([slab.local(o + u * e1 + v * e2)[1:] for u, v in r["pieces"][0]["uv"]])
    for y, z in ((y0, z0), (y1, z0), (y1, z1), (y0, z1)):
        assert np.hypot(*(corners - (y, z)).T).min() < 0.01
    sx = (slab.R.T @ r["axis"])[0]   # the extent in x; an end within 15 cm of the duct's end gets its cap
    ends = sorted(10 + sx * np.array([r["s0"], r["s1"]]))
    assert ends[0] == pytest.approx(x0, abs=1.0) and ends[1] == pytest.approx(x1, abs=1.0)
    caps = {f["key"]: f for f in r["faces"] if f["key"][0] == "c"}
    for key, s, x in (("cap0", r["s0"], x0 if sx > 0 else x1), ("cap1", r["s1"], x1 if sx > 0 else x0)):
        if abs(10 + sx * s - x) < 0.1:
            assert key in caps and caps[key]["area"] == pytest.approx(0.48, rel=0.05)
            assert np.dot(caps[key]["normal"], r["axis"]) == pytest.approx(1 if key == "cap1" else -1)
    assert caps, "the duct's ends are scanned: at least one end reaches one"


# ---------------------------------------------------------------- (e) the owner's on / off / add / s0 / s1
def test_e_on_off_add_and_a_forced_extent(slab):
    r = slab.element(*GIRDER_BOTTOM)
    segs, on = r["segments"], [g["key"] for g in r["segments"] if g["on"]]
    seed = next(g["key"] for g in segs if g["seed"])
    web = next(k for k in on if k != seed)
    soffit = next(g["key"] for g in segs if not g["on"] and g["n"][1] < -0.99 and g["t"][1] - g["t"][0] > 3)
    kw = dict(axis=r["axis"])
    r2 = check(slab.element(*GIRDER_BOTTOM, off=[web], **kw))                     # off: that web is gone
    assert [g["key"] for g in r2["segments"] if g["on"]] == [k for k in on if k != web] and len(side_faces(r2)) == 2
    assert next(g for g in r2["segments"] if g["key"] == web)["auto"]            # still the chain's choice
    r3 = check(slab.element(*GIRDER_BOTTOM, on=[soffit], **kw))                   # on: a candidate far from the chain
    assert next(g for g in r3["segments"] if g["key"] == soffit)["on"] and len(side_faces(r3)) == 4
    assert not next(g for g in r3["segments"] if g["key"] == soffit)["auto"]
    deck_top = slab.at(10, -1.0, 0.25)                                            # add: the candidate under a point
    r4 = check(slab.element(*GIRDER_BOTTOM, add=[deck_top.tolist()], **kw))
    added = [g for g in r4["segments"] if g["on"] and not g["auto"]]
    assert len(added) == 1 and added[0]["n"][1] > 0.99 and len(r4["pieces"]) == 2   # the deck's top, a piece of its own
    r5 = check(slab.element(*GIRDER_BOTTOM, s0=-3, s1=4.5, **kw))                 # a forced extent; the automatic one kept
    assert (r5["s0"], r5["s1"]) == (-3, 4.5) and r5["auto"] == r["auto"] and all(f["length"] == 7.5 for f in r5["faces"])
    r6 = check(slab.element(*GIRDER_BOTTOM, s1=2.0, **kw))                        # only one end forced
    assert (r6["s0"], r6["s1"]) == (r["auto"][0], 2.0)
    r7 = check(slab.element(*GIRDER_BOTTOM, off=[web], on=[web], **kw))           # off wins
    assert not next(g for g in r7["segments"] if g["key"] == web)["on"]


# ---------------------------------------------------------------- (f) the keys stay put across refits
def test_f_keys_are_stable_across_refits(slab):
    r = slab.element(*GIRDER_BOTTOM)
    same = lambda a: [(g["key"], g["n"], g["c"], g["t"], g["area"], g["rms"], g["seed"]) for g in a["segments"]]  # noqa: E731
    frame = lambda a: [a[k] for k in ("origin", "axis", "e1", "e2")]  # noqa: E731
    off = [g["key"] for g in r["segments"] if g["on"]][:1]
    for kw in ({}, {"off": off}, {"on": [0, 1]}, {"s0": -1, "s1": 1}, {"add": [slab.at(10, 0, 0.25).tolist()]}):
        r2 = slab.element(*GIRDER_BOTTOM, axis=r["axis"], **kw)
        assert same(r2) == same(r) and frame(r2) == frame(r)
    a, b = (slab.element(*GIRDER_BOTTOM, axis=r["axis"], off=off) for _ in range(2))   # the whole answer, but its clock
    assert {**a, "ms": 0} == {**b, "ms": 0}


def profile(r):   # what must not depend on where the element is clicked: its faces' widths, its extent, its axis
    widths = sorted(f["width"] for f in side_faces(r))
    a, o = np.array(r["axis"]), np.array(r["origin"])
    return widths, sorted((o + s * a) @ a for s in (r["s0"], r["s1"])), a * np.sign(a @ (1, 1, 1))


def test_f_the_same_element_wherever_it_is_clicked(slab):
    """A prism has one cross-section: clicks along the girder (its bottom, its webs, at six stations, at different heights)
    and along the soffit bay give the same faces (widths within 2 cm), the same extent (0.3 m) and the same axis."""
    for clicks in ([((x, -2.0, -0.8), (0.1, 0.2, 1)) for x in (1.5, 4, 7.5, 11, 14, 18.5)] +
                   [((x, -2.25, z), (0, 1, 0.1)) for x, z in ((3, -0.6), (9, -0.4), (16, -0.2))],
                   [((x, y, 0.0), (0, 0.1, 1)) for x, y in ((2, -1.2), (6, 0.3), (10, 1.1), (13, -0.4), (17, 0.8))]):
        ref = profile(slab.element(*clicks[0]))
        for p, d in clicks[1:]:
            got = profile(slab.element(p, d))
            assert len(got[0]) == len(ref[0]) and np.allclose(got[0], ref[0], atol=0.02), (p, got[0], ref[0])
            assert np.allclose(got[1], ref[1], atol=0.3) and angle(got[2], ref[2]) < 0.1, (p, got[1], ref[1])


# ---------------------------------------------------------------- (g) nothing there, and bad arguments
NOTHING = "Ovdje nije prepoznat element"   # the LookupError's text: the viewer shows it


def test_g_a_click_in_the_air_is_a_lookup_error(slab):
    with pytest.raises(LookupError, match=NOTHING):
        slab.element((10, 0, 3.0), (0, 0, -1))                     # 2.75 m above the deck
    with pytest.raises(LookupError, match=NOTHING):
        slab.element((-3, -8, -3.5), (0, 0, 1))                    # under the ground, looking up at its back
    with pytest.raises(LookupError, match=NOTHING):                # an axis along the clicked face's normal
        slab.element((10, 0, 0.25), (0, 0, -1), axis=slab.R @ (0, 0, 1.0))
    empty = faces_core.Faces(np.zeros((0, 3)), np.zeros((0, 3), np.int64))
    with pytest.raises(LookupError, match=NOTHING):
        empty.element((0, 0, 0), (0, 0, 1))


def test_g_a_click_on_something_too_small_is_no_element():
    """The gate: an element shorter than 1 m (a 30 cm box on the ground) along every axis tried is no element; the ground
    beside it is one (a plane, 10 m). No holes here: one patch would take the whole box."""
    rng = np.random.default_rng(4)
    ground, cube = quad(rng, (-5, -5, 0), (10, 0, 0), (0, 10, 0)), box(rng, (0, 0, 0), (0.3, 0.3, 0.3), skip=("z-",), step=0.05)
    scene = Scene(*scanned(rng, *join(ground, cube), holes=0), np.eye(3))
    with pytest.raises(LookupError, match=NOTHING):
        scene.element((0.3, 0.15, 0.15), (-1, 0, 0))
    r = check(scene.element((-3, -2, 0), (0, 0, -1)))
    assert r["s1"] - r["s0"] > 5 and min(f["width"] for f in side_faces(r)) > 5


def test_g_bad_arguments_are_value_errors(slab):
    f, p, d = slab.faces, slab.at(*GIRDER_BOTTOM[0]), slab.R @ GIRDER_BOTTOM[1]
    for kw in ({"point": (0, 0)}, {"point": (np.nan, 0, 0)}, {"dir": (0, 0, 0)}, {"axis": (0, 0, 0)}, {"axis": (1, 2)},
               {"window_m": 0}, {"slab_m": -1}, {"angle_deg": 90}, {"presence": 1.5}, {"gap_m": -1}, {"element_m": 0},
               {"concave_max_m": -0.1}, {"s0": 2, "s1": 1}, {"s0": np.inf}, {"s0": 50}, {"on": [999]}, {"off": [-1]},
               {"add": [[1, 2]]}, {"add": [[np.nan, 0, 0]]}):
        with pytest.raises(ValueError):
            f.element(**{"point": p, "dir": d, **kw})
    with pytest.raises(TypeError):
        f.element(p, d, on=["a"])
    with pytest.raises(ValueError, match="vertex 3"):
        faces_core.Faces(np.zeros((3, 3)), np.array([[0, 1, 3]]))


# ---------------------------------------------------------------- (h) speed
def test_h_a_million_triangles():
    rng = np.random.default_rng(3)
    V, F = scanned(rng, *deck(rng), R=rot_z(23.5))
    G = rect((-20, -30, -4), (60, 0, 0), (0, 60, 0), 0.085)   # a wide ground under it all, of fine triangles
    V, F = join((V, F), (G[0] @ rot_z(23.5).T + FAR, G[1]))
    assert len(F) > 1_000_000
    f, R = faces_core.Faces(V, F), rot_z(23.5)
    best = min(json.loads(f.element(FAR + R @ (10, -2.0, -0.8), R @ (0, 0, 1.0)))["ms"] for _ in range(5))
    t = time.perf_counter()
    for _ in range(5):
        f.element(FAR + R @ (10, -2.0, -0.8), R @ (0, 0, 1.0))
    wall = (time.perf_counter() - t) / 5 * 1000
    print(f"\nelement: {len(F)} triangles, {best:.1f} ms (its own clock), {wall:.1f} ms a call")
    assert best < 30 and wall < 60


# ---------------------------------------------------------------- (i) POST /element
def test_i_the_server_answers_element(tmp_path, slab):
    import selinf

    core = SimpleNamespace(names=[])
    on = selinf.server(core, None, [], tmp_path, port=0, auth="test:test", faces=slab.faces)
    off = selinf.server(core, None, [], tmp_path, port=0, auth="test:test")
    for srv in (on, off):
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    def post(srv, body, login="test:test"):
        head = {"Authorization": "Basic " + base64.b64encode(login.encode()).decode(), "Content-Type": "text/plain"}
        try:
            with urlopen(Request(f"http://127.0.0.1:{srv.server_address[1]}/element", body, head)) as r:
                return r.status, r.headers["Content-Type"], json.loads(r.read())
        except HTTPError as e:
            return e.code, e.headers["Content-Type"], json.loads(e.read())

    click = {"point": slab.at(*GIRDER_BOTTOM[0]).tolist(), "dir": (slab.R @ GIRDER_BOTTOM[1]).tolist()}
    try:
        code, kind, r = post(on, json.dumps(click).encode())
        ref = json.loads(slab.faces.element(**click))
        assert code == 200 and kind == "application/json" and {**r, "ms": 0} == {**ref, "ms": 0} and len(side_faces(r)) == 3
        refit = {**click, "axis": r["axis"], "off": [r["segments"][0]["key"]], "on": [], "add": [], "s0": -2, "s1": None,
                 "window_m": 6, "slab_m": 1.5, "angle_deg": 15, "concave_max_m": 0.5, "element_m": 2.5, "presence": 0.35,
                 "gap_m": 2.0}
        code, _, r2 = post(on, json.dumps(refit).encode())
        assert code == 200 and r2["s0"] == -2 and [g["c"] for g in r2["segments"]] == [g["c"] for g in r["segments"]]
        try:
            urlopen(Request(f"http://127.0.0.1:{on.server_address[1]}/element", json.dumps(click).encode(),
                            {"Authorization": "Basic " + base64.b64encode(b"test:wrong").decode()}))
            raise AssertionError("no login asked")
        except HTTPError as e:
            assert e.code == 401
        for bad in (b"{", b"[]", b"\xff", json.dumps({"point": click["point"]}).encode(), json.dumps({**click, "box": 1}).encode(),
                    json.dumps({**click, "point": [1, 2]}).encode(), json.dumps({**click, "window_m": "x"}).encode(),
                    json.dumps({**click, "on": [1.5]}).encode(), json.dumps({**click, "on": [9999]}).encode(),
                    json.dumps({**click, "s0": 3, "s1": 1}).encode()):
            code, kind, body = post(on, bad)
            assert code == 400 and kind == "application/json" and list(body) == ["error"], bad
        code, kind, body = post(on, json.dumps({**click, "point": slab.at(10, 0, 30).tolist()}).encode())   # in the air
        assert code == 422 and kind == "application/json" and body["error"] == NOTHING
        code, kind, body = post(off, json.dumps(click).encode())
        assert code == 503 and kind == "application/json" and list(body) == ["error"]
        (tmp_path / "faces.js").write_text("faces.js")                    # the viewer's half: served, never stored
        login = {"Authorization": "Basic " + base64.b64encode(b"test:test").decode()}
        with urlopen(Request(f"http://127.0.0.1:{on.server_address[1]}/faces.js", headers=login)) as r:
            assert r.read() == b"faces.js" and r.headers["Cache-Control"] == "no-store"
            assert r.headers["Content-Type"] == "text/javascript"
        try:   # the box tool's route is gone
            urlopen(Request(f"http://127.0.0.1:{on.server_address[1]}/faces", b"{}", login))
            raise AssertionError("POST /faces still answers")
        except HTTPError as e:
            assert e.code == 404
    finally:
        for srv in (on, off):
            srv.shutdown()
            srv.server_close()
