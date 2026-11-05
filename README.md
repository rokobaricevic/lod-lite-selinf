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
5. Write 3D Tiles 1.1: KTX2 UASTC textures, meshopt geometry (positions on a 0.24 mm grid, the same in every tile),
   geometricError = max(simplify error, 16 × texel).

The build is resumable, and takes about 30 min and up to ~12 GB RAM for the 50 M-triangle Petrinja survey.

`viewer.html` is three.js + 3d-tiles-renderer from jsDelivr (needs internet), with no build step.
Controls: drag to orbit, right/shift-drag to pan, wheel to zoom to the cursor, double-click to set the
pivot, `F` to fit, `R` to make a drag zoom instead of orbit (up = closer, toward where the drag started; `R` again
orbits); on a phone or tablet: drag to orbit, pinch to zoom, two-finger drag to pan, double-tap to set the
pivot. The dock at the bottom: Slojevi (damage classes, opacity), Prepoznaj oštećenja (selective inference),
Prikaži cijeli most (fit), Zumiranje povlačenjem (`R`, also on a phone: one finger zooms), Tehnički prikaz (the developer HUD: fps, tiles, LOD sliders; hidden by default).
URL params: `?tileset=`, `?lru=<MB>` (default 3072, 512 on touch devices), `?uncapped` (render as fast as the GPU
finishes frames; opens the HUD), `?debug` (opens the HUD), `?selinf=<url>` (another inference server),
`?damage=<dir>` (default `out/damage/`), `?found=<dir>` (default `out/found/`), `?title=` (the structure's name in the title pill),
`?faces` (the element faces tool, below; `?fcell=` `?fgap=` `?fmin=` `?fangle=` tune its split). On touch devices the LOD error target
is 32 px (16 elsewhere): iOS Safari kills a tab that holds ~1 GB, and a close view of the deck at full detail does.

Element faces (`faces.js`, loaded only with `?faces`): the dock tool "Plohe elementa". Turned on, a click on the bridge
drops a 3 m box there (one axis up, one along the camera's horizontal view direction); its gizmo moves, rotates and
resizes it (keys `1` / `2` / `3` or the panel's buttons: pomak / rotacija / veličina). After the drop and after every
drag the box goes to the server (`POST /faces`, in the bake frame, as `/click`), which splits the mesh surface inside it
into flat faces. The viewer asks for a coarse split (`cell_m` 0.10, `gap_m` 0.15, `min_area_m2` 0.25, `angle_deg` 20:
the PC's bake mesh has triangles up to ~30 cm, and the server's finer defaults cut a 3 m box into 12–17 scraps);
`?fcell=` `?fgap=` `?fmin=` `?fangle=` override them. The panel (top left: damage.js's inspector is on the right; a
bottom sheet on a phone) shows the faces alone in a small 3D view of its own, flat grey lit from above with dark
outlines and numbered: drag to orbit, right/shift-drag to pan, wheel or pinch to zoom at the cursor, double-click (or
Prikaži sve) to fit; Izo / Odozgo / Sprijeda (along the box's −y) / Bok (along its x) turn to those views. It refits to
each answer until you orbit. Below it, the faces listed with their area and orientation (gore / dolje / bočno), the
total and the server's time. Hovering or clicking a face (in the view or the list) picks it out in its colour in the
view, the list and over the bridge (drawn on top: the bake mesh is coarser than the tiles); a click keeps it, a click
on empty space clears it. Display only, nothing is saved. `Esc` removes the box (again: the tool off).
`node test_faces.mjs` checks the decoder and the mask geometry (the triangles and outlines built from each mask).

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

In the viewer: Slojevi has one toggle per class (with its count and total), the damage opacity and "Debljina pukotina":
the segmentation's crack masks are 5-10x wider than the crack, so a crack is drawn as a band of that width along its
centreline (`thin.js`, in a Worker at load: each point's distance to the centreline of its crack's mask; ?thin=<mm> |
off sets the half-width, default 2 mm; the points, their measures and picking are unchanged). Click or tap a
damage: the inspector (a bottom sheet on a phone) shows its class, length or area and photos; a photo opens full
screen with a filmstrip of the others (← → or swipe, Esc closes).

How the damage is drawn (`damage.js`): the scene renders into an MSAA target; the damage points draw opaque into a
mask that shares its depth (the bridge in front hides them), and one full-screen pass lays the mask over the scene
with the opacity, so overlapping points never add up. That pass blurs the mask by about half a point's size (its mips,
B-spline filtered) and thresholds it with an antialiased edge: round outlines instead of squares, small gaps filled,
and a thin dark outline. A find's points are stored coarse to fine, so far away only an even subsample is drawn (a
thinned crack's band gets its own coarse-to-fine order, rebuilt when its width changes).
`?dmpost=0` is the old path (blended squares); `?dmlook=plain|smooth|fill|outline` and `?dmk= ?dmt= ?dmo=` tune it.

What "Prepoznaj oštećenja" finds is saved on the PC (`selinf.py`'s FoundStore, in `out/found/`: `found.json`, one
float32 `<id>.bin` per find, photo crops) and shown like the app's damage, for everyone, across reloads and
restarts: its crack length (lynceus's own skeleton length) or area, up to 3 photos picked with the same least-overlap
rule, the damage boxed. Analysing the same damage again replaces the earlier find; "Obriši oštećenje" in the inspector
deletes one (`POST /found/delete {"id": "p7"}`). `./test.sh data` never sends or counts `out/found` (it is the PC's).

## Selective inference (on the PC)

`selinf.py` is the models and the HTTP front; `selinf.cpp` (the pybind11 module `selinf_core`) is everything else,
and its header describes the loop. `test_selinf.py` checks selinf_core against the lynceus pipeline's own Python.

The whole stack runs on the PC, in `C:\Users\rokob\lod-lite-selinf`: selinf.py serves the viewer, its tiles and the
clicks on 127.0.0.1:8765, behind a login (`LOGIN`, default test / test). The public address is a Cloudflare quick tunnel over TCP: traffic
leaving the PC through Tailscale (Funnel, or a tunnel over the tailnet) is capped at ~1 MB/s, plain TCP is not.

```
./test.sh test          # Mac: build selinf_core + faces_core, run test_selinf.py + test_faces.py
./test.sh data          # copy source/ work/ out/ into the PC folder (~10 GB)
./test.sh               # PC: copy the code, build, test, swap in, start; tunnel to the Mac's 127.0.0.1:8765, open it
./test.sh public on     # prints https://<random>.trycloudflare.com/ for anyone with the login; off | status
./test.sh stop          # the PC server and the tunnel
```

The one link to lynceus: selinf reads, and never writes, a lynceus checkout (`SELINF_REPO`; the PC's
`C:\dev\lynceus`, the Mac's `~/dev/lynceus` for the tests): the inference stage's model code, the worker venv's
Python and the job's data. `job/` on the PC holds the job's `job_params.json` and `photos.json` and the click log
`clicks.jsonl`. Its history up to 2026-10-30 is lynceus's `experiments/selective_inference` (commit ffd6b2e9).

## Element faces

Click a bridge element (a girder, an edge beam, a cross-beam, a pier…) in the viewer (`faces.js`): the PC answers it
as a prism, one cross-section swept along a straight axis, whose faces meet exactly (each profile corner is where two
face lines cross), and lists the other candidate faces of the section for the owner to turn on and off. It is only
shown, never saved. `faces.cpp` (the pybind11 module `faces_core`: no Embree, nothing shared with selinf.cpp) is built
from the Survey's bake mesh once, when selinf.py starts; if it cannot load, the server runs without it and `/element`
answers 503. Its header describes the algorithm and the answer; `test_faces.py` checks it on synthetic meshes made to
look like the scan (8-30 cm triangles, ±5 mm noise, 10 % in holes, clutter) with `./test.sh test`.

- `POST /element {"point": [x,y,z], "dir": [x,y,z]}`: the click and its unit view ray in the bake frame, sent as
  text/plain. Optional keys: `axis` (kept as is: a refit sends the answer's back, so the candidates' keys stay),
  `on` / `off` (candidate keys forced in / out), `add` (points: the candidate under each forced in), `s0` / `s1` (a
  forced extent, metres along the axis from the click) and the tuning `window_m` (6), `slab_m` (1.5), `angle_deg`
  (15), `concave_max_m` (0.5), `element_m` (2.5), `presence` (0.35), `gap_m` (2). Any other key, or a bad value, gets
  400 `{"error"}`; a click with nothing to fit there 422 `{"error"}`.
- The answer is JSON: the section frame (`origin`, `axis`, `e1`, `e2`), the extent used and the automatic one, every
  candidate segment of the section (its line, extent, area; on / auto / seed), the profile's `pieces` (polylines through
  the corners, a face key per edge) and the `faces`: 4 exact corners per side face, the closed profile for an end cap
  where the scan closes an end, each with its width, length and the share the scan covers.
- How: the clicked plane (the triangles facing the viewer there) gives the axis: of the bridge's directions (L, T, Z) and
  the local faces' cross products, the one across which that plane is narrowest. The triangles in a 3 m slab around
  the click, projected along it, give the candidate lines (per normal direction the offsets' modes; per line only the
  stretches seen along most of the slab, so brackets, posts and stiffeners drop out). From the clicked one a chain grows
  through convex corners (a short concave face ends a side) to faces ending within 2.5 m. The extent runs both ways
  while the scan covers 35 % of the profile, across gaps of up to 2 m; an automatic axis is then tilted to the
  element's own drift along it (the girders run 0.3° off the bridge's L) and the fit redone.
- 6-16 ms a click on the PC's 1 M-triangle bake mesh (Mac M5 Pro).
- `probe_faces.py <mesh.obj> <dir>` runs it on clicks on Petrinja's bridge (edge beams, road, soffit, a cross-beam, the
  main girder, the duct, the river banks, the abutments) and draws each: the section with every candidate and the chosen
  profile, and the faces over the scan, seen from two sides. The real mesh, not the synthetic tests, is the judge.
