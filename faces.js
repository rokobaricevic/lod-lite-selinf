// Element faces (viewer.html loads this only with ?faces): the dock tool "Plohe elementa". Click the bridge -> a box there
// (3 m; x = the camera's horizontal view direction, z = up), moved / rotated / resized with three's TransformControls
// (keys 1 2 3, or the panel's buttons). After each drag, POST /faces (selinf.py) splits the mesh surface inside the box into
// flat faces. The panel shows them alone in a 3D view of its own (flat grey, lit from above) and lists them, numbered; the
// hovered or selected face is drawn in its colour there, in the list and over the bridge. Display only: nothing is saved.
// ?selinf=<url>: the server (as selinf.js); ?fcell= ?fgap= ?fmin= ?fangle=: the split's cell_m, gap_m, min_area_m2,
// angle_deg. Node imports this module for its pure functions alone (test_faces.mjs): three.js is loaded only in the page.

// The answer: uint32 LE n, n bytes of JSON header (space-padded), then each face's mask in header order: w*h uint8 (1 =
// covered), row-major, row j along v, column i along u. An error answer (400 / 503) has the header {"error"} and no masks.
export function decode(buf) {
  const n = new DataView(buf).getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  let at = 4 + n;
  for (const f of head.faces ?? []) { f.mask = new Uint8Array(buf, at, f.w * f.h); at += f.w * f.h; } // views, no copy
  return head;
}
// a face's rectangle in the bake frame: p00, p10 (u end), p01 (v end), p11
export function corners(f) {
  const a = f.w * f.cell, b = f.h * f.cell, p = new Float64Array(12);
  for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) p[3 * k + c] = f.origin[c] + (k & 1 ? a * f.u[c] : 0) + (k & 2 ? b * f.v[c] : 0);
  return p;
}
export const facing = (f) => (f.normal[2] > 0.7 ? 'gore' : f.normal[2] < -0.7 ? 'dolje' : 'bočno');

// a face's mask as geometry relative to o (float32 then keeps millimetres): positions, the covered cells as triangles (one
// quad per run of covered cells in a row, grown down while the next rows repeat the run); edges, the mask's boundary as
// segments (cell sides with a covered cell on one side only, collinear runs merged); at, a label's place: the covered cell
// nearest the covered cells' centroid (the centroid itself may be off the face, e.g. an L's)
export function maskGeometry(f, o) {
  const { w, h, mask: m, cell, u, v } = f, b = [0, 1, 2].map((c) => f.origin[c] - o[c]), P = [], E = [], at = [];
  const put = (A, i, j) => A.push(b[0] + (i * u[0] + j * v[0]) * cell, b[1] + (i * u[1] + j * v[1]) * cell, b[2] + (i * u[2] + j * v[2]) * cell);
  const on = (i, j) => i >= 0 && j >= 0 && i < w && j < h && m[j * w + i] > 0;
  let open = new Map(), n = 0, ci = 0, cj = 0; // open: the runs of the row above, i0 * 2^16 + i1 -> the row the quad started on
  for (let j = 0; j <= h; j++) {
    const next = new Map();
    for (let i = 0; j < h && i < w; i++) if (m[j * w + i]) {
      const i0 = i;
      while (i < w && m[j * w + i]) { n++; ci += i; cj += j; i++; }
      next.set(i0 * 65536 + i, open.get(i0 * 65536 + i) ?? j);
    }
    for (const [k, j0] of open) if (!next.has(k)) { // the run ends above row j: its quad, counter-clockwise about the normal
      const i0 = k >>> 16, i1 = k & 65535;
      for (const [i, jj] of [[i0, j0], [i1, j0], [i1, j], [i0, j0], [i1, j], [i0, j]]) put(P, i, jj);
    }
    open = next;
  }
  for (let j = 0; j <= h; j++) for (let i = 0; i < w; i++) if (on(i, j - 1) !== on(i, j)) { // along u, on the line v = j
    const i0 = i;
    while (i < w && on(i, j - 1) !== on(i, j)) i++;
    put(E, i0, j); put(E, i, j);
  }
  for (let i = 0; i <= w; i++) for (let j = 0; j < h; j++) if (on(i - 1, j) !== on(i, j)) { // along v, on the line u = i
    const j0 = j;
    while (j < h && on(i - 1, j) !== on(i, j)) j++;
    put(E, i, j0); put(E, i, j);
  }
  let best = Infinity, bi = 0, bj = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (m[j * w + i]) {
    const d = (i - ci / n) ** 2 + (j - cj / n) ** 2;
    if (d < best) { best = d; bi = i; bj = j; }
  }
  if (n) put(at, bi + 0.5, bj + 0.5);
  return { positions: new Float32Array(P), edges: new Float32Array(E), at };
}

if (globalThis.lod) viewer(await import('three'), await import('three/addons/controls/TransformControls.js'));

function viewer(THREE, { TransformControls }) {
  const lod = window.lod, ui = lod.ui, el = lod.el, Q = new URLSearchParams(location.search), API = Q.get('selinf') ?? ''; // as selinf.js
  // the split's tuning, sent with each box: the PC's bake mesh is coarse (triangles up to ~30 cm), and finer cells and gaps
  // cut its faces into scraps
  const OPTS = { cell_m: +Q.get('fcell') || 0.1, gap_m: +Q.get('fgap') || 0.15, min_area_m2: +Q.get('fmin') || 0.25, angle_deg: +Q.get('fangle') || 20 };
  const TOUCH = matchMedia('(pointer: coarse)').matches, hr = new Intl.NumberFormat('hr-HR');
  const n1 = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ploha = (n) => `${hr.format(n)} ${n % 10 > 1 && n % 10 < 5 && (n % 100 < 12 || n % 100 > 14) ? 'plohe' : 'ploha'}`;
  const HALF = 1.5, LABELS = 50, INK0 = 0x0c0c0d, ISO = [1.25 * Math.PI, 0.6155]; // ISO: the eye toward box -x -y, 35 deg up
  const PLACE = `${TOUCH ? 'Dodirnite' : 'Kliknite'} element mosta da postavite kutiju.`;
  const KEYS = TOUCH ? 'Povucite ručice kutije za pomak, rotaciju ili veličinu.' : '1 pomak · 2 rotacija · 3 veličina · Esc uklanja kutiju';
  // on: the tool; gen: bumped when the box goes (an answer for an older box is dropped); busy / again: the one request in
  // flight, and a newer box waiting; grab: the pointer dragging the gizmo; down: the last press on the canvas
  let on = false, unhint = () => {}, gen = 0, busy = false, again = false, grab = null, down = null;

  // the bake frame (Z-up, metres), as selinf.js's root: the box and the picked face live in its coordinates. Its rotation
  // is lod.src2w, the inverse of lod.w2src, which turns the click and the camera into it
  const root = new THREE.Group(), rot = new THREE.Matrix4(), ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  root.rotation.x = -Math.PI / 2;
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), // scale = the half sizes
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
  box.renderOrder = 999; box.visible = false;
  // the picked face over the bridge: the same mask geometry, on top (the bake mesh it comes from is coarser than the
  // tiles, so depth-tested it would show speckled). Its geometries share the side view's attributes, drawRange = the face
  const hi = new THREE.Group(), hiMesh = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  const hiLines = new THREE.LineSegments(undefined, new THREE.LineBasicMaterial({ transparent: true, depthTest: false })); // transparent: drawn after the mesh
  hiMesh.renderOrder = 998; hiLines.renderOrder = 999; hi.visible = false; hi.add(hiMesh, hiLines);
  root.add(box, hi); lod.scene.add(root);
  const ctl = new TransformControls(lod.camera); // no element: the pointer handlers below drive it
  ctl.setSpace('local'); ctl.setSize(TOUCH ? 1.4 : 1);
  const gizmo = ctl.getHelper();
  lod.scene.add(gizmo); lod.overlays?.push(box, hi, gizmo); // over damage.js's composite, like selinf.js's seed
  ctl.addEventListener('mouseUp', () => split()); // a drag ended

  // the panel (left: damage.js's inspector is on the right, and a tap can open it while this tool is on): the mode buttons,
  // the 3D view and its view buttons, one row per face, the total. Phones: a bottom sheet, no caption (room for the view)
  const css = document.createElement('style');
  css.textContent = `
#fc{position:fixed;z-index:9;top:calc(76px + env(safe-area-inset-top));left:calc(16px + env(safe-area-inset-left));width:var(--w-insp);box-sizing:border-box;
 max-height:calc(100dvh - 108px - var(--h-dock) - env(safe-area-inset-top) - env(safe-area-inset-bottom));display:flex;flex-direction:column;padding:12px 16px;
 background:var(--ink1);border:1px solid var(--line);border-radius:var(--r-panel);box-shadow:var(--fp-shadow);color:var(--t);font-size:13px;-webkit-user-select:none;user-select:none}
#fc .md,#fc .pv{flex:none;display:flex;gap:4px;margin:10px 0 8px}#fc .pv{gap:2px;margin:4px 0}
#fc button{flex:1;height:28px;margin:0;padding:0;border:0;border-radius:var(--r-sm);background:var(--ink2);color:var(--t);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
#fc .md button.on{background:var(--ac);color:var(--ac-text)}#fc .pv button{flex:auto;padding:0 6px;background:none;color:var(--t-mid)}
#fc button:focus-visible{outline:2px solid var(--ac-fg);outline-offset:2px}
#fc .vw{position:relative;flex:none;height:280px;border-radius:var(--r-sm);overflow:hidden;background:var(--ink0)}
#fc .lbs,#fc .gz{position:absolute;pointer-events:none}#fc .lbs{inset:0}
#fc .lb{position:absolute;left:0;top:0;font-size:11px;font-weight:600;color:var(--t-hi);text-shadow:0 0 3px #000,0 0 2px #000}
#fc .gz{left:6px;bottom:6px;width:56px;height:56px;font:10px var(--font-mono)}#fc .gz circle{fill:var(--ink1);stroke:var(--line)}
#fc .gz line{stroke:var(--t-low);stroke-width:1.4}#fc .gz text{fill:var(--t-mid);text-anchor:middle;dominant-baseline:central}
#fc .ms{flex:none;margin-top:6px;color:var(--t-low)}#fc .ms:empty{display:none}
#fc .ls{flex:1 1 auto;min-height:0;margin-top:6px;overflow:auto;overscroll-behavior:contain}
#fc .r{display:flex;align-items:center;gap:10px;height:28px;padding:0 6px;border-radius:var(--r-sm);cursor:pointer}#fc .r.hv{background:var(--ink2)}#fc .r.on{background:var(--ac-dim)}
#fc .r b{width:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--t-low)}#fc .r i{flex:none;width:10px;height:10px;border-radius:var(--r-swatch)}
#fc .r .num{flex:1}#fc .r span:last-child{color:var(--t-low)}
#fc .tot{flex:none;margin-top:6px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--t-low)}#fc .tot:empty{display:none}
@media (hover:hover){#fc .pv button:hover{background:var(--ink2);color:var(--t)}}
@media (max-width:700px){#fc{top:auto;right:calc(16px + env(safe-area-inset-right));bottom:calc(28px + var(--h-dock) + env(safe-area-inset-bottom));width:auto;
 height:45dvh;max-height:none}#fc .cap{display:none}#fc .md{margin-top:0}#fc .vw{flex:3 1 0;height:auto;min-height:0}#fc .ls{flex:2 1 0}}
@media (pointer:coarse){#fc button{height:36px}#fc .r{height:36px}}`;
  document.head.append(css);
  const h = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const btn = (label, onclick, title = label) => Object.assign(h('button', '', label), { type: 'button', title, onclick });
  const panel = h('div'), md = h('div', 'md'), vw = h('div', 'vw'), lab = h('div', 'lbs'), pv = h('div', 'pv'), msg = h('div', 'ms'), rows = h('div', 'ls'), tot = h('div', 'tot num');
  panel.id = 'fc'; panel.hidden = true;
  const MODES = [['translate', 'Pomak'], ['rotate', 'Rotacija'], ['scale', 'Veličina']];
  const mb = MODES.map(([m, label], k) => md.appendChild(btn(label, () => mode(m), `${label} (${k + 1})`)));
  function mode(m) { ctl.setMode(m); mb.forEach((b, k) => { b.classList.toggle('on', MODES[k][0] === m); b.setAttribute('aria-pressed', MODES[k][0] === m); }); }
  mode('translate');

  // ---------- the side view: the faces alone, flat grey, the picked ones in their colour. Its own renderer, drawn on
  // demand (an answer, an orbit, a resize, a pick), never in a loop; an orthographic camera orbiting with Z up
  const R = new THREE.WebGLRenderer({ antialias: true });
  R.setPixelRatio(Math.min(devicePixelRatio, 2)); R.setClearColor(INK0);
  const sc = new THREE.Scene(), cam = new THREE.OrthographicCamera(), cv = R.domElement;
  const solid = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  const lines = new THREE.LineSegments(undefined, new THREE.LineBasicMaterial({ color: INK0 })); // the polygon offset keeps them in front
  sc.add(solid, lines);
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
  for (const [label, a, e] of [['Izo', ...ISO], ['Odozgo', Math.PI, Math.PI / 2], ['Sprijeda', Math.PI / 2, 0], ['Bok', Math.PI, 0]])
    pv.append(btn(label, () => fit(heading() + a, e))); // Sprijeda looks along the box's -y, Bok along its x
  pv.append(btn('Prikaži sve', () => fit(), 'Prikaži sve (dvoklik)'));
  panel.append(h('div', 'cap', 'Plohe elementa'), md, vw, pv, msg, rows, tot); document.body.append(panel);

  // the answer on the GPU: every face's triangles in one buffer (tv[k]..tv[k+1] its vertices), its edges in another (ev);
  // relative to O, the faces' centre (bake frame). V: the view, eye at az / el about the target t, span metres tall;
  // touched: orbited since the box was dropped (then an answer keeps the view, else it fits)
  let O = [0, 0, 0], tv = [0], ev = [0], EP = new Float32Array(0), AT = [], grey = [], hue = [], colA = null, rad = 1, hov = -1, sel = -1;
  const V = { az: 0, el: ISO[1], t: new THREE.Vector3(), span: 10 };
  let touched = false, pend = 0, moved = false;
  function show(res) {
    for (const m of [solid, lines, idm, hiMesh, hiLines]) m.geometry.dispose();
    rows.replaceChildren(); lab.replaceChildren(); tot.textContent = ''; hov = sel = -1; hi.visible = false;
    const fs = res?.faces ?? [], lo = [Infinity, Infinity, Infinity], up = [-Infinity, -Infinity, -Infinity];
    for (const f of fs) corners(f).forEach((x, i) => { lo[i % 3] = Math.min(lo[i % 3], x); up[i % 3] = Math.max(up[i % 3], x); });
    if (fs.length) {
      const o = lo.map((x, c) => (x + up[c]) / 2);
      V.t.x += O[0] - o[0]; V.t.y += O[1] - o[1]; V.t.z += O[2] - o[2]; O = o; // the view stays put in the bake frame
    }
    hi.position.fromArray(O);
    const G = fs.map((f) => maskGeometry(f, O));
    tv = [0]; ev = [0];
    for (const g of G) { tv.push(tv.at(-1) + g.positions.length / 3); ev.push(ev.at(-1) + g.edges.length / 3); }
    const pos = new Float32Array(3 * tv.at(-1)), col = new Float32Array(pos.length), idc = new Uint8Array(pos.length);
    EP = new Float32Array(3 * ev.at(-1)); AT = G.map((g) => g.at);
    // lambert, the light from above and toward the Izo eye (box -x -y): the three sides Izo shows get three shades
    const b = heading(), L = new THREE.Vector3(-0.35 * Math.cos(b) + 0.55 * Math.sin(b), -0.35 * Math.sin(b) - 0.55 * Math.cos(b), 0.76).normalize();
    grey = fs.map((f) => { const k = 0.25 + 0.75 * Math.max(0, L.dot(new THREE.Vector3(...f.normal))); return new THREE.Color().setRGB((38 + 66 * k) / 255, (44 + 72 * k) / 255, (51 + 77 * k) / 255, THREE.SRGBColorSpace); });
    hue = fs.map((f, k) => new THREE.Color().setHSL((0.6 + k * 0.618034) % 1, 0.75, 0.55, THREE.SRGBColorSpace)); // golden-angle hues
    let area = 0;
    G.forEach((g, k) => {
      pos.set(g.positions, 3 * tv[k]); EP.set(g.edges, 3 * ev[k]);
      for (let i = 3 * tv[k]; i < 3 * tv[k + 1]; i += 3) { col[i] = grey[k].r; col[i + 1] = grey[k].g; col[i + 2] = grey[k].b; idc[i] = (k + 1) & 255; idc[i + 1] = (k + 1) >> 8; idc[i + 2] = (k + 1) >> 16; }
      const f = fs[k], r = h('div', 'r'), sw = h('i');
      sw.style.background = '#' + hue[k].getHexString();
      r.append(h('b', '', k + 1), sw, h('span', 'num', `${n1.format(f.area)} m²`), h('span', '', facing(f)));
      r.onpointerenter = () => mark(k); r.onpointerleave = () => mark(-1); r.onclick = () => mark(sel === k ? -1 : k, true);
      rows.append(r); area += f.area;
      if (k < LABELS) lab.append(h('span', 'lb', k + 1));
    });
    const P = new THREE.BufferAttribute(pos, 3), E = new THREE.BufferAttribute(EP, 3);
    colA = new THREE.BufferAttribute(col, 3);
    solid.geometry = new THREE.BufferGeometry().setAttribute('position', P).setAttribute('color', colA);
    idm.geometry = new THREE.BufferGeometry().setAttribute('position', P).setAttribute('color', new THREE.BufferAttribute(idc, 3, true));
    lines.geometry = new THREE.BufferGeometry().setAttribute('position', E);
    hiMesh.geometry = new THREE.BufferGeometry().setAttribute('position', P);
    hiLines.geometry = new THREE.BufferGeometry().setAttribute('position', E);
    rad = 1;
    for (let i = 0; i < EP.length; i += 3) rad = Math.max(rad, Math.hypot(EP[i], EP[i + 1], EP[i + 2]));
    if (fs.length && !touched) fit(); else aim();
    if (res) msg.textContent = fs.length ? '' : 'U kutiji nema ploha.';
    if (fs.length) tot.textContent = `${ploha(fs.length)}, ${n1.format(area)} m² · ${hr.format(Math.round(res.ms))} ms`;
  }
  // the face picked out (hov: under the pointer, sel: clicked, sticky; -1: none): its colour in the 3D view, its row, and
  // over the bridge (hov first)
  function tint(k, c) {
    const a = colA.array;
    for (let i = 3 * tv[k]; i < 3 * tv[k + 1]; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    colA.addUpdateRange(3 * tv[k], 3 * (tv[k + 1] - tv[k])); colA.needsUpdate = true;
  }
  function mark(k, sticky = false) {
    for (const j of [hov, sel]) if (j >= 0) { tint(j, grey[j]); rows.children[j].classList.remove('hv', 'on'); }
    if (sticky) sel = k; else hov = k;
    for (const j of [sel, hov]) if (j >= 0) tint(j, hue[j]);
    rows.children[sel]?.classList.add('on'); rows.children[hov]?.classList.add('hv');
    const s = hov >= 0 ? hov : sel;
    hi.visible = s >= 0;
    if (s >= 0) {
      hiMesh.geometry.setDrawRange(tv[s], tv[s + 1] - tv[s]); hiLines.geometry.setDrawRange(ev[s], ev[s + 1] - ev[s]);
      hiMesh.material.color.copy(hue[s]); hiLines.material.color.copy(hue[s]);
    }
    draw();
  }

  // the camera: the eye along ve (az about Z, el above the horizon), screen right vr, screen up vu = ve x vr
  const ve = new THREE.Vector3(), vr = new THREE.Vector3(), vu = new THREE.Vector3(), M = new THREE.Matrix4(), p = new THREE.Vector3();
  function basis() { ve.set(Math.cos(V.el) * Math.cos(V.az), Math.cos(V.el) * Math.sin(V.az), Math.sin(V.el)); vr.set(-Math.sin(V.az), Math.cos(V.az), 0); vu.crossVectors(ve, vr); }
  function aim() {
    basis();
    const D = rad + V.t.length() + 1; // outside everything
    cam.position.copy(V.t).addScaledVector(ve, D); cam.quaternion.setFromRotationMatrix(M.makeBasis(vr, vu, ve));
    cam.top = V.span / 2; cam.bottom = -cam.top; cam.right = (cam.top * vw.clientWidth) / (vw.clientHeight || 1); cam.left = -cam.right;
    cam.near = 0; cam.far = 2 * D; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
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
    if (x0 <= x1) { V.t.copy(vr).multiplyScalar((x0 + x1) / 2).addScaledVector(vu, (y0 + y1) / 2); V.span = 1.15 * Math.max(y1 - y0, ((x1 - x0) * vw.clientHeight) / (vw.clientWidth || 1), 0.1); }
    aim();
  }
  function zoomAt(x, y, s) { // about the point under (x, y) (client px), which stays put
    const b = cv.getBoundingClientRect(), nx = ((x - b.left) / b.width) * 2 - 1, ny = 1 - ((y - b.top) / b.height) * 2;
    s = Math.min(Math.max(V.span * s, 0.05), 5000) / V.span;
    V.t.addScaledVector(vr, nx * cam.right * (1 - s)).addScaledVector(vu, ny * cam.top * (1 - s)); V.span *= s;
  }
  function panBy(dx, dy) { const k = V.span / (vw.clientHeight || 1); V.t.addScaledVector(vr, -dx * k).addScaledVector(vu, dy * k); }
  function heading() { rot.makeRotationFromQuaternion(box.quaternion).extractBasis(...ax); return Math.atan2(ax[0].y, ax[0].x); } // the box's x, about Z

  const draw = () => { pend ||= requestAnimationFrame(render); };
  function render() {
    pend = 0;
    const w = vw.clientWidth, H = vw.clientHeight;
    if (!w || !H) return;
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
    return k < hue.length ? k : -1;
  }
  const faceAt = (e) => idAt(Math.floor(e.offsetX), Math.floor(e.offsetY));
  new ResizeObserver(() => { if (vw.clientWidth && vw.clientHeight) { R.setSize(vw.clientWidth, vw.clientHeight, false); aim(); } }).observe(vw);

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
    if (!q) { const k = e.pointerType === 'mouse' ? faceAt(e) : hov; if (k !== hov) mark(k); return; }
    if (tap && Math.hypot(e.clientX - tap[0], e.clientY - tap[1]) < tap[2]) return; // still a tap
    tap = null; touched = true;
    const dx = e.clientX - q[0], dy = e.clientY - q[1], o = [...pts.values()].find((x) => x !== q);
    if (o) { zoomAt((e.clientX + o[0]) / 2, (e.clientY + o[1]) / 2, Math.hypot(q[0] - o[0], q[1] - o[1]) / Math.max(1, Math.hypot(e.clientX - o[0], e.clientY - o[1]))); panBy(dx / 2, dy / 2); }
    else if (pan) panBy(dx, dy);
    else { V.az -= dx * 0.008; V.el = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, V.el + dy * 0.008)); }
    q[0] = e.clientX; q[1] = e.clientY; aim();
  });
  for (const t of ['pointerup', 'pointercancel']) cv.addEventListener(t, (e) => {
    if (tap && t === 'pointerup') { mark(faceAt(e), true); rows.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    pts.delete(e.pointerId); tap = null;
  });
  cv.addEventListener('pointerleave', () => { if (hov >= 0) mark(-1); });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015)); touched = true; aim(); }, { passive: false });
  cv.addEventListener('dblclick', () => fit());
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  // the dock tool: on, a click on the bridge drops the box (again: a new one there); off or Esc removes it
  const tool = ui.tool({ label: 'Plohe elementa', order: 25, onClick: () => setOn(!on),
    icon: '<path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z"/><path d="M3.5 6.25L10 10l6.5-3.75M10 10v7.5"/>' }); // a box
  function setOn(v) {
    on = v; tool.classList.toggle('on', v); tool.setAttribute('aria-pressed', v);
    remove(); unhint(); if (v) unhint = ui.hint(PLACE);
  }
  function remove() { gen++; ctl.detach(); box.visible = false; show(null); msg.textContent = ''; panel.hidden = true; }
  const fwd = new THREE.Vector3();
  function drop(point) { // the box at point (world), x along the camera's view direction made horizontal, z up
    const d = lod.w2src(lod.camera.getWorldDirection(fwd)), l = Math.hypot(d[0], d[1]), x = l > 1e-6 ? [d[0] / l, d[1] / l] : [1, 0];
    box.position.fromArray(lod.w2src(point)); box.scale.setScalar(HALF);
    box.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(x[0], x[1], 0), new THREE.Vector3(-x[1], x[0], 0), new THREE.Vector3(0, 0, 1)));
    box.visible = true; ctl.attach(box); panel.hidden = false;
    touched = false; V.az = heading() + ISO[0]; V.el = ISO[1]; // a new box: Izo, fitted to each answer until orbited
    unhint = ui.hint(KEYS);
    split();
  }
  setOn(false);

  // the box as the server takes it, in the bake frame: centre, the axes as orthonormal rows, the half sizes
  function boxJSON() {
    rot.makeRotationFromQuaternion(box.quaternion.normalize()).extractBasis(...ax);
    return { center: box.position.toArray(), axes: ax.map((a) => a.toArray()), half: box.scale.toArray().map(Math.abs), ...OPTS }; // a drag may flip a scale
  }
  // one request at a time: boxes that change meanwhile are sent once it returns, only the latest
  async function split() {
    if (busy) { again = true; return; }
    busy = true;
    do {
      again = false;
      const g = gen;
      msg.textContent = 'Računanje…';
      try { // text/plain body (a string): no CORS preflight
        const r = await fetch(API + '/faces', { method: 'POST', body: JSON.stringify(boxJSON()) }).catch(() => { throw new Error('server ne odgovara'); });
        let res = null;
        try { res = decode(await r.arrayBuffer()); } catch {} // not our answer (a proxy's page, an empty 401): the status says it
        if (!r.ok || !res || res.error) throw new Error(res?.error || (r.ok ? 'neispravan odgovor' : `HTTP ${r.status}`));
        if (g === gen) show(res);
      } catch (e) {
        if (g === gen) { show(null); msg.textContent = 'Plohe nisu izračunate.'; unhint = ui.hint(`Plohe nisu izračunate: ${e.message}`, 8000); }
      }
    } while (again && ctl.object);
    busy = false;
  }

  // pointers (capture, on window: before the viewer's and damage.js's own handlers). A press on the gizmo is the gizmo's
  // alone: the viewer never sees it, so the camera doesn't orbit while it drags. A tap elsewhere drops the box.
  const ptr = (e) => { const p = lod.ndcOf(e); return { x: p.x, y: p.y, button: e.button }; };
  addEventListener('pointerdown', (e) => {
    if (e.target !== el) return;
    if (grab !== null) { e.stopPropagation(); return; } // another finger while the gizmo drags: nobody's
    down = { x: e.clientX, y: e.clientY, slop: e.pointerType === 'touch' ? 10 : 4, skip: e.altKey || e.button !== 0 || lod.inferArmed }; // alt / armed: selinf's
    if (!ctl.object) return;
    const p = ptr(e);
    ctl.pointerHover(p); ctl.pointerDown(p);
    if (!ctl.dragging) return; // not on the gizmo: orbit, pan, taps as always
    grab = e.pointerId; down.skip = true; el.setPointerCapture(e.pointerId); e.stopPropagation();
  }, true);
  addEventListener('pointermove', (e) => {
    if (e.pointerId === grab) ctl.pointerMove(ptr(e));
    else if (ctl.object && e.pointerType !== 'touch' && e.target === el) ctl.pointerHover(ptr(e)); // the handle under the cursor lights up
  }, true);
  for (const t of ['pointerup', 'pointercancel']) addEventListener(t, (e) => { if (e.pointerId === grab) { grab = null; ctl.pointerUp(null); } }, true);
  el.addEventListener('click', (e) => {
    if (!on || !down || down.skip || Math.hypot(e.clientX - down.x, e.clientY - down.y) > down.slop) return;
    const hit = lod.pick(lod.ndcOf(e));
    if (hit) drop(hit.point);
  });
  addEventListener('keydown', (e) => {
    if (!on || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { if (ctl.object) { remove(); unhint = ui.hint(PLACE); } else setOn(false); }
    else if (ctl.object && MODES[e.key - 1]) mode(MODES[e.key - 1][0]);
  });
}
