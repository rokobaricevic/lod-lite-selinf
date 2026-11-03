// node --test test_thin.mjs: thin.js's centreline distance on synthetic crack masks (points on a jittered 5 mm grid,
// like the bake's voxels, in a tilted plane)
import test from 'node:test';
import assert from 'node:assert/strict';
import { centreDist, planeUV, job, UNIT, FAR } from './thin.js';

const VOX = 0.005;
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
// a mask = the 2D points (jittered grid) inside inside(x, y), placed in 3D on a plane tilted 30 deg about x
function mask(inside, [x0, y0, x1, y1], seed = 1) {
  const r = rng(seed), uv = [];
  for (let y = y0; y <= y1; y += VOX) for (let x = x0; x <= x1; x += VOX) {
    const px = x + (r() - 0.5) * 0.6 * VOX, py = y + (r() - 0.5) * 0.6 * VOX;
    if (inside(px, py)) uv.push(px, py);
  }
  const n = uv.length / 2, P = new Float64Array(3 * n), c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  for (let i = 0; i < n; i++) { P[3 * i] = 10 + uv[2 * i]; P[3 * i + 1] = 5 + uv[2 * i + 1] * c; P[3 * i + 2] = 0.8 + uv[2 * i + 1] * s; }
  return { uv, n, P };
}
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, f = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax + f * dx - px, ay + f * dy - py);
};
// share of the axis (sampled every mm) with no point of t <= h within 3.75 mm (half a 7.5 mm sprite): the dashes
function gaps(m, t, h, axes) {
  let miss = 0, all = 0;
  for (const [ax, ay, bx, by] of axes) {
    const L = Math.hypot(bx - ax, by - ay);
    for (let q = 0.02; q < L - 0.02; q += 0.001, all++) {
      const x = ax + ((bx - ax) * q) / L, y = ay + ((by - ay) * q) / L;
      let ok = false;
      for (let i = 0; i < m.n && !ok; i++) ok = t[i] * UNIT <= h && Math.max(Math.abs(m.uv[2 * i] - x), Math.abs(m.uv[2 * i + 1] - y)) <= 0.00375;
      if (!ok) miss++;
    }
  }
  return miss / all;
}

test('planeUV keeps in-plane distances', () => {
  const m = mask((x, y) => Math.abs(y) < 0.03, [0, -0.04, 0.3, 0.04]), uv = planeUV(m.P, m.n);
  for (const [i, j] of [[0, m.n - 1], [5, 77], [12, m.n >> 1]]) {
    const d2 = Math.hypot(uv[2 * i] - uv[2 * j], uv[2 * i + 1] - uv[2 * j + 1]), d0 = Math.hypot(m.uv[2 * i] - m.uv[2 * j], m.uv[2 * i + 1] - m.uv[2 * j + 1]);
    assert.ok(Math.abs(d2 - d0) < 1e-9, `${d2} vs ${d0}`);
  }
});

test('a straight band: t = the distance to its axis, the thin band has no gaps', () => {
  const m = mask((x, y) => Math.abs(y) < 0.03, [0, -0.04, 1, 0.04]), t = centreDist(m.P, m.n, VOX);
  let bad = 0, inner = 0;
  for (let i = 0; i < m.n; i++) {
    const x = m.uv[2 * i], d = Math.abs(m.uv[2 * i + 1]);
    if (x < 0.05 || x > 0.95) continue; // the ends
    inner++;
    if (t[i] !== 0 && Math.abs(t[i] * UNIT - d) > 0.003) bad++; // t = 0: the spine
    assert.ok(t[i] * UNIT <= d + 0.004, `t ${t[i] * UNIT} > d ${d}`);
  }
  assert.ok(bad / inner < 0.01, `${bad} of ${inner} off by > 3 mm`);
  const g0 = gaps(m, t, 0, [[0, 0, 1, 0]]), g3 = gaps(m, t, 0.003, [[0, 0, 1, 0]]);
  assert.ok(g0 < 0.02 && g3 < 0.01, `gaps: spine alone ${g0}, 3 mm ${g3}`); // the jittered grid's columns are up to 8 mm apart
  const kept = t.filter((v) => v * UNIT <= 0.003).length / m.n;
  assert.ok(kept > 0.08 && kept < 0.25, `kept at 3 mm: ${kept}`); // ~6 mm of a 60 mm wide band (+ the spine)
});

test('a Y: every branch keeps its centreline, a bump makes no spur', () => {
  const arms = [0, 2, 4].map((k) => [0, 0, 0.4 * Math.cos((k * Math.PI) / 3 + 0.3), 0.4 * Math.sin((k * Math.PI) / 3 + 0.3)]);
  const bump = [0.25 * Math.cos(0.3) - 0.04 * Math.sin(0.3), 0.25 * Math.sin(0.3) + 0.04 * Math.cos(0.3)]; // a lump on arm 0's side
  const near = (x, y) => Math.min(...arms.map((a) => segDist(x, y, ...a)));
  const m = mask((x, y) => near(x, y) < 0.025 || Math.hypot(x - bump[0], y - bump[1]) < 0.03, [-0.45, -0.45, 0.45, 0.45]);
  const t = centreDist(m.P, m.n, VOX);
  // each arm from 15 % out (the junction) to its end; arm 0 not along the lump (its medial axis bends towards it)
  const part = ([ax, ay, bx, by], f0, f1) => [ax + f0 * (bx - ax), ay + f0 * (by - ay), ax + f1 * (bx - ax), ay + f1 * (by - ay)];
  const g = [[part(arms[0], 0.15, 0.45), part(arms[0], 0.82, 1)], [part(arms[1], 0.15, 1)], [part(arms[2], 0.15, 1)]].map((a) => gaps(m, t, 0.003, a));
  assert.ok(g.every((v) => v < 0.01), `branches: gaps ${g}`);
  let spur = 0;
  for (let i = 0; i < m.n; i++) if (near(m.uv[2 * i], m.uv[2 * i + 1]) > 0.03 && t[i] * UNIT < 0.01) spur++; // in the lump, near a centreline
  assert.equal(spur, 0, `${spur} lump points within 1 cm of a centreline`);
});

test('the tips reach the mask end (dead ends extended)', () => {
  const m = mask((x, y) => Math.abs(y) < 0.03 && x > 0 && x < 0.5, [-0.01, -0.04, 0.51, 0.04]), t = centreDist(m.P, m.n, VOX);
  let xmin = 1, xmax = -1;
  for (let i = 0; i < m.n; i++) if (t[i] * UNIT <= 0.002) { xmin = Math.min(xmin, m.uv[2 * i]); xmax = Math.max(xmax, m.uv[2 * i]); }
  assert.ok(xmin < 0.012 && xmax > 0.488, `kept from ${xmin} to ${xmax}`);
});

test('degenerate items and the worker job', () => {
  assert.deepEqual([...centreDist(new Float64Array(0), 0, VOX)], []);
  assert.deepEqual([...centreDist(new Float64Array([1, 2, 3]), 1, VOX)], [0]);
  assert.deepEqual([...centreDist(new Float64Array([1, 2, 3, 1.01, 2, 3]), 2, VOX)], [0, 0]);
  const same = centreDist(new Float64Array(30).fill(1), 10, VOX); // coincident points: one cell, its centre
  assert.ok(same.every((v) => v * UNIT <= VOX * Math.SQRT1_2), String(same));
  // job: two runs in one quantised array, FAR outside them
  const a = mask((x, y) => Math.abs(y) < 0.02, [0, -0.03, 0.3, 0.03], 2), lo = [9, 4, 0], sc = [3 / 65535, 3 / 65535, 3 / 65535];
  const q = new Uint16Array(3 * (a.n + 4));
  for (let i = 0; i < a.n; i++) for (let k = 0; k < 3; k++) q[3 * (i + 4) + k] = Math.round((a.P[3 * i + k] - lo[k]) / sc[k]);
  const t = job({ pos: q, runs: [4, a.n], voxel: VOX, base: lo, scale: sc });
  assert.deepEqual([...t.subarray(0, 4)], [FAR, FAR, FAR, FAR]);
  const direct = centreDist(a.P, a.n, VOX);
  let diff = 0;
  for (let i = 0; i < a.n; i++) diff = Math.max(diff, Math.abs(t[4 + i] - direct[i]));
  assert.ok(diff * UNIT <= 0.0025, `quantised vs float: ${diff * UNIT} m`);
});
