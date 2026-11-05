// Element prisms (viewer.html loads this only with ?faces): the dock tool "Odabir elementa". A click on the bridge -> POST
// /element (selinf.py, faces_core) fits the element there as a prism: one cross-section (a polyline in the plane across
// its straight axis) swept between two stations, its faces meeting exactly. Over the bridge it is a closed shell (the
// profile inflated by 3 cm with mitered corners, so it sits just outside the scan), the candidate faces next to it are
// ghost outlines (a click adds one) and two handles at its ends drag along the axis. The side panel shows the prism alone
// in a 3D view of its own, its section (click a segment: in or out) and its faces listed; full screen on request.
// Shift-click adds the surface under the cursor, Delete drops the selected face, Esc clears. Each change refits: one
// request in flight, the latest wins. Display only: nothing is saved. ?selinf=<url>: the server (as selinf.js); ?ewin=
// ?eslab= ?eangle= ?econcave= ?eelem= ?epresence= ?egap=: the fit's window_m, slab_m, angle_deg, concave_max_m, element_m,
// presence, gap_m.
// Node imports this module for its pure functions alone (test_faces.mjs): three.js is loaded only in the page.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const same = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 5e-3; // one corner of the section (the answer's floats)

// The answer's section frame: P(u, v, s) = origin + u e1 + v e2 + s axis, and a point back to (u, v, s)
export const at = (A, u, v, s) => [0, 1, 2].map((c) => A.origin[c] + u * A.e1[c] + v * A.e2[c] + s * A.axis[c]);
export const uvs = (A, p) => { const w = sub(p, A.origin); return [dot(w, A.e1), dot(w, A.e2), dot(w, A.axis)]; };
export const facing = (f) => (f.normal[2] > 0.7 ? 'gore' : f.normal[2] < -0.7 ? 'dolje' : 'bočno');
// a candidate segment's ends in the section (q(t) = c n + t d, d = (-nv, nu)), and a point's distance to it
export const ends = (g) => g.t.map((t) => [g.c * g.n[0] - t * g.n[1], g.c * g.n[1] + t * g.n[0]]);
export function segDist(g, u, v) {
  const t = Math.min(g.t[1], Math.max(g.t[0], -g.n[1] * u + g.n[0] * v));
  return Math.hypot(u - g.c * g.n[0] + t * g.n[1], v - g.c * g.n[1] - t * g.n[0]);
}

// a piece's edges' outward unit normals in the section. The segments' edges lie on their lines, and the material is on
// one side of the whole polyline, so each edge's normal is its left one times the side those edges agree on (joints too)
export function edgeNormals(pc, segs) {
  const P = pc.uv, n = P.length, L = [];
  for (let i = 0; i < (pc.closed ? n : n - 1); i++) {
    const a = P[i], b = P[(i + 1) % n], du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
    L.push([-dv / l, du / l]);
  }
  let side = 0;
  for (const g of segs) if (pc.keys?.includes(g.key)) L.forEach((m, i) => {
    const on = (p) => Math.abs(g.n[0] * p[0] + g.n[1] * p[1] - g.c) < 1e-3;
    if (on(P[i]) && on(P[(i + 1) % n])) side += m[0] * g.n[0] + m[1] * g.n[1];
  });
  return side < 0 ? L.map(([x, y]) => [-x, -y]) : L;
}
// the polyline pts moved d out along its edges' normals m (one per edge): each corner on both neighbours' offset lines
// (mitered; at most limit d from where it was), an open end along its edge's normal
export function inflate(pts, closed, m, d, limit = 4) {
  const E = m.length;
  return pts.map((p, i) => {
    const a = closed ? m[(i + E - 1) % E] : m[i - 1], b = closed ? m[i % E] : m[i];
    if (!a || !b) { const c = a ?? b; return c ? [p[0] + c[0] * d, p[1] + c[1] * d] : p; }
    const k = 1 + a[0] * b[0] + a[1] * b[1]; // w = d (a + b) / (1 + a.b) solves a.w = b.w = d
    let w = k < 1e-6 ? [b[0] * d, b[1] * d] : [((a[0] + b[0]) * d) / k, ((a[1] + b[1]) * d) / k];
    const l = Math.hypot(...w);
    if (l > limit * d) w = w.map((x) => (x * limit * d) / l);
    return [p[0] + w[0], p[1] + w[1]];
  });
}
// a simple polygon's triangles (ear clipping: a profile has a few corners), index triples in the polygon's own turn
export function earcut(P) {
  const sg = P.reduce((s, p, i) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0) < 0 ? -1 : 1;
  const cr = (a, b, c) => sg * ((P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]));
  const I = P.map((_, i) => i), T = [];
  while (I.length > 3) {
    const n = I.length, k = I.findIndex((b, i) => {
      const a = I[(i + n - 1) % n], c = I[(i + 1) % n];
      return cr(a, b, c) > 1e-12 && I.every((j) => j === a || j === b || j === c || cr(a, b, j) < 0 || cr(b, c, j) < 0 || cr(c, a, j) < 0);
    });
    if (k < 0) break; // only flat or crossed corners left
    T.push([I[(k + n - 1) % n], I[k], I[(k + 1) % n]]); I.splice(k, 1);
  }
  if (I.length === 3) T.push(I);
  return T;
}
// each piece's edges (uv[i] -> uv[i + 1]) as the answer's faces: their index, by the face's edge at s0 (-1: none)
export function edgeFaces(A) {
  const fe = (A.faces ?? []).map((f) => (f.key.startsWith('cap') ? null : [uvs(A, f.points[0]), uvs(A, f.points[1])]));
  return (A.pieces ?? []).map(({ uv, closed }) => uv.slice(0, closed ? uv.length : -1).map((p, i) => {
    const q = uv[(i + 1) % uv.length];
    return fe.findIndex((e) => e && ((same(e[0], p) && same(e[1], q)) || (same(e[0], q) && same(e[1], p))));
  }));
}
// The shell over the bridge: each piece's profile inflated by d, swept from s0 to s1 (past an end with a cap, by d: the cap
// is inflated too), the caps' polygons on the same corners. Indexed: pos holds each piece's corners at both ends once, so
// neighbouring quads share their vertices. quads: [a0, b0, b1, a1] per edge; tris: each triangle's face (-1: none, e.g. a
// forced piece the answer drew no face for); edges: the outline as point pairs (both profiles, the corners along the axis)
export function prism(A, d) {
  const F = A.faces ?? [], E = edgeFaces(A), cap = [0, 1].map((k) => F.findIndex((f) => f.key === 'cap' + k));
  const S = [A.s0 - (cap[0] >= 0 ? d : 0), A.s1 + (cap[1] >= 0 ? d : 0)], pos = [], index = [], quads = [], tris = [], edges = [], rings = [];
  const P = (i) => pos.slice(3 * i, 3 * i + 3), line = (i, j) => edges.push(...P(i), ...P(j));
  const tri = (a, b, c, f, out) => { // wound so that its normal points along out
    const w = dot(crs(sub(P(b), P(a)), sub(P(c), P(a))), out) < 0;
    index.push(a, w ? c : b, w ? b : c); tris.push(f);
  };
  (A.pieces ?? []).forEach((pc, k) => {
    const n = pc.uv.length, m = edgeNormals(pc, A.segments ?? []), q = inflate(pc.uv, pc.closed, m, d), b = pos.length / 3;
    for (const s of S) for (const [u, v] of q) pos.push(...at(A, u, v, s));
    m.forEach((mi, i) => {
      const j = (i + 1) % n, out = [0, 1, 2].map((c) => mi[0] * A.e1[c] + mi[1] * A.e2[c]);
      quads.push([b + i, b + j, b + n + j, b + n + i]);
      tri(b + i, b + j, b + n + j, E[k][i], out); tri(b + i, b + n + j, b + n + i, E[k][i], out);
      line(b + i, b + j); line(b + n + i, b + n + j);
    });
    for (let i = 0; i < n; i++) line(b + i, b + n + i);
    rings.push({ pc, q, b, n });
  });
  for (const k of [0, 1]) if (cap[k] >= 0) { // the profile closed by its chord: on the piece whose corners it has
    const cu = F[cap[k]].points.map((p) => uvs(A, p)), out = A.axis.map((x) => (k ? x : -x));
    const r = rings.find((r) => r.n === cu.length && cu.every((p) => r.pc.uv.some((u) => same(u, p))));
    if (r) {
      const o = r.b + (k ? r.n : 0);
      for (const [a, b, c] of earcut(r.q)) tri(o + a, o + b, o + c, cap[k], out);
      if (!r.pc.closed) line(o + r.n - 1, o);
    } else { // on no piece: its own polygon, d out along the axis
      const o = pos.length / 3;
      for (const p of F[cap[k]].points) pos.push(...p.map((x, c) => x + out[c] * d));
      for (const [a, b, c] of earcut(cu)) tri(o + a, o + b, o + c, cap[k], out);
      cu.forEach((_, i) => line(o + i, o + ((i + 1) % cu.length)));
    }
  }
  return { pos: Float32Array.from(pos), index, quads, tris, edges: Float32Array.from(edges) };
}
// the candidates not in the element (off): rectangles across [s0, s1], d off their surface. p: A0 B0 B1 A1 (t0, t1 at s0, s1)
export function ghosts(A, d) {
  return (A.segments ?? []).filter((g) => !g.on).map((g) => {
    const [a, b] = ends(g).map(([u, v]) => [u + d * g.n[0], v + d * g.n[1]]);
    return { key: g.key, p: [...at(A, ...a, A.s0), ...at(A, ...b, A.s0), ...at(A, ...b, A.s1), ...at(A, ...a, A.s1)] };
  });
}
export const quadLines = (p) => [0, 1, 2, 3].flatMap((i) => [...p.slice(3 * i, 3 * i + 3), ...p.slice(3 * ((i + 1) % 4), 3 * ((i + 1) % 4) + 3)]);
// a candidate's distance to the profile in the section (0: they touch or cross): only its neighbours are drawn as ghosts
export function gap(A, g) {
  const ps = (p, a, b) => { const x = b[0] - a[0], y = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * x + (p[1] - a[1]) * y) / (x * x + y * y || 1))); return Math.hypot(p[0] - a[0] - t * x, p[1] - a[1] - t * y); };
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]), [a, b] = ends(g);
  let d = Infinity;
  for (const { uv, closed } of A.pieces ?? []) uv.forEach((p, i) => {
    if (!closed && i === uv.length - 1) return;
    const q = uv[(i + 1) % uv.length];
    d = Math.min(d, cr(a, b, p) * cr(a, b, q) < 0 && cr(p, q, a) * cr(p, q, b) < 0 ? 0 : Math.min(ps(a, p, q), ps(b, p, q), ps(p, a, b), ps(q, a, b)));
  });
  return d;
}
// the profile at both ends (point pairs): the section's outline, which edges along the axis do not show end on
export const rings = (A, o = [0, 0, 0]) => (A.pieces ?? []).flatMap(({ uv, closed }) => uv.slice(0, closed ? uv.length : -1).flatMap((p, i) =>
  [A.s0, A.s1].flatMap((s) => [...sub(at(A, ...p, s), o), ...sub(at(A, ...uv[(i + 1) % uv.length], s), o)])));
// a face of the answer as triangles wound along its normal and its outline (point pairs), relative to o; at: its label's
// place (a side face's centre; a cap's largest triangle's, an L's centre being off it)
export function faceMesh(A, f, o = [0, 0, 0]) {
  const cap = f.key.startsWith('cap'), L = (cap ? f.points : [0, 1, 3, 2].map((i) => f.points[i])).map((p) => sub(p, o));
  const tri = [], best = [-1, null];
  for (const t of cap ? earcut(f.points.map((p) => uvs(A, p))) : [[0, 1, 2], [0, 2, 3]]) {
    let [a, b, c] = t.map((i) => L[i]);
    const n = crs(sub(b, a), sub(c, a)), ar = Math.hypot(...n);
    if (dot(n, f.normal) < 0) [b, c] = [c, b];
    tri.push(...a, ...b, ...c);
    if (ar > best[0]) best.splice(0, 2, ar, [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3));
  }
  const at = cap ? best[1] : [0, 1, 2].map((k) => L.reduce((s, p) => s + p[k], 0) / 4);
  return { tri, lines: L.flatMap((p, i) => [...p, ...L[(i + 1) % L.length]]), at };
}
// the nearest triangle (pos: xyz, index: triples) on the ray o + t dir, t > 0, from either side: {t, i}, or null
export function rayHit(o, dir, pos, index) {
  let best = null;
  const V = (k) => [pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]];
  for (let i = 0; i < index.length; i += 3) { // Moeller-Trumbore
    const a = V(index[i]), e1 = sub(V(index[i + 1]), a), e2 = sub(V(index[i + 2]), a), p = crs(dir, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(o, a), u = dot(s, p) / det, q = crs(s, e1), v = dot(dir, q) / det, t = dot(e2, q) / det;
    if (u >= 0 && v >= 0 && u + v <= 1 && t > 0 && !(best?.t <= t)) best = { t, i: i / 3 };
  }
  return best;
}
// a handle's drag: the station s on the axis p0 + s a (a unit) nearest the pointer's ray o + t dir (unit); null: the ray
// runs along the axis
export function axisParam(o, dir, p0, a) {
  const w = sub(p0, o), b = dot(a, dir), k = 1 - b * b;
  return k < 1e-6 ? null : (b * dot(dir, w) - dot(a, w)) / k;
}
// the section in a W x H px drawing: x = x0 + k u, y = y0 - k v (v up), fitting the profile and the click with room for
// their neighbours (a quarter of the element, at least 25 cm), pad px from the sides
export function sectionFit(A, W, H, pad = 12) {
  let u0 = 0, u1 = 0, v0 = 0, v1 = 0; // the click is (0, 0)
  for (const pc of A.pieces ?? []) for (const [u, v] of pc.uv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const r = Math.max(0.25, 0.25 * Math.max(u1 - u0, v1 - v0)), k = Math.min((W - 2 * pad) / (u1 - u0 + 2 * r), (H - 2 * pad) / (v1 - v0 + 2 * r));
  return { k, x0: W / 2 - (k * (u0 + u1)) / 2, y0: H / 2 + (k * (v0 + v1)) / 2 };
}
export const nice = (m) => { const e = 10 ** Math.floor(Math.log10(m)); return [5, 2.5, 2, 1].map((f) => f * e).find((x) => x <= m * (1 + 1e-9)); }; // a scale bar's length <= m

if (globalThis.lod) viewer(...await Promise.all(['three', 'three/addons/lines/LineSegments2.js', 'three/addons/lines/LineSegmentsGeometry.js', 'three/addons/lines/LineMaterial.js'].map((m) => import(m))));

function viewer(THREE, { LineSegments2 }, { LineSegmentsGeometry }, { LineMaterial }) {
  const lod = window.lod, ui = lod.ui, el = lod.el, Q = new URLSearchParams(location.search), API = Q.get('selinf') ?? ''; // as selinf.js
  const TUNE = {}; // the fit's tuning from the URL (only what is given: the server's defaults otherwise)
  for (const [q, k] of [['ewin', 'window_m'], ['eslab', 'slab_m'], ['eangle', 'angle_deg'], ['econcave', 'concave_max_m'],
    ['eelem', 'element_m'], ['epresence', 'presence'], ['egap', 'gap_m']]) if (Q.get(q) && Number.isFinite(+Q.get(q))) TUNE[k] = +Q.get(q);
  const TOUCH = matchMedia('(pointer: coarse)').matches, nf = (o) => new Intl.NumberFormat('hr-HR', o).format;
  const n0 = nf({ maximumFractionDigits: 0 }), n2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }), pct = nf({ style: 'percent' });
  const ploha = (n) => `${n0(n)} ${n % 10 > 1 && n % 10 < 5 && (n % 100 < 12 || n % 100 > 14) ? 'plohe' : 'ploha'}`;
  // D: the shell's inflation; ADD: how near a shift-click's point its face is (the server's 0.15 m and some); MIN: the shortest
  // element a handle drags to; the element's colour (--ac-fg) over the bridge and in the section
  const D = 0.03, ADD = 0.2, MIN = 0.2, NEAR_M = 0.3, LABELS = 60, INK0 = 0x0c0c0d, AC = 0x5a9bff, ISO = 0.6155;
  const PICK = `${TOUCH ? 'Dodirnite' : 'Kliknite'} element mosta.`;
  const MORE = TOUCH ? 'Presjek: dodir dodaje ili uklanja plohu.' : 'Presjek ili sivi obris: dodaj ili ukloni plohu · Shift+klik dodaje · Esc briše';
  // on: the tool; req: the element's request ({point, dir, axis, on, off: forced keys, add: points, s0, s1, tog: keys the
  // user toggled}); ok: a copy of the request of the answer shown (a failed refit goes back to it); ans: that answer; hov /
  // sel: the hovered / selected face or candidate ('s12' a segment's, 'j3' a joint, 'cap0'); gen: bumped on clear
  let on = false, unhint = () => {}, req = null, ok = null, ans = null, hov = null, sel = null, gen = 0, busy = false, dirty = false;
  const h = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const btn = (label, onclick, title = label) => Object.assign(h('button', '', label), { type: 'button', title, onclick });
  const seg = (k) => ans?.segments.find((g) => g.key === k), segOf = (id) => (/^s\d+$/.test(id ?? '') ? seg(+id.slice(1)) : null);
  const want = (g) => (g.auto || req.on.has(g.key)) && !req.off.has(g.key); // in the element as the request stands
  const lm = (o) => new LineMaterial({ linewidth: 1, ...o }); // fat lines: CSS px wide, antialiased with the scene

  // ---------- over the bridge, in the bake frame (as selinf.js's root). In the scene, not lod.overlays: its MSAA target
  // smooths them, and the shell is depth-tested against the bridge. The picked face's outline is drawn on top, faintly
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; lod.scene.add(root);
  const fillM = (opacity, color = AC) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  const shell = new THREE.Mesh(undefined, fillM(0.2)), edges = new LineSegments2(undefined, lm({ color: 0xa8cbff, linewidth: 1.75 }));
  const ghostL = new LineSegments2(undefined, lm({ color: 0xd8d8dc, linewidth: 1.25, dashed: true, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.85 }));
  const hovF = new THREE.Mesh(undefined, fillM(0.22)), selF = new THREE.Mesh(undefined, fillM(0.38, 0x9cc3ff));
  const ghH = new LineSegments2(undefined, lm({ color: AC, linewidth: 2.25 }));
  const selL = new LineSegments2(undefined, lm({ color: 0xffffff, linewidth: 1.5, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false }));
  shell.renderOrder = 1; hovF.renderOrder = selF.renderOrder = 2; selL.renderOrder = 9;
  root.add(shell, edges, ghostL, hovF, selF, ghH, selL);
  function setMesh(o, pos, index) { // new geometry (the old one disposed); hidden while empty
    o.geometry.dispose(); o.geometry = new THREE.BufferGeometry(); o.visible = pos.length > 0;
    if (o.visible) { o.geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3)); if (index) o.geometry.setIndex(index); }
  }
  function setLines(o, pos) { // pos: point pairs
    o.geometry.dispose(); o.geometry = new LineSegmentsGeometry(); o.visible = pos.length > 0;
    if (o.visible) { o.geometry.setPositions(pos); if (o.material.dashed) o.computeLineDistances(); }
  }
  for (const o of [shell, hovF, selF]) setMesh(o, []);
  for (const o of [edges, ghostL, ghH, selL]) setLines(o, []);
  // G: the shown answer's prism() and ghosts() (all: a candidate hovered in the section shows wherever it is); NEAR: the keys
  // of the ghosts drawn and clickable, the candidates within NEAR_M of the profile (the fit chains within 0.25 m; a window
  // has dozens of candidates, each drawn the element's whole length)
  let G = null, NEAR = new Set();
  function build3(A) { // the shell, its edges and the ghosts of A (the answer, or the answer at a handle's drag)
    G = A && { ...prism(A, D), gh: ghosts(A, D) };
    setMesh(shell, G?.pos ?? [], G?.index); setLines(edges, G?.edges ?? []);
    setLines(ghostL, (G?.gh ?? []).filter((g) => NEAR.has(g.key)).flatMap((g) => quadLines(g.p)));
    hilite();
  }
  function shape3(id) { // id over the bridge: its triangles and outline (a face's on the shell, a ghost's)
    const g = id && G?.gh.find((x) => 's' + x.key === id), k = ans?.faces.findIndex((f) => f.key === id) ?? -1;
    if (g) return { tri: [...g.p.slice(0, 9), ...g.p.slice(0, 3), ...g.p.slice(6)], lines: quadLines(g.p) };
    if (!G || k < 0) return null;
    const tri = [], cnt = new Map(), V = (i) => [...G.pos.subarray(3 * i, 3 * i + 3)];
    G.tris.forEach((f, t) => {
      if (f !== k) return;
      const I = G.index.slice(3 * t, 3 * t + 3);
      I.forEach((a, j) => { const b = I[(j + 1) % 3], e = Math.min(a, b) + ',' + Math.max(a, b); cnt.set(e, (cnt.get(e) ?? 0) + 1); tri.push(...V(a)); });
    });
    return { tri, lines: [...cnt].filter(([, c]) => c === 1).flatMap(([e]) => e.split(',').flatMap((i) => V(+i))) }; // its outline: edges of one triangle
  }
  function hilite() { // the hovered face lighter, the selected one lighter still, their outlines on top; a hovered ghost solid
    const s = shape3(sel), v = hov !== sel ? shape3(hov) : null, gv = v && G.gh.some((g) => 's' + g.key === hov);
    setMesh(selF, s?.tri ?? []); setMesh(hovF, v?.tri ?? []);
    setLines(selL, [...(s?.lines ?? []), ...(v && !gv ? v.lines : [])]); setLines(ghH, gv ? v.lines : []);
  }
  const rc = new THREE.Raycaster();
  function ray(e) { rc.setFromCamera(lod.ndcOf(e), lod.camera); return [lod.w2src(rc.ray.origin), lod.w2src(rc.ray.direction)]; } // bake frame
  function under(o, d) { // the element's face or the ghost the ray meets first: {id, t, ghost: its key}
    const s = G && rayHit(o, d, G.pos, G.index);
    let best = s && ans.faces[G.tris[s.i]] ? { id: ans.faces[G.tris[s.i]].key, t: s.t } : null;
    for (const g of G?.gh ?? []) if (NEAR.has(g.key)) { const q = rayHit(o, d, g.p, [0, 1, 2, 0, 2, 3]); if (q && !(best?.t <= q.t)) best = { id: 's' + g.key, t: q.t, ghost: g.key }; }
    return best;
  }

  // the two handles: on the axis at s0 and s1, dragged along it (the shell follows), released -> a refit with that extent.
  // DOM dots placed each frame while an element is shown (crisp, on top, their own pointer events)
  const hd = [0, 1].map((k) => { const b = h('div', 'fe-h'); b.title = k ? 'Kraj elementa: povucite' : 'Početak elementa: povucite'; b.hidden = true; document.body.append(b); return b; });
  let ext = null, drag = null, raf = 0; // ext: [s0, s1] drawn
  const cpos = new THREE.Vector3();
  function place() {
    raf = ans ? requestAnimationFrame(place) : 0;
    hd.forEach((b, k) => {
      const p = ans && lod.src2w(at(ans, 0, 0, ext[k])), c = p && cpos.copy(p).applyMatrix4(lod.camera.matrixWorldInverse);
      if (p) p.project(lod.camera);
      b.hidden = !p || c.z > -lod.camera.near || Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || fs;
      if (!b.hidden) b.style.transform = `translate(${((p.x + 1) / 2) * el.clientWidth}px,${((1 - p.y) / 2) * el.clientHeight}px)`;
    });
  }
  hd.forEach((b, k) => {
    b.addEventListener('pointerdown', (e) => {
      if (!ans || drag || e.button !== 0) return;
      e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('dr'); drag = { id: e.pointerId, moved: false };
    });
    b.addEventListener('pointermove', (e) => {
      if (drag?.id !== e.pointerId) return;
      const [o, d] = ray(e), s = axisParam(o, d, ans.origin, ans.axis);
      if (s == null) return;
      ext[k] = k ? Math.min(100, Math.max(s, ext[0] + MIN)) : Math.max(-100, Math.min(s, ext[1] - MIN));
      drag.moved = true; build3({ ...ans, s0: ext[0], s1: ext[1] });
      unhint = ui.hint(`Duljina ${n2(ext[1] - ext[0])} m`, 2000);
    });
    const up = (e) => { // the extent as shown, both ends (the other one where it is)
      if (drag?.id !== e.pointerId) return;
      const m = drag.moved; drag = null; b.classList.remove('dr');
      if (m && req) { [req.s0, req.s1] = ext; send(); }
    };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  });

  // ---------- the panel (left: damage.js's inspector is on the right; a bottom sheet on a phone): the buttons, the 3D view
  // and its presets, the section, the faces, the total. Full screen: the 3D view large, the section and the list beside it
  // (below it on a phone)
  const css = document.createElement('style');
  css.textContent = `
#fc{position:fixed;z-index:9;top:calc(76px + env(safe-area-inset-top));left:calc(16px + env(safe-area-inset-left));width:var(--w-insp);box-sizing:border-box;
 max-height:calc(100dvh - 108px - var(--h-dock) - env(safe-area-inset-top) - env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;padding:12px 16px;
 background:var(--ink1);border:1px solid var(--line);border-radius:var(--r-panel);box-shadow:var(--fp-shadow);color:var(--t);font-size:13px;-webkit-user-select:none;user-select:none}
#fc .hd{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px}#fc .hd .cap{flex:1 0 100%;margin-bottom:4px}
#fc button{flex:auto;height:28px;margin:0;padding:0 8px;border:0;border-radius:var(--r-sm);background:var(--ink2);color:var(--t);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
#fc button:disabled{color:var(--t-off);cursor:default}#fc button:focus-visible{outline:2px solid var(--ac-fg);outline-offset:2px}
#fc .c3,#fc .c2{display:flex;flex-direction:column;gap:6px;min-height:0;min-width:0}#fc .c2{flex:1 1 auto}
#fc .vw,#fc .sc{position:relative;flex:none;border-radius:var(--r-sm);overflow:hidden;background:var(--ink0)}#fc .vw{height:240px}#fc .sc{height:150px}
#fc .pv{flex:none;display:flex;gap:2px}#fc .pv button{padding:0 4px;background:none;color:var(--t-mid)}
#fc .lbs,#fc .gz{position:absolute;pointer-events:none}#fc .lbs{inset:0}
#fc .lb{position:absolute;left:0;top:0;font-size:11px;font-weight:600;color:var(--t-hi);text-shadow:0 0 3px #000,0 0 2px #000}
#fc .gz{left:6px;bottom:6px;width:56px;height:56px;font:10px var(--font-mono)}#fc .gz circle{fill:var(--ink1);stroke:var(--line)}
#fc .gz line{stroke:var(--t-low);stroke-width:1.4}#fc .gz text{fill:var(--t-mid);text-anchor:middle;dominant-baseline:central}
#fc .sc svg{position:absolute;inset:0;width:100%;height:100%}#fc .sc .cap{position:absolute;left:10px;top:8px;font-size:10px;pointer-events:none}
#fc .sc :is(line,polyline){fill:none;stroke-linecap:round;stroke-linejoin:round}#fc .sc .c{stroke:var(--t-low);stroke-width:1.5}
#fc .sc .c.off{stroke:var(--t-off);stroke-dasharray:4 3}#fc .sc .e{stroke:#5a9bff;stroke-width:2.5}#fc .sc .k{fill:#5a9bff}
#fc .sc :is(.c,.e).hv{stroke:var(--t-hi)}#fc .sc :is(.c,.e).on{stroke:#9cc3ff;stroke-width:3.5}#fc .sc .sd{fill:none;stroke:var(--t-hi);stroke-width:1.5}
#fc .sc text{font-size:10px;font-weight:600;fill:var(--t-mid);text-anchor:middle;dominant-baseline:central;pointer-events:none}
#fc .sc .h{stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}#fc .sc .sb{stroke:var(--t-low);stroke-width:1.5}#fc .sc .st{fill:var(--t-low);text-anchor:start}
#fc .ms{flex:none;color:var(--t-low)}#fc .ms:empty{display:none}
#fc .ls{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
#fc .r{display:flex;align-items:center;gap:8px;height:28px;padding:0 6px;border-radius:var(--r-sm);font-size:12px;cursor:pointer}
#fc .r.hv{background:var(--ink2)}#fc .r.on{background:var(--ac-dim)}#fc .r.x{color:var(--t-off)}
#fc .r b{flex:none;width:18px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--t-low)}#fc .r .ar{flex:1}
#fc .r :is(.wl,.cv,.or){color:var(--t-low)}#fc .r .cv{width:34px;text-align:right}#fc .r .or{width:36px}#fc .r.x :is(.wl,.or){color:var(--t-off)}
#fc .tg{position:relative;flex:none;width:26px;height:16px;padding:0;border-radius:8px;background:var(--ink4)}#fc i.tg{background:none}
#fc .tg::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--t-mid);transition:transform var(--fast)}
#fc i.tg::after{content:none}#fc .tg[aria-pressed=true]{background:var(--ac)}#fc .tg[aria-pressed=true]::after{transform:translateX(10px);background:var(--t-hi)}
#fc .tot{flex:none;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--t-low)}#fc .tot:empty{display:none}
#fc.fs{inset:0;width:auto;max-height:none;border:0;border-radius:0;box-shadow:none;z-index:1001;display:grid;grid-template:auto minmax(0,1fr)/minmax(0,1fr) min(400px,38%);
 gap:12px 16px;padding:calc(14px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))}
#fc.fs .hd{grid-column:1/-1;flex-wrap:nowrap}#fc.fs .hd .cap{flex:1 1 auto;margin:0}#fc.fs .hd button{flex:none;padding:0 12px}
#fc.fs .vw{flex:1 1 0;height:auto}#fc.fs .sc{height:clamp(180px,40vh,400px)}#fc.fs .pv button{flex:none;padding:0 12px}
.fe-h{position:fixed;left:0;top:0;z-index:8;width:28px;height:28px;margin:-14px 0 0 -14px;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none}
.fe-h::after{content:"";width:12px;height:12px;border-radius:50%;background:var(--t-hi);box-shadow:0 0 0 2.5px var(--ac),var(--pin-shadow);transition:transform var(--fast)}
.fe-h.dr{cursor:grabbing}.fe-h.dr::after{transform:scale(1.3)}
@media (hover:hover){#fc button:not(:disabled,.tg):hover{background:var(--ink4)}#fc .pv button:hover{background:var(--ink2);color:var(--t)}.fe-h:hover::after{transform:scale(1.3)}}
@media (max-width:700px){#fc{top:auto;right:calc(16px + env(safe-area-inset-right));bottom:calc(28px + var(--h-dock) + env(safe-area-inset-bottom));width:auto;
 height:58dvh;max-height:none;padding:10px 12px;gap:6px}#fc .hd .cap{display:none}#fc .c3{flex:5 1 0}#fc .c2{flex:5 1 0}#fc .vw{flex:1 1 0;height:auto}#fc .sc{height:110px}
 #fc.fs{display:flex;height:auto}#fc.fs .c3{flex:none;height:44dvh}#fc.fs .c2{flex:1 1 0}#fc.fs .sc{height:30dvh}#fc.fs :is(.hd,.pv) button{flex:auto;padding:0 6px}}
@media (pointer:coarse){#fc button{height:36px}#fc .r{height:36px}#fc .tg{height:20px;width:34px;border-radius:10px}#fc .tg::after{width:16px;height:16px}
 #fc .tg[aria-pressed=true]::after{transform:translateX(14px)}#fc .sc .h{stroke-width:24}.fe-h{width:44px;height:44px;margin:-22px 0 0 -22px}.fe-h::after{width:16px;height:16px}}`;
  document.head.append(css);
  const panel = h('div'), hdr = h('div', 'hd'), c3 = h('div', 'c3'), c2 = h('div', 'c2'), vw = h('div', 'vw'), lab = h('div', 'lbs'), pv = h('div', 'pv');
  const sv = h('div', 'sc'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), msgEl = h('div', 'ms'), rows = h('div', 'ls'), tot = h('div', 'tot num');
  panel.id = 'fc'; panel.hidden = true;
  const fsB = btn('Cijeli zaslon', () => setFs(!fs)), autoB = btn('Automatska duljina', () => { if (req) { req.s0 = req.s1 = null; send(); } }, 'Duljina prema skenu (poništava ručice)');
  hdr.append(h('div', 'cap', 'Odabir elementa'), fsB, autoB, btn('Očisti', () => clear(), 'Očisti (Esc)'));
  sv.append(svg, h('div', 'cap', 'Presjek'));
  c3.append(vw, pv); c2.append(sv, msgEl, rows, tot); panel.append(hdr, c3, c2); document.body.append(panel);
  const msg = (t) => (msgEl.textContent = t);

  // ---------- the side view: the prism alone, flat grey lit from above (lynceus's lambert), dark edges, the picked face in
  // colour, the other candidates dashed, numbered. Its own renderer, drawn on demand (an answer, an orbit, a resize, a pick),
  // never in a loop; an orthographic camera orbiting with Z up
  const R = new THREE.WebGLRenderer({ antialias: true });
  R.setPixelRatio(Math.min(devicePixelRatio, 2)); R.setClearColor(INK0);
  const sc = new THREE.Scene(), cam = new THREE.OrthographicCamera(), cv = R.domElement;
  const faceMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  faceMat.onBeforeCompile = (s) => { // a face's back (an open profile seen from inside): darker and greyer, as lynceus's;
    // not the picked one (its colour's alpha 0; the canvas has no alpha)
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nif ( !gl_FrontFacing && vColor.a > 0.5 ) diffuseColor.rgb = mix( vec3( dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) ), diffuseColor.rgb, 0.35 ) * 0.55;');
  };
  const solid = new THREE.Mesh(undefined, faceMat), lines = new LineSegments2(undefined, lm({ color: INK0, linewidth: 1.25 }));
  const ring = new LineSegments2(undefined, lm({ color: 0xa1a1a6, linewidth: 1.25, transparent: true, opacity: 0.8 })); // the section at both ends, light
  const sGh = new LineSegments2(undefined, lm({ color: 0x8e8e93, dashed: true, dashSize: 0.1, gapSize: 0.07 })), sGhH = new LineSegments2(undefined, lm({ color: AC, linewidth: 2 }));
  sc.add(solid, lines, ring, sGh, sGhH);
  for (const o of [lines, ring, sGh, sGhH]) setLines(o, []);
  // the id pass: each face in the colour k + 1 into a target read back once per view, so hover and the labels' occlusion
  // are a lookup (a target is linear: the bytes come back exact)
  const idSc = new THREE.Scene(), idm = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const rt = new THREE.WebGLRenderTarget(1, 1);
  idSc.add(idm);
  let ids = new Uint8Array(4);
  const gz = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); // the axes, bake frame
  gz.setAttribute('viewBox', '-28 -28 56 56'); gz.setAttribute('class', 'gz');
  gz.innerHTML = '<circle r="27"/>' + [...'XYZ'].map((c) => `<line/><text>${c}</text>`).join('');
  const gzL = gz.querySelectorAll('line'), gzT = gz.querySelectorAll('text');
  vw.append(cv, lab, gz);
  // Izo: from the click's side, turned toward the +axis end, 35 deg above (below, if the click looked up: a soffit's girder);
  // Sprijeda: square on from the click's side; Bok: along the axis (the section as drawn below it: e1 right, e2 up)
  for (const [label, k] of [['Izo', 'iso'], ['Odozgo', 'top'], ['Sprijeda', 'front'], ['Bok', 'side']]) pv.append(btn(label, () => ans && fit(...look(k))));
  pv.append(btn('Prikaži sve', () => fit(), 'Prikaži sve (dvoklik)'));
  const front = (A) => A.e1.map((x) => x * (-Math.sign(dot(req.dir, A.e1)) || 1)), up = () => (req.dir[2] > 0.25 ? -1 : 1); // the click's sides
  function look(k) { // [az, el] of a preset, from the answer's frame
    const a = ans.axis, f = front(ans), hz = Math.hypot(a[0], a[1]) > 0.05, az = (x, y) => Math.atan2(y, x);
    if (k === 'side') return [az(a[0], a[1]), Math.asin(Math.max(-1, Math.min(1, a[2])))];
    if (k === 'top') return [hz ? az(a[1], -a[0]) : az(f[0], f[1]) + Math.PI / 2, Math.PI / 2];
    if (k === 'front') return [az(f[0], f[1]), 0];
    return [hz ? az(f[0] + a[0], f[1] + a[1]) : az(f[0], f[1]) + Math.PI / 4, up() * ISO];
  }

  // the answer on the GPU: every face's triangles in one buffer (tv[k]..tv[k+1] its vertices), its edges in another (ev);
  // relative to O, the answer's origin (bake frame). V: the view, eye at az / el about the target t, span metres tall;
  // touched: orbited since the click (then an answer keeps the view, else it fits)
  let O = [0, 0, 0], FS = [], tv = [0], EP = new Float32Array(0), AT = [], grey = [], colA = null, rad = 1, touched = false, pend = 0, moved = false, ghs = {};
  const V = { az: 0, el: ISO, t: new THREE.Vector3(), span: 10 };
  const SEL = new THREE.Color().setRGB(0.45 * 12 / 255 + 0.55 * 31 / 255, 0.45 * 12 / 255 + 0.55 * 111 / 255, 0.45 * 13 / 255 + 0.55 * 235 / 255, THREE.SRGBColorSpace); // lynceus: --ac over the ground, 55 %
  const SELH = new THREE.Color().setRGB(0.28 * 12 / 255 + 0.72 * 31 / 255, 0.28 * 12 / 255 + 0.72 * 111 / 255, 0.28 * 13 / 255 + 0.72 * 235 / 255, THREE.SRGBColorSpace);
  function side(A) {
    for (const m of [solid, idm]) { m.geometry.dispose(); m.geometry = new THREE.BufferGeometry(); }
    lab.replaceChildren(); FS = A?.faces ?? [];
    if (A) { const o = A.origin; V.t.x += O[0] - o[0]; V.t.y += O[1] - o[1]; V.t.z += O[2] - o[2]; O = o; } // the view stays put in the bake frame
    const M = FS.map((f) => faceMesh(A, f, O));
    tv = [0];
    for (const m of M) tv.push(tv.at(-1) + m.tri.length / 3);
    const pos = new Float32Array(3 * tv.at(-1)), col = new Float32Array((pos.length / 3) * 4), idc = new Uint8Array(pos.length);
    EP = Float32Array.from(M.flatMap((m) => m.lines)); AT = M.map((m) => m.at);
    // lambert (lynceus's anchors), the light from Izo's side (above, or below), the click's and the +axis end: its three sides differ
    const f = A ? front(A) : [0, 0, 0], L = A ? [0, 1, 2].map((c) => 0.55 * f[c] + 0.25 * A.axis[c] + (c === 2 ? 0.8 * up() : 0)) : [0, 0, 1];
    const l = Math.hypot(...L);
    grey = FS.map((f) => { const k = 0.25 + 0.75 * Math.max(0, dot(f.normal, L) / l); return new THREE.Color().setRGB((38 + 66 * k) / 255, (44 + 72 * k) / 255, (51 + 77 * k) / 255, THREE.SRGBColorSpace); });
    M.forEach((m, k) => {
      pos.set(m.tri, 3 * tv[k]);
      for (let i = 3 * tv[k]; i < 3 * tv[k + 1]; i += 3) { idc[i] = (k + 1) & 255; idc[i + 1] = (k + 1) >> 8; idc[i + 2] = (k + 1) >> 16; }
      if (k < LABELS) lab.append(h('span', 'lb', k + 1));
    });
    const P = new THREE.BufferAttribute(pos, 3);
    colA = new THREE.BufferAttribute(col, 4);
    solid.geometry.setAttribute('position', P).setAttribute('color', colA);
    idm.geometry.setAttribute('position', P).setAttribute('color', new THREE.BufferAttribute(idc, 3, true));
    const gh = A ? ghosts(A, 0) : []; // the candidates out: all for a hover, the near ones drawn
    ghs = Object.fromEntries(gh.map((g) => ['s' + g.key, quadLines(g.p.map((x, i) => x - O[i % 3]))]));
    setLines(lines, EP); setLines(ring, A ? rings(A, O) : []); setLines(sGh, gh.filter((g) => NEAR.has(g.key)).flatMap((g) => ghs['s' + g.key]));
    rad = 1;
    for (let i = 0; i < EP.length; i += 3) rad = Math.max(rad, Math.hypot(EP[i], EP[i + 1], EP[i + 2]));
    if (FS.length && !touched) fit(); else aim();
  }
  function tint() { // each face's colour: grey, lighter hovered, blue selected (those two the same from behind)
    if (!colA) return;
    const a = colA.array;
    FS.forEach((f, k) => {
      const c = f.key === sel ? (f.key === hov ? SELH : SEL) : f.key === hov ? grey[k].clone().lerp(new THREE.Color(0x9da6b0), 0.35) : grey[k];
      for (let i = 4 * tv[k]; i < 4 * tv[k + 1]; i += 4) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; a[i + 3] = c === grey[k] ? 1 : 0; }
    });
    colA.needsUpdate = true;
  }
  // linked: what is hovered (hov) or selected (sel, sticky; a click on it again drops it) shows in the 3D view, the list,
  // the section and over the bridge. mark() with no id redraws them all
  function mark(id, sticky = false) {
    if (id !== undefined) { if (sticky) sel = sel === id ? null : id; else hov = id; }
    tint(); setLines(sGhH, ghs[hov] ?? []);
    for (const r of rows.children) { r.classList.toggle('on', r.dataset.id === sel); r.classList.toggle('hv', r.dataset.id === hov); }
    for (const e of svg.querySelectorAll('[data-id]:not(.h)')) { e.classList.toggle('on', e.dataset.id === sel); e.classList.toggle('hv', e.dataset.id === hov && e.dataset.id !== sel); }
    hilite(); draw();
  }

  // the camera: the eye along ve (az about Z, el above the horizon), screen right vr, screen up vu = ve x vr
  const ve = new THREE.Vector3(), vr = new THREE.Vector3(), vu = new THREE.Vector3(), MB = new THREE.Matrix4(), p = new THREE.Vector3();
  function basis() { ve.set(Math.cos(V.el) * Math.cos(V.az), Math.cos(V.el) * Math.sin(V.az), Math.sin(V.el)); vr.set(-Math.sin(V.az), Math.cos(V.az), 0); vu.crossVectors(ve, vr); }
  function aim() {
    basis();
    const Dd = rad + V.t.length() + 1; // outside everything
    cam.position.copy(V.t).addScaledVector(ve, Dd); cam.quaternion.setFromRotationMatrix(MB.makeBasis(vr, vu, ve));
    cam.top = V.span / 2; cam.bottom = -cam.top; cam.right = (cam.top * vw.clientWidth) / (vw.clientHeight || 1); cam.left = -cam.right;
    cam.near = 0; cam.far = 2 * Dd; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    for (let c = 0; c < 3; c++) { // each bake axis as the screen shows it
      const x = vr.getComponent(c) * 17, y = -vu.getComponent(c) * 17;
      gzL[c].setAttribute('x2', x); gzL[c].setAttribute('y2', y); gzT[c].setAttribute('x', x * 1.4); gzT[c].setAttribute('y', y * 1.4);
    }
    moved = true; draw();
  }
  function fit(az = V.az, el = V.el) { // the faces' outline (their edges) filling the view at that angle
    V.az = az; V.el = el; basis();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < EP.length; i += 3) {
      const x = EP[i] * vr.x + EP[i + 1] * vr.y + EP[i + 2] * vr.z, y = EP[i] * vu.x + EP[i + 1] * vu.y + EP[i + 2] * vu.z;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x0 <= x1) { V.t.copy(vr).multiplyScalar((x0 + x1) / 2).addScaledVector(vu, (y0 + y1) / 2); V.span = 1.2 * Math.max(y1 - y0, ((x1 - x0) * vw.clientHeight) / (vw.clientWidth || 1), 0.1); }
    aim();
  }
  function zoomAt(x, y, s) { // about the point under (x, y) (client px), which stays put
    const b = cv.getBoundingClientRect(), nx = ((x - b.left) / b.width) * 2 - 1, ny = 1 - ((y - b.top) / b.height) * 2;
    s = Math.min(Math.max(V.span * s, 0.05), 5000) / V.span;
    V.t.addScaledVector(vr, nx * cam.right * (1 - s)).addScaledVector(vu, ny * cam.top * (1 - s)); V.span *= s;
  }
  function panBy(dx, dy) { const k = V.span / (vw.clientHeight || 1); V.t.addScaledVector(vr, -dx * k).addScaledVector(vu, dy * k); }

  const draw = () => { pend ||= requestAnimationFrame(render); };
  function render() {
    pend = 0;
    const w = vw.clientWidth, H = vw.clientHeight;
    if (!w || !H || panel.hidden) return;
    R.render(sc, cam);
    if (!moved) return;
    moved = false;
    if (rt.width !== w || rt.height !== H) { rt.setSize(w, H); ids = new Uint8Array(4 * w * H); }
    R.setRenderTarget(rt); R.setClearColor(0); R.render(idSc, cam); R.readRenderTargetPixels(rt, 0, 0, w, H, ids);
    R.setRenderTarget(null); R.setClearColor(INK0);
    [...lab.children].forEach((s, k) => { // a label shows where its own face is the one in front
      p.fromArray(AT[k]).project(cam);
      const x = Math.floor(((p.x + 1) / 2) * w), y = Math.floor(((1 - p.y) / 2) * H);
      s.hidden = idAt(x, y) !== k;
      if (!s.hidden) s.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
    });
  }
  function idAt(x, y) { // the face at view pixel (x, y); -1: none (or one of an older answer, before its id pass)
    if (!(x >= 0 && y >= 0 && x < rt.width && y < rt.height)) return -1;
    const i = 4 * ((rt.height - 1 - y) * rt.width + x), k = (ids[i] | (ids[i + 1] << 8) | (ids[i + 2] << 16)) - 1;
    return k < FS.length ? k : -1;
  }
  const faceAt = (e) => FS[idAt(Math.floor(e.offsetX), Math.floor(e.offsetY))]?.key ?? null;
  new ResizeObserver(() => { if (vw.clientWidth && vw.clientHeight) { R.setSize(vw.clientWidth, vw.clientHeight, false); if (touched || !FS.length) aim(); else fit(); } }).observe(vw);

  // the view's pointers: drag orbits (right / shift-drag pans), two fingers pinch and pan, the wheel zooms at the cursor, a
  // tap picks (empty space clears), a double-click fits; a mouse's hover picks out
  const pts = new Map();
  let tap = null, pan = false;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    tap = pts.size === 1 ? [e.clientX, e.clientY, e.pointerType === 'mouse' ? 4 : 10] : null; pan = e.button === 2 || e.shiftKey;
  });
  cv.addEventListener('pointermove', (e) => {
    const q = pts.get(e.pointerId);
    if (!q) { if (e.pointerType === 'mouse') { const k = faceAt(e); if (k !== hov) mark(k); } return; }
    if (tap && Math.hypot(e.clientX - tap[0], e.clientY - tap[1]) < tap[2]) return; // still a tap
    tap = null; touched = true;
    const dx = e.clientX - q[0], dy = e.clientY - q[1], o = [...pts.values()].find((x) => x !== q);
    if (o) { zoomAt((e.clientX + o[0]) / 2, (e.clientY + o[1]) / 2, Math.hypot(q[0] - o[0], q[1] - o[1]) / Math.max(1, Math.hypot(e.clientX - o[0], e.clientY - o[1]))); panBy(dx / 2, dy / 2); }
    else if (pan) panBy(dx, dy);
    else { V.az -= dx * 0.008; V.el = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, V.el + dy * 0.008)); }
    q[0] = e.clientX; q[1] = e.clientY; aim();
  });
  for (const t of ['pointerup', 'pointercancel']) cv.addEventListener(t, (e) => {
    if (tap && t === 'pointerup') { const k = faceAt(e); if (k !== sel) mark(k, true); rows.querySelector(`[data-id="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); } // empty: none
    pts.delete(e.pointerId); tap = null;
  });
  cv.addEventListener('pointerleave', () => { if (hov && !pts.size) mark(null); });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015)); touched = true; aim(); }, { passive: false });
  cv.addEventListener('dblclick', () => fit());
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- the section: every candidate (solid: in the element, dashed: out), the profile through its corners, the
  // click, the faces' numbers, a scale bar. A click on a candidate puts it in or takes it out
  function section() {
    const W = sv.clientWidth, H = sv.clientHeight;
    if (!ans || !W || !H) return void svg.replaceChildren();
    const { k, x0, y0 } = sectionFit(ans, W, H, 14), X = ([u, v]) => [x0 + k * u, y0 - k * v].map((x) => x.toFixed(1));
    const ln = (a, b, cls, id) => { const [x1, y1] = X(a), [x2, y2] = X(b); return `<line class="${cls}"${id ? ` data-id="${id}"` : ''} x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; };
    const EF = edgeFaces(ans), [cx, cy] = X([0, 0]);
    let s = '', top = '', hit = '';
    for (const g of ans.segments) { const [a, b] = ends(g); s += ln(a, b, want(g) ? 'c' : 'c off', 's' + g.key); hit += ln(a, b, 'h', 's' + g.key); }
    ans.pieces.forEach((pc, j) => {
      const n = pc.uv.length, M = edgeNormals(pc, ans.segments);
      EF[j].forEach((f, i) => {
        const a = pc.uv[i], b = pc.uv[(i + 1) % n], id = ans.faces[f]?.key, m = M[i];
        s += ln(a, b, 'e', id);
        if (id) hit += ln(a, b, 'h', id);
        if (f >= 0 && f < LABELS) { // its number off its middle (a quarter along it if the click is there)
          let [x, y] = X([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          if (Math.hypot(x - cx, y - cy) < 16) [x, y] = X([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
          top += `<text x="${(+x + 12 * m[0]).toFixed(1)}" y="${(+y - 12 * m[1]).toFixed(1)}">${f + 1}</text>`;
        }
      });
      for (const c of pc.uv) { const [x, y] = X(c); top += `<circle class="k" cx="${x}" cy="${y}" r="2.5"/>`; }
    });
    const L = nice((0.3 * W) / k), bx = 12, by = H - 12;
    top += `<circle class="sd" cx="${cx}" cy="${cy}" r="4.5"/><line class="sd" x1="${cx - 7}" y1="${cy}" x2="${+cx + 7}" y2="${cy}"/><line class="sd" x1="${cx}" y1="${cy - 7}" x2="${cx}" y2="${+cy + 7}"/>`;
    top += `<line class="sb" x1="${bx}" y1="${by}" x2="${(bx + L * k).toFixed(1)}" y2="${by}"/><line class="sb" x1="${bx}" y1="${by - 4}" x2="${bx}" y2="${by + 4}"/>`;
    top += `<line class="sb" x1="${(bx + L * k).toFixed(1)}" y1="${by - 4}" x2="${(bx + L * k).toFixed(1)}" y2="${by + 4}"/><text class="st" x="${bx}" y="${by - 10}">${L < 1 ? n0(L * 100) + ' cm' : nf({ maximumFractionDigits: 1 })(L) + ' m'}</text>`;
    svg.innerHTML = s + top + hit;
  }
  svg.addEventListener('pointerover', (e) => { const id = e.target.dataset?.id; if (id && id !== hov) mark(id); });
  svg.addEventListener('pointerout', (e) => { if (e.target.dataset?.id && !e.relatedTarget?.dataset?.id) mark(null); });
  svg.addEventListener('click', (e) => { const g = segOf(e.target.dataset?.id); if (g) toggle(g.key); });
  new ResizeObserver(() => section()).observe(sv);

  // ---------- the faces: number, area, width x length, how much of it the scan covers, orientation, in / out; then the
  // candidates the user took out (to put them back). The total: faces, area, the element's length, the server's time
  function list() {
    rows.replaceChildren(); tot.textContent = '';
    if (!ans) return;
    const row = (id, k, f, g) => {
      const r = h('div', 'r' + (f ? '' : ' x'));
      r.dataset.id = id;
      r.append(h('b', '', k == null ? '–' : k + 1), h('span', 'num ar', f ? `${n2(f.area)} m²` : 'isključena'), h('span', 'num wl', f ? `${n2(f.width)} × ${n2(f.length)} m` : ''),
        h('span', 'num cv', f ? pct(f.coverage) : ''), h('span', 'or', facing(f ?? { normal: [0, 1, 2].map((c) => g.n[0] * ans.e1[c] + g.n[1] * ans.e2[c]) })));
      if (g) {
        const t = btn('', (e) => { e.stopPropagation(); toggle(g.key); }, f ? 'Ukloni plohu iz elementa (Delete)' : 'Vrati plohu u element');
        t.className = 'tg'; t.setAttribute('aria-pressed', !!f); r.append(t);
      } else r.append(h('i', 'tg')); // a cap or a joint: comes with its neighbours
      r.onpointerenter = () => mark(id); r.onpointerleave = () => mark(null); r.onclick = () => mark(id, true);
      return r;
    };
    ans.faces.forEach((f, k) => rows.append(row(f.key, k, f, f.seg == null ? null : seg(f.seg))));
    for (const key of req.tog) { const g = seg(key); if (g && !g.on) rows.append(row('s' + key, null, null, g)); }
    const len = ans.s1 - ans.s0, area = ans.faces.reduce((a, f) => a + f.area, 0);
    tot.textContent = `${ploha(ans.faces.length)} · ${n2(area)} m² · duljina ${n2(len)} m${req.s0 != null || req.s1 != null ? ' (ručno)' : ''} · ${ans.ms < 1 ? '< 1' : n0(ans.ms)} ms`;
  }

  // ---------- an answer shown (null: none): over the bridge, in the 3D view, the section, the list
  function show(A) {
    ans = A; ext = A && [A.s0, A.s1];
    const idsNow = new Set([...(A?.faces ?? []).map((f) => f.key), ...(A?.segments ?? []).map((g) => 's' + g.key)]);
    if (!idsNow.has(sel)) sel = null;
    if (!idsNow.has(hov)) hov = null;
    NEAR = new Set((A?.segments ?? []).filter((g) => !g.on && gap(A, g) <= NEAR_M).map((g) => g.key));
    build3(A); side(A); section(); list(); mark();
    autoB.disabled = !(req && (req.s0 != null || req.s1 != null));
    if (A && !raf) raf = requestAnimationFrame(place);
    if (!A) hd.forEach((b) => (b.hidden = true));
  }

  // ---------- requests: one in flight; changes meanwhile go out once it returns, only the latest (an older answer is dropped)
  const copy = (r) => r && { ...r, on: new Set(r.on), off: new Set(r.off), add: [...r.add], tog: new Set(r.tog) };
  const body = (r) => ({ point: r.point, dir: r.dir, ...(r.axis && { axis: r.axis }), ...(r.on.size && { on: [...r.on] }), ...(r.off.size && { off: [...r.off] }),
    ...(r.add.length && { add: r.add }), ...(r.s0 != null && { s0: r.s0 }), ...(r.s1 != null && { s1: r.s1 }), ...TUNE });
  function send() { dirty = true; msg('Računanje…'); if (!busy) pump(); }
  async function pump() {
    busy = true;
    while (dirty && req) {
      dirty = false;
      const g = gen, b = body(req);
      let res = null, err = null;
      try { // text/plain body (a string): no CORS preflight
        const r = await fetch(API + '/element', { method: 'POST', body: JSON.stringify(b) }).catch(() => { throw new Error('server ne odgovara'); });
        res = await r.json().catch(() => null); // not our answer (a proxy's page, an empty 401): the status says it
        if (!r.ok || !res?.faces) err = [r.status, res?.error || (r.ok ? 'neispravan odgovor' : `HTTP ${r.status}`)];
      } catch (e) { err = [0, e.message]; }
      if (g !== gen || dirty) continue; // superseded: the latest goes out instead
      msg('');
      if (err) fail(...err); else done(res);
    }
    busy = false;
  }
  function done(A) { // the axis kept from now on (the keys stay stable), a shift-clicked point's face kept by its key
    const first = !ok;
    req.axis = A.axis;
    for (const pt of req.add) {
      const [u, v] = uvs(A, pt), g = A.segments.filter((x) => x.on).sort((a, b) => segDist(a, u, v) - segDist(b, u, v))[0];
      if (g && segDist(g, u, v) < ADD) { if (!g.auto) req.on.add(g.key); } else unhint = ui.hint('Ondje nema plohe za dodati.', 5000);
    }
    req.add = []; ok = copy(req);
    show(A);
    if (first) { if (!touched) fit(...look('iso')); unhint(); unhint = ui.hint(MORE, 8000); } // a new element: Izo, fitted
  }
  function fail(status, text) {
    const why = status === 422 ? 'Tu nije prepoznat element.' : status === 503 ? 'Prepoznavanje elemenata nije dostupno na poslužitelju.' : `Element nije izračunat: ${text}.`;
    unhint(); unhint = ui.hint(why, 8000);
    if (ok) { req = copy(ok); show(ans); } // a refit: back to the answer shown
    else { req = null; show(null); panel.hidden = true; } // a new click: nothing there
  }
  function start(point, dir) { // a new element at the click
    gen++; req = { point, dir, axis: null, on: new Set(), off: new Set(), add: [], s0: null, s1: null, tog: new Set() }; ok = null;
    hov = sel = null; touched = false; show(null); panel.hidden = false;
    send();
  }
  function toggle(key) { // a candidate in or out of the element
    const g = seg(key);
    if (!g || !req) return;
    if (want(g)) { req.on.delete(key); if (g.auto) req.off.add(key); } else { req.off.delete(key); if (!g.auto) req.on.add(key); }
    req.tog.add(key); send();
  }
  function clear() { gen++; req = ok = null; hov = sel = null; setFs(false); show(null); msg(''); panel.hidden = true; }

  // ---------- full screen: the panel over everything (the Fullscreen API where there is one, else a CSS overlay: iOS)
  let fs = false;
  function setFs(v) {
    if (v === fs) return;
    fs = v; panel.classList.toggle('fs', v);
    fsB.textContent = v ? 'Izađi' : 'Cijeli zaslon'; fsB.title = v ? 'Izađi iz cijelog zaslona (Esc)' : 'Cijeli zaslon';
    if (v && document.fullscreenEnabled && !document.fullscreenElement) panel.requestFullscreen().catch(() => {}); // refused: the overlay stays
    if (!v && document.fullscreenElement === panel) document.exitFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => { if (fs && document.fullscreenElement !== panel) setFs(false); }); // Esc, or the browser's own

  // ---------- the dock tool: on, a click on the bridge picks the element there; off or Esc clears
  const tool = ui.tool({ label: 'Odabir elementa', order: 25, onClick: () => setOn(!on),
    icon: '<path d="M3 15.5L8 7l5 8.5z"/><path d="M8 7l4.5-3.5 5 8.5-4.5 3.5"/>' }); // a prism
  function setOn(v) {
    on = v; tool.classList.toggle('on', v); tool.setAttribute('aria-pressed', v);
    clear(); unhint(); if (v) unhint = ui.hint(PICK);
    if (!lod.inferArmed) el.style.cursor = '';
  }
  setOn(false);
  lod.element = { get answer() { return ans; }, get request() { return req && body(req); } }; // for the bench and tests: read only

  // pointers on the bridge (a click, not a drag; alt / selinf's armed tool: selinf's): the element's face -> selected; a
  // ghost -> in the element; shift -> the surface there added; elsewhere -> a new element. Nearer than the bridge only
  let down = null;
  addEventListener('pointerdown', (e) => {
    if (e.target === el) down = { x: e.clientX, y: e.clientY, slop: e.pointerType === 'touch' ? 10 : 4, skip: e.altKey || e.button !== 0 || lod.inferArmed };
  }, true);
  el.addEventListener('click', (e) => {
    if (!on || !down || down.skip || Math.hypot(e.clientX - down.x, e.clientY - down.y) > down.slop) return;
    const [o, d] = ray(e), u = ans && under(o, d), hit = lod.pick(lod.ndcOf(e));
    if (u && (!hit || u.t <= hit.distance + 0.15)) return u.ghost != null ? toggle(u.ghost) : mark(u.id, true);
    if (!hit) return mark(null, true);
    const pt = lod.w2src(hit.point);
    if (e.shiftKey && req) { req.add.push(pt); send(); } else start(pt, d);
  });
  el.addEventListener('pointermove', (e) => { // a mouse over the element: its face or ghost picked out (not through the bridge: hover only)
    if (!on || !ans || e.buttons || e.pointerType !== 'mouse' || drag) return;
    const u = under(...ray(e)), id = u?.id ?? null;
    if (id !== hov) mark(id);
    if (!lod.inferArmed) el.style.cursor = u ? 'pointer' : '';
  });
  el.addEventListener('pointerleave', () => { if (on && hov) mark(null); });
  addEventListener('keydown', (e) => {
    if (!on || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { if (fs) setFs(false); else if (req) clear(); else setOn(false); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && segOf(sel) && want(segOf(sel))) { e.preventDefault(); toggle(segOf(sel).key); }
  });
}
