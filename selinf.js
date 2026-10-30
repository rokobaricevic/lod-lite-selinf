// Selective inference: alt-click the bridge, or arm the dock tool "Prepoznaj oštećenja" and then click / tap it -> the
// PC runs the damage models only on the photos around the click (selinf.py, which also serves this page). It saves what
// it finds, and damage.js shows that (event lod-found); an older server's result is only drawn here. ?selinf=<url>
// overrides the server (default: the one this page came from).
import * as THREE from 'three';

const lod = window.lod, ui = lod.ui;
const API = new URLSearchParams(location.search).get('selinf') ?? '';
const COLOR = { Crack: '#FF2D2D', ExposedRebars: '#FF8A00', Rust: '#FF2DAF', Spalling: '#FFD60A',
  Wetspot: '#00E5FF', Cavity: '#7CFF00', Efflorescence: '#C42DFF' }; // = the product palette (drawings/colors.py)
const NAME = { Crack: 'Pukotina', ExposedRebars: 'Ogoljela armatura', Rust: 'Korozija', Spalling: 'Odlamanje betona',
  Wetspot: 'Vlažna mrlja', Cavity: 'Šupljina', Efflorescence: 'Iscvjetavanje' };
const IDLE = 'selective inference: the dock\'s sparkle tool, then click the bridge (or alt-click it)';
const TOUCH = matchMedia('(pointer: coarse)').matches, hr = new Intl.NumberFormat('hr-HR');
const photos = (n) => `${hr.format(n)} ${n % 10 > 1 && n % 10 < 5 && (n % 100 < 12 || n % 100 > 14) ? 'fotografije' : 'fotografija'}`;
const n2 = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // " · 1,84 m", " · 0,12 m²", " · 22 cm²"
const measure = (f) => (f?.m == null ? '' : ` · ${f.measure === 'length' ? n2.format(f.m) + ' m' : f.m < 0.01 ? hr.format(Math.round(f.m * 1e4)) + ' cm²' : n2.format(f.m) + ' m²'}`);

const root = new THREE.Group();
root.rotation.x = -Math.PI / 2; // source (bake) frame, like tiles.group
lod.scene.add(root);
const sel = new THREE.Group(), full = new THREE.Group();
full.visible = false;
const seed = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
  new THREE.PointsMaterial({ color: 0xffffff, size: 12, sizeAttenuation: false, depthTest: false }));
seed.renderOrder = 999; seed.visible = false;
root.add(sel, full, seed);
let through = false;

// the dev HUD (lod.ctl): the detailed status and the layer toggles
const box = document.createElement('div');
box.style.cssText = 'margin-top:8px;border-top:1px solid var(--line);padding-top:8px';
const status = document.createElement('pre');
status.textContent = IDLE;
box.append(status);
lod.ctl.append(box);
function toggle(label, on, fn) {
  const l = document.createElement('label'), c = document.createElement('input');
  c.type = 'checkbox'; c.checked = on; c.onchange = () => fn(c.checked);
  l.append(c, ' ' + label); box.append(l);
}
toggle('selective result', true, (on) => (sel.visible = on));
toggle('full run (as in the app)', false, (on) => (full.visible = on));
toggle('show through surfaces', false, (on) => {
  through = on;
  for (const g of [sel, full]) g.traverse((o) => { if (o.material) o.material.depthTest = !on; });
});

function cloud(group, byClass) {
  group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  group.clear();
  let n = 0;
  for (const [c, flat] of Object.entries(byClass || {})) {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(flat, 3));
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: COLOR[c] || '#828A92', size: 4, sizeAttenuation: false, depthTest: !through })));
    n += flat.length / 3;
  }
  return n;
}

// the dock tool arms one click (no alt key on a phone); damage.js skips that tap while lod.inferArmed is set
const btn = ui.tool({ label: 'Prepoznaj oštećenja', order: 20, onClick: () => { if (!busy) arm(!lod.inferArmed); },
  icon: '<path d="M8.5 2.5l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4-4.4-1.6 4.4-1.6z"/><path d="M15 12.5v5M12.5 15h5"/>' });
let unhint = () => {}; // hides selinf's last hint (armed / running / result), if it is still the one shown
function arm(on) {
  if (lod.inferArmed && !on) unhint();
  lod.inferArmed = on; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on);
  lod.el.style.cursor = on ? 'crosshair' : '';
  if (on) unhint = ui.hint(`${TOUCH ? 'Dodirnite' : 'Kliknite'} model gdje treba prepoznati oštećenja.`);
}
arm(false);

let busy = false, down = [0, 0], slop = 4;
lod.el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; slop = e.pointerType === 'touch' ? 10 : 4; });
lod.el.addEventListener('click', async (e) => {
  if (!(e.altKey || lod.inferArmed) || busy || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > slop) return;
  const hit = lod.pick(lod.ndcOf(e));
  if (!hit) return; // a miss stays armed
  arm(false);
  const o = lod.w2src(lod.camera.position), p = lod.w2src(hit.point);
  busy = true; btn.disabled = true;
  seed.position.fromArray(p); seed.visible = true;
  const t0 = performance.now(); let shown = -1;
  const run = () => { // whole seconds: the chip changes once a second
    const s = Math.round((performance.now() - t0) / 1000); if (s === shown) return; shown = s;
    status.textContent = `running... ${s} s`; unhint = ui.hint(`Prepoznavanje oštećenja… ${hr.format(s)} s`);
  };
  run(); const tick = setInterval(run, 250);
  try {
    // text/plain body: no CORS preflight. Answer: uint32 header length, JSON header, float32 xyz per layer
    const r = await fetch(API + '/click', { method: 'POST', body: JSON.stringify({ origin: o, direction: p.map((v, i) => v - o[i]) }) })
      .catch(() => { throw new Error('server ne odgovara'); });
    if (!r.ok && r.status !== 500) throw new Error(`HTTP ${r.status}`); // a 500 carries {error} in the answer's form
    const buf = await r.arrayBuffer();
    const n = new DataView(buf).getUint32(0, true), res = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    if (res.error) throw new Error(res.error);
    let at = 4 + n;
    for (const part of [res.points, res.full]) for (const c in part) { part[c] = new Float32Array(buf, at, part[c] * 3); at += part[c].byteLength; }
    seed.position.fromArray(res.seed);
    const f = res.found, ns = Object.values(res.points || {}).reduce((a, x) => a + x.length / 3, 0), nf = cloud(full, res.full);
    cloud(sel, !f && res.points); // a saved find is damage.js's to draw (clickable, for everyone)
    const grow = res.photos.filter((x) => x.phase === 'grow').length, s = res.seconds, k = res.photos.length;
    status.textContent = `${res.class || '-'}: ${res.stop}\n` +
      `${k} photos (${grow} grow + ${k - grow} confirm)\n` +
      `${s.total} s (models ${s.models} s, bake ${s.bake} s)\n` +
      `points: selective ${ns.toLocaleString()} | full run ${nf.toLocaleString()}` +
      (f ? `\nsaved ${f.id}${res.replaced?.length ? ', replaces ' + res.replaced.join(' ') : ''}` : '');
    unhint = ui.hint(!k ? 'Nijedna fotografija ne prikazuje to mjesto.' : !res.class || !ns ? 'Nisu otkrivena oštećenja.'
      : `${NAME[res.class] || res.class}${measure(f)} · ${photos(k)} · ${hr.format(Math.round(s.total))} s`, 8000);
    if (f) dispatchEvent(new CustomEvent('lod-found', { detail: { found: f, replaced: res.replaced || [] } }));
  } catch (err) {
    status.textContent = `failed: ${err.message}\n(is the PC server running? ./test.sh)`;
    const msg = String(err.message).replace(/^\w+\((['"])(.*)\1\)$/s, '$2'); // the server sends repr(exc)
    unhint = ui.hint(`Prepoznavanje nije uspjelo: ${msg}. Pokušajte ponovno.`, 8000);
  } finally {
    clearInterval(tick); busy = false; btn.disabled = false; arm(false);
  }
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || busy) return;
  if (lod.inferArmed) return arm(false);
  cloud(sel); cloud(full); seed.visible = false; status.textContent = IDLE; unhint();
});
