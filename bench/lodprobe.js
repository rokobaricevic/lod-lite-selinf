// lodprobe.js: loaded into the viewer by bench/lod_probe.py (served from the variant's folder; needs damage.js's lod.dm).
// For the current view: how many damage points each LOD scheme draws, against an oracle; and the CPU side (lodUpdate,
// the tap's scan, the coarse-to-fine builds).
//   find:  one prefix per find from its box's nearest depth (master's lodUpdate; all of it once the box reaches the eye)
//   chunk: chunks of ch m, each frustum-culled and its own prefix (damage.js's chunkRanges)
//   oracle: every point by its own depth, and only in the frustum (what no scheme can beat at these levels)
//   vis:   the points in the frustum, all levels (what a renderer without LOD would rasterise)
import * as THREE from 'three';

const dm = () => window.lod.dm;
function view() { // eye, view direction, frustum planes (source frame), px per metre at 1 m
  const cam = window.lod.camera, R = window.lod.renderer, w2src = window.lod.w2src;
  cam.updateMatrixWorld();
  const H = R.getDrawingBufferSize(new THREE.Vector2()).y, P = (cam.projectionMatrix.elements[5] * H) / 2;
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const pl = fr.planes.map((p) => [...w2src(p.normal), p.constant]);
  return { o: w2src(cam.position), d: w2src(cam.getWorldDirection(new THREE.Vector3())), P, pl };
}
// what a find draws now: its band (t order) or all its points, and whether it is a band
function items() {
  const { finds, cumK, knobs } = dm(), thin = knobs.thinMm();
  return finds().filter((f) => f.c.on).map((f) => {
    const band = !!f.tsort && thin !== Infinity;
    const ids = band ? f.tsort.idx.array.subarray(0, f.tsort.cum[cumK()]) : Uint32Array.from({ length: f.n }, (_, i) => i);
    return { f, ids, band, v: f.c.voxel || (band ? 0.005 : 0.01), size: f.c.mat.size };
  });
}
const cache = new Map();
function build(it, lv, ch) {
  const k = `${it.f.id}|${it.band}|${it.ids.length}|${lv}|${ch}`;
  if (!cache.has(k)) cache.set(k, Object.assign(dm().chunkLod(it.f.xyz, it.ids, it.v, it.f.b, lv, ch), { band: it.band }));
  return cache.get(k);
}
const level = (c0, P, depth, lim, lv) => Math.min(lv, Math.max(0, Math.ceil(Math.log2((c0 * P) / (depth * lim)) - 1e-9)));
function count(it, L, V, px, band, minPx) {
  const { o, d, P, pl } = V, a = it.f.xyz, od = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], lv = L.lv, n = L.n;
  const lim = (dep) => (it.band ? band * Math.max(minPx, (it.size * P) / dep) : px);
  const r = { find: 0, chunk: 0, oracle: 0, vis: 0, n: it.ids.length, ranges: 0 };
  // find: the find's box's nearest corner (master: one prefix, no culling but three's per-object one)
  const b = it.f.b;
  let dmin = Infinity;
  for (let c = 0; c < 8; c++) dmin = Math.min(dmin, (b[c & 1 ? 3 : 0] - o[0]) * d[0] + (b[c & 2 ? 4 : 1] - o[1]) * d[1] + (b[c & 4 ? 5 : 2] - o[2]) * d[2]);
  r.find = L.at[(dmin > 0 ? level(L.c0, P, dmin, lim(dmin), lv) : lv) * n + n];
  // chunk: damage.js's own chunkRanges with this config (in-frustum chunks, their own prefix, GAP-bridged ranges)
  const rg = {}, Fp = new Float64Array(pl.flat());
  dm().chunkRanges(L, o, d, P, it.size, rg, px, band, Fp);
  r.chunk = rg.pts; r.ranges = rg.nd;
  // per point: in the frustum (padded by its sprite) and its level under its own depth's
  for (let l = 0; l <= lv; l++) for (let i = L.at[l * n], e = L.at[l * n + n]; i < e; i++) {
    const j = L.order[i] * 3, x = a[j], y = a[j + 1], z = a[j + 2], dep = x * d[0] + y * d[1] + z * d[2] - od;
    if (dep <= 0) continue;
    const pad = 0.5 * Math.max(it.size, (minPx * dep) / P);
    let ok = true;
    for (const [nx, ny, nz, w] of pl) if (nx * x + ny * y + nz * z + w < -pad) { ok = false; break; }
    if (!ok) continue;
    r.vis++;
    if (l <= level(L.c0, P, dep, lim(dep), lv)) r.oracle++;
  }
  return r;
}
// per scheme config: totals over the finds (and per find for the big ones)
export function counts(configs) {
  const V = view(), its = items(), out = {};
  for (const { name, lv, ch, px, band, minPx } of configs) {
    const t = { find: 0, chunk: 0, oracle: 0, vis: 0, n: 0, ranges: 0, chunks: 0, per: {} };
    for (const it of its) {
      const L = build(it, lv, ch), r = count(it, L, V, px, band, minPx);
      for (const k of ['find', 'chunk', 'oracle', 'vis', 'n', 'ranges']) t[k] += r[k];
      t.chunks += L.n;
      if (it.f.n > 20000) t.per[it.f.id] = r;
    }
    out[name] = t;
  }
  return out;
}
// master's tap scan: every point of every item whose padded box the ray meets (a find's floats; app items: lod.dm.app)
function pickRef(ndc, mouse, dist) {
  const L = window.lod, cam = L.camera, caster = new THREE.Raycaster();
  caster.setFromCamera(ndc, cam);
  const o = L.w2src(caster.ray.origin), dir = L.w2src(caster.ray.direction), ray = new THREE.Ray(new THREE.Vector3(...o), new THREE.Vector3(...dir));
  const k = (2 * Math.tan((cam.fov * Math.PI) / 360)) / L.el.clientHeight, R = mouse ? 8 : 16, tmax = dist * 1.02 + 0.02;
  const box = new THREE.Box3(), at = new THREE.Vector3();
  let best = null, bs = R * R;
  const { app, Q, B, K } = dm().app(), Z = [0, 0, 0], U = [1, 1, 1];
  for (const it of app.concat(dm().finds())) {
    if (!it.c.on) continue;
    box.setFromArray(it.b).expandByScalar(R * k * tmax);
    if (!box.containsPoint(ray.origin) && !(ray.intersectBox(box, at) && at.distanceTo(ray.origin) <= tmax)) continue;
    const [A, j0, b0, s0] = it.xyz ? [it.xyz, 0, Z, U] : [Q, it.s * 3, B, K];
    for (let j = j0; j < j0 + it.n * 3; j += 3) {
      const x = b0[0] + A[j] * s0[0] - o[0], y = b0[1] + A[j + 1] * s0[1] - o[1], z = b0[2] + A[j + 2] * s0[2] - o[2], t = x * dir[0] + y * dir[1] + z * dir[2];
      if (t <= 0 || t > tmax) continue;
      const s2 = (x * x + y * y + z * z - t * t) / (k * k * t * t);
      if (s2 < bs) { bs = s2; best = it; }
    }
  }
  return best;
}
// CPU: lodUpdate per frame; the tap's scan at a grid of screen points (and the tiles' raycast before it)
export function cpu() {
  const L = window.lod, cam = L.camera, R = L.renderer, H = R.getDrawingBufferSize(new THREE.Vector2()).y, P = (cam.projectionMatrix.elements[5] * H) / 2;
  const N = 200, t0 = performance.now();
  for (let i = 0; i < N; i++) dm().lodUpdate(cam, P);
  const lodUs = ((performance.now() - t0) / N) * 1000;
  const picks = [];
  // taps: a 5 x 5 grid, and on 3 points of each find (where they project on screen)
  const taps = [];
  for (let y = -0.8; y <= 0.81; y += 0.4) for (let x = -0.8; x <= 0.81; x += 0.4) taps.push([x, y]);
  const { app, Q, B, K } = dm().app();
  for (const f of [...dm().finds(), ...app]) for (const q of [0.1, 0.5, 0.9]) {
    const i = Math.floor(f.n * q), p = f.xyz ? [0, 1, 2].map((d) => f.xyz[i * 3 + d]) : [0, 1, 2].map((d) => B[d] + Q[(f.s + i) * 3 + d] * K[d]);
    const w = L.src2w(p).project(cam);
    if (Math.abs(w.x) < 0.98 && Math.abs(w.y) < 0.98 && w.z < 1) taps.push([w.x, w.y]);
  }
  for (const [x, y] of taps) {
    const ndc = new THREE.Vector2(x, y), a = performance.now(), hit = L.pick(ndc), b = performance.now();
    if (!hit) continue;
    let best = null;
    const reps = 5, c = performance.now();
    for (let i = 0; i < reps; i++) best = dm().pickDamage(ndc, true, hit.distance);
    const t = performance.now(), ref = pickRef(ndc, true, hit.distance), tr = performance.now() - t;
    picks.push({ x: +x.toFixed(1), y: +y.toFixed(1), tiles: +(b - a).toFixed(2), dmg: +((performance.now() - c - tr) / reps).toFixed(3),
      full: +tr.toFixed(3), hit: best?.tid ?? null, ref: ref?.tid ?? null });
  }
  return { lodUs: +lodUs.toFixed(1), picks };
}
// load time: master's c2f vs chunkLod per find, all points and (cracks) the band at the current width; best of 3
export function builds() {
  const { c2f, chunkLod, knobs } = dm(), res = [];
  for (const it of items()) {
    const all = Uint32Array.from({ length: it.f.n }, (_, i) => i), rows = { id: it.f.id, n: it.f.n, nb: it.band ? it.ids.length : 0 };
    for (const [k, ids] of [['all', all], ...(it.band ? [['band', it.ids]] : [])]) {
      let t1 = Infinity, t2 = Infinity;
      for (let r = 0; r < 3; r++) {
        let s = performance.now(); c2f(it.f.xyz, ids, it.v, it.f.b, 6); t1 = Math.min(t1, performance.now() - s);
        s = performance.now(); chunkLod(it.f.xyz, ids, it.v, it.f.b, knobs.LV, knobs.CHUNK || 0.64); t2 = Math.min(t2, performance.now() - s);
      }
      rows[k] = { c2f: +t1.toFixed(2), chunk: +t2.toFixed(2) };
    }
    res.push(rows);
  }
  return res;
}
