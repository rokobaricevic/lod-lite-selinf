// Damage overlay: the damage point clouds of damage.py (out/damage/) drawn on the bridge, per-class toggles and opacity;
// tap a damage -> side panel with its measure and photo crops; tap a crop -> a basic photo viewer.
// ?damage=<dir> overrides the data dir (default out/damage/, relative to this page).
import * as THREE from 'three';

const lod = window.lod;
let BASE = new URLSearchParams(location.search).get('damage') ?? 'out/damage/';
if (!BASE.endsWith('/')) BASE += '/';
const jsonP = fetch(BASE + 'damage.json', { cache: 'no-cache' }), binP = fetch(BASE + 'damage.bin', { cache: 'no-cache' });
binP.catch(() => {}); // awaited only when the JSON is there

const css = document.createElement('style');
css.textContent = `
.dm-hud{margin-top:6px;border-top:1px solid #444;padding-top:4px}
.dm-hud label{display:flex!important;align-items:center;gap:5px}
.dm-sw{display:inline-block;width:10px;height:10px;border-radius:2px;flex:none}
.dm-panel{position:fixed;top:6px;right:6px;width:300px;max-height:calc(100% - 12px);box-sizing:border-box;overflow-y:auto;
 overscroll-behavior:contain;z-index:10;font:12px/1.4 ui-monospace,Menlo,monospace;color:#d8d8d8;background:rgba(0,0,0,.75);
 padding:4px 10px 10px;border-radius:3px}
.dm-head{display:flex;align-items:center;gap:6px;font-weight:bold}
.dm-x{margin:0 -8px 0 auto;min-width:36px;min-height:36px;background:none;border:0;color:inherit;font:22px/1 sans-serif;cursor:pointer}
.dm-m{font-size:1.6em;margin:2px 0}
.dm-n{color:#999}
.dm-ph{position:relative;margin-top:8px;cursor:zoom-in}
.dm-ph img{display:block;width:100%}
.dm-bx{position:absolute;border:2px solid;box-shadow:0 0 0 1px rgba(0,0,0,.7);box-sizing:border-box;pointer-events:none}
.dm-cap{color:#aaa;word-break:break-all;margin-top:2px}
.dm-vc{white-space:pre-wrap;text-align:center;padding:0 8px}
.dm-view{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.92);display:flex;flex-direction:column;align-items:center;
 justify-content:center;gap:6px;touch-action:none;user-select:none;font:13px ui-monospace,Menlo,monospace;color:#ddd}
.dm-view .dm-ph{margin:0;cursor:default}
.dm-view img{width:auto;max-width:96vw;max-height:86vh}
.dm-view button{position:absolute;min-width:44px;min-height:44px;background:rgba(0,0,0,.45);border:0;border-radius:4px;color:#fff;
 font:30px/1 sans-serif;cursor:pointer}
.dm-view .x{top:calc(4px + env(safe-area-inset-top));right:calc(4px + env(safe-area-inset-right))}
.dm-view .prev{left:calc(4px + env(safe-area-inset-left));top:50%;transform:translateY(-50%)}
.dm-view .next{right:calc(4px + env(safe-area-inset-right));top:50%;transform:translateY(-50%)}
@media (max-width:700px){.dm-panel{top:auto;left:0;right:0;bottom:0;width:auto;max-height:45vh;border-radius:8px 8px 0 0;font-size:13px;
 padding:4px calc(12px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left))}}
@media (pointer:coarse){.dm-hud label,.dm-hud .row{min-height:32px}}`;
document.head.append(css);

const h = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
const swatch = (color) => { const s = h('span', 'dm-sw'); s.style.background = color; return s; };
const unit = (c) => (c.measure === 'length' ? 'm' : 'm²');

const hud = h('div', 'dm-hud'), status = h('pre', '', 'damage: loading...');
hud.append(status);
lod.ctl.append(hud);

// the GPU dequantises: q maps the unit cube (normalized uint16) onto the data box, inside the Z-up source frame
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
const q = new THREE.Group();
root.add(q); lod.scene.add(root);

// Points size in world units (P[1][1] = 1/tan(fov/2), mvPosition includes q's scale) so cracks look solid up close, with a
// floor in device px so far ones don't vanish. The depth pull (1 % of view depth) keeps coarser LOD tiles from hiding them.
function patch(s) {
  s.vertexShader = s.vertexShader
    .replace('gl_PointSize *= ( scale / - mvPosition.z );', 'gl_PointSize = max( MIN_PX, size * projectionMatrix[ 1 ][ 1 ] * scale / - mvPosition.z );')
    .replace('#include <logdepthbuf_vertex>', '#include <logdepthbuf_vertex>\n#ifdef USE_LOGARITHMIC_DEPTH_BUFFER\n' +
      'vFragDepth = 1.0 + gl_Position.w * 0.99;\n#endif');
}
function mat(color, size, minPx, opts) {
  const m = new THREE.PointsMaterial({ color, size, ...opts });
  m.defines = { MIN_PX: minPx.toFixed(1) }; // part of the program key: one program per floor, same patch
  m.onBeforeCompile = patch;
  return m;
}
const selMat = mat(0xffffff, 0.02, 4, { depthTest: false, transparent: true }); // transparent: drawn after (over) the class points

let J = null, Q = null, B, S, K, on = [], pts = [], opacity = 0.8, sel = -1, selPts = null;
const unitBox = (b) => new THREE.Box3().setFromArray(b.map((v, i) => (v - B[i % 3]) / S[i % 3]));

async function load() {
  const r = await jsonP;
  if (r.status === 404) return void (status.textContent = 'damage: no data (run damage.py)');
  if (!r.ok) throw new Error(`damage.json: HTTP ${r.status}`);
  J = await r.json();
  B = J.box.slice(0, 3); S = B.map((v, i) => Math.max(J.box[i + 3] - v, 1e-6)); K = S.map((s) => s / 65535);
  on = J.classes.map(() => true);
  const row = h('div', 'row'), t = h('span'), sl = h('input');
  Object.assign(sl, { type: 'range', min: 0, max: 100, value: 80 });
  sl.oninput = () => {
    opacity = sl.value / 100; t.textContent = `opacity ${sl.value} %`;
    for (const p of pts) if (p) p.material.opacity = opacity;
  };
  sl.oninput(); row.append(t, sl); hud.append(row);
  J.classes.forEach((c, ci) => {
    const l = h('label'), cb = h('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.onchange = () => {
      on[ci] = cb.checked;
      if (pts[ci]) pts[ci].visible = cb.checked;
      if (!cb.checked && sel >= 0 && J.items[sel].c === ci) select(-1);
    };
    l.append(cb, swatch(c.color), `${c.name} ${c.items} · ${+(c.total ?? 0).toPrecision(4)} ${unit(c)}`);
    hud.append(l);
  });
  status.textContent = `damage: loading ${J.points.toLocaleString()} points...`;
  const br = await binP;
  if (!br.ok) throw new Error(`damage.bin: HTTP ${br.status}`);
  const buf = await br.arrayBuffer();
  if (buf.byteLength !== J.points * 6) throw new Error(`damage.bin: ${buf.byteLength} B, expected ${J.points * 6}`);
  Q = new Uint16Array(buf);
  q.position.fromArray(B); q.scale.fromArray(S);
  const cube = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), Math.sqrt(3) / 2); // no 1.7 M-point scan
  J.classes.forEach((c, ci) => {
    if (!c.count) return;
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf, c.start * 6, c.count * 3), 3, true));
    g.boundingSphere = cube.clone();
    const p = new THREE.Points(g, mat(c.color, 1.5 * (c.voxel || 0.01), 2.5, { transparent: true, opacity, depthWrite: false }));
    p.visible = on[ci]; q.add(p); pts[ci] = p;
  });
  status.textContent = `damage  ${J.items.length.toLocaleString()} items · ${(J.points / 1e6).toFixed(2)} M points`;
}
load().catch((e) => (status.textContent = 'damage: failed: ' + e.message));

// ---------- tap to select ----------
const active = new Set();
let tap = null;
lod.el.addEventListener('pointerdown', (e) => {
  if (e.isPrimary) active.clear(); // a primary down means no other pointer of its kind is down: drop any stale ids
  active.add(e.pointerId);
  tap = active.size === 1 && e.button === 0 && !e.altKey ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, (e) => active.delete(e.pointerId), true);
lod.el.addEventListener('pointerup', (e) => {
  const d = tap;
  tap = null;
  if (!d || d.id !== e.pointerId || e.altKey || lod.inferArmed || !Q) return; // armed: this tap belongs to selinf.js
  const mouse = e.pointerType === 'mouse';
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= (mouse ? 5 : 10) || performance.now() - d.t >= 500) return;
  const hit = lod.pick(lod.ndcOf(e));
  if (!hit) return select(-1);
  const p = lod.w2src(hit.point), px = (2 * Math.tan((lod.camera.fov * Math.PI) / 360) * hit.distance) / lod.el.clientHeight;
  const r = Math.max(0.02, (mouse ? 8 : 16) * px); // a fingertip is less precise than a cursor
  let best = -1, bd = r * r;
  J.items.forEach((it, i) => {
    const b = it.b;
    if (!on[it.c] || p[0] < b[0] - r || p[0] > b[3] + r || p[1] < b[1] - r || p[1] > b[4] + r || p[2] < b[2] - r || p[2] > b[5] + r) return;
    for (let j = it.s * 3, end = (it.s + it.n) * 3; j < end; j += 3) {
      const dx = B[0] + Q[j] * K[0] - p[0], dy = B[1] + Q[j + 1] * K[1] - p[1], dz = B[2] + Q[j + 2] * K[2] - p[2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bd) { bd = dd; best = i; }
    }
  });
  select(best);
});

function select(i) {
  if (i === sel) return; // e.g. the double-click/tap that sets the pivot: keep the panel and its scroll
  if (selPts) { q.remove(selPts); selPts.geometry.dispose(); selPts = null; }
  sel = i;
  closeView();
  if (i < 0) return void (panel.style.display = 'none');
  const it = J.items[i], c = J.classes[it.c];
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Uint16Array(Q.buffer, it.s * 6, it.n * 3), 3, true));
  g.boundingSphere = unitBox(it.b).getBoundingSphere(new THREE.Sphere());
  selMat.size = 2.5 * (c.voxel || 0.01);
  selPts = new THREE.Points(g, selMat);
  selPts.renderOrder = 999;
  q.add(selPts);
  showPanel(it, c);
}

// ---------- side panel (right on wide screens, bottom sheet on narrow ones) ----------
const panel = h('div', 'dm-panel');
panel.style.display = 'none';
document.body.append(panel);

function crop(k, color) {
  const [, x0, y0, x1, y1] = J.items[sel].p[k], f = h('div', 'dm-ph'), img = h('img'), b = h('div', 'dm-bx');
  img.loading = 'lazy'; img.alt = ''; img.src = `${BASE}img/${sel}_${k}.jpg`;
  Object.assign(b.style, { left: x0 * 100 + '%', top: y0 * 100 + '%', width: (x1 - x0) * 100 + '%', height: (y1 - y0) * 100 + '%', borderColor: color });
  f.append(img, b);
  return f;
}
function showPanel(it, c) {
  const head = h('div', 'dm-head'), x = h('button', 'dm-x', '×');
  x.title = 'close (Esc)'; x.onclick = () => select(-1);
  head.append(swatch(c.color), c.name, h('span', 'dm-n', `C-${it.id}`), x);
  const m = it.m == null ? '–' : `${+it.m.toPrecision(3)} ${unit(c)}`;
  panel.replaceChildren(head, h('div', 'dm-m', `${c.measure === 'length' ? 'Length' : 'Area'} ${m}`), h('div', 'dm-n', `${it.n.toLocaleString()} points`));
  if (!it.p.length) panel.append(h('div', 'dm-n', 'no photos'));
  it.p.forEach((ph, k) => {
    const f = crop(k, c.color);
    f.onclick = () => openView(k);
    panel.append(f, h('div', 'dm-cap', J.photos[ph[0]]));
  });
  panel.style.display = ''; panel.scrollTop = 0;
}

// ---------- photo viewer: the crop already is the close-up, so no zoom ----------
const view = h('div', 'dm-view'), bx = h('button', 'x', '×'), bp = h('button', 'prev', '‹'), bn = h('button', 'next', '›');
view.style.display = 'none';
document.body.append(view);
let vk = -1, sw = null;
bx.onclick = () => closeView();
bp.onclick = () => openView(vk - 1);
bn.onclick = () => openView(vk + 1);

function openView(k) {
  const it = J.items[sel], n = it.p.length;
  vk = (k + n) % n;
  const f = crop(vk, J.classes[it.c].color), img = f.firstChild;
  img.loading = 'eager';
  img.onload = () => (img.style.width = `min(96vw, ${((86 * img.naturalWidth) / img.naturalHeight).toFixed(2)}vh)`); // fit, small crops scale up
  bp.hidden = bn.hidden = n < 2;
  view.replaceChildren(f, h('div', 'dm-vc', `${J.photos[it.p[vk][0]]}  ${vk + 1} / ${n}`), bx, bp, bn);
  view.style.display = '';
}
function closeView() {
  if (vk < 0) return;
  vk = -1; view.style.display = 'none'; view.replaceChildren();
}
view.addEventListener('pointerdown', (e) => (sw = { x: e.clientX, y: e.clientY }));
view.addEventListener('pointerup', (e) => {
  if (!sw) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  sw = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) openView(vk + (dx < 0 ? 1 : -1));
  else if (Math.hypot(dx, dy) < 10 && e.target === view) closeView();
});

// capture: an Esc that closes the viewer or the panel stops here, so selinf.js's Esc doesn't also clear its result
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (vk >= 0) {
    if (e.key === 'Escape') { closeView(); e.stopPropagation(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') openView(vk + (e.key === 'ArrowLeft' ? -1 : 1));
  } else if (e.key === 'Escape' && sel >= 0) { select(-1); e.stopPropagation(); }
}, true);
