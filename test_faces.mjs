// node test_faces.mjs (or node --test): faces.js's pure geometry on answers built by hand per the wire format of POST
// /element: the profile's mitered inflation (an L, a square, a slope, a step), the shell (its quads share their vertices,
// closed with its caps, wound outward), the ghosts from the segments' t-ranges, picking, a handle's axis projection, the
// section's drawing
import test from 'node:test';
import assert from 'node:assert/strict';
import { at, uvs, ends, segDist, edgeNormals, inflate, earcut, edgeFaces, prism, ghosts, gap, rings, faceMesh, rayHit, axisParam, sectionFit, nice } from './faces.js';

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
const sub = (a, b) => a.map((x, i) => x - b[i]), dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const D = 0.03;

// the frame of a girder along the bridge (L = (0.917, 0.399, 0)): e2 up, e1 = e2 x axis
const l = Math.hypot(0.917, 0.399), AX = [0.917 / l, 0.399 / l, 0], E1 = crs([0, 0, 1], AX), E2 = [0, 0, 1], ORG = [12.5, -6.25, 0.4];
// an answer as the server sends it: segments {n, c, t} (the lines' normals point out of the material), pieces through
// the corners, a side face per piece edge (p(s0) of its start and end, then the same at s1), caps on request
function answer(segs, pieces, { s0 = -2, s1 = 3, caps = [] } = {}) {
  const A = { origin: ORG, axis: AX, e1: E1, e2: E2, s0, s1, auto: [s0, s1], rms: 0.01, tris: 100, ms: 3 };
  A.segments = segs.map((g, key) => ({ key, on: true, auto: true, seed: key === 0, area: 1, rms: 0.01, ...g }));
  A.pieces = pieces;
  A.faces = pieces.flatMap((pc) => pc.keys.map((k, i) => {
    const a = pc.uv[i], b = pc.uv[(i + 1) % pc.uv.length], g = A.segments[k], w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { key: 's' + k, seg: k, normal: [0, 1, 2].map((c) => g.n[0] * E1[c] + g.n[1] * E2[c]), points: [at(A, ...a, s0), at(A, ...b, s0), at(A, ...a, s1), at(A, ...b, s1)],
      area: w * (s1 - s0), width: w, length: s1 - s0, coverage: 0.8 };
  }));
  for (const k of caps) A.faces.push({ key: 'cap' + k, seg: null, normal: AX.map((x) => (k ? x : -x)), points: pieces[0].uv.map(([u, v]) => at(A, u, v, k ? s1 : s0)), area: 1, width: 1, length: 1, coverage: 0.5 });
  return A;
}
// a girder's left web and soffit (an L; the material at u > 0, v > 0), and a closed 1 x 1 m box
const Lsegs = [{ n: [-1, 0], c: 0, t: [-1, 0] }, { n: [0, -1], c: 0, t: [0, 1.2] }];
const Lpc = { keys: [0, 1], uv: [[0, 1], [0, 0], [1.2, 0]], closed: false };
const Bsegs = [{ n: [0, -1], c: 0, t: [0, 1] }, { n: [1, 0], c: 1, t: [0, 1] }, { n: [0, 1], c: 1, t: [-1, 0] }, { n: [-1, 0], c: 0, t: [-1, 0] }];
const Bpc = { keys: [0, 1, 2, 3], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], closed: true };

// each edge's offset line is d out along its normal: both ends of the moved edge on it, so every corner is on both lines
function offsetCheck(P, Q, m, closed, d) {
  m.forEach((mi, i) => {
    const j = (i + 1) % P.length;
    for (const k of [i, j]) near(dot(mi, sub(Q[k], P[i])), d, `edge ${i}, corner ${k}: ${Q[k]}`);
  });
  if (!closed) { near(Math.hypot(...sub(Q[0], P[0])), d, 'open start'); near(Math.hypot(...sub(Q.at(-1), P.at(-1))), d, 'open end'); }
}

test('edge normals: the segments\' own, and a joint\'s from the side they agree on', () => {
  assert.deepEqual(edgeNormals(Lpc, answer(Lsegs, [Lpc]).segments).map((m) => m.map((x) => x + 0)), [[-1, 0], [0, -1]]);
  assert.deepEqual(edgeNormals(Bpc, answer(Bsegs, [Bpc]).segments).map((m) => m.map((x) => x + 0)), [[0, -1], [1, 0], [0, 1], [-1, 0]]);
  const back = { keys: [1, 0], uv: [[1.2, 0], [0, 0], [0, 1]], closed: false }; // the same L walked the other way
  assert.deepEqual(edgeNormals(back, answer(Lsegs, [Lpc]).segments).map((m) => m.map((x) => x + 0)), [[0, -1], [-1, 0]]);
  // a soffit stepping up 10 cm (two parallel segments and the joint between them): the joint faces +u, out of the material
  const step = { keys: [0, 1], uv: [[0, 0], [1, 0], [1, 0.1], [2, 0.1]], closed: false };
  const m = edgeNormals(step, [{ key: 0, n: [0, -1], c: 0, t: [0, 1] }, { key: 1, n: [0, -1], c: -0.1, t: [1, 2] }]);
  assert.deepEqual(m.map((v) => v.map((x) => x + 0)), [[0, -1], [1, 0], [0, -1]]);
});

test('inflate: an L, a closed square, a sloped bank, a step: every edge moves exactly d, the corners on both offset lines', () => {
  const A = answer(Lsegs, [Lpc]), mL = edgeNormals(Lpc, A.segments), qL = inflate(Lpc.uv, false, mL, D);
  offsetCheck(Lpc.uv, qL, mL, false, D);
  qL.forEach((q, i) => [[-D, 1], [-D, -D], [1.2, -D]][i].forEach((x, c) => near(q[c], x, `L corner ${i}`)));
  const mB = edgeNormals(Bpc, answer(Bsegs, [Bpc]).segments), qB = inflate(Bpc.uv, true, mB, D);
  offsetCheck(Bpc.uv, qB, mB, true, D);
  qB.forEach((q, i) => [[-D, -D], [1 + D, -D], [1 + D, 1 + D], [-D, 1 + D]][i].forEach((x, c) => near(q[c], x, `square corner ${i}`)));
  // a trapezoid channel (banks at 1:1.5 down to a 4 m bed), walked with the ground below: 146 and 214 deg corners
  const ch = [[-5, 2], [-2, 0], [2, 0], [5, 2]], up = (a, b) => { const x = b[0] - a[0], y = b[1] - a[1], k = Math.hypot(x, y); return [-y / k, x / k]; };
  const mC = ch.slice(1).map((b, i) => up(ch[i], b)), qC = inflate(ch, false, mC, 0.05);
  offsetCheck(ch, qC, mC, false, 0.05);
  // a step: the joint's corners are right angles, so it is mitered too
  const st = [[0, 0], [1, 0], [1, 0.1], [2, 0.1]], mS = [[0, -1], [1, 0], [0, -1]], qS = inflate(st, false, mS, D);
  offsetCheck(st, qS, mS, false, D);
  // a 10 deg spike: its miter (11.5 d) is capped at 4 d along the bisector; the right-angle corner stays exact
  const sp = [[0, 0], [1, 0], [0, Math.tan(Math.PI / 18)]];
  const mSp = edgeNormals({ keys: [0], uv: sp, closed: true }, [{ key: 0, n: [0, -1], c: 0, t: [0, 1] }]), qP = inflate(sp, true, mSp, D);
  near(Math.hypot(...sub(qP[1], sp[1])), 4 * D, 'the spike capped');
  for (const m of [mSp[2], mSp[0]]) near(dot(m, sub(qP[0], sp[0])), D, 'the right angle');
});

test('earcut: a convex and an L-shaped polygon in either turn, their area kept', () => {
  const area = (P, T) => T.reduce((s, [a, b, c]) => s + Math.abs((P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0])) / 2, 0);
  const Lp = [[0, 0], [2, 0], [2, 0.5], [0.5, 0.5], [0.5, 1.5], [0, 1.5]];
  for (const P of [Lp, [...Lp].reverse(), [[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 0], [1, 0], [0.5, 0.8]]]) {
    const T = earcut(P), want = Math.abs(P.reduce((s, p, i) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0)) / 2;
    assert.equal(T.length, P.length - 2); near(area(P, T), want, 'area');
  }
});

test('prism: a closed box with both caps is watertight, its quads share their vertices, every triangle faces out', () => {
  const A = answer(Bsegs, [Bpc], { caps: [0, 1] }), G = prism(A, D);
  assert.equal(G.pos.length, 3 * 8); // 4 corners at each end, once
  assert.equal(G.quads.length, 4);
  G.quads.forEach((q, i) => { const r = G.quads[(i + 1) % 4]; assert.equal(q[1], r[0]); assert.equal(q[2], r[3]); }); // b0 b1 of one = a0 a1 of the next
  const cnt = new Map();
  for (let t = 0; t < G.index.length; t += 3) for (let j = 0; j < 3; j++) {
    const a = G.index[t + j], b = G.index[t + ((j + 1) % 3)], e = Math.min(a, b) + '-' + Math.max(a, b);
    cnt.set(e, (cnt.get(e) ?? 0) + 1);
  }
  assert.ok([...cnt.values()].every((c) => c === 2), 'every edge between exactly two triangles'); // closed
  const V = (i) => [...G.pos.subarray(3 * i, 3 * i + 3)], mid = at(A, 0.5, 0.5, 0.5);
  for (let t = 0; t < G.index.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => V(G.index[t + j])), n = crs(sub(b, a), sub(c, a)), m = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    assert.ok(dot(n, sub(m, mid)) > 0, `triangle ${t / 3} faces in`);
  }
  // the box inflated: corners d out in the section, the caps d past s0 and s1
  const us = [...Array(8).keys()].map((i) => uvs(A, V(i)));
  for (const [u, v, s] of us) { near(Math.abs(u - 0.5), 0.5 + D, 'u', 1e-5); near(Math.abs(v - 0.5), 0.5 + D, 'v', 1e-5); near(Math.abs(s - 0.5), 2.5 + D, 's', 1e-5); }
  // each triangle knows its face: two per side, two per cap
  const per = A.faces.map((_, k) => G.tris.filter((f) => f === k).length);
  assert.deepEqual(per, [2, 2, 2, 2, 2, 2]);
  assert.equal(G.edges.length / 6, 4 + 4 + 4); // both profiles and the 4 corners along the axis
});

test('prism: an open L without caps; a forced piece of its own; a cap on one end only', () => {
  const A = answer(Lsegs, [Lpc]), G = prism(A, D);
  assert.equal(G.pos.length, 3 * 6); assert.deepEqual(G.quads, [[0, 1, 4, 3], [1, 2, 5, 4]]); // the corner 1 / 4 shared
  for (const i of [0, 1, 2]) near(uvs(A, [...G.pos.subarray(3 * i, 3 * i + 3)])[2], -2, 's0 (no cap: not extended)', 1e-5);
  assert.deepEqual(edgeFaces(A), [[0, 1]]);
  // the webs of a U, the soffit off and forced pieces: two pieces, each its own corners
  const U = [{ n: [-1, 0], c: 0, t: [-1, 0] }, { n: [0, -1], c: 0, t: [0, 0.6] }, { n: [1, 0], c: 0.6, t: [0, 1] }];
  const pcs = [{ keys: [0], uv: [[0, 1], [0, 0]], closed: false }, { keys: [2], uv: [[0.6, 0], [0.6, 1]], closed: false }];
  const B = answer(U, pcs), H = prism(B, D);
  assert.equal(H.pos.length, 3 * 8); assert.deepEqual(H.tris, [0, 0, 1, 1]); // faces s0 and s2: indices 0 and 1
  // the U with its end at s1 scanned: the cap on the U closed by its chord, on the shell's own corners
  const pcU = { keys: [0, 1, 2], uv: [[0, 1], [0, 0], [0.6, 0], [0.6, 1]], closed: false }, C = answer(U, [pcU], { caps: [1] }), K = prism(C, D);
  assert.equal(K.pos.length, 3 * 8);
  const capT = K.tris.map((f, t) => [f, t]).filter(([f]) => C.faces[f].key === 'cap1').map(([, t]) => t);
  assert.equal(capT.length, 2);
  for (const t of capT) for (let j = 0; j < 3; j++) assert.ok(K.index[3 * t + j] >= 4, 'the cap on the s1 ring');
  const s = [...Array(8).keys()].map((i) => uvs(C, [...K.pos.subarray(3 * i, 3 * i + 3)])[2]);
  s.slice(0, 4).forEach((x) => near(x, -2, 's0 open', 1e-5)); s.slice(4).forEach((x) => near(x, 3 + D, 's1 capped', 1e-5));
});

test('ghosts: an off candidate\'s rectangle from its t-range across [s0, s1], d off its surface', () => {
  const segs = [...Lsegs, { n: [0.6, 0.8], c: 0.5, t: [-0.2, 0.3], on: false, auto: false }], A = answer(segs, [Lpc]), [g] = ghosts(A, D);
  assert.equal(g.key, 2); assert.equal(g.p.length, 12);
  const q = (t) => [0.5 * 0.6 - t * 0.8 + D * 0.6, 0.5 * 0.8 + t * 0.6 + D * 0.8];
  const want = [[...q(-0.2), -2], [...q(0.3), -2], [...q(0.3), 3], [...q(-0.2), 3]];
  for (let k = 0; k < 4; k++) uvs(A, g.p.slice(3 * k, 3 * k + 3)).forEach((x, c) => near(x, want[k][c], `corner ${k}`, 1e-9));
  assert.deepEqual(ends(segs[2]).map((p) => p.map((x) => +x.toFixed(9))), [[0.46, 0.28], [0.06, 0.58]]);
  near(segDist(segs[2], 0.46 + 0.6, 0.28 + 0.8), 1, 'distance off the line'); near(segDist(segs[2], 0.46 + 0.8, 0.28 - 0.6), 1, 'past an end');
  assert.equal(ghosts(answer(Lsegs, [Lpc]), D).length, 0);
});

test('gap: a candidate\'s distance to the profile (the ghosts drawn are its neighbours); rings: the profile at both ends', () => {
  const A = answer(Lsegs, [Lpc]), g = (n, c, t) => gap(A, { n, c, t });
  near(g([0, -1], -1, [-1.5, 0]), 0, 'the deck soffit meeting the web\'s top (v = 1, u -1.5..0)');
  near(g([-1, 0], 0.5, [-1, 0]), 0.5, 'a web 0.5 m outside (u = -0.5, v 0..1)');
  near(g([-1, 0], -0.5, [-1, 0]), 0, 'a web standing on the soffit (u = 0.5)');
  near(g([0, -1], 0.4, [0.2, 1]), 0.4, 'a soffit 0.4 m below');
  near(g([0.6, 0.8], 0.5, [-0.2, 0.3]), 0.06, 'a candidate in the L\'s corner, 6 cm off the web');
  near(g([0.6, 0.8], 0.3, [-1, 1]), 0, 'one crossing the soffit (0.98, -0.36 to -0.62, 0.84)');
  near(g([0, -1], 0, [1.5, 2]), 0.3, 'past the soffit\'s open end');
  const B = answer(Bsegs, [Bpc]), R = rings(B, ORG);
  assert.equal(R.length / 6, 8); // 4 edges at s0 and 4 at s1
  for (let k = 0; k < R.length; k += 3) near(Math.abs(uvs(B, R.slice(k, k + 3).map((x, c) => x + ORG[c]))[2] - 0.5), 2.5, 's at an end', 1e-9);
  assert.equal(rings(A).length / 6, 4); // the open L: its 2 edges at both ends
});

test('faceMesh: side quads and an L-shaped cap wound along their normals, labelled on themselves', () => {
  const Lp = [[0, 0], [2, 0], [2, 0.5], [0.5, 0.5], [0.5, 1.5], [0, 1.5]], A = answer(Bsegs, [Bpc], { caps: [1] });
  A.faces.push({ key: 'cap0', seg: null, normal: AX.map((x) => -x), points: Lp.map(([u, v]) => at(A, u, v, -2)) });
  for (const f of A.faces) {
    const m = faceMesh(A, f, ORG);
    let area = 0;
    for (let t = 0; t < m.tri.length; t += 9) {
      const [a, b, c] = [0, 3, 6].map((o) => m.tri.slice(t + o, t + o + 3)), n = crs(sub(b, a), sub(c, a));
      assert.ok(dot(n, f.normal) > 0, `${f.key} wound along its normal`); area += Math.hypot(...n) / 2;
    }
    near(area, f.key === 'cap0' ? 1.5 : f.key === 'cap1' ? 1 : 5, `${f.key} area`, 1e-6);
    assert.equal(m.lines.length, 6 * f.points.length);
  }
  const lab = faceMesh(A, A.faces.at(-1), [0, 0, 0]).at, [u, v] = uvs(A, lab);
  assert.ok((u >= 0 && u <= 2 && v >= 0 && v <= 0.5) || (u >= 0 && u <= 0.5 && v >= 0 && v <= 1.5), `the L cap's label on it: ${u}, ${v}`);
});

test('rayHit: the nearest triangle from either side; axisParam: a handle\'s ray onto the axis', () => {
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], index = [0, 1, 2, 3, 4, 5]; // z = 0 and z = 1
  assert.deepEqual(rayHit([0.2, 0.2, 5], [0, 0, -1], pos, index), { t: 4, i: 1 });
  assert.deepEqual(rayHit([0.2, 0.2, -5], [0, 0, 1], pos, index), { t: 5, i: 0 });
  assert.equal(rayHit([0.8, 0.8, 5], [0, 0, -1], pos, index), null); // past the diagonal
  assert.equal(rayHit([0.2, 0.2, 5], [0, 0, 1], pos, index), null); // behind
  // the eye 9 m off, looking at stations of the axis: they come back
  const eye = at({ origin: ORG, axis: AX, e1: E1, e2: E2 }, -6, 4, 1.5);
  for (const s of [-3.2, 0, 0.75, 6]) {
    const p = ORG.map((x, c) => x + s * AX[c]), d = sub(p, eye), k = Math.hypot(...d);
    near(axisParam(eye, d.map((x) => x / k), ORG, AX), s, `station ${s}`, 1e-9);
  }
  // a skew ray: the station nearest it (against a brute-force search along the axis)
  const o = [3, -2, 4], d = [0.3, 0.9, -0.3].map((x, _, a) => x / Math.hypot(...a)), s = axisParam(o, d, ORG, AX);
  const dist = (t) => { const p = ORG.map((x, c) => x + t * AX[c]), w = sub(p, o), m = dot(w, d); return Math.hypot(...sub(w, d.map((x) => x * m))); };
  for (const e of [-0.01, 0.01]) assert.ok(dist(s) < dist(s + e), `${s} is the nearest`);
  assert.equal(axisParam(o, AX, ORG, AX), null); // along the axis: no station
});

test('sectionFit: the profile and the click inside the drawing, v up, one scale for both; nice scale bars', () => {
  const A = answer(Lsegs, [Lpc]), W = 300, H = 150, pad = 14, { k, x0, y0 } = sectionFit(A, W, H, pad);
  for (const [u, v] of [...Lpc.uv, [0, 0]]) {
    const x = x0 + k * u, y = y0 - k * v;
    assert.ok(x >= pad && x <= W - pad && y >= pad && y <= H - pad, `${u}, ${v} -> ${x}, ${y}`);
  }
  assert.ok(y0 - k * 1 < y0, 'v up'); // the web's top above the soffit
  near(k, (H - 2 * pad) / (1 + 2 * 0.3), 'the taller side fills the height (room: a quarter of 1.2 m, at least 25 cm)');
  assert.deepEqual([0.07, 0.3, 0.6, 1, 2.4, 7].map(nice), [0.05, 0.25, 0.5, 1, 2, 5]);
});
