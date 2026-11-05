# bench/: the viewer rendered and timed on the PC's GPUs

Built for the damage-look study (2026-11-03/04), which is closed: the owner chose the screen-space mask, now on master;
the lean look was rejected and its branch deleted. The harness stays for checking a change's look and GPU cost on real
GPUs. It lives on the PC in `C:\Users\rokob\voxel-bench` (this folder's files but `vbench.sh`, plus `.venv` with
playwright + numpy + pillow and `variants\`), and `vbench.sh` drives it from the Mac.

Why a queue: a Chrome started over ssh runs in session 0 and has no WebGL. The scheduled task **VoxelBench**
("Interactive only", runs `vb.bat` -> `runner.py`) runs in the logged-in session, where Chrome gets the GPU. `runner.py`
serves `serve.py` on 127.0.0.1:8790 and runs `queue\*.cmd` one at a time, so GPU timings never overlap.

- `serve.py`: `/v/<variant>/<path>` = `variants\<variant>\<path>`, else `variants\base\`, else the live checkout's `out\`
  (tiles, damage, finds; read only). viewer.html is patched as served so `window.lod` also has
  `renderer, S, frame, setUncapped`.
- `bench.py`: Playwright. Per variant and view (far, deck, mid, close, graze, rust): wait for the tiles to settle, then
  `--shots` (PNG, UI hidden) and `--perf` (GPU ms via EXT_disjoint_timer_query_webgl2 around `lod.renderFrame()` or
  `renderer.render`, median of `--frames`, `--rounds` interleaved). `nodmg` = base with no damage, the baseline.
  `--gpu rtx` is the installed Chrome (RTX 4070 Laptop); `--gpu igpu` is Playwright's Chromium, pinned to the Intel UHD
  by `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` (`GpuPreference=1;`), a weak-GPU stand-in.
- `vbench.sh push VARIANT FILE...` / `run JOB LOCALDIR BENCHARGS...` / `cmd JOB 'cmd line'` / `status`.
- `gpuinfo.py`: which GPU each browser gets.
- `diffimg.py DIR A:B[,...] VIEW[,...]`: how two labels' shots differ per view (max channel difference, share of pixels
  off by > 2 / > 16), and `diff_A_B__VIEW.png` where they differ.
- `thin_ui.py VARIANT OUTDIR [query]`: the thinning UI in the real page (the Slojevi popover's "Debljina pukotina" slider
  and its draw ranges, a tap on a crack and its inspector) -> PNGs + ui.json in `out\OUTDIR`. Queue it with `vbench.sh cmd`.

`variants\` on the PC: `base` = master as of 6aa3ff2 (before the mask, no thin.js), the fallback for any file a variant
lacks, so a variant of today's viewer carries all of viewer.html, damage.js, selinf.js and thin.js; `mask-sel` = 49239b5
(the mask, with the selection drawn in it); `op50` = 6be9cb2 (50 % opacity); `rev` = 441d589. The others (lean-*,
mask-*, screen-*, shape-*, perf-*, ...) are the study's leftovers. Not in the repo: `.venv`, `variants\`, the job folders
`queue\ running\ done\`, results in `out\`, and `page\` (the study's comparison page).

Gotchas: keep vsync on (an unpaced loop starves screenshots on the iGPU). With the PC at its lock screen the RTX idles at
210-500 MHz and its timings swing; lock the clock for a timing run (`nvidia-smi -lgc 1800,1800` from an elevated ssh,
`nvidia-smi -rgc` after). Contract for variants: keep viewer.html's `window.lod` line and damage.js's dev() HUD lines,
and set `window.lod.damageBusy` while any async prep runs.

```
bench/vbench.sh push cur viewer.html damage.js selinf.js thin.js
bench/vbench.sh run cmp /tmp/res --variants nodmg,mask-sel,cur --views far,deck,close --perf --gpu igpu
bench/vbench.sh cmd thinui '%PY% -u thin_ui.py cur thinui'
```
