"""Selective inference, the models and the HTTP front. A click on the bridge is followed from photo to photo and
baked by selinf_core (selinf.cpp, which describes the loop); it calls back into Models.infer for the masks.

    python selinf.py      # PC: loads the survey + models, serves 127.0.0.1:8765   (./test.sh deploys and starts it)

GET /: the lod-lite viewer (viewer.html, selinf.js, out/'s tiles); GET /health: JSON.
POST /click {"origin": [x,y,z], "direction": [x,y,z]} (a camera ray, bake frame) -> selinf_core's answer: uint32 LE n,
  n bytes of JSON header, then each layer's float32 xyz; an error -> 500, the same form with {"error": ...}.
SELINF_AUTH=user:pass: every request needs that HTTP Basic login (./test.sh starts the server so).
SELINF_REPO: the lynceus checkout whose pipeline code, worker venv and job data this reads; it never writes there.
"""

import base64
import functools
import hmac
import json
import os
import posixpath
import sys
import threading
import time
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


def server(core, infer, classes, root, port=8765, auth=None):
    """The viewer (root's viewer.html, selinf.js and out/) and the clicks, on 127.0.0.1:port. With auth ("user:pass")
    every request needs that HTTP Basic login: the public address forwards here."""
    lock = threading.Lock()
    login = auth and ("Basic " + base64.b64encode(auth.encode()).decode()).encode()

    class H(SimpleHTTPRequestHandler):
        extensions_map = {".html": "text/html", ".js": "text/javascript", ".json": "application/json",   # not the
                          ".glb": "model/gltf-binary"}   # Windows registry's guess: a module script must come as JS

        def end_headers(self):  # revalidate every time: a rebuilt tile keeps its url
            self.send_header("Cache-Control", "no-cache")
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
            if path in ("/viewer.html", "/selinf.js") or path.startswith("/out/") and os.path.isfile(self.translate_path(path)):
                self.path = path   # nothing else under root: source/, work/, job/ and the code stay private
                return super().do_GET()
            self.send_error(404)

        def do_HEAD(self):
            self.send_error(405)

        def do_POST(self):
            if not self.allowed():
                return
            if urlsplit(self.path).path != "/click":
                return self.send_error(404)
            try:
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with lock:   # one click at a time: one GPU, and selinf_core's localtime + clicks.jsonl append
                    body, code = core.click(req["origin"], req["direction"], infer), 200
            except Exception as exc:  # noqa: BLE001 -- the viewer shows it
                head = json.dumps({"error": repr(exc)}).encode()
                head += b" " * (-len(head) % 4)
                body, code = len(head).to_bytes(4, "little") + head, 500
            self.reply(code, body, "application/octet-stream")

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
    auth = os.environ.get("SELINF_AUTH")
    srv = server(core, models.infer, (job / "inference" / "classes.txt").read_text().split(), ROOT, auth=auth)
    print(f"serving http://127.0.0.1:{srv.server_address[1]}/" + (" (login required)" if auth else ""), flush=True)
    srv.serve_forever()
