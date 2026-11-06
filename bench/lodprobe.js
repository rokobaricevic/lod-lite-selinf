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
  if (!cache.has(k)) cache.set(k, dm().chunkLod(it.f.xyz, it.ids, it.v, it.f.b, lv, ch));
  return cache.get(k);
}
const level = (c0, P, depth, lim, lv) => Math.min(lv, Math.max(0, Math.ceil(Math.log2((c0 * P) / (depth * lim)) - 1e-9)));
function count(it, L, V, px, band, minPx) {
  const { o, d, P, pl } = V, a = it.f.xyz, E = L.lv + 1, od = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], lv = L.lv;
  const lim = (dep) => (it.band ? band * Math.max(minPx, (it.size * P) / dep) : px);
  const r = { find: 0, chunk: 0, oracle: 0, vis: 0, n: it.ids.length, ranges: 0 };
  // find: the find's box's nearest corner
  const b = it.f.b;
  let dmin = Infinity;
  for (let c = 0; c < 8; c++) dmin = Math.min(dmin, (b[c & 1 ? 3 : 0] - o[0]) * d[0] + (b[c & 2 ? 4 : 1] - o[1]) * d[1] + (b[c & 4 ? 5 : 2] - o[2]) * d[2]);
  const kf = dmin > 0 ? level(L.c0, P, dmin, lim(dmin), lv) : lv;
  let end = -1;
  for (let c = 0; c < L.n; c++) {
    r.find += L.ends[c * E + kf];
    const q = c * 6, bx = L.box, [x0, y0, z0, x1, y1, z1] = bx.subarray(q, q + 6);
    const dmax = (d[0] > 0 ? x1 : x0) * d[0] + (d[1] > 0 ? y1 : y0) * d[1] + (d[2] > 0 ? z1 : z0) * d[2] - od;
    const cmin = (d[0] > 0 ? x0 : x1) * d[0] + (d[1] > 0 ? y0 : y1) * d[1] + (d[2] > 0 ? z0 : z1) * d[2] - od;
    let inF = dmax > 0;
    if (inF) {
      const pad = 0.5 * Math.max(it.size, (minPx * dmax) / P);
      for (const [nx, ny, nz, w] of pl) if ((nx > 0 ? x1 : x0) * nx + (ny > 0 ? y1 : y0) * ny + (nz > 0 ? z1 : z0) * nz + w < -pad) { inF = false; break; }
    }
    if (inF) {
      const k = cmin > 0 ? level(L.c0, P, cmin, lim(cmin), lv) : lv, m = L.ends[c * E + k];
      if (m) { r.chunk += m; if (L.first[c] !== end) r.ranges++; end = m === L.ends[c * E + lv] ? L.first[c] + m : -1; }
    }
    // per point: in the frustum (padded by its sprite) and its level under its own depth's
    for (let k = 0, i = L.first[c]; k <= lv; k++) {
      for (const e = L.first[c] + L.ends[c * E + k]; i < e; i++) {
        const j = L.order[i] * 3, x = a[j], y = a[j + 1], z = a[j + 2], dep = x * d[0] + y * d[1] + z * d[2] - od;
        if (dep <= 0) continue;
        const pad = 0.5 * Math.max(it.size, (minPx * dep) / P);
        let ok = true;
        for (const [nx, ny, nz, w] of pl) if (nx * x + ny * y + nz * z + w < -pad) { ok = false; break; }
        if (!ok) continue;
        r.vis++;
        if (k <= level(L.c0, P, dep, lim(dep), lv)) r.oracle++;
      }
    }
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
// CPU: lodUpdate per frame; the tap's scan at a grid of screen points (and the tiles' raycast before it)
export function cpu() {
  const L = window.lod, cam = L.camera, R = L.renderer, H = R.getDrawingBufferSize(new THREE.Vector2()).y, P = (cam.projectionMatrix.elements[5] * H) / 2;
  const N = 200, t0 = performance.now();
  for (let i = 0; i < N; i++) dm().lodUpdate(cam, P);
  const lodUs = ((performance.now() - t0) / N) * 1000;
  const picks = [];
  for (let y = -0.8; y <= 0.81; y += 0.4) for (let x = -0.8; x <= 0.81; x += 0.4) {
    const ndc = new THREE.Vector2(x, y), a = performance.now(), hit = L.pick(ndc), b = performance.now();
    if (!hit) continue;
    let best = null;
    const reps = 5, c = performance.now();
    for (let i = 0; i < reps; i++) best = dm().pickDamage(ndc, true, hit.distance);
    picks.push({ x: +x.toFixed(1), y: +y.toFixed(1), tiles: +(b - a).toFixed(2), dmg: +((performance.now() - c) / reps).toFixed(3), hit: best?.tid ?? null });
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
