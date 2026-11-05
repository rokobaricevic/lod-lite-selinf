"""gpuinfo.py [rtx|igpu]: which GPU each browser gets, and any page errors of the base viewer."""
import asyncio, sys
from playwright.async_api import async_playwright
ARGS = ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu", "--headless=new"]
async def main():
    async with async_playwright() as p:
        for gpu in sys.argv[1:] or ["rtx", "igpu"]:
            b = await p.chromium.launch(channel="chrome" if gpu == "rtx" else None, headless=False, args=ARGS)
            pg = await b.new_page(); logs = []
            pg.on("console", lambda m: logs.append(m.text)); pg.on("pageerror", lambda e: logs.append(str(e)))
            r = await pg.evaluate("""() => { const g = document.createElement('canvas').getContext('webgl2'); if (!g) return 'no webgl2';
                const e = g.getExtension('WEBGL_debug_renderer_info'); return g.getParameter(e.UNMASKED_RENDERER_WEBGL); }""")
            print(gpu, b.version, '->', r, flush=True)
            await pg.goto("http://127.0.0.1:8790/v/base/viewer.html?title=x"); await pg.wait_for_timeout(15000)
            print('  err:', await pg.evaluate("document.getElementById('err').textContent"), '| lod:', await pg.evaluate("!!window.lod"))
            print('  logs:', logs[:8])
            await b.close()
asyncio.run(main())
