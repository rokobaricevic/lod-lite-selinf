// node test_faces.mjs (or node --test): faces.js's decoder on /faces answers built by hand per the wire format (uint32 LE n,
// n bytes of JSON header padded with spaces to a multiple of 4, then each face's w*h uint8 mask in header order), and its
// mask geometry (the side view's and the picked face's triangles and outline) on small masks
import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, corners, facing, maskGeometry } from './faces.js';

function answer(head, masks = []) {
  let text = new TextEncoder().encode(JSON.stringify(head));
  text = Uint8Array.from([...text, ...new Array((4 - (text.length % 4)) % 4).fill(32)]); // pad the bytes, not the characters
  const out = new Uint8Array(4 + text.length + masks.reduce((a, m) => a + m.length, 0));
  new DataView(out.buffer).setUint32(0, text.length, true);
  out.set(text, 4);
  let at = 4 + text.length;
  for (const m of masks) { out.set(m, at); at += m.length; }
  return out.buffer;
}
const close = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${msg}: ${[...a]} vs ${b}`));

// A: a vertical face (normal -y), 3 x 2 cells of 5 cm, only cell (i 2, j 0) and the row j 1 covered.
// B: a deck face (normal +z), 4 x 5 cells of 10 cm along a rotated u, a diagonal covered.
const A = { normal: [0, -1, 0], d: -20, origin: [10, 20, 5], u: [1, 0, 0], v: [0, 0, 1], cell: 0.05, w: 3, h: 2, area: 0.0175, tris: 12 };
const c = Math.cos(0.3), s = Math.sin(0.3);
const B = { normal: [0, 0, 1], d: 7, origin: [-1, 2, 7], u: [c, s, 0], v: [-s, c, 0], cell: 0.1, w: 4, h: 5, area: 0.04, tris: 3 };
const mA = Uint8Array.from([0, 0, 1, 1, 1, 1]); // row j 0: i 0 1 2, then row j 1
const mB = new Uint8Array(20);
for (let j = 0; j < 4; j++) mB[j * 4 + j] = 1;
const head = { faces: [A, B], tris: 15, ms: 3.25 };

test('two faces: header, masks of different sizes, in order', () => {
  const buf = answer(head, [mA, mB]), r = decode(buf);
  assert.equal(r.tris, 15); assert.equal(r.ms, 3.25); assert.equal(r.faces.length, 2);
  for (const [f, g] of [[r.faces[0], A], [r.faces[1], B]]) for (const k of Object.keys(g)) assert.deepEqual(f[k], g[k], k);
  assert.deepEqual([...r.faces[0].mask], [...mA]); assert.deepEqual([...r.faces[1].mask], [...mB]);
  const n = new DataView(buf).getUint32(0, true);
  assert.equal(n % 4, 0); assert.equal(r.faces[0].mask.byteOffset, 4 + n); assert.equal(r.faces[1].mask.byteOffset, 4 + n + 6); // no padding
  assert.equal(r.faces[1].mask.byteOffset + r.faces[1].mask.length, buf.byteLength);
  const at = (f, i, j) => f.mask[j * f.w + i]; // cell (i, j): column i along u, row j along v
  assert.equal(at(r.faces[0], 2, 0), 1); assert.equal(at(r.faces[0], 0, 0), 0); assert.equal(at(r.faces[0], 0, 1), 1);
  assert.equal(at(r.faces[1], 3, 3), 1); assert.equal(at(r.faces[1], 3, 4), 0); assert.equal(at(r.faces[1], 0, 1), 0);
});

test('corners: origin + w cells along u, h cells along v', () => {
  const [a, b] = decode(answer(head, [mA, mB])).faces;
  close(corners(a), [10, 20, 5, 10.15, 20, 5, 10, 20, 5.1, 10.15, 20, 5.1], 'A');
  const q = corners(b), U = [0.4 * c, 0.4 * s, 0], V = [-0.5 * s, 0.5 * c, 0], o = [-1, 2, 7];
  close(q, [...o, ...o.map((x, k) => x + U[k]), ...o.map((x, k) => x + V[k]), ...o.map((x, k) => x + U[k] + V[k])], 'B');
  // the face's own plane: every unlifted corner has normal . p = d
  for (const [f, p] of [[a, corners(a)], [b, corners(b)]]) for (let k = 0; k < 4; k++)
    assert.ok(Math.abs(f.normal[0] * p[3 * k] + f.normal[1] * p[3 * k + 1] + f.normal[2] * p[3 * k + 2] - f.d) < 1e-9);
});

test('orientation from the normal\'s bake z', () => {
  assert.deepEqual([[0, 0, 1], [0, 0.6, 0.8], [0, 0.8, 0.6], [1, 0, 0], [0, -0.6, -0.8], [0, 0, -1]].map((normal) => facing({ normal })),
    ['gore', 'gore', 'bočno', 'bočno', 'dolje', 'dolje']);
});

test('an error answer: the server\'s message, no faces', () => {
  const r = decode(answer({ error: 'kutija je prevelika: 2 300 000 trokuta' }));
  assert.equal(r.error, 'kutija je prevelika: 2 300 000 trokuta'); assert.equal(r.faces, undefined);
});

test('no faces, and a truncated answer', () => {
  const r = decode(answer({ faces: [], tris: 0, ms: 0.1 }));
  assert.deepEqual(r.faces, []); assert.equal(r.tris, 0);
  const buf = answer(head, [mA, mB]);
  assert.throws(() => decode(buf.slice(0, buf.byteLength - 1)), RangeError); // the last mask is a byte short
  assert.throws(() => decode(new ArrayBuffer(0)), RangeError); // an empty 401
});

// maskGeometry: the triangles' total area, the outline's total length (and its segment count: collinear runs merged)
const tri = (P) => {
  let a = 0;
  for (let t = 0; t < P.length; t += 9) {
    const u = [0, 1, 2].map((k) => P[t + 3 + k] - P[t + k]), v = [0, 1, 2].map((k) => P[t + 6 + k] - P[t + k]);
    a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return a;
};
const len = (E) => { let l = 0; for (let t = 0; t < E.length; t += 6) l += Math.hypot(E[t + 3] - E[t], E[t + 4] - E[t + 1], E[t + 5] - E[t + 2]); return l; };
const face = (base, w, h, rows) => ({ ...base, w, h, mask: Uint8Array.from(rows.join('').split('').map(Number)) }); // rows: j = 0 first
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test('maskGeometry: a full 3 x 2 mask is one quad of 6 cells, outlined by its 4 sides', () => {
  for (const base of [A, B]) { // A: 5 cm cells, u x v = normal; B: 10 cm along a rotated u
    const f = face(base, 3, 2, ['111', '111']), g = maskGeometry(f, f.origin), q = base.cell ** 2;
    assert.equal(g.positions.length, 18); near(tri(g.positions), 6 * q, 'area');
    assert.equal(g.edges.length, 4 * 6); near(len(g.edges), 10 * base.cell, 'outline');
    for (let t = 0; t < g.positions.length; t += 9) { // counter-clockwise about the normal
      const u = [0, 1, 2].map((k) => g.positions[t + 3 + k] - g.positions[t + k]), v = [0, 1, 2].map((k) => g.positions[t + 6 + k] - g.positions[t + k]);
      assert.ok((u[1] * v[2] - u[2] * v[1]) * f.normal[0] + (u[2] * v[0] - u[0] * v[2]) * f.normal[1] + (u[0] * v[1] - u[1] * v[0]) * f.normal[2] > 0);
    }
  }
});

test('maskGeometry: an L, a ring, a diagonal, an empty row between two parts', () => {
  const q = A.cell;
  const L = maskGeometry(face(A, 3, 3, ['111', '100', '100']), A.origin); // 5 cells; outline 3 + 1 + 2 + 2 + 1 + 3
  near(tri(L.positions), 5 * q * q, 'L area'); near(len(L.edges), 12 * q, 'L outline'); assert.equal(L.edges.length / 6, 6);
  const O = maskGeometry(face(A, 3, 3, ['111', '101', '111']), A.origin); // 8 cells; the outer square and the hole's
  near(tri(O.positions), 8 * q * q, 'ring area'); near(len(O.edges), 16 * q, 'ring outline'); assert.equal(O.edges.length / 6, 8);
  const D = maskGeometry(face(A, 3, 3, ['100', '010', '001']), A.origin); // corners touch: 3 squares, 12 sides
  near(tri(D.positions), 3 * q * q, 'diagonal area'); near(len(D.edges), 12 * q, 'diagonal outline');
  const G = maskGeometry(face(A, 2, 3, ['11', '00', '11']), A.origin); // a run interrupted: two quads
  assert.equal(G.positions.length, 36); near(tri(G.positions), 4 * q * q, 'gap area'); near(len(G.edges), 12 * q, 'gap outline');
  assert.deepEqual(maskGeometry(face(A, 2, 2, ['00', '00']), A.origin), { positions: new Float32Array(0), edges: new Float32Array(0), at: [] });
});

test('maskGeometry: positions relative to the origin given, the label on a covered cell', () => {
  const f = face(B, 3, 3, ['111', '100', '100']), o = [-1.25, 2.5, 6.5], g = maskGeometry(f, o), g0 = maskGeometry(f, [0, 0, 0]);
  near(g.positions[0], f.origin[0] - o[0], 'x'); near(g.positions[1], f.origin[1] - o[1], 'y'); near(g.positions[2], f.origin[2] - o[2], 'z'); // cell (0, 0)
  g.positions.forEach((x, i) => near(x, g0.positions[i] - o[i % 3], `p ${i}`));
  g.edges.forEach((x, i) => near(x, g0.edges[i] - o[i % 3], `e ${i}`));
  for (let i = 0; i < g.positions.length; i += 3) // all in the face's plane
    near(f.normal.reduce((a, n, k) => a + n * (g.positions[i + k] + o[k]), 0), f.d, 'plane');
  // the L's centroid (1.1, 1.1 cells) is on no cell: the nearest covered ones are (1, 0) and (0, 1), row 0 first
  const at = [0, 1, 2].map((k) => f.origin[k] - o[k] + f.cell * (1.5 * f.u[k] + 0.5 * f.v[k]));
  g.at.forEach((x, k) => near(x, at[k], `at ${k}`));
});
