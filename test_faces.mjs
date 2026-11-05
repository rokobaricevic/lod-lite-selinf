// node test_faces.mjs (or node --test): faces.js's decoder on /faces answers built by hand per the wire format: uint32 LE n,
// n bytes of JSON header padded with spaces to a multiple of 4, then each face's w*h uint8 mask in header order
import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, corners, facing } from './faces.js';

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

test('corners: origin + w cells along u, h cells along v, lifted along the normal', () => {
  const [a, b] = decode(answer(head, [mA, mB])).faces;
  close(corners(a), [10, 20, 5, 10.15, 20, 5, 10, 20, 5.1, 10.15, 20, 5.1], 'A');
  close(corners(a, 0.01), [10, 19.99, 5, 10.15, 19.99, 5, 10, 19.99, 5.1, 10.15, 19.99, 5.1], 'A lifted');
  const q = corners(b, 0.01), U = [0.4 * c, 0.4 * s, 0], V = [-0.5 * s, 0.5 * c, 0], o = [-1, 2, 7.01];
  close(q, [...o, ...o.map((x, k) => x + U[k]), ...o.map((x, k) => x + V[k]), ...o.map((x, k) => x + U[k] + V[k])], 'B lifted');
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
