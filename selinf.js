// Selective inference: alt-click the bridge -> the PC runs the damage models only on the photos
// around the click (lynceus experiments/selective_inference/selinf.py) and the result is drawn here.
// ?selinf=<url> overrides the server (default http://127.0.0.1:8765, an ssh tunnel to the PC).
import * as THREE from 'three';

const lod = window.lod;
const API = new URLSearchParams(location.search).get('selinf') || 'http://127.0.0.1:8765';
const COLOR = { Crack: '#FF2D2D', ExposedRebars: '#FF8A00', Rust: '#FF2DAF', Spalling: '#FFD60A',
  Wetspot: '#00E5FF', Cavity: '#7CFF00', Efflorescence: '#C42DFF' }; // = the product palette (drawings/colors.py)
const IDLE = 'selective inference: alt-click the bridge';

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

const box = document.createElement('div');
box.style.cssText = 'margin-top:6px;border-top:1px solid #444;padding-top:4px';
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

let busy = false, down = [0, 0];
lod.el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
lod.el.addEventListener('click', async (e) => {
  if (!e.altKey || busy || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const hit = lod.pick(lod.ndcOf(e));
  if (!hit) return;
  const o = lod.w2src(lod.camera.position), p = lod.w2src(hit.point);
  busy = true;
  seed.position.fromArray(p); seed.visible = true;
  const t0 = performance.now();
  const tick = setInterval(() => (status.textContent = `running... ${((performance.now() - t0) / 1000).toFixed(0)} s`), 250);
  try {
    // text/plain body: no CORS preflight. Answer: uint32 header length, JSON header, float32 xyz per layer
    const buf = await (await fetch(API + '/click', { method: 'POST', body: JSON.stringify({ origin: o, direction: p.map((v, i) => v - o[i]) }) })).arrayBuffer();
    const n = new DataView(buf).getUint32(0, true), res = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    if (res.error) throw new Error(res.error);
    let at = 4 + n;
    for (const part of [res.points, res.full]) for (const c in part) { part[c] = new Float32Array(buf, at, part[c] * 3); at += part[c].byteLength; }
    seed.position.fromArray(res.seed);
    const ns = cloud(sel, res.points), nf = cloud(full, res.full);
    const grow = res.photos.filter((x) => x.phase === 'grow').length, s = res.seconds;
    status.textContent = `${res.class || '-'}: ${res.stop}\n` +
      `${res.photos.length} photos (${grow} grow + ${res.photos.length - grow} confirm)\n` +
      `${s.total} s (models ${s.models} s, bake ${s.bake} s)\n` +
      `points: selective ${ns.toLocaleString()} | full run ${nf.toLocaleString()}`;
  } catch (err) {
    status.textContent = `failed: ${err.message}\n(is experiments/selective_inference/test.sh running?)`;
  } finally {
    clearInterval(tick); busy = false;
  }
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || busy) return;
  cloud(sel); cloud(full); seed.visible = false; status.textContent = IDLE;
});
