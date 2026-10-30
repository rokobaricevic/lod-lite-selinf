// Damage overlay: the damage point clouds of damage.py (out/damage/) drawn on the bridge. The dock tool "Slojevi" opens the
// layers popover (per-class toggles, opacity); tap a damage -> the inspector (measure, photo); tap the photo -> a viewer.
// ?damage=<dir> overrides the data dir (default out/damage/, relative to this page). The look is lynceus "Ui Inspect": the
// colours, fonts and sizes are viewer.html's :root tokens; the dock tool and the hint chip come from its lod.ui.
import * as THREE from 'three';

const lod = window.lod, ui = lod.ui;
let BASE = new URLSearchParams(location.search).get('damage') ?? 'out/damage/';
if (!BASE.endsWith('/')) BASE += '/';
const jsonP = fetch(BASE + 'damage.json', { cache: 'no-cache' }), binP = fetch(BASE + 'damage.bin', { cache: 'no-cache' });
binP.catch(() => {}); // awaited only when the JSON is there

const css = document.createElement('style');
css.textContent = `
:where(.dm) button{margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;
 flex:none;transition:background-color var(--fast),color var(--fast)}
:where(.dm) :focus-visible{outline:2px solid var(--ac-fg);outline-offset:2px}.dm-sw{flex:none;width:10px;height:10px;border-radius:var(--r-swatch);background:var(--c)}
.dm-pop,.dm-insp{position:fixed;box-sizing:border-box;background:var(--ink1);border:1px solid var(--line);border-radius:var(--r-panel);box-shadow:var(--fp-shadow);color:var(--t)}
.dm-pop{z-index:14;bottom:calc(34px + var(--h-dock) + env(safe-area-inset-bottom));width:min(320px,calc(100% - 32px));padding:12px 16px 16px}
.dm-ar{position:absolute;bottom:-6px;width:10px;height:10px;box-sizing:border-box;background:var(--ink1);border:solid var(--line);border-width:0 1px 1px 0;transform:rotate(45deg)}
.dm-ph1{display:flex;align-items:center;justify-content:space-between;height:28px}.dm-px{width:28px;height:28px;margin-right:-6px;border-radius:var(--r-sm);color:var(--t-low)}
.dm-msg{margin-top:8px;font-size:13px}.dm-msg:empty{display:none}.dm-rows{margin-top:4px}
.dm-row{height:34px;display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;-webkit-user-select:none;user-select:none}
.dm-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dm-eye{width:28px;height:28px;border-radius:var(--r-sm);color:var(--icon)}
.dm-ct,.dm-tot{font-size:12px;color:var(--t-low);text-align:right}.dm-ct{min-width:32px}.dm-tot{width:64px}
.off .dm-sw{background:none;box-shadow:inset 0 0 0 1.5px var(--t-off)}.off :is(.dm-nm,.dm-ct,.dm-tot){color:var(--t-off)}
.dm-ol{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px}.dm-ol .num{font-size:12px;color:var(--t-low)}
.dm-sl{-webkit-appearance:none;appearance:none;display:block;width:100%;height:16px;margin:8px 0 0;background:none;cursor:pointer;
 --fill:linear-gradient(90deg,var(--ac) calc(8px + (100% - 16px) * var(--p,.8)),var(--ink4) 0)} /* blue up to the thumb's centre */
.dm-sl::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--fill)}.dm-sl::-moz-range-track{height:4px;border-radius:2px;background:var(--fill)}
.dm-sl::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--t-hi);box-shadow:var(--pin-shadow)}
.dm-sl::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--t-hi);box-shadow:var(--pin-shadow)}
.dm-insp{z-index:12;top:calc(76px + env(safe-area-inset-top));right:calc(16px + env(safe-area-inset-right));width:var(--w-insp);padding:16px;display:flex;
 flex-direction:column;gap:14px;max-height:calc(100dvh - 92px - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow-y:auto;overscroll-behavior:contain}
.dm-head{display:flex;align-items:center;gap:10px}.dm-head .dm-sw{width:12px;height:12px}.dm-head h2{flex:1;min-width:0;margin:0;font:600 22px/26px var(--font-display)}
.dm-x{width:30px;height:30px;border-radius:var(--r-sm);background:var(--ink2)}
.dm-ms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px 0;border:solid var(--line);border-width:1px 0}
.dm-v{font-size:26px;font-weight:500;line-height:1.2}.dm-l{margin-top:2px;font-size:12px;color:var(--t-low)}.dm-none{font-size:13px;color:var(--t-low)}
.dm-ph{position:relative;background:var(--ink2)}.dm-ph img{display:block;width:100%;aspect-ratio:auto 1/1}
.dm-tile{display:block;width:100%;border-radius:var(--r);overflow:hidden;cursor:zoom-in}
.dm-bx{position:absolute;box-sizing:border-box;border:2px solid;box-shadow:0 0 0 1.5px rgba(0,0,0,.6),inset 0 0 0 1.5px rgba(0,0,0,.6);pointer-events:none}
.dm-chip{position:absolute;left:10px;bottom:10px;height:26px;box-sizing:border-box;display:flex;align-items:center;padding:0 10px;border-radius:var(--r-sm);
 background:var(--ink1);border:1px solid var(--line);font-size:12px;font-weight:600;white-space:nowrap}
.dm-err{display:flex;align-items:center;justify-content:center;min-height:120px;padding:16px;font-size:13px;text-align:center}
.dm-tech{border-top:1px solid var(--line);font-size:13px;color:var(--t-low)}.dm-tech summary{line-height:36px;list-style:none;cursor:pointer}
.dm-tech summary::-webkit-details-marker{display:none}.dm-tech svg{vertical-align:-2px;margin-right:8px}.dm-tech:not([open]) svg{transform:rotate(-90deg)}
.dm-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12px}.dm-dl>:nth-child(even){font-family:var(--font-mono);color:var(--t);overflow-wrap:anywhere}
.dm-view{position:fixed;inset:0;z-index:1000;background:var(--ink0);color:var(--t);touch-action:none;-webkit-user-select:none;user-select:none;--fs:102px;
 --dmw:calc(100vw - 32px - env(safe-area-inset-left) - env(safe-area-inset-right));--dmh:calc(100dvh - 104px - var(--fs) - env(safe-area-inset-top) - env(safe-area-inset-bottom))}
.dm-st{position:absolute;inset:calc(72px + env(safe-area-inset-top)) 0 calc(32px + var(--fs) + env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center}
.dm-st img{width:min(var(--dmw),var(--dmh))} /* --dmw x --dmh: the area above the filmstrip; dvh: iOS's vh is taller than the visible area */
.dm-vt{position:absolute;top:calc(16px + env(safe-area-inset-top));left:calc(16px + env(safe-area-inset-left));right:calc(72px + env(safe-area-inset-right));display:flex;
 align-items:center;gap:12px}
.dm-vc{height:40px;box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;border-radius:var(--r-pill);background:var(--ink1);
 border:1px solid var(--line);font-weight:600;white-space:nowrap}
.dm-vn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--t-low)}
.dm-vb{position:absolute;width:40px;height:40px;box-sizing:border-box;border-radius:var(--r);background:var(--ink1);border:1px solid var(--line);color:var(--icon)}
.dm-vb.x{top:calc(16px + env(safe-area-inset-top));right:calc(16px + env(safe-area-inset-right))}.dm-vb.prev,.dm-vb.next{top:50%;transform:translateY(-50%)}
.dm-vb.prev{left:calc(16px + env(safe-area-inset-left))}.dm-vb.next{right:calc(16px + env(safe-area-inset-right))}
.dm-fs{position:absolute;bottom:calc(16px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);box-sizing:border-box;max-width:calc(100% - 32px);display:flex;
 align-items:center;gap:8px;padding:10px;border-radius:16px;background:var(--ink1);border:1px solid var(--line);overflow-x:auto}
.dm-fs button{width:120px;height:80px;border-radius:var(--r-sm);overflow:hidden;background:var(--ink2)}.dm-fs .on{box-shadow:0 0 0 2px var(--ac-fg)}
.dm-fs img{display:block;width:100%;height:100%;object-fit:cover}.dm-fs .num{padding:0 4px;font-size:12px;color:var(--t-low)}
@media (max-width:700px){.dm-insp{top:auto;left:calc(16px + env(safe-area-inset-left));bottom:calc(28px + var(--h-dock) + env(safe-area-inset-bottom));
 width:auto;max-height:50dvh}.dm-head h2{font-size:18px;line-height:22px}.dm-view{--fs:78px}.dm-fs button{width:80px;height:56px}}
@media (pointer:coarse){.dm-row{height:44px}.dm-px,.dm-x,.dm-vb{width:44px;height:44px}.dm-sl{height:44px}.dm-tech summary{line-height:44px}}
@media (hover:hover){.dm-px:hover,.dm-eye:hover,.dm-vb:hover{background:var(--ink2)}.dm-x:hover{background:var(--ink4)}}`; // reduced motion: viewer.html's global rule
document.head.append(css);

const h = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
const svg = (d, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const XP = '<path d="M6 6l12 12M18 6L6 18"/>', EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const btn = (cls, label, html = '') => { const b = Object.assign(h('button', cls), { type: 'button', innerHTML: html }); b.setAttribute('aria-label', label); return b; };
const swatch = (color) => { const s = h('span', 'dm-sw'); s.style.setProperty('--c', color); return s; };

// Croatian names (in the palette order, the legend's) and hr-HR numbers: "1,84 m", "0,12 m²", below 1 dm² "22 cm²", "80 %"
const HR = { Crack: 'Pukotina', ExposedRebars: 'Ogoljela armatura', Rust: 'Korozija', Spalling: 'Odlamanje betona',
  Wetspot: 'Vlažna mrlja', Cavity: 'Šupljina', Efflorescence: 'Iscvjetavanje' };
const ORDER = Object.keys(HR), hr = (c) => HR[c.name] ?? c.name;
const nf = (o) => new Intl.NumberFormat('hr-HR', o).format, n0 = nf({ maximumFractionDigits: 0 }), pct = nf({ style: 'percent' });
const n2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v, c) => (v == null ? '—' : c.measure === 'length' ? n2(v) + ' m' : v < 0.01 ? n0(v * 1e4) + ' cm²' : n2(v) + ' m²');
const fotografij = (n) => `${n0(n)} fotografij${n % 10 > 1 && n % 10 < 5 && (n % 100 < 12 || n % 100 > 14) ? 'e' : 'a'}`; // 2-4, 22-24: -e

const status = h('pre', '', 'damage: loading...'); // the dev HUD's English one-liner
status.style.cssText = 'margin-top:8px;border-top:1px solid var(--line);padding-top:8px'; lod.ctl.append(status);
const unhint = ui.hint('Učitavanje oštećenja…'); // clears only while it still shows this hint
const say = (text, dev, ms) => { ui.hint(text, ms); msg.textContent = text; status.textContent = dev; };

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

// ---------- "Slojevi": the layers popover above its dock tool ----------
const pop = h('div', 'dm dm-pop'), ph = h('div', 'dm-ph1'), px = btn('dm-px', 'Zatvori slojeve', svg(XP));
const msg = h('div', 'dm-msg', 'Učitavanje oštećenja…'), rows = h('div', 'dm-rows'), ar = h('i', 'dm-ar');
ph.append(h('span', 'cap', 'Klase oštećenja'), px); pop.append(ph, msg, rows, ar); document.body.append(pop);
pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Slojevi');
const tool = ui.tool({ label: 'Slojevi', order: 10, onClick: () => layers(pop.style.display === 'none'),
  icon: '<path d="M10 3.5l7.5 4.2-7.5 4.2-7.5-4.2z"/><path d="M2.5 12l7.5 4.2 7.5-4.2"/>' }); // layers; lod.ui wraps the <svg>
px.onclick = () => layers(false);
ui.dock.addEventListener('click', (e) => tool.contains(e.target) || layers(false)); // another tool: it may need the hint chip under us
layers(false);
function layers(open) {
  pop.style.display = open ? '' : 'none'; tool.classList.toggle('on', open); tool.setAttribute('aria-expanded', open);
  if (open) place();
}
function place() { // centred on the tool, clamped to the screen; the arrow keeps pointing at the tool
  const r = tool.getBoundingClientRect(), cx = r.left + r.width / 2, w = pop.offsetWidth;
  const x = Math.max(16, Math.min(cx - w / 2, document.documentElement.clientWidth - 16 - w));
  pop.style.left = x + 'px'; ar.style.left = cx - x - 6 + 'px'; // 6: half the arrow + the border
}
addEventListener('resize', () => pop.style.display || place());

function layersUI() {
  msg.textContent = '';
  const rank = (ci) => { const i = ORDER.indexOf(J.classes[ci].name); return i < 0 ? ORDER.length : i; };
  for (const ci of J.classes.map((_, i) => i).sort((a, b) => rank(a) - rank(b))) {
    const c = J.classes[ci], row = h('div', 'dm-row'), eye = btn('dm-eye', ''); // the whole row toggles; the eye is its button
    row.append(swatch(c.color), h('span', 'dm-nm', hr(c)), h('span', 'num dm-ct', n0(c.items)), h('span', 'num dm-tot', fmt(c.total, c)), eye);
    const show = () => { // hidden: hollow swatch, --t-off text, eye-off
      row.classList.toggle('off', !on[ci]); eye.innerHTML = svg(on[ci] ? EYE : EYE + '<path d="M3 3l18 18"/>');
      eye.setAttribute('aria-label', `${on[ci] ? 'Sakrij' : 'Prikaži'} klasu ${hr(c)}`);
    };
    row.onclick = () => {
      on[ci] = !on[ci]; show();
      if (pts[ci]) pts[ci].visible = on[ci];
      if (!on[ci] && sel >= 0 && J.items[sel].c === ci) select(-1);
    };
    show(); rows.append(row);
  }
  const lab = h('div', 'dm-ol'), val = h('span', 'num'), sl = h('input', 'dm-sl');
  Object.assign(sl, { type: 'range', min: 0, max: 100, value: 80 });
  sl.setAttribute('aria-label', 'Neprozirnost oštećenja');
  sl.oninput = () => {
    opacity = sl.value / 100; val.textContent = pct(opacity); sl.style.setProperty('--p', opacity); // --p: the blue fill
    for (const p of pts) if (p) p.material.opacity = opacity;
  };
  sl.oninput(); lab.append('Neprozirnost oštećenja', val); pop.append(lab, sl);
}

async function load() {
  const r = await jsonP;
  if (r.status === 404) return say('Oštećenja nisu dostupna (pokrenite damage.py)', 'damage: no data (run damage.py)', 8000);
  if (!r.ok) throw new Error(`damage.json: HTTP ${r.status}`);
  J = await r.json();
  B = J.box.slice(0, 3); S = B.map((v, i) => Math.max(J.box[i + 3] - v, 1e-6)); K = S.map((s) => s / 65535);
  on = J.classes.map(() => true);
  layersUI();
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
  unhint();
}
load().catch((e) => say(`Oštećenja se nisu učitala: ${e.message}`, 'damage: failed: ' + e.message, 10000));

// ---------- tap to select ----------
const active = new Set(), caster = new THREE.Raycaster(), sray = new THREE.Ray(), ibox = new THREE.Box3(), at = new THREE.Vector3();
let tap = null, miss = 0;
lod.el.addEventListener('pointerdown', (e) => {
  clearTimeout(miss); // the 2nd tap of a double-tap / dblclick (the pivot) keeps the panel
  if (e.isPrimary) active.clear(); // a primary down means no other pointer of its kind is down: drop any stale ids
  active.add(e.pointerId);
  tap = active.size === 1 && e.button === 0 && !e.altKey ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, (e) => active.delete(e.pointerId), true);
const missed = () => { clearTimeout(miss); miss = setTimeout(() => select(-1), 350); };
lod.el.addEventListener('pointerup', (e) => {
  const d = tap;
  tap = null;
  if (!d || d.id !== e.pointerId || e.altKey || lod.inferArmed || !Q) return; // armed: this tap belongs to selinf.js
  const mouse = e.pointerType === 'mouse';
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= (mouse ? 5 : 10) || performance.now() - d.t >= 500) return;
  const ndc = lod.ndcOf(e), hit = lod.pick(ndc);
  if (!hit) return missed();
  // the damage point nearest the tap ON SCREEN (a 3D radius at the hit shrinks to a pixel in grazing views), among the
  // points not behind the surface: t <= the hit's depth + the 1 % the depth pull shows through, + 2 cm
  caster.setFromCamera(ndc, lod.camera);
  const o = lod.w2src(caster.ray.origin), dir = lod.w2src(caster.ray.direction);
  sray.origin.fromArray(o); sray.direction.fromArray(dir);
  const k = (2 * Math.tan((lod.camera.fov * Math.PI) / 360)) / lod.el.clientHeight; // px size / depth
  const R = mouse ? 8 : 16, tmax = hit.distance * 1.02 + 0.02; // a fingertip is less precise than a cursor
  let best = -1, bs = R * R;
  J.items.forEach((it, i) => {
    if (!on[it.c]) return;
    ibox.setFromArray(it.b).expandByScalar(R * k * tmax);
    if (!ibox.containsPoint(sray.origin) && !(sray.intersectBox(ibox, at) && at.distanceTo(sray.origin) <= tmax)) return;
    for (let j = it.s * 3, end = (it.s + it.n) * 3; j < end; j += 3) {
      const x = B[0] + Q[j] * K[0] - o[0], y = B[1] + Q[j + 1] * K[1] - o[1], z = B[2] + Q[j + 2] * K[2] - o[2];
      const t = x * dir[0] + y * dir[1] + z * dir[2];
      if (t <= 0 || t > tmax) continue;
      const s2 = (x * x + y * y + z * z - t * t) / (k * k * t * t); // squared screen distance, px
      if (s2 < bs) { bs = s2; best = i; }
    }
  });
  if (best < 0) return missed();
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

// ---------- inspector: right on wide screens, a bottom sheet above the dock on phones ----------
const panel = h('div', 'dm dm-insp');
panel.style.display = 'none'; document.body.append(panel);
let techOpen = false; // "Tehnički podaci" stays as the user left it

const src = (k) => `${BASE}img/${sel}_${k}.jpg`;
function crop(k, color, f = h('div', 'dm-ph')) { // photo k's crop in f, with the damage's box (fractions of the crop) over it
  const [, x0, y0, x1, y1] = J.items[sel].p[k], img = h('img'), b = h('span', 'dm-bx');
  img.alt = ''; img.src = src(k);
  img.onerror = () => { img.replaceWith(h('span', 'dm-err', 'Fotografija se nije učitala.')); b.remove(); };
  Object.assign(b.style, { left: x0 * 100 + '%', top: y0 * 100 + '%', width: (x1 - x0) * 100 + '%', height: (y1 - y0) * 100 + '%', borderColor: color });
  f.append(img, b);
  return f;
}
function showPanel(it, c) {
  const head = h('div', 'dm-head'), x = btn('dm-x', 'Zatvori', svg(XP)), ms = h('div', 'dm-ms'), n = it.p.length;
  x.onclick = () => select(-1);
  head.append(swatch(c.color), h('h2', '', `${hr(c)} ${it.id}`), x);
  for (const [v, l] of [[fmt(it.m, c), c.measure === 'length' ? 'Duljina' : 'Površina'], [n0(n), 'Fotografije']]) {
    const d = h('div'); d.append(h('div', 'num dm-v', v), h('div', 'dm-l', l)); ms.append(d);
  }
  let tile = h('div', 'dm-none', 'Nema fotografija za ovo oštećenje');
  if (n) {
    tile = crop(0, c.color, btn('dm-ph dm-tile', 'Otvori fotografije oštećenja'));
    tile.append(h('span', 'dm-chip', fotografij(n) + ' ›')); tile.onclick = () => openView(0);
  }
  const tech = h('details', 'dm-tech'), sm = h('summary'), dl = h('div', 'dm-dl');
  sm.innerHTML = svg('<path d="M6 9l6 6 6-6"/>', 14) + 'Tehnički podaci';
  const kv = (k, ...v) => { const d = h('div'); for (const t of v) d.append(h('div', '', t)); dl.append(h('div', '', k), d); };
  kv('ID oštećenja', `C-${it.id}`); kv('Točke', n0(it.n));
  if (n) kv('Fotografije', ...it.p.map((p) => J.photos[p[0]]));
  tech.append(sm, dl); tech.open = techOpen; tech.ontoggle = () => (techOpen = tech.open);
  panel.replaceChildren(head, ms, tile, tech);
  panel.style.display = ''; panel.scrollTop = 0;
}

// ---------- photo viewer: full screen, over everything; the crop already is the close-up, so no zoom ----------
const view = h('div', 'dm dm-view'), stage = h('div', 'dm-st'), top = h('div', 'dm-vt'), chip = h('div', 'dm-vc'), cap = h('span', 'dm-vn');
const fs = h('div', 'dm-fs'), cnt = h('span', 'num'), bx = btn('dm-vb x', 'Zatvori', svg(XP, 20));
const bp = btn('dm-vb prev', 'Prethodna fotografija', svg('<path d="M15 18l-6-6 6-6"/>', 20));
const bn = btn('dm-vb next', 'Sljedeća fotografija', svg('<path d="M9 6l6 6-6 6"/>', 20));
top.append(chip, cap); view.append(stage, top, bx, bp, bn, fs); view.style.display = 'none'; document.body.append(view);
let vk = -1, sw = null;
bx.onclick = () => closeView(); bp.onclick = () => openView(vk - 1); bn.onclick = () => openView(vk + 1);

function openView(k) {
  const it = J.items[sel], c = J.classes[it.c], n = it.p.length;
  if (vk < 0) { // opening: this item's chip and filmstrip
    chip.replaceChildren(swatch(c.color), `${hr(c)} ${it.id}`);
    fs.replaceChildren(...it.p.map((_, j) => {
      const t = btn('', `Fotografija ${j + 1} od ${n}`), img = h('img');
      img.alt = ''; img.src = src(j); t.append(img); t.onclick = () => openView(j);
      return t;
    }), cnt);
    bp.style.display = bn.style.display = n < 2 ? 'none' : '';
    view.style.display = '';
  }
  vk = (k + n) % n;
  const f = crop(vk, c.color), img = f.firstChild;
  img.onload = () => (img.style.width = `min(var(--dmw), var(--dmh) * ${(img.naturalWidth / img.naturalHeight).toFixed(4)})`); // fit; small crops scale up
  stage.replaceChildren(f);
  cap.textContent = J.photos[it.p[vk][0]]; cnt.textContent = `${vk + 1} od ${n}`;
  for (let j = 0; j < n; j++) fs.children[j].classList.toggle('on', j === vk);
}
function closeView() {
  if (vk < 0) return;
  vk = -1; view.style.display = 'none'; stage.replaceChildren(); fs.replaceChildren();
}
view.addEventListener('pointerdown', (e) => (sw = { x: e.clientX, y: e.clientY }));
view.addEventListener('pointerup', (e) => {
  if (!sw) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  sw = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) openView(vk + (dx < 0 ? 1 : -1));
  else if (Math.hypot(dx, dy) < 10 && [view, stage, top].includes(e.target)) closeView(); // a tap on the empty backdrop
});

// capture: an Esc that closes the viewer, the popover or the inspector stops here, so selinf.js's Esc doesn't also clear its result
addEventListener('keydown', (e) => {
  const esc = e.key === 'Escape';
  if (e.target.tagName === 'INPUT' && !esc) return; // a focused slider keeps its arrow keys
  if (vk >= 0) {
    if (esc) { closeView(); e.stopPropagation(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') openView(vk + (e.key === 'ArrowLeft' ? -1 : 1));
  } else if (esc && !pop.style.display) { layers(false); e.stopPropagation(); }
  else if (esc && sel >= 0 && !lod.inferArmed) { select(-1); e.stopPropagation(); } // armed: Esc disarms first
}, true);
