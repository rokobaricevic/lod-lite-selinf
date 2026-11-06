"""lod_probe.py: the damage LOD's counts and CPU timings in the real page (bench/lodprobe.js, from the variant's folder).

  %PY% lod_probe.py --out NAME --variant label=dir?query [--views far,deck,...] [--gpu igpu|rtx] [--configs JSON]

Per view (bench.py's VIEWS): the points each LOD scheme draws (lodprobe.counts: find / chunk / oracle / vis) for each
config {name, lv, ch, px, band, minPx}, the variant's lodUpdate per frame and the tap's scan (lodprobe.cpu); once per
page the coarse-to-fine builds (lodprobe.builds). -> out/NAME/probe.json + a table."""
import argparse, asyncio, json, time
from pathlib import Path
from playwright.async_api import async_playwright
from bench import VIEWS, SETTLE_JS, DAMAGE_READY_JS, parse_variant

B = Path(__file__).resolve().parent
DEF = [
    {"name": "lv6-ch0.32", "lv": 6, "ch": 0.32, "px": 1.25, "band": 0.35, "minPx": 2.5},
    {"name": "lv6-ch0.64", "lv": 6, "ch": 0.64, "px": 1.25, "band": 0.35, "minPx": 2.5},
    {"name": "lv6-ch1.28", "lv": 6, "ch": 1.28, "px": 1.25, "band": 0.35, "minPx": 2.5},
    {"name": "lv8-ch0.64", "lv": 8, "ch": 0.64, "px": 1.25, "band": 0.35, "minPx": 2.5},
    {"name": "lv8-ch0.64-px2.5", "lv": 8, "ch": 0.64, "px": 2.5, "band": 0.35, "minPx": 2.5},
    {"name": "lv8-ch0.64-px2.5-b0.5", "lv": 8, "ch": 0.64, "px": 2.5, "band": 0.5, "minPx": 2.5},
]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--variant", required=True)
    ap.add_argument("--views", default="far,deck,mid,close,graze,rust")
    ap.add_argument("--gpu", default="igpu", choices=["rtx", "igpu"])
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--configs", default="")
    ap.add_argument("--q", action="append", default=[])
    a = ap.parse_args()
    out = B / "out" / a.out
    out.mkdir(parents=True, exist_ok=True)
    label, url = parse_variant(a.variant, "&".join(a.q))
    configs = json.loads(a.configs) if a.configs else DEF
    w, h = map(int, a.size.split("x"))
    res = {"url": url, "configs": configs, "views": {}}
    args = ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--headless=new"]
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome" if a.gpu == "rtx" else None, headless=False, args=args)
        ctx = await browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print("pageerror:", e, flush=True))
        page.on("console", lambda m: m.type == "error" and print("console.error:", m.text, flush=True))
        t0 = time.time()
        await page.goto(url, wait_until="load", timeout=60000)
        await page.wait_for_function("!!(window.lod && window.lod.ready)", timeout=120000, polling=250)
        await page.evaluate("lod.ready")
        await page.wait_for_function(DAMAGE_READY_JS, timeout=180000, polling=250)
        await page.evaluate("async () => { window.lodprobe = await import(new URL('lodprobe.js', location.href).href); }")
        hud = await page.evaluate("[...document.querySelectorAll('#ctl pre')].map((e) => e.textContent).join(' | ')")
        res["hud"] = hud
        res["knobs"] = await page.evaluate("({ ...lod.dm.knobs, thinMm: lod.dm.knobs.thinMm(), tstat: lod.dm.tstat })")
        print(f"[{label}] loaded in {time.time() - t0:.1f}s  {hud}\nknobs {res['knobs']}", flush=True)
        res["builds"] = await page.evaluate("lodprobe.builds()")
        for v in a.views.split(","):
            if VIEWS[v] is None:
                await page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))")
            else:
                await page.evaluate("(v) => lod.setView(v)", VIEWS[v])
            await page.evaluate(SETTLE_JS, [2000, 1000, 60000])
            c = await page.evaluate("(cf) => lodprobe.counts(cf)", configs)
            u = await page.evaluate("lodprobe.cpu()")
            res["views"][v] = {"counts": c, "cpu": u}
            pk = u["picks"]
            med = lambda xs: sorted(xs)[len(xs) // 2] if xs else None
            print(f"\n== {v}: lodUpdate {u['lodUs']} us/frame; {len(pk)} taps, {sum(q['hit'] is not None for q in pk)} on damage, "
                  f"{sum(q['hit'] != q['ref'] for q in pk)} differ from the full scan; ms median/max: tiles {med([q['tiles'] for q in pk])}/"
                  f"{max([q['tiles'] for q in pk], default=None)}, damage {med([q['dmg'] for q in pk])}/{max([q['dmg'] for q in pk], default=None)}, "
                  f"full scan {med([q['full'] for q in pk])}/{max([q['full'] for q in pk], default=None)}", flush=True)
            print(f"{'config':<24}{'n':>8}{'vis':>8}{'find':>8}{'chunk':>8}{'oracle':>8}{'chunks':>7}{'ranges':>7}")
            for name, t in c.items():
                print(f"{name:<24}{t['n']:>8}{t['vis']:>8}{t['find']:>8}{t['chunk']:>8}{t['oracle']:>8}{t['chunks']:>7}{t['ranges']:>7}")
        await browser.close()
    print("\nbuilds (ms, best of 3): id n | all: c2f chunkLod | band: c2f chunkLod")
    for r in res["builds"]:
        print(f"  {r['id']:<4}{r['n']:>7} | {r['all']['c2f']:>8} {r['all']['chunk']:>8}" + (f" | {r['band']['c2f']:>7} {r['band']['chunk']:>7} ({r['nb']} pts)" if r.get("band") else ""))
    (out / "probe.json").write_text(json.dumps(res, indent=1))
    print(f"\nresults: {out / 'probe.json'}")


if __name__ == "__main__":
    asyncio.run(main())
