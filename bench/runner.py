"""runner.py: runs in the interactive session (scheduled task VoxelBench -> vb.bat), so Chrome gets the GPU.
Serves serve.py on :8790 and runs queue/*.cmd ONE AT A TIME (oldest first) -- GPU timings never overlap.
A job NAME.cmd runs with cwd = this folder, env PY = this venv's python; its output goes to done/NAME.log and its exit
code + seconds to done/NAME.exit (written last). runner.alive is touched every second (stale > 20 s = not running)."""
import os, subprocess, sys, time
from pathlib import Path

B = Path(__file__).resolve().parent
Q, R, D = B / "queue", B / "running", B / "done"
for d in (Q, R, D):
    d.mkdir(exist_ok=True)
env = dict(os.environ, PY=sys.executable, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
srv = None
while True:
    if srv is None or srv.poll() is not None:
        srv = subprocess.Popen([sys.executable, str(B / "serve.py")], cwd=B, env=env)
    (B / "runner.alive").write_text(str(time.time()))
    jobs = sorted(Q.glob("*.cmd"), key=lambda p: p.stat().st_mtime)
    if not jobs:
        time.sleep(1)
        continue
    j = jobs[0]
    r = R / j.name
    try:
        j.replace(r)
    except OSError:
        time.sleep(1)
        continue
    t0 = time.time()
    with open(D / (j.stem + ".log"), "wb") as log:
        log.write(f"[runner] {time.strftime('%H:%M:%S')} start {j.name}\r\n".encode())
        log.flush()
        p = subprocess.Popen(["cmd", "/c", str(r)], cwd=B, env=env, stdout=log, stderr=subprocess.STDOUT)
        while p.poll() is None:
            (B / "runner.alive").write_text(str(time.time()))
            if time.time() - t0 > 3600:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
            time.sleep(1)
    (D / (j.stem + ".exit")).write_text(f"{p.returncode} {time.time() - t0:.0f}s")
    r.unlink(missing_ok=True)
