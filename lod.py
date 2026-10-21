# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["numpy", "scipy", "numba", "xatlas", "meshoptimizer", "pillow"]
# ///
"""OBJ survey parts + diffuse atlas -> 3D Tiles 1.1 LOD tileset (KTX2 UASTC textures, meshopt geometry).

    uv run lod.py build [--workers 6]
    uv run lod.py serve [--port 8000]
"""
import argparse, functools, http.server, json, os, shutil, struct, subprocess, sys, tempfile, time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(__file__).resolve().parent / "work" / "numba"))
import numpy as np
from numba import njit, prange
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent
SOURCE, WORK, OUT = ROOT / "source", ROOT / "work", ROOT / "out"
NODES, META = WORK / "nodes", WORK / "meta"
TRIS = 200_000          # leaf size and simplify target
MIN_TEXEL = 0.0054      # m, native atlas resolution
Image.MAX_IMAGE_PIXELS = None


# ------------------------------------------------------------------ ingest

def parse_obj(path):
    v, vt, f = [], [], []
    for ln in Path(path).read_bytes().split(b"\n"):
        if ln[:2] == b"v ":
            v.append(ln[2:])
        elif ln[:3] == b"vt ":
            vt.append(ln[3:])
        elif ln[:2] == b"f ":
            f.append(ln[2:])
    pos = np.array(b" ".join(v).split(), dtype=np.float32).reshape(-1, 3)
    uv = np.array(b" ".join(vt).split(), dtype=np.float32).reshape(-1, 2)
    fa = np.array(b" ".join(f).translate(bytes.maketrans(b"/", b" ")).split(), dtype=np.int64).reshape(-1, 9)  # p/t/n x3
    return pos, uv, (fa[:, 0::3] - 1).astype(np.uint32), (fa[:, 1::3] - 1).astype(np.uint32)


def ingest():
    """Parse parts, weld positions by exact float32 bits, drop degenerate faces, cache in work/."""
    files = sorted(SOURCE.glob("*_00000??.obj"))
    print(f"ingest: {len(files)} parts", flush=True)
    with ProcessPoolExecutor(8) as ex:
        res = list(ex.map(parse_obj, files))
    voff = np.cumsum([0] + [len(r[0]) for r in res]).astype(np.uint32)
    uoff = np.cumsum([0] + [len(r[1]) for r in res]).astype(np.uint32)
    pos, uv = np.concatenate([r[0] for r in res]), np.concatenate([r[1] for r in res])
    fp = np.concatenate([r[2] + voff[i] for i, r in enumerate(res)])
    ft = np.concatenate([r[3] + uoff[i] for i, r in enumerate(res)])
    del res
    key = np.ascontiguousarray(pos).view(np.dtype((np.void, 12))).ravel()
    _, first, inv = np.unique(key, return_index=True, return_inverse=True)
    fp = inv.ravel().astype(np.uint32)[fp]
    ok = (fp[:, 0] != fp[:, 1]) & (fp[:, 1] != fp[:, 2]) & (fp[:, 0] != fp[:, 2])
    print(f"  {len(pos):,} -> {len(first):,} vertices, {len(fp):,} triangles, {(~ok).sum()} degenerate dropped", flush=True)
    for name, a in (("pos", pos[first]), ("uv", uv), ("fp", fp[ok]), ("ft", ft[ok])):
        np.save(WORK / f"{name}.npy", np.ascontiguousarray(a))
    if not (WORK / "atlas.npy").exists():
        np.save(WORK / "atlas.npy", np.asarray(Image.open(next(SOURCE.glob("*_diffuse.jpg"))).convert("RGB")))


# ------------------------------------------------------------------ tile tree

def centroids(pos, fp, chunk=4_000_000):
    out = np.empty((len(fp), 3), np.float32)
    for s in range(0, len(fp), chunk):
        f = np.asarray(fp[s:s + chunk])
        out[s:s + chunk] = (pos[f[:, 0]] + pos[f[:, 1]] + pos[f[:, 2]]) / 3
    return out


def make_tree():
    """k-d split of triangle centroids to <= TRIS per leaf; a tile's children are its k-d grandchildren."""
    pos, fp = np.load(WORK / "pos.npy", mmap_mode="r"), np.load(WORK / "fp.npy", mmap_mode="r")
    cen = centroids(pos, fp)
    idx = np.arange(len(cen), dtype=np.uint32)
    kd = []

    def split(lo, hi):
        me = len(kd)
        kd.append((lo, hi, []))
        if hi - lo > TRIS:
            c = cen[idx[lo:hi]]
            mid = (hi - lo) // 2
            idx[lo:hi] = idx[lo:hi][np.argpartition(c[:, int(np.argmax(c.max(0) - c.min(0)))], mid)]
            kd[me][2][:] = [split(lo, lo + mid), split(lo + mid, hi)]
        return me

    split(0, len(cen))
    del cen
    NODES.mkdir(parents=True, exist_ok=True)
    tiles = []

    def tile(k):
        lo, hi, kids = kd[k]
        t = {"id": len(tiles), "children": [], "leaf": not kids}
        tiles.append(t)
        if kids:
            for c in kids:
                t["children"] += [tile(c)] if not kd[c][2] else [tile(g) for g in kd[c][2]]
            t["height"] = 1 + max(tiles[c]["height"] for c in t["children"])
        else:
            t["height"] = 0
            np.save(NODES / f"{t['id']}_faces.npy", np.sort(idx[lo:hi]))
        return t["id"]

    tile(0)
    json.dump(tiles, open(WORK / "tree.json", "w"))
    print(f"tree: {len(tiles)} tiles, {sum(t['leaf'] for t in tiles)} leaves", flush=True)


# ------------------------------------------------------------------ numba kernels

@njit(cache=True)
def tri_closest(p0, p1, p2, px, py, pz):
    """Closest point on triangle (Ericson): (dist2, barycentrics wrt p0, p1, p2)."""
    abx, aby, abz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    acx, acy, acz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]
    d1 = abx * (px - p0[0]) + aby * (py - p0[1]) + abz * (pz - p0[2])
    d2 = acx * (px - p0[0]) + acy * (py - p0[1]) + acz * (pz - p0[2])
    u = v = w = 0.0
    if d1 <= 0 and d2 <= 0:
        u = 1.0
    else:
        bpx, bpy, bpz = px - p1[0], py - p1[1], pz - p1[2]
        d3 = abx * bpx + aby * bpy + abz * bpz
        d4 = acx * bpx + acy * bpy + acz * bpz
        if d3 >= 0 and d4 <= d3:
            v = 1.0
        else:
            vc = d1 * d4 - d3 * d2
            if vc <= 0 and d1 >= 0 and d3 <= 0:
                t = d1 / (d1 - d3)
                u, v = 1 - t, t
            else:
                cpx, cpy, cpz = px - p2[0], py - p2[1], pz - p2[2]
                d5 = abx * cpx + aby * cpy + abz * cpz
                d6 = acx * cpx + acy * cpy + acz * cpz
                if d6 >= 0 and d5 <= d6:
                    w = 1.0
                else:
                    vb = d5 * d2 - d1 * d6
                    if vb <= 0 and d2 >= 0 and d6 <= 0:
                        t = d2 / (d2 - d6)
                        u, w = 1 - t, t
                    else:
                        va = d3 * d6 - d5 * d4
                        if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
                            t = (d4 - d3) / ((d4 - d3) + (d5 - d6))
                            v, w = 1 - t, t
                        else:
                            den = 1.0 / (va + vb + vc)
                            v, w = vb * den, vc * den
                            u = 1 - v - w
    qx = u * p0[0] + v * p1[0] + w * p2[0]
    qy = u * p0[1] + v * p1[1] + w * p2[1]
    qz = u * p0[2] + v * p1[2] + w * p2[2]
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2, u, v, w


@njit(cache=True)
def raster_uv(uv, faces, w, h, tol):
    """Rasterise triangles (uv in px) at texel centres; texels within `tol` px outside a triangle still count.
    Inside beats outside, deepest-inside wins overlaps. Returns triangle id (h, w) (-1 empty), barycentrics."""
    tri = np.full((h, w), -1, np.int32)
    best = np.full((h, w), -1e30, np.float32)
    bary = np.zeros((h, w, 3), np.float32)
    for f in range(faces.shape[0]):
        ax, ay = uv[faces[f, 0], 0], uv[faces[f, 0], 1]
        bx, by = uv[faces[f, 1], 0], uv[faces[f, 1], 1]
        cx, cy = uv[faces[f, 2], 0], uv[faces[f, 2], 1]
        d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if abs(d) < 1e-9:
            continue
        ha = abs(d) / max(np.sqrt((cx - bx) ** 2 + (cy - by) ** 2), 1e-12)  # altitudes (px) per coordinate
        hb = abs(d) / max(np.sqrt((cx - ax) ** 2 + (cy - ay) ** 2), 1e-12)
        hc = abs(d) / max(np.sqrt((bx - ax) ** 2 + (by - ay) ** 2), 1e-12)
        x0, x1 = max(int(np.floor(min(ax, bx, cx) - tol - 1)), 0), min(int(np.ceil(max(ax, bx, cx) + tol + 1)), w - 1)
        y0, y1 = max(int(np.floor(min(ay, by, cy) - tol - 1)), 0), min(int(np.ceil(max(ay, by, cy) + tol + 1)), h - 1)
        inv = 1.0 / d
        for y in range(y0, y1 + 1):
            py = y + 0.5
            for x in range(x0, x1 + 1):
                px = x + 0.5
                wa = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inv
                wb = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inv
                wc = 1.0 - wa - wb
                m = min(wa * ha, wb * hb, wc * hc)
                if m < -tol or m <= best[y, x]:
                    continue
                best[y, x] = m
                tri[y, x] = f
                wa, wb, wc = max(wa, 0.0), max(wb, 0.0), max(wc, 0.0)
                s = wa + wb + wc
                bary[y, x, 0], bary[y, x, 1], bary[y, x, 2] = wa / s, wb / s, wc / s
    return tri, bary


@njit(cache=True, parallel=True)
def texel_attrs(tri, bary, pos, faces, fnorm):
    """Per-texel 3D position and face normal (flattened, zero where uncovered)."""
    h, w = tri.shape
    P = np.zeros((h * w, 3), np.float64)
    N = np.zeros((h * w, 3), np.float64)
    for y in prange(h):
        for x in range(w):
            f = tri[y, x]
            if f >= 0:
                for k in range(3):
                    P[y * w + x, k] = (bary[y, x, 0] * pos[faces[f, 0], k] + bary[y, x, 1] * pos[faces[f, 1], k]
                                       + bary[y, x, 2] * pos[faces[f, 2], k])
                    N[y * w + x, k] = fnorm[f, k]
    return P, N


@njit(cache=True)
def vert(pos, i):
    return np.float64(pos[i, 0]), np.float64(pos[i, 1]), np.float64(pos[i, 2])


@njit(cache=True, parallel=True)
def select_closest(P, N, cand, pos, faces, valid, dot_min):
    """Per texel, the nearest of the k candidate source triangles whose normal agrees (dot > dot_min), else the
    nearest overall. Returns source face (index into `faces`) and barycentrics."""
    n, k = cand.shape
    out_f = np.full(n, -1, np.int64)
    out_b = np.zeros((n, 3), np.float64)
    for i in prange(n):
        if not valid[i]:
            continue
        bd = ad = 1e300
        bf = af = -1
        bb = ab = (0.0, 0.0, 0.0)
        for j in range(k):
            f = cand[i, j]
            if f < 0:
                continue
            p0, p1, p2 = vert(pos, faces[f, 0]), vert(pos, faces[f, 1]), vert(pos, faces[f, 2])
            d2, u, v, w = tri_closest(p0, p1, p2, P[i, 0], P[i, 1], P[i, 2])
            if d2 < ad:
                ad, af, ab = d2, f, (u, v, w)
            nx = (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1])
            ny = (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2])
            nz = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])
            ln = max(np.sqrt(nx * nx + ny * ny + nz * nz), 1e-30)
            if (nx * N[i, 0] + ny * N[i, 1] + nz * N[i, 2]) / ln > dot_min and d2 < bd:
                bd, bf, bb = d2, f, (u, v, w)
        if bf < 0:
            bf, bb = af, ab
        out_f[i] = bf
        out_b[i, 0], out_b[i, 1], out_b[i, 2] = bb
    return out_f, out_b


@njit(cache=True, parallel=True)
def interp_uv(src_f, bary, uvs, faces_t):
    """Source UV at (source face, barycentrics); src_f < 0 gives 0."""
    out = np.zeros((src_f.shape[0], 2), np.float64)
    for i in prange(src_f.shape[0]):
        if src_f[i] >= 0:
            for k in range(3):
                t = faces_t[src_f[i], k]
                out[i, 0] += bary[i, k] * np.float64(uvs[t, 0])
                out[i, 1] += bary[i, k] * np.float64(uvs[t, 1])
    return out


@njit(cache=True, parallel=True)
def sample_bilinear(atlas, uv, valid):
    """Bilinear atlas sample; OBJ v=0 is the BOTTOM image row, so row = (1 - v) * H."""
    H, W = atlas.shape[0], atlas.shape[1]
    out = np.zeros((uv.shape[0], 3), np.uint8)
    for i in prange(uv.shape[0]):
        if not valid[i]:
            continue
        x = min(max(uv[i, 0] * W - 0.5, 0.0), W - 1.0)
        y = min(max((1.0 - uv[i, 1]) * H - 0.5, 0.0), H - 1.0)
        x0, y0 = min(int(x), W - 2), min(int(y), H - 2)
        fx, fy = x - x0, y - y0
        for c in range(3):
            a = atlas[y0, x0, c] * (1 - fx) + atlas[y0, x0 + 1, c] * fx
            b = atlas[y0 + 1, x0, c] * (1 - fx) + atlas[y0 + 1, x0 + 1, c] * fx
            out[i, c] = np.uint8(a * (1 - fy) + b * fy + 0.5)
    return out


# ------------------------------------------------------------------ bake

def face_normals(pos, faces):
    p = pos.astype(np.float64)[faces]
    n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-30)


def kd_split(cen, ids, max_tris):
    if len(ids) <= max_tris:
        return [ids]
    c = cen[ids]
    o = np.argsort(c[:, int(np.argmax(c.max(0) - c.min(0)))], kind="stable")
    h = len(ids) // 2
    return kd_split(cen, ids[o[:h]], max_tris) + kd_split(cen, ids[o[h:]], max_tris)


def parametrize(pos, faces, texel, max_px, sub_tris=10_000):
    """xatlas on spatial sub-meshes of <= sub_tris triangles (much faster than one big chart set) packed into
    one atlas. Returns vmapping into pos, faces (input face order), uv in px, w, h, final texel."""
    import xatlas
    p = pos.astype(np.float64)
    area = 0.5 * np.linalg.norm(np.cross(p[faces[:, 1]] - p[faces[:, 0]], p[faces[:, 2]] - p[faces[:, 0]]), axis=1).sum()
    texel = max(texel, float(np.sqrt(area / (0.7 * max_px ** 2))))  # ~70 % fill must fit
    subs = []
    for g in kd_split(p[faces].mean(1), np.arange(len(faces)), sub_tris):
        used, inv = np.unique(faces[g], return_inverse=True)
        subs.append((g, used, inv.reshape(-1, 3).astype(np.uint32)))
    for _ in range(6):
        atlas = xatlas.Atlas()
        for g, used, lf in subs:
            atlas.add_mesh(pos[used], lf)
        po = xatlas.PackOptions()
        po.padding, po.texels_per_unit, po.resolution, po.rotate_charts = 3, 1.0 / texel, 0, True
        atlas.generate(xatlas.ChartOptions(), po, verbose=False)
        w, h = int(atlas.width), int(atlas.height)
        if atlas.atlas_count == 1 and w <= max_px and h <= max_px:
            break
        texel *= max(max(w, h) / max_px if atlas.atlas_count == 1 else 1.3, 1.05) * 1.03
    else:
        raise RuntimeError("xatlas could not fit the mesh into max_px")
    vmaps, uvs, out = [], [], np.empty_like(faces)
    off = 0
    for j, (g, used, lf) in enumerate(subs):
        vm, ix, uv = atlas.get_mesh(j)
        assert ix.shape == lf.shape, "xatlas dropped or added faces"
        vmaps.append(used[vm])
        uvs.append(np.asarray(uv, np.float64))
        out[g] = ix.astype(np.uint32) + off
        off += len(vm)
    uv = np.concatenate(uvs)
    if uv.max() <= 1.0 + 1e-6:  # xatlas returns normalised uvs when a fixed resolution was not forced
        uv *= [w, h]
    return np.concatenate(vmaps), out, uv, w, h, texel


def bake(pos, faces, ids, exact, texel, max_px, G):
    """Texture for a tile mesh from the source atlas. `ids` = source faces under the tile. Leaves: each tile
    face IS source face ids[i] (exact barycentric -> UV). Interior: closest point on the descendant faces."""
    vmap, idx, uv, w, h, texel = parametrize(pos, faces, texel, max_px)
    res_pos = pos[vmap]
    tri, bary = raster_uv(uv, idx.astype(np.int64), w, h, 0.75)
    covered = tri >= 0
    valid = covered.reshape(-1)
    ft = np.asarray(G["ft"][ids])
    if exact:
        sf = np.where(valid, tri.reshape(-1), -1).astype(np.int64)
        suv = interp_uv(sf, bary.reshape(-1, 3), G["uv"], ft)
    else:
        P, N = texel_attrs(tri, bary, res_pos.astype(np.float64), idx.astype(np.int64), face_normals(res_pos, idx))
        fp = np.asarray(G["fp"][ids])
        tree = cKDTree(centroids(G["pos"], fp))
        cand = np.full((len(P), 8), -1, np.int64)
        vi = np.flatnonzero(valid)
        cand[vi] = tree.query(P[vi], k=8, workers=-1)[1]
        del tree
        sf, sb = select_closest(P, N, cand, G["pos"], fp, valid, 0.2)
        suv = interp_uv(sf, sb, G["uv"], ft)
    img = sample_bilinear(G["atlas"], suv, valid).reshape(h, w, 3)
    if not covered.all():  # dilate charts 8 px into the gutter, mean colour beyond
        d, (iy, ix) = ndimage.distance_transform_edt(~covered, return_indices=True)
        img_d = img[iy, ix]
        img_d[d > 8] = img[covered].mean(axis=0).astype(np.uint8)
        img = img_d
    return res_pos, (uv / [w, h]).clip(0, 1).astype(np.float32), idx, img, texel


# ------------------------------------------------------------------ glb

def ktx2_encode(img):
    """Edge-pad to multiples of 4, encode UASTC KTX2. Returns (ktx2 bytes, uv scale [w/W, h/H])."""
    ktx = os.environ.get("KTX_BIN") or shutil.which("ktx")
    if not ktx:
        sys.exit("ktx not found: install KTX-Software (brew install ktx-software) or set KTX_BIN")
    h, w = img.shape[:2]
    W, H = w + (-w % 4), h + (-h % 4)
    img = np.pad(img, ((0, H - h), (0, W - w), (0, 0)), mode="edge")
    with tempfile.TemporaryDirectory() as td:
        Image.fromarray(img).save(f"{td}/t.png", compress_level=1)
        subprocess.run([ktx, "create", "--format", "R8G8B8_SRGB", "--assign-tf", "srgb", "--generate-mipmap",
                        "--threads", "2", "--encode", "uastc", "--uastc-quality", "2", "--zstd", "19",
                        f"{td}/t.png", f"{td}/t.ktx2"], check=True, capture_output=True)
        return Path(f"{td}/t.ktx2").read_bytes(), np.float32([w / W, h / H])


def write_glb(path, pos, uv, faces, ktx2):
    """One mesh, unlit material, KTX2 texture, EXT_meshopt_compression (lossless float32 positions/uvs).
    Buffer 0 = GLB BIN chunk (compressed data + image); buffer 1 = uri-less fallback describing the raw layout."""
    import meshoptimizer as mo
    pos = np.ascontiguousarray(np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], 1), np.float32)  # Z-up -> Y-up
    idx = np.ascontiguousarray(faces, np.uint32).ravel()
    opt = np.empty_like(idx)
    mo.optimize_vertex_cache(opt, idx, vertex_count=len(pos))
    vtx = np.ascontiguousarray(np.hstack([pos, uv]), np.float32)
    out = np.empty_like(vtx)
    n = mo.optimize_vertex_fetch(out, opt, vtx)  # also renumbers `opt` in place
    pos, uv, idx = np.ascontiguousarray(out[:n, :3]), np.ascontiguousarray(out[:n, 3:]), opt
    binary, views, fb = bytearray(), [], 0
    for data, raw, mode, stride, target, count in (
            (mo.encode_vertex_buffer(pos), pos.nbytes, "ATTRIBUTES", 12, 34962, n),
            (mo.encode_vertex_buffer(uv), uv.nbytes, "ATTRIBUTES", 8, 34962, n),
            (mo.encode_index_buffer(idx), idx.nbytes, "TRIANGLES", 4, 34963, len(idx))):
        binary += b"\0" * (-len(binary) % 4)
        ext = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data), "byteStride": stride,
               "mode": mode, "count": count}
        view = {"buffer": 1, "byteOffset": fb, "byteLength": raw, "target": target,
                "extensions": {"EXT_meshopt_compression": ext}}
        if target == 34962:
            view["byteStride"] = stride
        views.append(view)
        binary += data
        fb += raw
    binary += b"\0" * (-len(binary) % 4)
    views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(ktx2)})
    binary += ktx2 + b"\0" * (-len(ktx2) % 4)
    gltf = {
        "asset": {"version": "2.0", "generator": "lod-lite"},
        "extensionsUsed": ["KHR_materials_unlit", "KHR_texture_basisu", "EXT_meshopt_compression"],
        "extensionsRequired": ["KHR_texture_basisu", "EXT_meshopt_compression"],
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2,
                                    "material": 0, "mode": 4}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0,
                                                "roughnessFactor": 1.0},
                       "extensions": {"KHR_materials_unlit": {}}}],
        "textures": [{"sampler": 0, "extensions": {"KHR_texture_basisu": {"source": 0}}}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": 3, "mimeType": "image/ktx2"}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3",
             "min": pos.min(0).tolist(), "max": pos.max(0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": n, "type": "VEC2"},
            {"bufferView": 2, "componentType": 5125, "count": len(idx), "type": "SCALAR"}],
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)},
                    {"byteLength": fb, "extensions": {"EXT_meshopt_compression": {"fallback": True}}}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<IIIII", 0x46546C67, 2, 28 + len(js) + len(binary), len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binary), 0x004E4942) + binary)


# ------------------------------------------------------------------ tiles

_G = {}


def state():
    if not _G:
        for k in ("pos", "uv", "fp", "ft", "atlas"):
            _G[k] = np.load(WORK / f"{k}.npy", mmap_mode="r")
        _G["tree"] = {t["id"]: t for t in json.load(open(WORK / "tree.json"))}
    return _G


def leaf_ids(tree, tid):
    t = tree[tid]
    return [tid] if t["leaf"] else [l for c in t["children"] for l in leaf_ids(tree, c)]


def do_tile(tid):
    """Mesh (leaf: source faces; interior: merged children simplified) -> bake -> glb + work/meta/<id>.json."""
    import meshoptimizer as mo
    t0 = time.time()
    G = state()
    t = G["tree"][tid]
    ids = np.concatenate([np.load(NODES / f"{l}_faces.npy") for l in leaf_ids(G["tree"], tid)])
    if t["leaf"]:
        gv, inv = np.unique(np.asarray(G["fp"][ids]), return_inverse=True)
        pos, faces, err = np.asarray(G["pos"][gv]), inv.reshape(-1, 3).astype(np.uint32), 0.0
        lo, hi = pos.min(0), pos.max(0)
        texel = MIN_TEXEL
    else:
        kids = [np.load(NODES / f"{c}.npz") for c in t["children"]]
        kmeta = [json.load(open(META / f"{c}.json")) for c in t["children"]]
        gv, first, inv = np.unique(np.concatenate([k["gvids"] for k in kids]), return_index=True, return_inverse=True)
        inv, off, fl = inv.ravel(), 0, []
        for k in kids:
            fl.append(inv[off:off + len(k["gvids"])][k["faces"]])
            off += len(k["gvids"])
        faces = np.concatenate(fl).astype(np.uint32)
        pos = np.concatenate([k["positions"] for k in kids])[first]
        dst, e = np.empty(faces.size, np.uint32), np.zeros(1, np.float32)
        n = mo.simplify(dst, np.ascontiguousarray(faces.ravel()), np.ascontiguousarray(pos, np.float32),
                        target_index_count=TRIS * 3, target_error=1e6,
                        options=mo.SIMPLIFY_LOCK_BORDER | mo.SIMPLIFY_ERROR_ABSOLUTE, result_error=e)
        used, inv = np.unique(dst[:n], return_inverse=True)
        pos, faces, gv, err = pos[used], inv.reshape(-1, 3).astype(np.uint32), gv[used], float(e[0])
        lo = np.minimum(pos.min(0), np.min([m["bbox"][0] for m in kmeta], 0))
        hi = np.maximum(pos.max(0), np.max([m["bbox"][1] for m in kmeta], 0))
        texel = max(MIN_TEXEL, max(m["texel_m"] for m in kmeta))  # never sharper than the coarsest child
    np.savez(NODES / f"{tid}.npz", positions=pos, faces=faces, gvids=gv.astype(np.uint32))
    res_pos, uv, idx, img, texel = bake(pos, faces, ids, t["leaf"], texel, 4096 if t["height"] >= 3 else 2048, G)
    ktx2, scale = ktx2_encode(img)
    write_glb(OUT / "tiles" / f"{tid}.tmp", res_pos, uv * scale, idx, ktx2)
    (OUT / "tiles" / f"{tid}.tmp").replace(OUT / "tiles" / f"{tid}.glb")
    json.dump({"texel_m": texel, "err": err, "bbox": [lo.tolist(), hi.tolist()], "tris": len(idx),
               "px": list(img.shape[1::-1]), "sec": time.time() - t0}, open(META / f"{tid}.json", "w"))
    return tid


# ------------------------------------------------------------------ tileset

def write_tileset(tiles):
    by = {t["id"]: t for t in tiles}
    meta = {i: json.load(open(META / f"{i}.json")) for i in by}
    ge = {}
    for t in sorted(tiles, key=lambda t: t["height"]):  # gE: simplify chain vs 16 x texel, strictly increasing
        mc = max((ge[c] for c in t["children"]), default=None)
        ge[t["id"]] = 0.0 if mc is None else max(meta[t["id"]]["err"] + mc, 16 * meta[t["id"]]["texel_m"], mc + 1e-4)

    def node(i):
        b = np.array(meta[i]["bbox"], float)
        lo, hi = b[0] - 1e-3, b[1] + 1e-3
        c, h = (lo + hi) / 2, (hi - lo) / 2
        n = {"boundingVolume": {"box": [c[0], c[1], c[2], h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]]},
             "geometricError": ge[i], "content": {"uri": f"tiles/{i}.glb"}}
        if by[i]["children"]:
            n["children"] = [node(c) for c in by[i]["children"]]
        return n

    root = node(0)
    root["refine"] = "REPLACE"
    diag = float(np.linalg.norm(np.subtract(*meta[0]["bbox"][::-1])))
    json.dump({"asset": {"version": "1.1"}, "geometricError": diag, "root": root}, open(OUT / "tileset.json", "w"),
              separators=(",", ":"))


# ------------------------------------------------------------------ commands

def build(workers):
    t0 = time.time()
    for d in (NODES, META, OUT / "tiles"):
        d.mkdir(parents=True, exist_ok=True)
    if not (WORK / "fp.npy").exists():
        ingest()
    if not (WORK / "tree.json").exists():
        make_tree()
    tiles = json.load(open(WORK / "tree.json"))
    sizes = {0: workers, 1: workers, 2: max(2, workers * 2 // 3), 3: 2, 4: 1}  # the root's 50M-centroid KD tree runs alone
    for h in range(max(t["height"] for t in tiles) + 1):
        todo = [t["id"] for t in tiles if t["height"] == h
                and not ((OUT / "tiles" / f"{t['id']}.glb").exists() and (META / f"{t['id']}.json").exists())]
        t1 = time.time()
        with ProcessPoolExecutor(sizes.get(h, 1)) as ex:
            for n, _ in enumerate(ex.map(do_tile, todo), 1):
                if n % 20 == 0:
                    print(f"  height {h}: {n}/{len(todo)} {time.time() - t1:.0f}s", flush=True)
        print(f"height {h}: {len(todo)} tiles built, {time.time() - t1:.0f}s", flush=True)
    write_tileset(tiles)
    print(f"done in {time.time() - t0:.0f}s -> {OUT / 'tileset.json'}")


def serve(port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/viewer.html"
    print("serving", url)
    subprocess.run(["open", url])
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--workers", type=int, default=6)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    build(a.workers) if a.cmd == "build" else serve(a.port)
