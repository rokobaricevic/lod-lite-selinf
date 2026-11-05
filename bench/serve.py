"""serve.py: the bench's static server, 127.0.0.1:8790, no login, nothing cached.
/v/<variant>/<path> -> variants/<variant>/<path>, else variants/base/<path> (master's viewer.html, damage.js, selinf.js),
else the live checkout's <path> for data only (out/: tiles, damage, found; read, never written).
viewer.html is patched as served: window.lod also carries renderer, S (frozen, ...), frame and setUncapped, for bench.py."""
import http.server, socketserver, urllib.parse
from pathlib import Path

LIVE = Path(r"C:\Users\rokob\lod-lite-selinf")
VAR = Path(__file__).resolve().parent / "variants"
MIME = {".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8", ".json": "application/json",
        ".bin": "application/octet-stream", ".glb": "model/gltf-binary", ".ktx2": "image/ktx2", ".jpg": "image/jpeg",
        ".png": "image/png", ".wasm": "application/wasm", ".css": "text/css"}

def resolve(name, rel):
    for f in (VAR / name / rel, VAR / "base" / rel):
        if f.is_file():
            return f
    if rel.startswith("out/") and (LIVE / rel).is_file():
        return LIVE / rel
    return None

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        parts = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/").split("/")
        if len(parts) < 3 or parts[0] != "v" or ".." in parts or not parts[1]:
            return self.send_error(404)
        rel = "/".join(parts[2:]) or "viewer.html"
        f = resolve(parts[1], rel)
        if f is None:
            return self.send_error(404)
        data = f.read_bytes()
        if rel == "viewer.html":
            data = data.replace(b"window.lod = {", b"window.lod = { renderer, S, frame, setUncapped,", 1)
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(f.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    S(("127.0.0.1", 8790), H).serve_forever()
