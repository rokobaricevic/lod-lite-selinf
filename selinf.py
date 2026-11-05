"""Selective inference, the models and the HTTP front. A click on the bridge is followed from photo to photo and
baked by selinf_core (selinf.cpp, which describes the loop); it calls back into Models.infer for the masks.

    python selinf.py      # PC: loads the survey + models, serves 127.0.0.1:8765   (./test.sh deploys and starts it)

GET /: the lod-lite viewer (viewer.html, selinf.js, out/'s tiles); GET /health: JSON.
POST /click {"origin": [x,y,z], "direction": [x,y,z]} (a camera ray, bake frame) -> selinf_core's answer: uint32 LE n,
  n bytes of JSON header, then each layer's float32 xyz; an error -> 500, the same form with {"error": ...}. A find is
  saved (FoundStore, out/found/) and the header gains "found": its item and "replaced": [the ids it replaced].
POST /found/delete {"id": "p7"} -> {"ok": true, "id": "p7"}; an unknown id -> 404 {"error": ...}.
POST /faces {"center": [3], "axes": [3 rows of 3], "half": [3]} (bake frame; optional angle_deg, gap_m, cell_m,
  min_area_m2; text/plain: no CORS preflight) -> faces_core's answer (faces.cpp: the flat faces of the mesh in that box);
  a bad request -> 400, no faces_core -> 503, the same form with {"error": ...}.
SELINF_AUTH=user:pass: every request needs that HTTP Basic login (./test.sh starts the server so).
SELINF_REPO: the lynceus checkout whose pipeline code, worker venv and job data this reads; it never writes there.
"""

import base64
import functools
import hmac
import json
import os
import posixpath
import re
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
REPO = Path(os.environ.get("SELINF_REPO", "C:/dev/lynceus"))
WORK = Path(os.environ.get("SELINF_WORK", ROOT / "job"))   # job_params.json + photos.json in, clicks.jsonl out
for _p in ("pipeline", "pipeline/training", "pipeline/cook", "apps/worker/src", "apps/server/src",
           "packages/protocol/python"):
    if str(REPO / _p) not in sys.path:
        sys.path.append(str(REPO / _p))
if sys.platform == "win32":   # the Embree DLLs the worker venv's embreex ships
    os.add_dll_directory(str(Path(np.__file__).parent.parent / "embreex.libs"))
import selinf_core  # noqa: E402 -- needs the DLL directory above

import damage  # noqa: E402 -- damage.py beside this file: the app's damage, whose picks and crops the finds reuse


class Models:
    """The job's checkpoints, loaded and run exactly as the inference stage does."""

    def __init__(self, values, model_dir, applied):
        import torch
        from lynceus_worker.stages import inference as st

        st.append_log = lambda *_: None
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.models = st._load_models(None, None, values, SimpleNamespace(model_dir=str(model_dir)), self.dev)
        self.thr = {c: float(v["threshold"]) for c, v in applied.items()}
        self.min_area = int(values.get("inference.min_mask_area_px", 64))
        for lm in self.models:   # fail at startup, not on every click
            if any(c in lm.owned and c in self.thr for c in lm.classes) and (
                    lm.damageseg or lm.legacy_v1 or not (lm.geometry["geometry"] == "whole" or lm.scales == (1.0,))):
                raise RuntimeError(f"{lm.model_id}: damageseg / format v1 / multi-scale checkpoints are not wired here")
        self.grids = {c: (lm.geometry["tile"], lm.overlap) for lm in self.models   # the tiled classes, for selinf_core
                      if lm.geometry["geometry"] != "whole" and lm.scales == (1.0,) for c in lm.owned if c in self.thr}
        from sliding_window import IMAGENET_MEAN, IMAGENET_STD

        dev = torch.device(self.dev)   # _normalize's float32 constants, on the model's device
        self.mean, self.std = (torch.from_numpy(np.asarray(v, np.float32) * 255.0).to(dev) for v in (IMAGENET_MEAN, IMAGENET_STD))
        self.path = None   # the photo the cache (img, probs, masks) holds

    def mask(self, p, c):   # probabilities -> the stage's uint8 mask
        from sliding_window import remove_small_blobs

        keep = remove_small_blobs(p >= self.thr[c], self.min_area) if self.min_area > 1 else p >= self.thr[c]
        m = (p * 255).astype(np.uint8)
        m[~keep] = 0
        return m

    def infer(self, path, classes, tiles):
        """{class: uint8 (H, W) mask} of the requested classes the models own: selinf_core's only call. `tiles` are a
        tiled model's grid tiles (y, x) to run, in grid order (None = all). The photo, its tiles' probabilities and the
        whole-model masks are kept until another photo is asked for."""
        import torch

        if path != self.path:
            bgr = cv2.imread(str(path))
            if bgr is None:
                raise RuntimeError(f"cannot read the photo {path}")
            self.path, self.img, self.probs, self.masks = path, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), {}, {}
        out = {}
        with torch.inference_mode():
            for k, lm in enumerate(self.models):
                cols = [(i, c) for i, c in enumerate(lm.classes) if c in lm.owned and c in self.thr and c in classes]
                if not cols:
                    continue
                whole = lm.geometry["geometry"] == "whole"
                out.update(self.whole(lm, cols) if whole else self.tiled(k, lm, cols, tiles))
        return out

    def whole(self, lm, cols):   # = predict_whole_streaming, upscaling only these classes
        import torch
        from whole_image import _forward_fitted

        H, W = self.img.shape[:2]
        if any(c not in self.masks for _, c in cols):
            p = _forward_fitted(lm.model, self.img, frame=lm.geometry["frame"], device=torch.device(self.dev),
                                scale_mult=1.0, max_upscale=lm.geometry["max_upscale"], amp_dtype=torch.bfloat16)[0]
            for i, c in cols:
                if c not in self.masks:
                    self.masks[c] = self.mask(cv2.resize(p[i], (W, H), interpolation=cv2.INTER_LINEAR), c)
        return {c: self.masks[c] for _, c in cols}

    def tiled(self, k, lm, cols, tiles):
        """Model k's masks from only `tiles`: the whole photo's (= predict_tiled) wherever every grid tile over a pixel
        ran, 0 elsewhere. New tiles run in batches of 4, the last padded with repeats (cuDNN is bit-exact only at the
        photo's batch size), normalised on the GPU with _normalize's float32 ops; blended in predict_tiled's order."""
        import torch
        from sliding_window import blend_window, tile_origins

        (H, W), T, ov, dev = self.img.shape[:2], lm.geometry["tile"], lm.overlap, torch.device(self.dev)
        img = self.img if min(H, W) >= T else cv2.copyMakeBorder(self.img, 0, max(0, T - H), 0, max(0, T - W),
                                                                 cv2.BORDER_REFLECT_101)   # as predict_tiled pads
        grid = [(y, x) for y in tile_origins(H, T, ov) for x in tile_origins(W, T, ov)]
        run = grid if tiles is None else [tuple(g) for g in tiles]
        new = [g for g in run if (k, *g) not in self.probs]
        for b in range(0, len(new), 4):
            chunk = new[b:b + 4]
            t = torch.from_numpy(np.stack([img[y:y + T, x:x + T] for y, x in chunk + chunk[-1:] * (4 - len(chunk))]))
            t = ((t.to(dev).float() - self.mean) / self.std).permute(0, 3, 1, 2)   # NCHW, with predict_tiled's (NHWC) strides
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=dev.type == "cuda"):
                probs = lm.model(t).float().sigmoid()
            self.probs.update(((k, *g), probs[j]) for j, g in enumerate(chunk))
        m = {c: np.zeros((H, W), np.uint8) for _, c in cols}
        if not run:
            return m
        y0, x0 = min(y for y, _ in run), min(x for _, x in run)
        y1, x1 = max(y for y, _ in run) + T, max(x for _, x in run) + T
        exact = np.ones((y1 - y0, x1 - x0), bool)   # every grid tile over the pixel ran (no tile at all: 0 / 0)
        for y, x in set(grid) - set(run):
            exact[max(0, y - y0):max(0, y - y0 + T), max(0, x - x0):max(0, x - x0 + T)] = False
        win, wsum = torch.from_numpy(blend_window(T, ov).copy()).to(dev), torch.zeros((y1 - y0, x1 - x0), device=dev)
        for y, x in run:
            wsum[y - y0:y - y0 + T, x - x0:x - x0 + T] += win
        for i, c in cols:
            acc = torch.zeros((y1 - y0, x1 - x0), device=dev)
            for y, x in run:
                acc[y - y0:y - y0 + T, x - x0:x - x0 + T] += self.probs[k, y, x][i] * win
            m[c][y0:y1, x0:x1] = self.mask(np.where(exact, (acc / wsum).cpu().numpy(), 0)[:H - y0, :W - x0], c)
        return m


SAME = 0.30   # a find replaces a same-class item sharing >= 30 % of either's voxel cells: a re-analysed crack updates


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def per_class(values, key, cls, default):   # = selinf.cpp's per_class: {cls: v, "*": v}, one number, or the default
    v = values.get(key)
    if isinstance(v, dict):
        v = v.get(cls, v.get("*"))
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def cells(P, voxel):   # the points' voxel cells (np.round(P / voxel)), unique, as comparable rows
    k = np.ascontiguousarray(np.round(np.asarray(P, np.float64) / voxel).astype(np.int64))
    return np.unique(k.view(np.dtype((np.void, 24))).ravel())


class FoundStore:
    """The finds, saved in `folder` (root/out/found, served as /out/found/): found.json {"format": 1, "next", "items"},
    <id>.bin (float32 LE xyz, source frame), img/<id>_<k>.jpg (damage.py's crops). found.json is written last and
    atomically, so it never names a missing file; files it stops naming are deleted after it. Ids are "p" + a number
    that is never reused ("next" outlives a deleted last item: a viewer keeps the bins it has by id).
    values: the job's parameters; shas: {lowercase photo stem: sha256} (photos.json); assets: data/assets."""

    def __init__(self, folder, values, shas, assets):
        self.dir, self.values, self.shas, self.assets = Path(folder), values, shas, Path(assets)
        (self.dir / "img").mkdir(parents=True, exist_ok=True)
        path = self.dir / "found.json"   # unreadable: raise here, rather than start over and lose every find
        doc = json.loads(path.read_bytes()) if path.exists() else {"items": []}
        self.items = doc["items"]
        self.next = max([int(doc.get("next", 1)), *(int(it["id"][1:]) + 1 for it in self.items)])
        keep = {f for it in self.items for f in self.files(it)}
        litter = [f for f in [*self.dir.glob("p*.bin"), *self.dir.glob("img/p*.jpg")]
                  if re.fullmatch(r"p\d+(_\d+)?", f.stem) and f.relative_to(self.dir).as_posix() not in keep]
        for f in [*litter, self.dir / "found.json.tmp"]:   # a save cut short, or a delete that could not finish
            try:
                f.unlink(missing_ok=True)
            except OSError as exc:
                log(f"found: cannot delete {f.name}: {exc!r}")

    @staticmethod
    def files(it):   # an item's files, relative to the folder
        return [f"{it['id']}.bin", *(f"img/{it['id']}_{k}.jpg" for k in range(len(it["p"])))]

    def save(self, core, head, P):
        """The click's find (head = the answer's header, P = its float32 points of head["class"]) as a new item,
        replacing the same class's items it overlaps. -> (item, [replaced ids])."""
        cls, n, P64 = head["class"], len(P), np.asarray(P, np.float64)
        voxel = per_class(self.values, "bake.voxel_size_m", cls, 0.01)
        if cls == "Crack":
            try:   # lynceus's crack length: a skeleton in the points' own plane (reflection-invariant)
                from lynceus_server.damage_measure import crack_length_m
                m = round(crack_length_m(P64, voxel), 3)
            except Exception as exc:  # noqa: BLE001 -- the find is kept without its length
                m = None
                log(f"found: no crack length: {exc!r}")
        else:
            m = round(n * voxel ** 2, 4)
        mine, replaced, lo, hi = cells(P64, voxel), [], P64.min(0) - voxel, P64.max(0) + voxel
        for it in self.items:
            if it["class"] == cls and (np.array(it["b"][:3]) <= hi).all() and (np.array(it["b"][3:]) >= lo).all():
                try:
                    other = cells(np.fromfile(self.dir / f"{it['id']}.bin", "<f4").reshape(-1, 3), voxel)
                except (OSError, ValueError) as exc:
                    log(f"found: {it['id']} not compared: {exc!r}")
                    continue
                if np.intersect1d(mine, other, assume_unique=True).size >= SAME * min(mine.size, other.size):
                    replaced.append(it)
        fid, self.next = f"p{self.next}", self.next + 1
        item = {"id": fid, "class": cls, "voxel": voxel, "measure": "length" if cls == "Crack" else "area", "n": n,
                "m": m, "b": [round(float(v), 3) for v in (*P64.min(0), *P64.max(0))], "p": [],
                "seed": [round(float(v), 3) for v in head["seed"]], "time": time.strftime("%Y-%m-%d %H:%M:%S")}
        try:
            (self.dir / f"{fid}.bin").write_bytes(np.ascontiguousarray(P, "<f4").tobytes())
            item["p"] = self.crops(core, fid, P64, [p["name"] for p in head["photos"]])
            items = [it for it in self.items if all(it is not r for r in replaced)] + [item]
            self.write(items)
        except Exception:
            self.drop({**item, "p": [None] * damage.PICKS})
            raise
        self.items = items
        for it in replaced:
            self.drop(it)
        log(f"found {fid}: {cls}, {n} points, m {m}, {len(item['p'])} photos" +
            (f", replaces {', '.join(it['id'] for it in replaced)}" if replaced else ""))
        return item, [it["id"] for it in replaced]

    def crops(self, core, fid, P, names):
        """ITEM.p, and its crops img/<fid>_<k>.jpg: of the answer's photos (deduped, in order), damage.py's cover --
        the one seeing most of P in frame (ties: the earlier), then the one seeing most not yet seen while it adds
        >= MIN_GAIN of P, up to PICKS; box = its in-frame pixel bbox. A missing or unreadable photo is left out."""
        index, cams, seen = {s: i for i, s in enumerate(core.names)}, core.cameras(), []
        for name in dict.fromkeys(names):
            lo = name.lower()
            if lo in index:
                uv, z = core.project(P, np.array([index[lo]]))   # one photo at a time: (k, n, 2) doubles add up
                u, v = uv[0, :, 0], uv[0, :, 1]
                ok = (z[0] > 0) & (u >= 0) & (u < cams[lo]["W"]) & (v >= 0) & (v < cams[lo]["H"])
                if ok.any():
                    seen.append((name, lo, ok, [float(f(a[ok])) for f in (np.min, np.max) for a in (u, v)]))
        picks, covered = [], np.zeros(len(P), bool)
        while seen and len(picks) < damage.PICKS:
            gain = [np.count_nonzero(ok & ~covered) for _, _, ok, _ in seen]
            g = int(np.argmax(gain))
            if picks and gain[g] < damage.MIN_GAIN * len(P):
                break
            picks.append(seen.pop(g))
            covered |= picks[-1][2]
        out = []
        for name, lo, _, box in picks:
            sha, jpg = self.shas.get(lo), self.dir / "img" / f"{fid}_{len(out)}.jpg"
            try:
                if sha is None:
                    raise FileNotFoundError(f"{name} is not in photos.json")
                path = self.assets / sha[:2] / sha[2:4] / sha
                fracs, missing, rotated = damage.crop_photo((path, [(jpg, box)]))
                if missing:
                    raise FileNotFoundError(path)
            except Exception as exc:  # noqa: BLE001 -- the find keeps its other photos
                jpg.unlink(missing_ok=True)
                log(f"found {fid}: no crop of {name}: {exc!r}")
                continue
            if rotated:
                log(f"found {fid}: {name} is EXIF-rotated, its box may be off")
            out.append([name, *fracs[0]])
        return out

    def delete(self, fid):
        """Item fid out of found.json, then its files. -> False if there is no such item."""
        it = next((it for it in self.items if it["id"] == fid), None)
        if it is None:
            return False
        items = [x for x in self.items if x is not it]
        self.write(items)
        self.items = items
        self.drop(it)
        log(f"found {fid}: deleted")
        return True

    def write(self, items):   # found.json via a temp file; Windows refuses the swap while the old one is being sent
        text = json.dumps({"format": 1, "next": self.next, "items": items}, separators=(",", ":")).encode()
        tmp = self.dir / "found.json.tmp"

        def swap():
            tmp.write_bytes(text)
            os.replace(tmp, self.dir / "found.json")
        damage.retry(swap)

    def drop(self, it):   # files found.json no longer names; one that stays is litter, removed at the next start
        for f in self.files(it):
            try:
                damage.retry((self.dir / f).unlink, True)
            except OSError as exc:
                log(f"found: cannot delete {f}: {exc!r}")


def with_found(store, core, body):
    """The click's answer with its find saved and in the header ("found", "replaced"), the layers as they were; the
    answer unchanged when it found nothing or the save failed (logged: saving never fails a click)."""
    n = int.from_bytes(body[:4], "little")
    try:
        head = json.loads(body[4:4 + n])
        k = head.get("points", {}).get(head.get("class"), 0)
        if not k:
            return body
        head["found"], head["replaced"] = store.save(core, head, np.frombuffer(body, "<f4", 3 * k, 4 + n).reshape(k, 3))
    except Exception as exc:  # noqa: BLE001
        log(f"found: not saved: {exc!r}")
        traceback.print_exc()
        return body
    text = json.dumps(head).encode()
    text += b" " * (-len(text) % 4)   # the layers stay 4-aligned: the viewer reads them in place
    return len(text).to_bytes(4, "little") + text + body[4 + n:]


def framed(head):   # an answer that is only a header (an error): uint32 LE n, the JSON padded to a multiple of 4
    text = json.dumps(head).encode()
    text += b" " * (-len(text) % 4)
    return len(text).to_bytes(4, "little") + text


FACES_OPTS = ("angle_deg", "gap_m", "cell_m", "min_area_m2")   # POST /faces's optional keys = split's tuning


def server(core, infer, classes, root, port=8765, auth=None, found=None, faces=None):
    """The viewer (root's viewer.html, selinf.js and out/) and the clicks, on 127.0.0.1:port. With auth ("user:pass")
    every request needs that HTTP Basic login: the public address forwards here. found: a FoundStore that keeps the
    finds (None: nothing is saved). faces: a faces_core.Faces of the mesh for POST /faces (None: it answers 503)."""
    lock = threading.Lock()
    login = auth and ("Basic " + base64.b64encode(auth.encode()).decode()).encode()

    class H(SimpleHTTPRequestHandler):
        extensions_map = {".html": "text/html", ".js": "text/javascript", ".json": "application/json",   # not the
                          ".glb": "model/gltf-binary"}   # Windows registry's guess: a module script must come as JS
        # the page and its scripts: the only code served
        PAGES = ("/viewer.html", "/selinf.js", "/damage.js", "/thin.js", "/faces.js")

        def end_headers(self):
            # the page and its scripts: never stored (iOS Safari restores a tab from its cache even under no-cache, so
            # an old viewer ran against the new server); tiles and data: revalidate (a rebuilt tile keeps its url)
            page = urlsplit(self.path).path in ("/", *self.PAGES)
            self.send_header("Cache-Control", "no-store" if page else "no-cache")
            super().end_headers()

        def reply(self, code, body, kind="application/json"):
            self.send_response(code)
            for k, v in (("Access-Control-Allow-Origin", "*"), ("Content-Type", kind), ("Content-Length", str(len(body)))):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            if not login or hmac.compare_digest(self.headers.get("Authorization", "").encode(), login):
                return True
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="lod-lite-selinf"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False

        def do_GET(self):
            if not self.allowed():
                return
            path = posixpath.normpath(unquote(urlsplit(self.path).path))
            if path == "/health":
                return self.reply(200, json.dumps({"ok": True, "photos": len(core.names), "classes": classes}).encode())
            path = "/viewer.html" if path == "/" else path
            if path == "/out/found/found.json":   # rewritten within a second, it would still be 304 Not Modified
                del self.headers["If-Modified-Since"]
            if path in self.PAGES or path.startswith("/out/") and os.path.isfile(self.translate_path(path)):
                self.path = path   # nothing else under root: source/, work/, job/ and the code stay private
                return super().do_GET()
            self.send_error(404)

        def do_HEAD(self):
            self.send_error(405)

        def do_POST(self):
            if not self.allowed():
                return
            route = urlsplit(self.path).path
            if route == "/found/delete":
                return self.delete()
            if route == "/faces":
                return self.faces()
            if route != "/click":
                return self.send_error(404)
            try:
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with lock:   # one click at a time: one GPU, selinf_core's localtime + clicks.jsonl append, the store
                    body, code = core.click(req["origin"], req["direction"], infer), 200
                    if found is not None:
                        body = with_found(found, core, body)
            except Exception as exc:  # noqa: BLE001 -- the viewer shows it
                body, code = framed({"error": repr(exc)}), 500
            self.reply(code, body, "application/octet-stream")

        def faces(self):   # POST /faces {"center", "axes", "half", FACES_OPTS...} (text/plain: no CORS preflight)
            if faces is None:
                return self.reply(503, framed({"error": "this server has no element faces (faces_core did not load)"}),
                                  "application/octet-stream")
            try:   # no lock: split only reads the mesh, takes ~50 ms and releases the GIL
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if not isinstance(req, dict) or set(req) - {"center", "axes", "half", *FACES_OPTS}:
                    raise ValueError(f'expected {{"center", "axes", "half"}}, optionally {", ".join(FACES_OPTS)}')
                body, code = faces.split(req["center"], req["axes"], req["half"],
                                         **{k: float(req[k]) for k in FACES_OPTS if k in req}), 200
            except (ValueError, TypeError, KeyError) as exc:   # not JSON, a key missing, a box split refuses
                body, code = framed({"error": repr(exc)}), 400
            except Exception as exc:  # noqa: BLE001 -- the viewer shows it
                body, code = framed({"error": repr(exc)}), 500
            self.reply(code, body, "application/octet-stream")

        def delete(self):   # POST /found/delete {"id": ...} (text/plain: no CORS preflight)
            try:
                fid = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["id"]
            except Exception as exc:  # noqa: BLE001
                return self.reply(400, json.dumps({"error": f'expected {{"id": ...}}: {exc!r}'}).encode())
            try:
                with lock:
                    ok = found is not None and found.delete(fid)
                code, out = (200, {"ok": True, "id": fid}) if ok else (
                    404, {"error": f"no saved find {fid!r}" if found is not None else "this server saves no finds"})
            except Exception as exc:  # noqa: BLE001 -- found.json could not be written: the find stays
                code, out = 500, {"error": repr(exc)}
            self.reply(code, json.dumps(out).encode())

        def log_request(self, code="-", size="-"):   # everything but the tiles that load fine
            if not self.path.startswith("/out/tiles/") or isinstance(code, int) and code >= 400:
                super().log_request(code, size)

        def log_message(self, fmt, *args):
            print(time.strftime("%H:%M:%S"), fmt % args, flush=True)

    return ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=str(root)))


if __name__ == "__main__":
    params = json.loads((WORK / "job_params.json").read_text())   # the job's frozen parameters (from the DB)
    job = REPO / "data" / "projects" / params["project_id"] / "pipeline" / params["job_id"]
    t = time.perf_counter()
    models = Models(params["values"], REPO / "data" / "models",
                    json.loads((job / "inference" / "thresholds.json").read_text())["classes"])
    core = selinf_core.Survey(str(REPO / "data"), str(WORK), models.grids)
    print(f"survey + models loaded in {time.perf_counter() - t:.0f} s: {len(core.names)} photos, grids {models.grids}",
          flush=True)
    try:   # the element faces (POST /faces) are an extra: without them the server runs and /faces answers 503
        import faces_core

        t = time.perf_counter()
        faces = faces_core.Faces(*core.mesh())
        print(f"faces: {faces.tris} triangles in {time.perf_counter() - t:.1f} s", flush=True)
    except Exception as exc:  # noqa: BLE001
        faces = None
        log(f"faces: off: {exc!r}")
    shas = {Path(p["name"]).stem.lower(): p["sha256"] for p in json.loads((WORK / "photos.json").read_bytes())}
    found = FoundStore(ROOT / "out" / "found", params["values"], shas, REPO / "data" / "assets")
    print(f"{len(found.items)} saved finds in {found.dir}", flush=True)
    auth = os.environ.get("SELINF_AUTH")
    srv = server(core, models.infer, (job / "inference" / "classes.txt").read_text().split(), ROOT, auth=auth,
                 found=found, faces=faces)
    print(f"serving http://127.0.0.1:{srv.server_address[1]}/" + (" (login required)" if auth else ""), flush=True)
    srv.serve_forever()
