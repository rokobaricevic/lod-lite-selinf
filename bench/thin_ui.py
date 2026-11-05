"""thin_ui.py VARIANT OUTDIR [query]: the thinning UI in the real page -- the Slojevi popover, the slider's draw ranges,
a tap on a crack (selection + inspector, white overlay), the overlay at 'puna'. PNGs + ui.json in out/OUTDIR."""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

B = Path(__file__).resolve().parent
var, outn = sys.argv[1], sys.argv[2]
q = sys.argv[3] if len(sys.argv) > 3 else ""
out = B / "out" / outn
out.mkdir(parents=True, exist_ok=True)
URL = f"http://127.0.0.1:8790/v/{var}/viewer.html?lru=2048&title=bench{'&' + q if q else ''}"
CLOSE = {"eye": [-10.986, 1.55, 1.70], "target": [-10.986, 2.08, 0.834]}
READY = """() => { const t = [...document.querySelectorAll('#ctl pre')].map((e) => e.textContent).join('\\n');
  return /found\\s+(\\d+ items|failed)/.test(t) && /damage\\s+(?!loading)/.test(t) && !window.lod.damageBusy; }"""
SETTLE = """async () => { const t0 = performance.now(); let calm = null;
  for (;;) { await new Promise((r) => setTimeout(r, 100)); const s = lod.tiles.stats, busy = (s.queued || 0) + (s.downloading || 0) + (s.parsing || 0), now = performance.now();
    calm = busy ? null : (calm ?? now); if (now - t0 > 2500 && calm != null && now - calm > 1500) return true; if (now - t0 > 120000) return false; } }"""
RANGES = """() => { const r = []; lod.scene.traverse((o) => { if (o.isPoints) { const g = o.geometry, n = g.attributes.position.count;
  r.push({ n, indexed: !!g.index, draw: g.index ? Math.min(g.drawRange.count, g.index.count) : Math.min(g.drawRange.count, n), sel: o.renderOrder === 999 }); } }); return r; }"""
SLIDE = """(i) => { const s = document.querySelector('input[aria-label="Debljina pukotina"]'); s.value = i; s.dispatchEvent(new Event('input'));
  return [...document.querySelectorAll('.dm-ol .num')].map((e) => e.textContent).join(' | '); }"""


async def main():
    res = {"url": URL}
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=False, args=["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu", "--headless=new"])
        ctx = await b.new_context(viewport={"width": 1600, "height": 900}, device_scale_factor=1)
        page = await ctx.new_page()
        log = []
        page.on("console", lambda m: m.type in ("error", "warning") and log.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: log.append(f"pageerror: {e}"))
        await page.goto(URL, wait_until="load", timeout=60000)
        await page.wait_for_function("!!(window.lod && window.lod.ready)", timeout=120000, polling=250)
        await page.wait_for_function(READY, timeout=180000, polling=250)
        await page.evaluate("(v) => lod.setView(v)", CLOSE)
        await page.evaluate(SETTLE)
        res["hud"] = await page.evaluate("[...document.querySelectorAll('#ctl pre')].map((e) => e.textContent).join(' | ')")
        await page.click('#dock button[aria-label="Slojevi"]')
        await page.wait_for_timeout(400)
        res["labels"] = await page.evaluate("[...document.querySelectorAll('.dm-ol')].map((e) => e.textContent)")
        await page.screenshot(path=str(out / "popover.png"))
        res["slider"] = []
        for i in range(11):
            lbl = await page.evaluate(SLIDE, i)
            await page.wait_for_timeout(50)
            rs = await page.evaluate(RANGES)
            res["slider"].append({"i": i, "label": lbl, "drawn": sum(r["draw"] for r in rs), "of": sum(r["n"] for r in rs)})
        await page.evaluate(SLIDE, 2)  # back to the default, 2 mm
        await page.click('#dock button[aria-label="Slojevi"]')  # close the popover
        await page.wait_for_timeout(300)
        # tap a crack: scan for the reddest pixel near the bottom middle crack (the close view's p9)
        await page.screenshot(path=str(out / "before_tap.png"))
        from PIL import Image
        im = Image.open(out / "before_tap.png").convert("RGB")
        px, best = im.load(), None
        for y in range(500, 880, 2):
            for x in range(700, 1100, 2):
                r, g, bb = px[x, y]
                if r > 200 and g < 80 and bb < 80:
                    best = (x, y)
                    break
            if best:
                break
        res["tap"] = best
        if best:
            await page.mouse.click(*best)
            await page.wait_for_timeout(800)
            res["panel"] = await page.evaluate("document.querySelector('.dm-insp')?.innerText")
            res["sel_ranges"] = [r for r in await page.evaluate(RANGES) if r["sel"]]
            await page.screenshot(path=str(out / "selected.png"))
            await page.click('#dock button[aria-label="Slojevi"]')
            await page.wait_for_timeout(300)
            await page.evaluate(SLIDE, 10)
            await page.click('#dock button[aria-label="Slojevi"]')
            await page.wait_for_timeout(500)
            res["sel_ranges_full"] = [r for r in await page.evaluate(RANGES) if r["sel"]]
            await page.screenshot(path=str(out / "selected_full.png"))
        res["log"] = log[:30]
        await b.close()
    (out / "ui.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(res, indent=1, ensure_ascii=False))


asyncio.run(main())
