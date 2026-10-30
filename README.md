# lod-lite + selective inference

Streaming LOD viewer for a RealityScan survey (built on Petrinja), made from the existing OBJ parts and
diffuse atlas with our own decimation and texture re-bake. RealityScan is not run. The app's damage is drawn on
it: click a damage for its crack length or area and its best photos. Press "Prepoznaj oštećenja" and click the
bridge (or alt-click it) and the PC runs the damage models only on the photos around the click; the damage it
finds is drawn in the viewer. The page is styled as the lynceus app, Ui Inspect (its v3 "C2 · Studio" tokens and
components, Croatian product text).

```
source/                 *_00000NN.obj parts + *_diffuse.jpg (copy them in)
uv run lod.py build     # -> out/tileset.json + out/tiles/*.glb   (needs `ktx` from KTX-Software, or KTX_BIN=…)
uv run lod.py serve     # http://127.0.0.1:8000/viewer.html, the tiles only (no inference)
```

`lod.py` is the whole pipeline:
1. Weld all parts into one mesh.
2. k-d split into 1024 leaf tiles of ~50k original triangles.
3. Simplify bottom-up with meshoptimizer into 256 / 64 / 16 / 4 / 1 parent tiles. Borders are locked, so tiles
   at different levels never crack.
4. Textures: leaves reuse the atlas's own texels. Each UV island's pixel rect is copied at an integer offset,
   so nothing is resampled. Parents are re-baked (xatlas + numba) from the closest point on the original mesh.
5. Write 3D Tiles 1.1: KTX2 ETC1S textures, lossless meshopt geometry,
   geometricError = max(simplify error, 16 × texel).

The build is resumable, and takes about 30 min and up to ~12 GB RAM for the 50 M-triangle Petrinja survey.

`viewer.html` is three.js + 3d-tiles-renderer from jsDelivr (needs internet), with no build step.
Controls: drag to orbit, right/shift-drag to pan, wheel to zoom to the cursor, double-click to set the
pivot, `F` to fit; on a phone or tablet: drag to orbit, pinch to zoom, two-finger drag to pan, double-tap to set the
pivot. The dock at the bottom: Slojevi (damage classes, opacity), Prepoznaj oštećenja (selective inference),
Prikaži cijeli most (fit), Tehnički prikaz (the developer HUD: fps, tiles, LOD sliders; hidden by default).
URL params: `?tileset=`, `?lru=<MB>` (default 3072, 768 on touch devices), `?uncapped` (render as fast as the GPU
finishes frames; opens the HUD), `?debug` (opens the HUD), `?selinf=<url>` (another inference server),
`?damage=<dir>` (default `out/damage/`), `?title=` (the structure's name in the title pill).

## Damage (the app's, from lynceus)

`damage.py` turns the lynceus app's damage store (the project's `content/`: points.bin, the hidden-points bitset,
crack_lengths.json, points_sources.bin, the photos) into `out/damage/`, static files the viewer's `damage.js` loads:

- `damage.bin`: the points the app shows (uint16 xyz in the scene's box, 6 B/point, ~10 MB), grouped by class, then damage.
- `damage.json`: per class its colour and totals; per damage (= the app's cluster) its point range, box, crack length
  (Crack: lynceus's own cached skeleton length) or area (point count × voxel², as the app counts it), and its photos.
- `img/<damage>_<k>.jpg`: crops of up to 3 photos per damage, chosen so they overlap least: the photo whose mask
  found most of the damage's points (the app's ranking), then while it adds ≥ 10 % of the points, the one that sees
  the most points not yet covered (per-point provenance, points_sources.bin). Each crop carries the damage's box.

```
./test.sh damage        # PC: run damage.py next to the data (~20 s), copy out\damage back into out/ (~80 MB)
```

In the viewer: Slojevi has one toggle per class (with its count and total) and the damage opacity. Click or tap a
damage: the inspector (a bottom sheet on a phone) shows its class, length or area and photos; a photo opens full
screen with a filmstrip of the others (← → or swipe, Esc closes).

## Selective inference (on the PC)

`selinf.py` is the models and the HTTP front; `selinf.cpp` (the pybind11 module `selinf_core`) is everything else,
and its header describes the loop. `test_selinf.py` checks selinf_core against the lynceus pipeline's own Python.

The whole stack runs on the PC, in `C:\Users\rokob\lod-lite-selinf`: selinf.py serves the viewer, its tiles and the
clicks on 127.0.0.1:8765, behind a login (`LOGIN`, default test / test). The public address is a Cloudflare quick tunnel over TCP: traffic
leaving the PC through Tailscale (Funnel, or a tunnel over the tailnet) is capped at ~1 MB/s, plain TCP is not.

```
./test.sh test          # Mac: build selinf_core, run test_selinf.py
./test.sh data          # copy source/ work/ out/ into the PC folder (~10 GB)
./test.sh               # PC: copy the code, build, test, swap in, start; tunnel to the Mac's 127.0.0.1:8765, open it
./test.sh public on     # prints https://<random>.trycloudflare.com/ for anyone with the login; off | status
./test.sh stop          # the PC server and the tunnel
```

The one link to lynceus: selinf reads, and never writes, a lynceus checkout (`SELINF_REPO`; the PC's
`C:\dev\lynceus`, the Mac's `~/dev/lynceus` for the tests): the inference stage's model code, the worker venv's
Python and the job's data. `job/` on the PC holds the job's `job_params.json` and `photos.json` and the click log
`clicks.jsonl`. Its history up to 2026-10-30 is lynceus's `experiments/selective_inference` (commit ffd6b2e9).
