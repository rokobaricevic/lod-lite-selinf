// Element faces (viewer.html loads this only with ?faces): the dock tool "Plohe elementa". Click the bridge -> a box there
// (3 m; x = the camera's horizontal view direction, z = up), moved / rotated / resized with three's TransformControls
// (keys 1 2 3, or the panel's buttons). After each drag, POST /faces (selinf.py) splits the mesh surface inside the box into
// flat faces; each is drawn as a translucent quad with its coverage mask, and listed. Display only: nothing is saved.
// ?selinf=<url>: the server (as selinf.js). Node imports this module for decode() alone (test_faces.mjs): three.js is
// loaded only in the page.

// The answer: uint32 LE n, n bytes of JSON header (space-padded), then each face's mask in header order: w*h uint8 (1 =
// covered), row-major, row j along v, column i along u. An error answer (400 / 503) has the header {"error"} and no masks.
export function decode(buf) {
  const n = new DataView(buf).getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  let at = 4 + n;
  for (const f of head.faces ?? []) { f.mask = new Uint8Array(buf, at, f.w * f.h); at += f.w * f.h; } // views, no copy
  return head;
}
// a face's rectangle in the bake frame, lift metres off the surface along its normal: p00, p10 (u end), p01 (v end), p11
export function corners(f, lift = 0) {
  const a = f.w * f.cell, b = f.h * f.cell, p = new Float64Array(12);
  for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) p[3 * k + c] = f.origin[c] + (k & 1 ? a * f.u[c] : 0) + (k & 2 ? b * f.v[c] : 0) + lift * f.normal[c];
  return p;
}
export const facing = (f) => (f.normal[2] > 0.7 ? 'gore' : f.normal[2] < -0.7 ? 'dolje' : 'bočno');

if (globalThis.lod) viewer(await import('three'), await import('three/addons/controls/TransformControls.js'));

function viewer(THREE, { TransformControls }) {
  const lod = window.lod, ui = lod.ui, el = lod.el, API = new URLSearchParams(location.search).get('selinf') ?? ''; // as selinf.js
  const TOUCH = matchMedia('(pointer: coarse)').matches, hr = new Intl.NumberFormat('hr-HR');
  const n1 = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ploha = (n) => `${hr.format(n)} ${n % 10 > 1 && n % 10 < 5 && (n % 100 < 12 || n % 100 > 14) ? 'plohe' : 'ploha'}`;
  const HALF = 1.5, LIFT = 0.01, OPACITY = 0.55;
  const PLACE = `${TOUCH ? 'Dodirnite' : 'Kliknite'} element mosta da postavite kutiju.`;
  const KEYS = TOUCH ? 'Povucite ručice kutije za pomak, rotaciju ili veličinu.' : '1 pomak · 2 rotacija · 3 veličina · Esc uklanja kutiju';
  // on: the tool; gen: bumped when the box goes (an answer for an older box is dropped); busy / again: the one request in
  // flight, and a newer box waiting; grab: the pointer dragging the gizmo; down: the last press on the canvas
  let on = false, unhint = () => {}, gen = 0, busy = false, again = false, grab = null, down = null;

  // the bake frame (Z-up, metres), as selinf.js's root: the box and the faces live in its coordinates. Its rotation is
  // lod.src2w, the inverse of lod.w2src, which turns the click and the camera into it
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  const faces = new THREE.Group(), box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), // scale = the half sizes
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
  box.renderOrder = 999; box.visible = false;
  root.add(faces, box); lod.scene.add(root);
  const ctl = new TransformControls(lod.camera); // no element: the pointer handlers below drive it
  ctl.setSpace('local'); ctl.setSize(TOUCH ? 1.4 : 1);
  const gizmo = ctl.getHelper();
  lod.scene.add(gizmo); lod.overlays?.push(box, gizmo); // over damage.js's composite, like selinf.js's seed
  ctl.addEventListener('mouseUp', () => split()); // a drag ended

  // the panel: the mode buttons, then one row per face (hover: that face stands out), the total
  const css = document.createElement('style');
  css.textContent = `
#fc{position:fixed;z-index:9;top:calc(76px + env(safe-area-inset-top));left:calc(16px + env(safe-area-inset-left));width:240px;box-sizing:border-box;
 max-height:calc(100dvh - 108px - var(--h-dock) - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow:auto;overscroll-behavior:contain;padding:12px 16px;
 background:var(--ink1);border:1px solid var(--line);border-radius:var(--r-panel);box-shadow:var(--fp-shadow);color:var(--t);font-size:13px;-webkit-user-select:none;user-select:none}
#fc .md{display:flex;gap:4px;margin:10px 0 6px}
#fc .md button{flex:1;height:28px;margin:0;padding:0;border:0;border-radius:var(--r-sm);background:var(--ink2);color:var(--t);font:inherit;font-size:12px;cursor:pointer}
#fc .md button.on{background:var(--ac);color:var(--ac-text)}
#fc .md button:focus-visible{outline:2px solid var(--ac-fg);outline-offset:2px}
#fc .ms{margin-top:6px;color:var(--t-low)}#fc .ms:empty{display:none}
#fc .r{display:flex;align-items:center;gap:10px;height:28px}#fc .r i{flex:none;width:10px;height:10px;border-radius:var(--r-swatch)}
#fc .r .num{flex:1}#fc .r span:last-child{color:var(--t-low)}
#fc .tot{margin-top:6px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--t-low)}#fc .tot:empty{display:none}
@media (max-width:700px){#fc{top:calc(112px + env(safe-area-inset-top));right:calc(16px + env(safe-area-inset-right));width:auto;max-height:30dvh}}
@media (pointer:coarse){#fc .md button{height:36px}#fc .r{height:36px}}`;
  document.head.append(css);
  const h = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const panel = h('div'), md = h('div', 'md'), msg = h('div', 'ms'), rows = h('div'), tot = h('div', 'tot num');
  panel.id = 'fc'; panel.hidden = true;
  const MODES = [['translate', 'Pomak'], ['rotate', 'Rotacija'], ['scale', 'Veličina']];
  const mb = MODES.map(([m, label], k) => {
    const b = h('button', '', label);
    b.type = 'button'; b.title = `${label} (${k + 1})`; b.onclick = () => mode(m); md.append(b);
    return b;
  });
  panel.append(h('div', 'cap', 'Plohe elementa'), md, msg, rows, tot); document.body.append(panel);
  function mode(m) { ctl.setMode(m); mb.forEach((b, k) => { b.classList.toggle('on', MODES[k][0] === m); b.setAttribute('aria-pressed', MODES[k][0] === m); }); }
  mode('translate');

  // the dock tool: on, a click on the bridge drops the box (again: a new one there); off or Esc removes it
  const tool = ui.tool({ label: 'Plohe elementa', order: 25, onClick: () => setOn(!on),
    icon: '<path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z"/><path d="M3.5 6.25L10 10l6.5-3.75M10 10v7.5"/>' }); // a box
  function setOn(v) {
    on = v; tool.classList.toggle('on', v); tool.setAttribute('aria-pressed', v);
    remove(); unhint(); if (v) unhint = ui.hint(PLACE);
  }
  setOn(false);
  function remove() { gen++; ctl.detach(); box.visible = false; show(null); msg.textContent = ''; panel.hidden = true; }
  const fwd = new THREE.Vector3();
  function drop(point) { // the box at point (world), x along the camera's view direction made horizontal, z up
    const d = lod.w2src(lod.camera.getWorldDirection(fwd)), l = Math.hypot(d[0], d[1]), x = l > 1e-6 ? [d[0] / l, d[1] / l] : [1, 0];
    box.position.fromArray(lod.w2src(point)); box.scale.setScalar(HALF);
    box.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(x[0], x[1], 0), new THREE.Vector3(-x[1], x[0], 0), new THREE.Vector3(0, 0, 1)));
    box.visible = true; ctl.attach(box); panel.hidden = false;
    unhint = ui.hint(KEYS);
    split();
  }

  // the box as the server takes it, in the bake frame: centre, the axes as orthonormal rows, the half sizes
  const rot = new THREE.Matrix4(), ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  function boxJSON() {
    rot.makeRotationFromQuaternion(box.quaternion.normalize()).extractBasis(...ax);
    return { center: box.position.toArray(), axes: ax.map((a) => a.toArray()), half: box.scale.toArray().map(Math.abs) }; // a drag may flip a scale
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

  // a face: a quad with its mask as the alpha. MeshBasicMaterial's alphaMap reads G, so the mask goes into an RG texture's G
  // (three r186 has no luminance format). Transparent, depth-tested, no depth write: drawn in the scene pass (damage.js's
  // MSAA target), after the bridge, which hides it where it is in front
  function show(res) {
    for (const m of faces.children) { m.geometry.dispose(); m.material.alphaMap.dispose(); m.material.dispose(); }
    faces.clear(); rows.replaceChildren(); tot.textContent = '';
    if (!res) return;
    let area = 0;
    res.faces.forEach((f, k) => {
      const c = corners(f, LIFT), p = new Float32Array(12), a = new Uint8Array(2 * f.w * f.h);
      for (let i = 0; i < 12; i++) p[i] = c[i] - c[i % 3]; // relative to p00 (the mesh's position): float32 keeps mm
      for (let i = 0; i < f.mask.length; i++) a[2 * i + 1] = f.mask[i] * 255;
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(p, 3))
        .setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2)).setIndex([0, 1, 2, 2, 1, 3]);
      const t = new THREE.DataTexture(a, f.w, f.h, THREE.RGFormat); // row j at v = j: the mask's own layout (flipY off)
      t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
      const color = new THREE.Color().setHSL((0.6 + k * 0.618034) % 1, 0.75, 0.55, THREE.SRGBColorSpace); // golden-angle hues
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, alphaMap: t, transparent: true, opacity: OPACITY, depthWrite: false, side: THREE.DoubleSide }));
      m.position.set(c[0], c[1], c[2]);
      faces.add(m);
      const r = h('div', 'r'), sw = h('i');
      sw.style.background = '#' + color.getHexString();
      r.append(sw, h('span', 'num', `${n1.format(f.area)} m²`), h('span', '', facing(f)));
      r.onpointerenter = () => hilite(m); r.onpointerleave = () => hilite(null);
      rows.append(r); area += f.area;
    });
    msg.textContent = res.faces.length ? '' : 'U kutiji nema ploha.';
    if (res.faces.length) tot.textContent = `${ploha(res.faces.length)}, ${n1.format(area)} m² · ${hr.format(Math.round(res.ms))} ms`;
  }
  function hilite(m) { for (const x of faces.children) x.material.opacity = !m ? OPACITY : x === m ? 0.9 : 0.15; }

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
