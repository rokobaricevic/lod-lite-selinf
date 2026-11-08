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
`?faces` (the element tool, below; `?ewin=` `?eslab=` `?eangle=` `?econcave=` `?eelem=` `?epresence=` `?egap=` tune its fit). On touch devices the LOD error target
is 32 px (16 elsewhere): iOS Safari kills a tab that holds ~1 GB, and a close view of the deck at full detail does.

Element prisms (`faces.js`, loaded only with `?faces`): the dock tool "Odabir elementa". Turned on, a click on the
bridge sends the point and the view ray to the server (`POST /element`, in the bake frame), which fits the element there
as a prism: one cross-section swept along a straight axis between two stations, its faces meeting exactly at the
profile's corners. Over the bridge it is a closed shell, the profile inflated by 3 cm with mitered corners: translucent,
crisp edges, drawn in front of the scan. Each pixel's depth is pulled toward the eye along its own ray by 0.12 m + 1.2 %
of its distance (at most 0.6 m, never past half way; `?ebias=b0,k,max`), so the scan's noise (±2 cm on clean concrete,
±10–20 cm under the deck and on the abutments, plus the tiles' LOD error, ~1 % of the distance) does not poke through it
in blotches, while what stands well in front still hides it (a railing post 0.3 m before the fascia seen from 5 m; the
braces ~0.2 m before a girder's web seen from 3 m); its parts behind other things are not drawn there (the panel's 3D
view shows them; only a hovered or picked face shows faintly through what hides it). On the
bridge a click always starts a new element at that point, on the shown one too; shift-click adds the surface under the
cursor; alt-click takes out the element's face under the cursor, which lights while alt is held over it (not where the
scan hides it: the mouse on the road does not take the girder's web below it; with the tool
on, an alt-click is the tool's, not the selective inference's). Until the answer comes the element shown stays, with a
pulsing dot at the click and "Računanje…" in the panel; where no element is recognised it stays too, and the hint says
why. Two handles on the axis drag its ends (the release refits with that extent; "Automatska duljina" lets the scan
decide again). The panel (top left:
damage.js's inspector is on the right; a bottom sheet on a phone; "Cijeli zaslon": full screen, the Fullscreen API or a
CSS overlay on iOS, `Esc` leaves) shows the prism alone in a 3D view of its own, lynceus's look (flat grey lambert faces,
dark edges, the section's outline light at both ends, the other candidates dashed, numbered): drag to orbit,
right/shift-drag to pan, wheel or pinch to zoom at the cursor, double-click (or Prikaži sve) to fit; Izo / Odozgo /
Sprijeda (square on, from the click's side) / Bok (along the axis) turn to those views. Below it the section: every
candidate segment (solid in the element, dashed out), the profile through its corners, the click, a scale bar; a click
on a segment puts it in or takes it out, the main way to refine it; a candidate hovered there (or in the list) shows
over the bridge, its rectangle outlined. Then the faces (area, width × length, how much of it the scan covers, gore /
dolje / bočno, a switch: in or out) and the total (faces, area, length, the server's time). Hovering or clicking a face
in the panel picks it out everywhere (the list, the 3D view, the section, over the bridge with its outline on top);
`Delete` takes the picked one out. Every change refits, one request at a time (the latest wins; a failure goes back to
the answer shown), with the answer's axis, so the candidates keep their keys. Display only, nothing is saved. `Esc`
clears (again: the tool off). On a phone a tap picks and the panel refines. `node test_faces.mjs` checks the geometry:
the mitered inflation, the shell, the ghosts, the face under a ray, the section's drawing, the handles' projection, the
bias's numbers. To try it on the Mac without the PC: `~/dev/lynceus/apps/worker/.venv/bin/python dev_faces.py`
(http://127.0.0.1:8770/viewer.html?faces) serves this folder, a tileset at `/out/` (`--out`, default
`~/dev/lod-lite-selinf/out-uastc-200k`) and `POST /element`: faces_core on the bake mesh with
`--mesh build/bake/mesh.obj` (when faces_core imports: `./test.sh test` builds it), else a mock girder at the click.

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

How the damage is drawn (`damage.js`): the scene renders into a target (no MSAA); the damage points draw opaque into a
mask that shares its depth (the bridge in front hides them), and one full-screen pass lays the mask over the scene
with the opacity, so overlapping points never add up. That pass blurs the mask by about half a point's size (its mips,
B-spline filtered) and thresholds it with an antialiased edge: round outlines instead of squares, small gaps filled,
and a thin dark outline. The scene has no MSAA: the same pass antialiases it with FXAA, only where the depth steps or
creases (the bridge's edges, not its texture); 4x MSAA was most of the frame on a weak GPU. The mask keeps 4x MSAA in a
target of its own (its points test the bridge's depth texture themselves): without it its sprites cover a pixel all or
nothing and its edges blink while the camera moves. The bridge's thin members shimmer more in motion than with MSAA,
and those thinner than a pixel, far away, break into dashes. `?dmsplit=0` is the look before (4x MSAA for both, the mask
inline); `?dmsplit=0&dmsamples=0` FXAA with the mask inline and no MSAA (the fastest, but the damage's edges blink);
`?dmaa=2` the lighter FXAA (console), `?dmaad=0` FXAA everywhere.
The points are grouped into chunks of ~0.64 m, stored chunk after chunk and coarse to fine
in each, so each frame a chunk out of view is skipped and one far away draws only an even subsample (its prefix for
its own nearest depth); all of a Points' chunk prefixes are one WEBGL_multi_draw call. A find's own floats are stored
that way; the app's classes (one Points each) draw through an index in that order; a thinned crack's band gets its
own chunked order, rebuilt when its width changes. A tap scans only the chunks its ray meets. `?dmchunk=0` is the
previous LOD (one prefix per find, none for the app's damage); `?dmlodpx= ?dmlodband= ?dmlv=` tune it.
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
  (15), `concave_max_m` (0: a concrete element takes no concave face), `element_m` (2.5), `presence` (0.35), `gap_m`
  (4). Any other key, or a bad value, gets
  400 `{"error"}`; a click where no element is recognised 422 `{"error": "Ovdje nije prepoznat element"}` (the viewer
  shows it).
- The answer is JSON: the section frame (`origin`, `axis`, `e1`, `e2`; `origin` is where the view ray meets the bake
  mesh, not the point sent: the viewer's LOD tile is 7-12 cm off it), the extent used and the automatic one, every
  candidate segment of the section (its line, extent, area; on / auto / seed), the profile's `pieces` (polylines through
  the corners, a face key per edge) and the `faces`: 4 exact corners per side face, the closed profile for an end cap
  where the scan closes an end, each with its width, length and the share the scan covers.
- How: the view ray picks the clicked face; the plane there gives the axis: of the bridge's directions (L, T, Z) and
  the local faces' cross products, the one across which that plane is narrowest, or the other when the element is
  1.5 times as long along it. The triangles projected along it give the candidate lines (per normal direction the
  offsets' modes; per line only the stretches seen at most stations, so brackets, posts and stiffeners drop out), each
  fitted robustly (Tukey's biweight at 3 cm), snapped onto the section's axes when that moves it 2 cm at most, linked
  faces within 4° of square made square. Collinear pieces are one face across a hole, and a steel plate's skin across
  whatever joins it (a girder's web through the deck slab); a web's two skins and a flange's are thin plates (a skin the
  scan runs on into the plate it meets still turns that corner). From the
  clicked face a chain grows through convex corners and through a steel section's own concave ones (web to flange,
  round a flange back to the web's other skin) -- not into a slab, a haunch, a soffit or a curb -- so a click anywhere
  on a main girder gives the whole I, closed. A thin plate's two skins are one element: the profile of an element with
  a plate is grown from its largest face (through its plates' other skins), the other skins it does not reach pieces of
  their own, so it is the same whichever face is clicked (the right girder's web above the deck, which reaches neither
  its fillet nor the concrete haunch, gives the girder). The extent runs both ways while the scan covers 35 % of the profile,
  across gaps of up to 4 m. Pass 1 (a 3 m slab round the click) finds the face and the element's drift (the girders run
  0.25° off L), pass 2a the element on stations along its extent, pass 2b samples the element's own extent: every
  input fixed to the mesh or the element, so the answer is the same wherever the click is, and a refit along its axis
  is the answer again (the owner's keys stay). An answer under 1 m long, 5 cm wide or 25 % covered tries the next
  axis, three at most; then 422.
- ~25 ms a click on the PC's 1 M-triangle bake mesh (median; 90 % under 33 ms, at most ~46; Mac M5 Pro).
- `probe_faces.py <mesh.obj> <dir>` runs it on clicks on Petrinja's bridge (edge beams, road, soffit, a cross-beam, the
  main girder, the duct, the river banks, the abutments) and draws each: the section with every candidate and the chosen
  profile, and the faces over the scan, seen from two sides. `--clicks` casts ~280 clicks as the owner makes them
  (cameras beside, below and above the bridge, at its ends, at the girders above the deck from the road and the
  sidewalks, at the right girder's top flange from above and its bottom flange from below, at the cross-beams' sides),
  labels each by element (a main girder is one element, any part of it) and
  counts per element the different profiles, the main one's share and the failures. The real mesh, not the synthetic
  tests, is the judge.
