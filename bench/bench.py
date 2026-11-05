"""bench.py: the LOD viewer + a damage-rendering variant in Chrome on this PC's GPU -> screenshots and GPU frame times.

  %PY% bench.py --out NAME [--variants base,nodmg,...] [--views far,deck,mid,close,graze,rust] [--size 1920x1080]
                [--gpu rtx|igpu] [--shots] [--perf] [--frames 120] [--rounds 2] [--q k=v ...] [--eval JS]

A variant is  label=dir?query  or just  dir  (label = dir): the page is /v/<dir>/viewer.html?<query>&<--q>, served by
serve.py from variants/<dir>/ over variants/base/ (master's code) over the live out/ (tiles, damage, finds).
Built in: nodmg = base without any damage (?damage=none/&found=none/), the frame cost the damage is measured against.

Per variant (one page), per view: setView, wait for the tiles to settle (nothing queued/downloading/parsing for 1.5 s),
then  --shots: out/NAME/<label>__<view>.png (UI hidden)  and  --perf: the viewer's loop stopped, frames rendered one per
rAF with EXT_disjoint_timer_query_webgl2 around the render (lod.renderFrame() if the variant defines one, else
renderer.render(scene, camera)) -> GPU ms median / p10 / p90 and the render call's CPU ms. --rounds repeats the whole
variant sweep (interleaved), so clock drift hits every variant alike. Results: out/NAME/results.json + a table on stdout.

Contract for variants: keep viewer.html's window.lod line (serve.py patches it), keep damage.js's dev() HUD lines
("damage ..." / "found ... items"), and set window.lod.damageBusy = true while any async prep runs (cleared when done).
--eval JS runs in every page after damage is ready (e.g. to set a variant's knob)."""
import argparse, asyncio, json, statistics, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

B = Path(__file__).resolve().parent
URL = "http://127.0.0.1:8790/v/"
VIEWS = {  # source frame (Z-up, metres); far = the viewer's own fit view
    "far": None,
    "deck": {"eye": [-4.0, -24.0, 15.0], "target": [-4.0, -1.0, 0.8]},
    "mid": {"eye": [-12.0, -4.5, 5.0], "target": [-12.0, 1.8, 0.82]},
    "close": {"eye": [-10.986, 1.55, 1.70], "target": [-10.986, 2.08, 0.834]},
    "graze": {"eye": [-21.0, 2.2, 1.45], "target": [-11.0, 2.2, 0.82]},
    "rust": {"eye": [-0.6, -7.8, 3.6], "target": [-0.642, -4.106, 1.021]},
}
HIDE_UI = "#dock,#title,#hint,#hud,#err,.dm-pop,.dm-insp,.dm-view{display:none!important}"
BUILTIN = {"nodmg": "base?damage=none/&found=none/"}

SETTLE_JS = """async ([minMs, calmMs, maxMs]) => {
  const t0 = performance.now(); let calm = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const s = lod.tiles.stats, busy = (s.queued || 0) + (s.downloading || 0) + (s.parsing || 0), now = performance.now();
    calm = busy ? null : (calm ?? now);
    if (now - t0 > minMs && calm != null && now - calm > calmMs) return { ok: true, ms: Math.round(now - t0) };
    if (now - t0 > maxMs) return { ok: false, ms: Math.round(now - t0), busy };
  }
}"""

PERF_JS = """async ([warm, frames]) => {
  const { renderer, scene, camera } = lod, gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { error: 'no EXT_disjoint_timer_query_webgl2' };
  renderer.setAnimationLoop(null); lod.S.uncapped = false;
  const render = lod.renderFrame || (() => renderer.render(scene, camera));
  const raf = () => new Promise((r) => requestAnimationFrame(r)), qs = [], cpu = [];
  gl.getParameter(ext.GPU_DISJOINT_EXT);
  for (let i = 0; i < warm + frames; i++) {
    await raf();
    camera.updateMatrixWorld();
    const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const t = performance.now(); render(); const c = performance.now() - t;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    if (i >= warm) { qs.push(q); cpu.push(c); } else gl.deleteQuery(q);
  }
  const gpu = [];
  for (const q of qs) {
    let n = 0;
    while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { await raf(); if (++n > 600) return { error: 'query timeout' }; }
    gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q);
  }
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  renderer.setAnimationLoop(lod.frame);
  return { gpu, cpu, disjoint, calls: renderer.info.render.calls, points: renderer.info.render.points, tris: renderer.info.render.triangles };
}"""

DAMAGE_READY_JS = """() => { const t = [...document.querySelectorAll('#ctl pre')].map((e) => e.textContent).join('\\n');
  return /found\\s+(\\d+ items|failed)/.test(t) && /damage\\s+(?!loading)/.test(t) && !window.lod.damageBusy; }"""


def pct(a, p):
    a = sorted(a)
    return a[min(len(a) - 1, int(p * (len(a) - 1) + 0.5))]


def parse_variant(s, extra):
    label, _, spec = s.partition("=") if "=" in s else (s, "", s)
    spec = BUILTIN.get(spec, spec)
    d, _, q = spec.partition("?")
    q = "&".join(x for x in (q, extra) if x)
    return label, f"{URL}{d}/viewer.html?lru=2048&title=bench{'&' + q if q else ''}"


async def run_variant(browser, label, url, a, out, res):
    w, h = map(int, a.size.split("x"))
    ctx = await browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
    page = await ctx.new_page()
    log = []
    page.on("console", lambda m: m.type in ("error", "warning") and log.append(f"console.{m.type}: {m.text}"))
    page.on("pageerror", lambda e: log.append(f"pageerror: {e}"))
    t0 = time.time()
    await page.goto(url, wait_until="load", timeout=60000)
    await page.wait_for_function("!!(window.lod && window.lod.ready)", timeout=120000, polling=250)
    await page.evaluate("lod.ready")
    await page.add_style_tag(content=HIDE_UI)
    await page.wait_for_function(DAMAGE_READY_JS, timeout=180000, polling=250)
    if a.eval:
        await page.evaluate(a.eval)
    info = await page.evaluate("""() => ({ gpu: (() => { const g = lod.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info');
        return g.getParameter(e.UNMASKED_RENDERER_WEBGL); })(), hud: [...document.querySelectorAll('#ctl pre')].map((e) => e.textContent).join(' | ') })""")
    print(f"[{label}] loaded in {time.time() - t0:.1f}s  {info['hud']}", flush=True)
    res.setdefault("_gpu", info["gpu"])
    for v in a.views:
        if VIEWS[v] is None:
            await page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))")
        else:
            await page.evaluate("(v) => lod.setView(v)", VIEWS[v])
        st = await page.evaluate(SETTLE_JS, [2500, 1500, 150000])
        await page.wait_for_timeout(300)
        r = res.setdefault(label, {}).setdefault(v, {"settle": st})
        if a.shots and "shot" not in r:
            p = out / f"{label}__{v}.png"
            await page.evaluate("() => { lod.renderer.setAnimationLoop(null); lod.frame(); }")  # one frame, then a still page
            await page.wait_for_timeout(200)
            await page.screenshot(path=str(p), timeout=120000)
            await page.evaluate("() => lod.renderer.setAnimationLoop(lod.frame)")
            r["shot"] = p.name
        if a.perf:
            m = await page.evaluate(PERF_JS, [a.warm, a.frames])
            if "error" in m:
                r.setdefault("errors", []).append(m["error"])
            else:
                r.setdefault("gpu_runs", []).append(m["gpu"])
                r.setdefault("cpu_runs", []).append(m["cpu"])
                r.update(calls=m["calls"], points=m["points"], tris=m["tris"], disjoint=m["disjoint"])
        print(f"[{label}] {v}: settle {st}", flush=True)
    if log:
        res.setdefault("_log", {}).setdefault(label, []).extend(log[:50])
        print(f"[{label}] console:\n  " + "\n  ".join(log[:20]), flush=True)
    await ctx.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--variants", default="base")
    ap.add_argument("--views", default="far,deck,mid,close,graze,rust")
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--gpu", default="rtx", choices=["rtx", "igpu"])
    ap.add_argument("--shots", action="store_true")
    ap.add_argument("--perf", action="store_true")
    ap.add_argument("--frames", type=int, default=120)
    ap.add_argument("--warm", type=int, default=30)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--q", action="append", default=[], help="extra URL param k=v for every variant")
    ap.add_argument("--eval", default="")
    a = ap.parse_args()
    a.views = a.views.split(",")
    out = B / "out" / a.out
    out.mkdir(parents=True, exist_ok=True)
    extra = "&".join(a.q)
    variants = [parse_variant(s, extra) for s in a.variants.split(",")]
    res = {"_args": vars(a) | {"views": a.views}, "_urls": dict(variants)}
    args = ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding"]  # vsync on: an unpaced loop floods the iGPU and starves the screenshots
    async with async_playwright() as p:
        # rtx: the installed Chrome (Windows picks the RTX 4070); igpu: Playwright's Chromium, pinned to the Intel UHD by
        # HKCU\Software\Microsoft\DirectX\UserGpuPreferences (GpuPreference=1) -- a stand-in for a weak (phone) GPU
        browser = await p.chromium.launch(channel="chrome" if a.gpu == "rtx" else None, headless=False, args=args + ["--headless=new"])
        try:
            for rnd in range(a.rounds):
                for label, url in (variants if rnd % 2 == 0 else variants[::-1]):
                    await run_variant(browser, label, url, a, out, res)
        finally:
            await browser.close()
    # summary
    print(f"\nGPU: {res.get('_gpu')}  size {a.size}")
    for label, _ in variants:
        for v in a.views:
            r = res.get(label, {}).get(v, {})
            if "gpu_runs" not in r:
                continue
            g = [x for run in r["gpu_runs"] for x in run]
            c = [x for run in r["cpu_runs"] for x in run]
            r["gpu_ms"] = {"median": round(statistics.median(g), 3), "p10": round(pct(g, 0.1), 3), "p90": round(pct(g, 0.9), 3),
                           "run_medians": [round(statistics.median(x), 3) for x in r["gpu_runs"]]}
            r["cpu_ms"] = round(statistics.median(c), 3)
            del r["gpu_runs"], r["cpu_runs"]
    base = res.get("nodmg", {})
    print(f"{'variant':<22}{'view':<7}{'gpu ms':>8}{'p10':>7}{'p90':>7}{'+dmg':>7}{'cpu ms':>8}{'calls':>6}{'points':>9}")
    for label, _ in variants:
        for v in a.views:
            r = res.get(label, {}).get(v, {})
            if "gpu_ms" not in r:
                continue
            b = base.get(v, {}).get("gpu_ms", {}).get("median")
            plus = f"{r['gpu_ms']['median'] - b:+.2f}" if b is not None and label != "nodmg" else ""
            print(f"{label:<22}{v:<7}{r['gpu_ms']['median']:>8.2f}{r['gpu_ms']['p10']:>7.2f}{r['gpu_ms']['p90']:>7.2f}{plus:>7}"
                  f"{r['cpu_ms']:>8.2f}{r.get('calls', 0):>6}{r.get('points', 0):>9}")
    (out / "results.json").write_text(json.dumps(res, indent=1))
    print(f"\nresults: {out / 'results.json'}")


if __name__ == "__main__":
    asyncio.run(main())
