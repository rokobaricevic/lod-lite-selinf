// Damage overlay: the app's damage (damage.py's out/damage/) and the finds of "Prepoznaj oštećenja" (selinf.py saves them
// in out/found/) drawn on the bridge. The dock tool "Slojevi" opens the layers popover (per-class toggles, opacity); tap a
// damage -> the inspector (measure, photo; a find can be deleted); tap the photo -> a viewer. ?damage=<dir>, ?found=<dir>
// override the data dirs (relative to this page), ?selinf=<url> the server (as selinf.js). The look is lynceus "Ui Inspect":
// the colours, fonts and sizes are viewer.html's :root tokens; the dock tool and the hint chip come from its lod.ui.
import * as THREE from 'three';

const lod = window.lod, ui = lod.ui, qs = new URLSearchParams(location.search), dir = (d) => (d.endsWith('/') ? d : d + '/');
const BASE = dir(qs.get('damage') ?? 'out/damage/'), FOUND = dir(qs.get('found') ?? 'out/found/'), API = qs.get('selinf') ?? '';
const get = (url) => fetch(url, { cache: 'no-cache' });
const jsonP = get(BASE + 'damage.json'), binP = get(BASE + 'damage.bin'), foundP = get(FOUND + 'found.json');
binP.catch(() => {}); foundP.catch(() => {}); // awaited later (the bin only when the JSON is there)

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
.dm-del{height:var(--h-btn);border-radius:var(--r-sm);background:var(--ink2);font-weight:600}.dm-del:disabled{color:var(--t-low);cursor:default} /* secondary: not blue, not red */
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
@media (pointer:coarse){.dm-row{height:44px}.dm-px,.dm-x,.dm-vb{width:44px;height:44px}.dm-sl{height:44px}.dm-tech summary{line-height:44px}.dm-del{height:44px}}
@media (hover:hover){.dm-px:hover,.dm-eye:hover,.dm-vb:hover{background:var(--ink2)}.dm-x:hover,.dm-del:hover:enabled{background:var(--ink4)}}`; // reduced motion: viewer.html's global rule
document.head.append(css);

const h = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
const svg = (d, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const XP = '<path d="M6 6l12 12M18 6L6 18"/>', EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const btn = (cls, label, html = '') => { const b = Object.assign(h('button', cls), { type: 'button', innerHTML: html }); b.setAttribute('aria-label', label); return b; };
const swatch = (color) => { const s = h('span', 'dm-sw'); s.style.setProperty('--c', color); return s; };

// the classes in the legend's order: Croatian name, colour (damage.json's wins; = the product palette, drawings/colors.py).
// hr-HR numbers: "1,84 m", "0,12 m²", below 1 dm² "22 cm²", "80 %"
const CL = { Crack: ['Pukotina', '#FF2D2D'], ExposedRebars: ['Ogoljela armatura', '#FF8A00'], Rust: ['Korozija', '#FF2DAF'],
  Spalling: ['Odlamanje betona', '#FFD60A'], Wetspot: ['Vlažna mrlja', '#00E5FF'], Cavity: ['Šupljina', '#7CFF00'], Efflorescence: ['Iscvjetavanje', '#C42DFF'] };
const ORDER = Object.keys(CL), hr = (c) => CL[c.name]?.[0] ?? c.name;
const nf = (o) => new Intl.NumberFormat('hr-HR', o).format, n0 = nf({ maximumFractionDigits: 0 }), pct = nf({ style: 'percent' });
const n2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v, c) => (v == null ? '—' : c.measure === 'length' ? n2(v) + ' m' : v < 0.01 ? n0(v * 1e4) + ' cm²' : n2(v) + ' m²');
const fotografij = (n) => `${n0(n)} fotografij${n % 10 > 1 && n % 10 < 5 && (n % 100 < 12 || n % 100 > 14) ? 'e' : 'a'}`; // 2-4, 22-24: -e

const status = h('pre'), st = { damage: 'loading...' }; // the dev HUD's English lines
status.style.cssText = 'margin-top:8px;border-top:1px solid var(--line);padding-top:8px'; lod.ctl.append(status);
const dev = (k, s) => { st[k] = s; status.textContent = `damage  ${st.damage}\nfound   ${st.found}` + (st.thin ? `\nthin    ${st.thin}` : ''); };
const LOADING = 'Učitavanje oštećenja…', unhint = ui.hint(LOADING); // clears only while it still shows this hint
dev('found', 'loading...');
const say = (text, k, d, ms) => { ui.hint(text, ms); msg.textContent = text; dev(k, d); };
const fail = (k) => (e) => say(`Oštećenja se nisu učitala: ${e.message}`, k, 'failed: ' + e.message, 10000);
const NONE = 'Oštećenja nisu dostupna (pokrenite damage.py)';

const root = new THREE.Group(); // the Z-up source frame
root.rotation.x = -Math.PI / 2; lod.scene.add(root);

// Points size in world units (P[1][1] = 1/tan(fov/2), mvPosition includes the app points' box scale) so cracks look solid up
// close, with a floor in device px so far ones don't vanish. The depth pull (1 % of view depth) keeps coarser LOD tiles from hiding them.
// VERTEX_DEPTH: a sprite faces the screen, so its log depth is one value: set it per vertex and leave gl_FragDepth alone,
// which lets the GPU reject hidden sprite pixels before shading them (early z)
function patch(s) {
  s.vertexShader = s.vertexShader
    .replace('gl_PointSize *= ( scale / - mvPosition.z );', 'gl_PointSize = max( MIN_PX, size * projectionMatrix[ 1 ][ 1 ] * scale / - mvPosition.z );')
    .replace('#include <logdepthbuf_pars_vertex>', '#include <logdepthbuf_pars_vertex>\n#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) && defined( VERTEX_DEPTH )\n' +
      'uniform float logDepthBufFC;\n#endif')
    .replace('#include <logdepthbuf_vertex>', '#include <logdepthbuf_vertex>\n#ifdef USE_LOGARITHMIC_DEPTH_BUFFER\n' +
      'vFragDepth = 1.0 + gl_Position.w * 0.99;\n#ifdef VERTEX_DEPTH\n' +
      'gl_Position.z = ( log2( max( vFragDepth, 1e-6 ) ) * logDepthBufFC - 1.0 ) * gl_Position.w;\n#endif\n#endif\n' +
      '#if defined( SIZE_OUT ) || defined( MASK_INLINE )\nvSz = log2( max( gl_PointSize, 1.0 ) ) * 0.125;\n#endif\n#ifdef HALF_RES\ngl_PointSize *= 0.5;\n#endif')
    .replace('void main() {', '#if defined( SIZE_OUT ) || defined( MASK_INLINE )\nvarying float vSz;\n#endif\nvoid main() {');
  if ('VERTEX_DEPTH' in this.defines) s.fragmentShader = s.fragmentShader.replace('#include <logdepthbuf_fragment>', '');
  // the 2nd output (never both). SIZE_OUT: the separate mask's 2nd target gets the sprite's size, log2(px) / 8, for the
  // composite's blur. MASK_INLINE: the mask is the scene target's 2nd attachment: the class colour scaled to r + g + b = 1,
  // so the coverage is that sum, also after MSAA resolve and mips (an average keeps a sum; a max channel, where classes of
  // different colours meet, would read low), and, in alpha, the size code (times the coverage)
  s.fragmentShader = s.fragmentShader.replace('void main() {', '#if defined( SIZE_OUT ) || defined( MASK_INLINE )\n' +
    'layout( location = 1 ) out highp vec4 pc_out1;\nvarying float vSz;\n#endif\nvoid main() {')
    .replace('#include <premultiplied_alpha_fragment>', '#include <premultiplied_alpha_fragment>\n#ifdef SIZE_OUT\n' +
    'pc_out1 = vec4( vSz, 0.0, 0.0, 1.0 );\n#elif defined( MASK_INLINE )\n' +
    'pc_out1 = vec4( diffuse / max( diffuse.r + diffuse.g + diffuse.b, 1e-3 ), vSz );\n#endif');
  // HALF_RES: a half-size mask has no depth buffer of the bridge's size: test against its depth texture here
  if ('HALF_RES' in this.defines) {
    s.uniforms.tBridge = post.U.tDepth;
    s.fragmentShader = s.fragmentShader.replace('void main() {', 'uniform highp sampler2D tBridge;\nvoid main() {\n' +
      'if ( gl_FragCoord.z > texelFetch( tBridge, min( ivec2( gl_FragCoord.xy * 2.0 ), textureSize( tBridge, 0 ) - 1 ), 0 ).r ) discard;');
  }
}
function mat(color, size, minPx, opts, defs = {}) {
  const m = new THREE.PointsMaterial({ color, size, ...opts });
  m.defines = { MIN_PX: minPx.toFixed(1), ...defs }; // part of the program key: one program per floor, same patch
  m.onBeforeCompile = patch;
  return m;
}

// ---------- the look: an opaque screen-space mask, laid over the scene once (?dmpost=0: the old blended sprites) ----------
// The scene renders into an MSAA target. The class points draw OPAQUE (one write per sample) into a mask, depth-tested
// against the bridge: by default (inline) a 2nd attachment of that target, drawn in the same pass after the bridge; with
// ?dminline=0 a separate target sharing the scene's resolved depth texture. One full-screen pass then lays the mask over
// the scene with the slider's opacity, so overlapping sprites cannot add up. Smoothing: per pixel, the mask's mip level
// whose B-spline (4 bilinear taps) blurs by ~k sprite sizes (the sprites write their size into the mask), thresholded at t
// with a 1 px antialiased edge: round corners instead of squares, gaps narrower than the blur filled; an outline of o px.
// Around the smallest sprites (far away; a thinned crack is a line one sprite wide) the threshold is 0.05 higher, so a
// line keeps its width (0.4: ~1.25 x its raw coverage, 0.45: ~1.15 x; 0.5 started to drop faint bits)
// ?dmlook=plain|smooth|fill|outline, ?dmk= ?dmt= ?dmts= ?dmo= ?dmvz= ?dmsamples= ?dmhalf= (a half-size mask, not inline) tune it.
const R = lod.renderer, POST = !!lod.post && !!R;
// PAD: every mip level the composite reads (up to 5: 32 px) halves the mask exactly. An odd size halves unevenly (1080 rows:
// 135 at level 3, then 67): ANGLE's D3D11 mips then sample a 2-texel footprint of 2.01 and a thin line fades out of levels
// 4-5, so the composite's "anything near?" test missed a thinned crack there: 2 px gaps, a quad wide
const PAD = 32;
const LOOKS = { plain: [0, 0, 0.5, 0], smooth: [1, 0.3, 0.5, 0], fill: [1, 0.5, 0.3, 0], outline: [1, 0.4, 0.4, 1.5] }; // [mode, k, t, o]
const look = LOOKS[qs.get('dmlook')] ?? LOOKS.outline, knob = (k, d) => (qs.has(k) ? +qs.get(k) : d);
// inline: no separate mask target and no depth texture, so the bridge's MSAA depth needs no resolve (ANGLE's D3D11 resolves
// depth with a shader pass: 3.6 ms at 1080p on the Intel iGPU, against 0.9 ms for the colour); the mask is packed (colour + size)
const MODE = knob('dmmode', look[0]), HALF = POST && !!knob('dmhalf', 0), INLINE = POST && !HALF && !!knob('dminline', 1), LIN = knob('dmlin', 0);
const SIZE = POST && MODE === 1 && !INLINE && knob('dmsize', 1);
const VZ = { ...(knob('dmvz', 1) || HALF ? { VERTEX_DEPTH: '' } : {}), ...(SIZE ? { SIZE_OUT: '' } : {}), ...(HALF ? { HALF_RES: '' } : {}),
  ...(INLINE ? { MASK_INLINE: '' } : {}) }; // the class points' defines
const OPACITY = 0.5; // the damage's opacity until the slider (Neprozirnost oštećenja) moves
// a class's points (POST: opaque, into the mask; INLINE: after the bridge), and the selected damage's: the same points with
// the same material, in a lighter colour, drawn just after its class's (the last write wins), so it is smoothed, outlined
// and hidden behind the bridge like the rest
const SZK = knob('dmszk', 1), MINPX = knob('dmminpx', 2.5); // bench knobs: the sprites' size factor and floor (px)
const classMat = (color, voxel, opacity) => (POST ? mat(color, 1.5 * voxel * SZK, MINPX, { depthWrite: false, ...(INLINE ? { transparent: true, blending: THREE.NoBlending } : {}) }, VZ)
  : mat(color, 1.5 * voxel, 2.5, { transparent: true, opacity, depthWrite: false }));
const selMat = classMat(0xffffff, 0.01, OPACITY), SEL_LIGHT = Math.min(1, Math.max(0, knob('dmsel', 0.45))); // ?dmsel=: how far toward white
function selColor(c) { // c's colour as drawn (POST: the composite shows a colour at a max channel of 1), SEL_LIGHT of the way to white
  const col = new THREE.Color(c.color), s = {};
  if (POST) col.multiplyScalar(1 / Math.max(col.r, col.g, col.b, 1e-3));
  col.getRGB(s, THREE.SRGBColorSpace);
  return col.setRGB(...[s.r, s.g, s.b].map((v) => v + (1 - v) * SEL_LIGHT), THREE.SRGBColorSpace);
}
const post = POST && (() => {
  const depth = new THREE.DepthTexture(1, 1); depth.type = THREE.UnsignedIntType; // DEPTH_COMPONENT24, shared by both
  const scene = new THREE.WebGLRenderTarget(1, 1, { samples: knob('dmsamples', 4), depthTexture: INLINE ? null : depth, resolveDepthBuffer: !INLINE,
    colorSpace: THREE.SRGBColorSpace, count: INLINE ? 2 : 1 });
  if (INLINE) Object.assign(scene.textures[1], { colorSpace: THREE.NoColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  // ?dmlin=1: the scene target holds sRGB-encoded values in plain RGBA8, like the canvas (three writes a target's colour
  // space only for XR targets; nothing else reads the flag), instead of SRGB8_ALPHA8 (hardware encode / decode)
  if (LIN) { scene.isXRRenderTarget = true; scene.texture.internalFormat = 'RGBA8'; }
  const mask = INLINE ? null : new THREE.WebGLRenderTarget(1, 1, { depthTexture: HALF ? null : depth, depthBuffer: !HALF, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, count: SIZE ? 2 : 1 });
  if (SIZE) mask.textures[1].format = THREE.RedFormat;
  const mt = INLINE ? scene.textures[1] : mask.texture;
  const thr = knob('dmt', look[2]);
  const U = { tScene: { value: scene.texture }, tMask: { value: mt }, tDepth: { value: depth }, opacity: { value: OPACITY },
    tSize: { value: SIZE ? mask.textures[1] : mt },
    logFar: { value: 1 }, pxPerM: { value: 1 }, sprite: { value: 1.5 * knob('dmvox', 0.005) }, minPx: { value: 2.5 },
    kSig: { value: knob('dmk', look[1]) }, thr: { value: thr }, thrS: { value: knob('dmts', thr + 0.05) }, outPx: { value: knob('dmo', look[3]) },
    outRef: { value: knob('dmor', 6) } };
  const vertexShader = 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
  const fragmentShader = `
uniform sampler2D tScene, tMask, tDepth, tSize;
uniform float opacity, logFar, pxPerM, sprite, minPx, kSig, thr, thrS, outPx, outRef;
vec2 vUv; // this pixel in the targets' uv (they are padded: see PAD)
vec3 srgb( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) ); }
// the mip level whose B-spline blurs by kSig sprite sizes; the sprite's size in px from the view depth (log depth buffer)
float lv( float spx ) { return max( 0.0, log2( kSig * spx / 0.65 ) - LOFF ); } // LOFF: the mask's level 0 is level LOFF of the screen
float spxAt( float d ) { return max( minPx, sprite * pxPerM / ( exp2( d * logFar ) - 1.0 ) ); }
float level( float d ) { return lv( spxAt( d ) ); }
// the mask's coverage, its coverage-weighted size code, and its colour
#ifdef PACKED
float cov( vec4 m ) { return m.r + m.g + m.b; }
float szc( vec2 uv, float l, vec4 m ) { return m.a; }
vec3 hue( vec4 m ) { return m.rgb / max( max( m.r, m.g ), max( m.b, 1e-3 ) ); }
#else
float cov( vec4 m ) { return m.a; }
float szc( vec2 uv, float l, vec4 m ) { return textureLod( tSize, uv, l ).r; }
vec3 hue( vec4 m ) { return m.rgb / max( m.a, 1e-3 ); }
#endif
vec4 cubicW( float v ) {
  vec4 n = vec4( 1.0, 2.0, 3.0, 4.0 ) - v, s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4( x, y, z, 6.0 - x - y - z ) / 6.0;
}
vec4 bspline( float lod ) { // cubic B-spline of mip level lod: 4 bilinear taps
  vec2 ts = vec2( textureSize( tMask, int( lod ) ) ), tc = vUv * ts - 0.5, f = fract( tc );
  tc -= f;
  vec4 xc = cubicW( f.x ), yc = cubicW( f.y ), c = tc.xxyy + vec2( -0.5, 1.5 ).xyxy;
  vec4 s = vec4( xc.xz + xc.yw, yc.xz + yc.yw ), o = ( c + vec4( xc.yw, yc.yw ) / s ) / ts.xxyy;
  vec4 s0 = textureLod( tMask, o.xz, lod ), s1 = textureLod( tMask, o.yz, lod ), s2 = textureLod( tMask, o.xw, lod ), s3 = textureLod( tMask, o.yw, lod );
  float sx = s.x / ( s.x + s.y ), sy = s.z / ( s.z + s.w );
  return mix( mix( s3, s2, sx ), mix( s1, s0, sx ), sy );
}
void main() {
  ivec2 px = ivec2( gl_FragCoord.xy );
  vUv = gl_FragCoord.xy / vec2( textureSize( tScene, 0 ) );
#ifdef SCENE_SRGB
  vec3 base = texelFetch( tScene, px, 0 ).rgb;
#else
  vec3 base = srgb( texelFetch( tScene, px, 0 ).rgb );
#endif
#if MODE == 1
  // nothing near this 2x2 quad: the scene. One decision per quad, so fwidth() below sees all 4 pixels
  vec2 q = ( floor( gl_FragCoord.xy * 0.5 ) * 2.0 + 1.0 ) / vec2( textureSize( tScene, 0 ) );
#ifdef NO_DEPTH
  // no depth texture: first the 32 px level (anything near at all? the sprites' mean size there)
  vec4 p = textureLod( tMask, q, 5.0 );
  if ( cov( p ) < 0.5 / 255.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }
  float spx = exp2( 8.0 * szc( q, 5.0, p ) / cov( p ) ), L = lv( spx );
  if ( cov( textureLod( tMask, q, L + 2.0 ) ) < 0.5 / 255.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }
#else
  if ( cov( textureLod( tMask, q, level( textureLod( tDepth, q, 0.0 ).r ) + 2.0 ) ) < 0.5 / 255.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }
  float spx = spxAt( texelFetch( tDepth, px, 0 ).r ), L = lv( spx );
#endif
#if defined( SIZE_IN ) || defined( PACKED )
  // the sprites' own size around here (their mean log2 px, coverage-weighted, two levels up)
  vec4 pp = textureLod( tMask, vUv, L + 2.0 );
  float pa = cov( pp );
  if ( pa > 2.0 / 255.0 ) { spx = exp2( 8.0 * szc( vUv, L + 2.0, pp ) / pa ); L = lv( spx ); }
#endif
  float L0 = floor( L );
  vec4 m = mix( bspline( L0 ), bspline( L0 + 1.0 ), L - L0 );
  float t = mix( thrS, thr, clamp( ( spx - minPx ) / ( outRef - minPx ), 0.0, 1.0 ) ); // thrS: around the smallest sprites
  float B = cov( m ), sd = ( B - t ) / max( fwidth( B ), 1e-4 ), inner = clamp( sd + 0.5, 0.0, 1.0 ); // sd: px to the edge
  vec3 col = srgb( hue( m ) ), o = mix( base, col, opacity * inner );
  float ow = outPx * clamp( spx / outRef, 0.4, 1.0 ); // thinner around small sprites (far away), which it would drown
  if ( ow > 0.0 ) o = mix( o, col * 0.3, min( 1.0, opacity + 0.2 ) * ( clamp( sd + ow + 0.5, 0.0, 1.0 ) - inner ) );
  gl_FragColor = vec4( o, 1.0 );
#elif MODE == 0
  vec4 m = texelFetch( tMask, px >> int( LOFF ), 0 );
  gl_FragColor = vec4( mix( base, srgb( hue( m ) ), opacity * cov( m ) ), 1.0 );
#else
  gl_FragColor = vec4( base, 1.0 );
#endif
}`;
  const sm = (mode) => new THREE.ShaderMaterial({ uniforms: U, vertexShader, fragmentShader, defines: { MODE: mode, LOFF: HALF ? '1.0' : '0.0', ...(SIZE ? { SIZE_IN: '' } : {}), ...(LIN ? { SCENE_SRGB: '' } : {}),
    ...(INLINE ? { PACKED: '', NO_DEPTH: '' } : {}) },
    depthTest: false, depthWrite: false });
  const shade = sm(MODE), copy = sm(-1), quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shade), cam = new THREE.OrthographicCamera();
  quad.frustumCulled = false;
  return { scene, mask, U, shade, copy, quad, cam };
})();
// the frame (viewer.html's loop and bench.py both call lod.renderFrame): the scene without the damage into post.scene, the
// damage (the selected one in it, lighter) into the mask (only when some is in view), the composite onto the canvas
// LOD (POST; ?dmlod=0: off): the points are ordered coarse to fine (one per cell of 64, 32, ... 2 voxels, then the rest),
// so a prefix is an even subsample, and drawn only as fine as their spacing stays under LOD_PX px at their nearest depth.
// Far away their sprites overlap many times anyway, and the mask shows coverage, not count. Thinned cracks (below) draw
// a band of a crack's points, ordered coarse to fine on its own (an index), with a finer limit (?dmlodpx= ?dmlodband=).
// CHUNK (?dmchunk=<m>; 0: master's one prefix per find, and none for the app's damage): the levels are kept per chunk,
// a cube of ~CHUNK m aligned to the box the cells are (so a cell never straddles two chunks): each frame a chunk out of
// the frustum is skipped and one in it is drawn up to the level its own nearest depth asks for. Stored level-major
// (level 0 of every chunk, then level 1, ...), so a far find is one range and a near one a run per level; a Points'
// ranges are one WEBGL_multi_draw call (drawChunks, in its onAfterRender: three draws an empty range, the multi-draw
// reuses its state). A find's floats are stored in that order; an app class draws through an index in it. The chunks'
// boxes are also the tap's index (pickDamage scans only the chunks the ray meets).
const LOD = POST && knob('dmlod', 1), LOD_PX = knob('dmlodpx', 1.25), LOD_BAND = knob('dmlodband', 0.35), LV = knob('dmlv', 6);
const CHUNK = LOD ? knob('dmchunk', 0.64) : 0, SKIP = knob('dmskip', 0); // SKIP (bench): never the finest SKIP levels (with ?dmszk=, bigger sprites)
function c2f(a, ids, v, b, lv = LV) { // the points ids (of xyz a, box b, voxel v) coarse to fine: {order, ends[k]: points up to level k, s[k]: its cell}
  const n = ids.length, done = new Uint8Array(n), picked = [], ends = [], s = [];
  for (let k = 0; k < lv; k++) {
    const c = v * 2 ** (lv - k), seen = new Set();
    const key = (j) => Math.floor((a[j] - b[0]) / c) + Math.floor((a[j + 1] - b[1]) / c) * 131072 + Math.floor((a[j + 2] - b[2]) / c) * 17179869184;
    for (const i of picked) seen.add(key(ids[i] * 3));
    for (let i = 0; i < n; i++) { // in ids' order: the first point of a cell stands for it (a band's: the one nearest the centreline)
      if (done[i]) continue;
      const q = key(ids[i] * 3);
      if (!seen.has(q)) { seen.add(q); done[i] = 1; picked.push(i); }
    }
    ends.push(picked.length); s.push(c);
  }
  const order = new Uint32Array(n);
  let j = 0;
  for (const i of picked) order[j++] = ids[i];
  for (let i = 0; i < n; i++) if (!done[i]) order[j++] = ids[i];
  return { order, ends, s };
}
// chunkLod: c2f's levels, per chunk. A point's level is the coarsest whose cell (v * 2^(lv - k), aligned to b) it is the
// first point of, in ids' order (the same points c2f picks: the first point of a cell is also the first of the finer
// cells inside it), so a chunk's points up to level k are c2f's restricted to it. Typed arrays only (c2f's Set of
// float keys took 4x as long): per chunk, a dense "first point" grid per level (reset after the chunk); the levels
// coarser than a chunk over the chunks' first points. -> {order: the ids level-major, n chunks, at[l * n + c]: where
// chunk c's level-l points start (at[l * n + c + 1]: end), box[c * 6]: the chunk's bounds, c0: level 0's cell, lv}
const SCR = [];
function chunkLod(a, ids, v, b, lv = LV, chM = CHUNK) {
  const m = ids.length, fine = 2 * v, cs = Math.max(0, Math.min(6, Math.round(Math.log2(chM / fine)))), msk = (1 << cs) - 1;
  const F = new Int32Array(3 * m);
  let mx = 0, my = 0, mz = 0;
  for (let r = 0, q = 0; r < m; r++, q += 3) {
    const j = ids[r] * 3;
    const x = Math.max(0, Math.floor((a[j] - b[0]) / fine)), y = Math.max(0, Math.floor((a[j + 1] - b[1]) / fine)), z = Math.max(0, Math.floor((a[j + 2] - b[2]) / fine));
    F[q] = x; F[q + 1] = y; F[q + 2] = z;
    if (x > mx) mx = x; if (y > my) my = y; if (z > mz) mz = z;
  }
  // chunk ids in grid order (x fastest): neighbours along x are neighbours in the buffer, so fully drawn runs merge
  const NX = (mx >> cs) + 1, NY = (my >> cs) + 1, NZ = (mz >> cs) + 1, ck = new Int32Array(m);
  let nch = 0;
  if (NX * NY * NZ <= 1 << 22) {
    const cell = new Int32Array(NX * NY * NZ);
    for (let r = 0, q = 0; r < m; r++, q += 3) { const k = (F[q] >> cs) + NX * ((F[q + 1] >> cs) + NY * (F[q + 2] >> cs)); ck[r] = k; cell[k] = 1; }
    for (let k = 0; k < cell.length; k++) if (cell[k]) cell[k] = ++nch;
    for (let r = 0; r < m; r++) ck[r] = cell[ck[r]] - 1;
  } else { // a huge sparse grid (the app's whole class): its keys sorted
    const key = new Float64Array(m);
    for (let r = 0, q = 0; r < m; r++, q += 3) key[r] = (F[q] >> cs) + NX * ((F[q + 1] >> cs) + NY * (F[q + 2] >> cs));
    const u = Float64Array.from(new Set(key)).sort(), at = new Map();
    u.forEach((k, i) => at.set(k, i)); nch = u.length;
    for (let r = 0; r < m; r++) ck[r] = at.get(key[r]);
  }
  const st = new Int32Array(nch + 1), perm = new Int32Array(m);
  for (let r = 0; r < m; r++) st[ck[r] + 1]++;
  for (let c = 0; c < nch; c++) st[c + 1] += st[c];
  const pos = st.slice(0, nch);
  for (let r = 0; r < m; r++) perm[pos[ck[r]]++] = r; // stable: ids' order within a chunk
  const lvl = new Uint8Array(m).fill(lv), top = Math.min(cs, lv - 1), A = new Int32Array(m), B2 = new Int32Array(m), reps = [];
  for (let j = 0; j <= top; j++) { const W = 1 << (cs - j); if (!(SCR[j]?.length >= W * W * W)) SCR[j] = new Int32Array(W * W * W).fill(-1); }
  for (let c = 0; c < nch; c++) {
    let cand = A, next = B2, nc = 0;
    for (let i = st[c]; i < st[c + 1]; i++) cand[nc++] = perm[i];
    for (let j = 0; j <= top; j++) { // shift j: cells of fine << j, level lv - 1 - j
      const W = 1 << (cs - j), arr = SCR[j], k = lv - 1 - j;
      let nn = 0;
      for (let i = 0; i < nc; i++) {
        const r = cand[i], q = 3 * r, e = ((F[q] & msk) >> j) + W * (((F[q + 1] & msk) >> j) + W * ((F[q + 2] & msk) >> j));
        if (arr[e] < 0) { arr[e] = r; lvl[r] = k; next[nn++] = r; }
      }
      for (let i = 0; i < nn; i++) { const q = 3 * next[i]; arr[((F[q] & msk) >> j) + W * (((F[q + 1] & msk) >> j) + W * ((F[q + 2] & msk) >> j))] = -1; }
      const t = cand; cand = next; next = t; nc = nn;
    }
    if (top === cs) reps.push(cand[0]); // the chunk's first point: the only one that can stand for a coarser cell
  }
  for (let j = cs + 1, rs = reps; j < lv && rs.length; j++) { // levels coarser than a chunk
    const best = new Map(), key = (r) => (F[3 * r] >> j) + 65536 * ((F[3 * r + 1] >> j) + 65536 * (F[3 * r + 2] >> j));
    for (const r of rs) { const k = key(r), o = best.get(k); if (o === undefined || r < o) best.set(k, r); }
    rs = rs.filter((r) => best.get(key(r)) === r);
    for (const r of rs) lvl[r] = lv - 1 - j;
  }
  // the order: level-major (level 0 of every chunk, then level 1, ...), chunk after chunk in a level, ids' order in a
  // chunk's level: a prefix of all levels <= k is one range (a far find: one draw), and a chunk's refinement is a run
  // per level (neighbouring chunks' runs merge)
  const E = lv + 1, at = new Int32Array(E * nch + 1), box = new Float32Array(nch * 6).fill(Infinity), order = new Uint32Array(m);
  for (let c = 0; c < nch; c++) box.fill(-Infinity, c * 6 + 3, c * 6 + 6);
  for (let r = 0; r < m; r++) at[lvl[r] * nch + ck[r] + 1]++;
  for (let i = 0; i < E * nch; i++) at[i + 1] += at[i];
  const put = at.slice(0, E * nch);
  for (let r = 0; r < m; r++) {
    const c = ck[r], id = ids[r], j = id * 3, q = c * 6;
    order[put[lvl[r] * nch + c]++] = id;
    for (let k = 0; k < 3; k++) { const x = a[j + k]; if (x < box[q + k]) box[q + k] = x; if (x > box[q + 3 + k]) box[q + 3 + k] = x; }
  }
  return { order, n: nch, at, box, c0: v * 2 ** lv, lv, band: false };
}
function progressive(it) { // the find's own floats, stored coarse to fine (a permutation: every point stays, picking reads them all)
  const a = it.xyz, n = it.n, ids = Uint32Array.from({ length: n }, (_, i) => i), t = performance.now();
  const L = CHUNK ? chunkLod(a, ids, it.c.voxel || 0.01, it.b) : null, { order, ends, s } = L ?? c2f(a, ids, it.c.voxel || 0.01, it.b);
  const out = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) { const k = order[i] * 3; out[j] = a[k]; out[j + 1] = a[k + 1]; out[j + 2] = a[k + 2]; }
  if (L) L.order = null;
  it.xyz = out; it.lod = L ?? { ends, s };
  tstat.prog += performance.now() - t;
}
// a chunked Points' ranges for this frame (in g.userData.rg, shared with the selection's Points): each chunk in the
// frustum (planes pl, in the source frame, padded by a sprite) up to the level its own nearest depth asks for (as
// lodUpdate's per-find prefix: the coarsest whose cell is under px, a band's under bandK sprites), level by level;
// a range starting within GAP points of the last one's end extends it (a few culled coarse points are cheaper than a draw)
const Fr = new Float64Array(24), frs = new THREE.Frustum(), pvs = new THREE.Matrix4(), GAP = knob('dmgap', 64);
function chunkRanges(L, o, d, P, sizeM, r, px = LOD_PX, bandK = LOD_BAND, pl = Fr) {
  const { n, lv, at, box, c0 } = L, od = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], [d0, d1, d2] = d;
  if (!(r.kk?.length >= n)) { r.kk = new Int8Array(n); r.firsts = new Int32Array((lv + 1) * n); r.counts = new Int32Array((lv + 1) * n); r.offs = new Int32Array((lv + 1) * n); }
  const kk = r.kk, fi = r.firsts, co = r.counts;
  let top = -1;
  for (let c = 0, q = 0; c < n; c++, q += 6) {
    kk[c] = -1;
    const x0 = box[q], y0 = box[q + 1], z0 = box[q + 2], x1 = box[q + 3], y1 = box[q + 4], z1 = box[q + 5];
    const dmax = (d0 > 0 ? x1 : x0) * d0 + (d1 > 0 ? y1 : y0) * d1 + (d2 > 0 ? z1 : z0) * d2 - od;
    if (dmax <= 0) continue;
    const pad = 0.5 * Math.max(sizeM, (MINPX * dmax) / P);
    let p = 0;
    for (; p < 24; p += 4) {
      const nx = pl[p], ny = pl[p + 1], nz = pl[p + 2];
      if ((nx > 0 ? x1 : x0) * nx + (ny > 0 ? y1 : y0) * ny + (nz > 0 ? z1 : z0) * nz + pl[p + 3] < -pad) break;
    }
    if (p < 24) continue; // outside a plane
    const dmin = (d0 > 0 ? x0 : x1) * d0 + (d1 > 0 ? y0 : y1) * d1 + (d2 > 0 ? z0 : z1) * d2 - od;
    let k = lv - SKIP;
    if (dmin > 0) {
      const lim = L.band ? bandK * Math.max(MINPX, (sizeM * P) / dmin) : px;
      k = Math.min(lv - SKIP, Math.max(0, Math.ceil(Math.log2((c0 * P) / (dmin * lim)) - 1e-9)));
    }
    kk[c] = k; if (k > top) top = k;
  }
  let nd = 0, pts = 0, end = -Infinity;
  for (let l = 0; l <= top; l++) {
    for (let c = 0, i = l * n; c < n; c++, i++) {
      if (kk[c] < l) continue;
      const s = at[i], e = at[i + 1];
      if (s === e) continue;
      if (s - end <= GAP) { pts += e - end; co[nd - 1] = e - fi[nd - 1]; } else { fi[nd] = s; co[nd++] = e - s; pts += e - s; }
      end = e;
    }
  }
  r.nd = nd; r.pts = pts;
}
const MD = LOD && CHUNK && knob('dmmd', 1) ? R.getContext().getExtension('WEBGL_multi_draw') : null;
function drawChunks(g) { // onAfterRender: three has bound g's program, VAO and index and drawn nothing (an empty range)
  const r = g.userData.rg, gl = R.getContext();
  if (!r?.nd || g.drawRange.count) return;
  const idx = g.index;
  if (idx) {
    const bpe = idx.array.BYTES_PER_ELEMENT, type = bpe === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, of = r.offs;
    for (let i = 0; i < r.nd; i++) of[i] = r.firsts[i] * bpe;
    if (MD) MD.multiDrawElementsWEBGL(gl.POINTS, r.counts, 0, type, of, 0, r.nd);
    else for (let i = 0; i < r.nd; i++) gl.drawElements(gl.POINTS, r.counts[i], type, of[i]);
  } else if (MD) MD.multiDrawArraysWEBGL(gl.POINTS, r.firsts, 0, r.counts, 0, r.nd);
  else for (let i = 0; i < r.nd; i++) gl.drawArrays(gl.POINTS, r.firsts[i], r.counts[i]);
  R.info.render.points += r.pts;
}
const eye = new THREE.Vector3(), fwd = new THREE.Vector3();
function lodUpdate(cam, P) { // P: px per metre at depth 1 m
  const o = lod.w2src(eye.copy(cam.position)), d = lod.w2src(cam.getWorldDirection(fwd));
  if (CHUNK) { // the frustum's planes in the source frame
    frs.setFromProjectionMatrix(pvs.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(root.matrixWorld));
    frs.planes.forEach((p, i) => { Fr[4 * i] = p.normal.x; Fr[4 * i + 1] = p.normal.y; Fr[4 * i + 2] = p.normal.z; Fr[4 * i + 3] = p.constant; });
  }
  for (const f of finds) {
    const { n, lv } = f.draw ?? { n: f.n, lv: f.lod }; // f.draw: findDraw's (thinned: the band's)
    if (!lv) continue;
    const g = f.pts.geometry;
    if (lv.at) { chunkRanges(lv, o, d, P, f.c.mat.size, (g.userData.rg ??= {})); g.setDrawRange(0, 0); continue; }
    const b = f.b;
    let dmin = Infinity, m = n;
    for (let c = 0; c < 8; c++) dmin = Math.min(dmin, (b[c & 1 ? 3 : 0] - o[0]) * d[0] + (b[c & 2 ? 4 : 1] - o[1]) * d[1] + (b[c & 4 ? 5 : 2] - o[2]) * d[2]);
    // a band is a line, one or two points wide: a cell's point may be ~2.5 cells from the next one along it, so its
    // spacing must stay well under a sprite (LOD_BAND of one; the sprites' floor or their size); an area overlaps anyway
    const lim = lv.band ? LOD_BAND * Math.max(MINPX, (f.c.mat.size * P) / dmin) : LOD_PX;
    if (dmin > 0) { const k = lv.s.findIndex((c) => (c * P) / dmin <= lim); if (k >= 0) m = lv.ends[k]; }
    g.setDrawRange(0, m);
  }
  if (CHUNK) for (const c of C) if (c.on && c.draw?.lv) { const g = c.appPts.geometry; chunkRanges(c.draw.lv, o, d, P, c.mat.size, (g.userData.rg ??= {})); g.setDrawRange(0, 0); }
}
const fr = new THREE.Frustum(), pv = new THREE.Matrix4(), dbs = new THREE.Vector2(), clear = new THREE.Color();
function inView(cam) {
  pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); fr.setFromProjectionMatrix(pv);
  for (const c of C) if (c.on) for (const p of c.g.children) if (fr.intersectsObject(p)) return true;
  return false;
}
// lod.overlays (viewer.html's pivot marker, selinf.js's seed: depthTest off, drawn last): over the composite, not under it
const tops = lod.overlays ?? [], topsOn = [];
function hideTops() { topsOn.length = 0; for (const o of tops) if (o.visible) { o.visible = false; topsOn.push(o); } }
function drawTops(cam) { for (const o of topsOn) { o.visible = true; R.render(o, cam); } }
const gl = R?.getContext(), DB = gl && { scene: [gl.COLOR_ATTACHMENT0, gl.NONE], mask: [gl.NONE, gl.COLOR_ATTACHMENT1] };
function dbMask() { gl.drawBuffers(DB.mask); }
function dbScene() { gl.drawBuffers(DB.scene); }
function afterPts(r, s, c, g) { drawChunks(g); if (INLINE) dbScene(); } // a Points' onAfterRender: its chunks, then the scene's buffers
if (post) lod.renderFrame = () => {
  const { scene, mask, U, quad } = post, cam = lod.camera, ca = R.getClearAlpha();
  R.getDrawingBufferSize(dbs);
  if (dbs.x !== post.w || dbs.y !== post.h) { // PAD: the targets padded to a multiple of 32 px, the picture in their corner
    const w = Math.ceil(dbs.x / PAD) * PAD, h = Math.ceil(dbs.y / PAD) * PAD, f = HALF ? 2 : 1; // f: the mask's downscale
    post.w = dbs.x; post.h = dbs.y; scene.setSize(w, h); scene.viewport.set(0, 0, dbs.x, dbs.y);
    mask?.setSize(w / f, h / f); mask?.viewport.set(0, 0, Math.ceil(dbs.x / f), Math.ceil(dbs.y / f));
  }
  R.info.autoReset = false; R.info.reset(); // the HUD's calls / points: all passes
  root.updateMatrixWorld(); // for inView (the scene's render would do it, after the test)
  const any = inView(cam); // no damage in view: no mask pass (nor its clear, resolve or depth resolve), the composite only copies
  U.logFar.value = Math.log2(cam.far + 1); U.pxPerM.value = (cam.projectionMatrix.elements[5] * dbs.y) / 2;
  if (any && LOD) lodUpdate(cam, U.pxPerM.value);
  R.getClearColor(clear); hideTops();
  if (INLINE) inlinePass(cam, ca, any);
  else {
    scene.resolveDepthBuffer = any;
    root.visible = false; R.setRenderTarget(scene); R.render(lod.scene, cam); root.visible = true;
    R.autoClear = false; // the mask keeps the scene's depth
    if (any) { R.setRenderTarget(mask); R.setClearColor(0, 0); R.clear(true, false, false); R.render(root, cam); R.setClearColor(clear, ca); }
  }
  quad.material = any ? post.shade : post.copy;
  R.setRenderTarget(null); R.render(quad, post.cam);
  drawTops(cam);
  R.autoClear = true;
};

// INLINE: one scene pass draws the bridge into attachment 0 and the damage (after it: transparent, opaque blending) into
// attachment 1 (the points switch the draw buffers around their draws); three then resolves both and builds the mask's mips.
// With no damage in view the mask is neither cleared nor resolved (the target's textures, for that render, are just the first).
function inlinePass(cam, ca, any) {
  const { scene } = post, all = scene.textures, st = R.state.buffers;
  R.setRenderTarget(scene);
  st.color.setMask(true); st.depth.setMask(true);
  if (any) { dbMask(); R.setClearColor(0, 0); R.clear(true, false, false); }
  dbScene(); R.setClearColor(clear, ca); R.clear(true, true, false); // (set while the target is bound: three converts it for the target)
  root.visible = any;
  if (!any) scene.textures = all.slice(0, 1);
  R.autoClear = false;
  R.render(lod.scene, cam);
  scene.textures = all; root.visible = true;
}

// C: the classes ({name, color, voxel, measure, items + total: the app's, g: its group, mat}); app, finds: the two kinds of
// damage ({c, n, m, b, p: [[photo name, box]], img, title, tid}; the app's: s = its run in Q, a find's: xyz = its floats)
let J = null, Q = null, B, S, K, finds = [], opacity = OPACITY, sel = null, selPts = null;
const C = [], app = [], Z = [0, 0, 0], U = [1, 1, 1];
const unitBox = (b) => new THREE.Box3().setFromArray(b.map((v, i) => (v - B[i % 3]) / S[i % 3]));
function points(arr, m, box, quant) { // quant: the app's normalized uint16 in the data box (the GPU dequantises), else floats
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(arr, 3, quant));
  g.boundingSphere = box.getBoundingSphere(new THREE.Sphere()); // no scan of 1.7 M points
  const p = new THREE.Points(g, m);
  if (quant) { p.position.fromArray(B); p.scale.fromArray(S); }
  p.onAfterRender = afterPts; if (INLINE) p.onBeforeRender = dbMask; // INLINE: in the scene pass, into the mask only
  return p;
}
const itemPts = (it, m) => (it.xyz ? points(it.xyz, m, new THREE.Box3().setFromArray(it.b).expandByScalar(0.001), false) // b: to 1 mm
  : points(new Uint16Array(Q.buffer, it.s * 6, it.n * 3), m, unitBox(it.b), true)); // zero-copy views

// ---------- crack thinning: draw only the core of a crack's mask (the segmentation's is 5-10x wider than the crack) ----------
// thin.js (in a Worker) gives every crack point t, its distance to the crack's centreline (0.25 mm steps; 0 = the spine,
// a point every few mm along it, so even the thinnest band is unbroken). A crack's Points get an index of its points
// ordered by t, and draw the first ones: those within the chosen half-width. With the LOD, a find's band then gets its
// own coarse-to-fine order (c2f over the band in t order, so a coarse cell keeps the point nearest the centreline),
// rebuilt when the width changes (the slider: 200 ms after it stops; meanwhile the whole band, in t order).
// The points, the data, the measures, picking and selection keep every point; only fewer are drawn.
const TUNIT = 0.25e-3, THIN = [0, 1, 2, 3, 4, 6, 8, 12, 16, 25, Infinity]; // half-widths, mm; Infinity: every point
const thinQ = qs.get('thin'); // ?thin=<mm> | off
let thinMm = thinQ == null ? 2 : /^(off|full|no)$/i.test(thinQ) ? Infinity : Math.max(0, +thinQ || 0);
const thinURL = new URL('thin.js?v=1', import.meta.url), thinWait = new Map(), tstat = { n: 0, pts: 0, ms: 0, sort: 0, band: 0, t0: 0, t1: 0, prog: 0 };
let thinWorker = null, thinMod = null, thinSeq = 0, bandT = 0;
const cumK = () => Math.min(255, Math.floor((thinMm * 1e-3) / TUNIT + 1e-6) + 1); // cum[cumK()]: the points with t <= thinMm
function thinOrder(t, off, n) { // counting sort by t: {idx: an index attribute, cum[k]: how many have t < k}
  const s = performance.now(), cum = new Uint32Array(257), idx = n < 65536 ? new Uint16Array(n) : new Uint32Array(n);
  for (let i = 0; i < n; i++) cum[t[off + i] + 1]++;
  for (let k = 0; k < 256; k++) cum[k + 1] += cum[k];
  const at = cum.slice(0, 256);
  for (let i = 0; i < n; i++) idx[at[t[off + i]]++] = i;
  tstat.sort += performance.now() - s;
  return { idx: new THREE.BufferAttribute(idx, 1), cum };
}
function thinDraw(g) { // the app's class Points and the selection: g's draw range for thinMm (off: no index, every point as before)
  const d = g?.userData.thin;
  if (!d) return;
  if (thinMm === Infinity) { if (g.index) g.setIndex(null); g.setDrawRange(0, Infinity); return; }
  if (g.index !== d.idx) g.setIndex(d.idx);
  g.setDrawRange(0, d.cum[cumK()]);
}
function band(f) { // a find's band for thinMm, coarse to fine
  const s = performance.now(), d = f.tsort, ids = d.idx.array.subarray(0, d.cum[cumK()]), v = f.c.voxel || 0.005;
  const L = CHUNK ? Object.assign(chunkLod(f.xyz, ids, v, f.b), { band: true }) : null, { order, ends, s: cell } = L ?? c2f(f.xyz, ids, v, f.b);
  f.band = { mm: thinMm, idx: new THREE.BufferAttribute(f.n < 65536 ? Uint16Array.from(order) : order, 1), lod: L ?? { ends, s: cell, band: true } };
  if (L) L.order = null;
  tstat.band += performance.now() - s;
}
function findDraw(f) { // what a find draws: f.draw = {n points of its index, lv: the LOD steps lodUpdate takes a prefix of}
  const g = f.pts?.geometry;
  if (!g) return;
  let idx = null, n = f.n, lv = f.lod ?? null; // not a crack, not thinned (yet), or "puna": its stored order
  if (f.tsort && thinMm !== Infinity) {
    if (f.band?.mm === thinMm) { idx = f.band.idx; n = idx.count; lv = f.band.lod; }
    else { idx = f.tsort.idx; n = f.tsort.cum[cumK()]; lv = null; } // no band for this width (yet): all of it, in t order
  }
  if (g.index !== idx) g.setIndex(idx);
  f.draw = { n, lv }; g.setDrawRange(0, n); if (!lv?.at) g.userData.rg = null; // chunked: lodUpdate sets its ranges
}
// CHUNK, the app's damage: a class's Points draw through an index, chunk after chunk, coarse to fine in each (the class's
// points themselves stay in Q's order: the items are runs in it, for the tap and the selection); thinned, the band's own
// chunked index, as a find's. c.appLod = {all: L, idx, band: {mm, L, idx}}
function appFloats(jc) { // the class's points in metres (the source frame), for chunkLod
  const a = new Float32Array(jc.count * 3);
  for (let i = 0, j = jc.start * 3; i < a.length; i += 3, j += 3) { a[i] = B[0] + Q[j] * K[0]; a[i + 1] = B[1] + Q[j + 1] * K[1]; a[i + 2] = B[2] + Q[j + 2] * K[2]; }
  return a;
}
const idxAttr = (order, n) => new THREE.BufferAttribute(n < 65536 ? Uint16Array.from(order) : order, 1);
function appLod(c, jc) {
  const t = performance.now(), L = chunkLod(appFloats(jc), Uint32Array.from({ length: jc.count }, (_, i) => i), c.voxel || 0.01, B);
  c.appLod = { jc, all: L, idx: idxAttr(L.order, jc.count) }; L.order = null;
  tstat.prog += performance.now() - t;
}
function appBand(c) { // the app class's band for thinMm, chunked
  const s = performance.now(), A = c.appLod, d = c.appPts.geometry.userData.thin, ids = d.idx.array.subarray(0, d.cum[cumK()]);
  const L = Object.assign(chunkLod(appFloats(A.jc), ids, c.voxel || 0.005, B), { band: true });
  A.band = { mm: thinMm, L, idx: idxAttr(L.order, A.jc.count) }; L.order = null;
  tstat.band += performance.now() - s;
}
function appDraw(c) { // as findDraw, for an app class
  const g = c.appPts?.geometry, A = c.appLod, d = g?.userData.thin;
  if (!A) return thinDraw(g);
  let idx = A.idx, n = idx.count, lv = A.all;
  if (d && thinMm !== Infinity) {
    if (A.band?.mm === thinMm) { idx = A.band.idx; n = idx.count; lv = A.band.L; } else { idx = d.idx; n = d.cum[cumK()]; lv = null; }
  }
  if (g.index !== idx) g.setIndex(idx);
  c.draw = { n, lv }; g.setDrawRange(0, n); if (!lv) g.userData.rg = null;
}
function rebands() { // the LOD's bands for thinMm
  clearTimeout(bandT); bandT = 0;
  if (thinMm !== Infinity) for (const f of finds) if (f.tsort && f.band?.mm !== thinMm) band(f);
  if (thinMm !== Infinity) for (const c of C) if (c.appLod && c.appPts.geometry.userData.thin && c.appLod.band?.mm !== thinMm) appBand(c);
  for (const f of finds) findDraw(f);
  for (const c of C) if (c.appLod) appDraw(c);
  dev('thin', thinLine());
}
function thinAll(now) { // thinMm changed
  for (const f of finds) findDraw(f);
  for (const c of C) appDraw(c);
  thinDraw(selPts?.geometry);
  clearTimeout(bandT); bandT = 0;
  if (LOD) { if (now) rebands(); else bandT = setTimeout(rebands, 200); }
}
const thinLine = () => `${tstat.pts.toLocaleString()} pts in ${tstat.n} jobs: ${tstat.ms.toFixed(0)} ms ${thinWorker ? 'worker' : 'main thread'}, ` +
  `${(tstat.t1 - tstat.t0).toFixed(0)} ms wall, sort ${tstat.sort.toFixed(1)} ms` + (LOD ? `, bands ${tstat.band.toFixed(0)} ms` : '');
function thinLocal(id) { // no module Worker (or thin.js failed in one): the same job on this thread
  const w = thinWait.get(id), end = (t) => { thinWait.delete(id); w.res(t); }; // settles even if the job throws
  (thinMod ??= import(thinURL.href)).then((m) => m.job(w.msg)).then(end, (e) => { console.warn('[thin]', e); end(null); });
}
function thinJob(msg, done) { // {pos, runs, voxel, base?, scale?} -> done(t) (null: no thinning); lod.damageBusy until all are done
  if (!tstat.n++) tstat.t0 = performance.now();
  tstat.pts += msg.runs.reduce((a, v, i) => a + (i & 1 ? v : 0), 0);
  lod.damageBusy = true;
  new Promise((res) => {
    const id = ++thinSeq;
    thinWait.set(id, { res, msg });
    if (thinWorker === null) {
      try {
        thinWorker = new Worker(thinURL, { type: 'module' });
        thinWorker.onmessage = (e) => {
          const w = thinWait.get(e.data.id);
          thinWait.delete(e.data.id);
          if (e.data.error) console.warn('[thin]', e.data.error); else tstat.ms += e.data.ms;
          w?.res(e.data.t ?? null);
        };
        thinWorker.onerror = (e) => { e.preventDefault(); thinWorker = false; for (const k of [...thinWait.keys()]) thinLocal(k); };
      } catch { thinWorker = false; }
    }
    if (thinWorker) thinWorker.postMessage({ id, ...msg }); else thinLocal(id);
  }).then((t) => {
    try { done(t); } catch (e) { console.warn('[thin]', e); }
    tstat.t1 = performance.now();
    if (!thinWait.size) { lod.damageBusy = false; dev('thin', thinLine()); }
  });
}
const isCrack = (c) => c.measure === 'length';
function thinFind(it) { // a find's floats (LOD: already coarse to fine), as one item
  if (!isCrack(it.c)) return;
  thinJob({ pos: it.xyz, runs: [0, it.n], voxel: it.c.voxel || 0.005 }, (t) => {
    if (!t || !it.pts) return;
    it.tsort = thinOrder(t, 0, it.n);
    if (LOD && thinMm !== Infinity) band(it);
    findDraw(it);
  });
}
function thinApp(c, jc) { // the app's class run: its items are runs in it (no LOD: one Points per class)
  const runs = [];
  for (const it of J.items) if (J.classes[it.c] === jc) runs.push(it.s - jc.start, it.n);
  thinJob({ pos: Q.slice(jc.start * 3, (jc.start + jc.count) * 3), runs, voxel: c.voxel || 0.005, base: B, scale: K }, (t) => {
    if (!t) return;
    c.appThin = { t, start: jc.start }; c.appPts.geometry.userData.thin = thinOrder(t, 0, jc.count);
    if (c.appLod && thinMm !== Infinity) appBand(c);
    appDraw(c);
    if (sel?.c === c && !sel.xyz) thinSel();
  });
}
function thinSel() { // an app item's selection: the points of its run that its class draws (a find's shares the find's geometry)
  const g = selPts?.geometry, d = sel?.c.appThin;
  if (!g || !d || sel.pts) return;
  g.userData.thin = thinOrder(d.t, sel.s - d.start, sel.n);
  thinDraw(g);
}

// ---------- "Slojevi": the layers popover above its dock tool ----------
const pop = h('div', 'dm dm-pop'), ph = h('div', 'dm-ph1'), px = btn('dm-px', 'Zatvori slojeve', svg(XP));
const msg = h('div', 'dm-msg', LOADING), rows = h('div', 'dm-rows'), ar = h('i', 'dm-ar');
const lab = h('div', 'dm-ol'), val = h('span', 'num'), sl = h('input', 'dm-sl');
Object.assign(sl, { type: 'range', min: 0, max: 100, value: OPACITY * 100 });
sl.setAttribute('aria-label', 'Neprozirnost oštećenja');
sl.oninput = () => {
  opacity = sl.value / 100; val.textContent = pct(opacity); sl.style.setProperty('--p', opacity); // --p: the blue fill
  if (post) post.U.opacity.value = opacity; else for (const m of [selMat, ...C.map((c) => c.mat)]) m.opacity = opacity;
};
sl.oninput(); lab.append('Neprozirnost oštećenja', val);
// "Debljina pukotina": the drawn band's width on the bridge, ~ 2 x the half-width + a point's size; at the end every point
const tlab = h('div', 'dm-ol'), tval = h('span', 'num'), tsl = h('input', 'dm-sl'), n1 = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
Object.assign(tsl, { type: 'range', min: 0, max: THIN.length - 1, step: 1 });
tsl.setAttribute('aria-label', 'Debljina pukotina');
const tshow = () => {
  tsl.value = THIN.reduce((b, v, i) => (Math.abs(v - thinMm) < Math.abs(THIN[b] - thinMm) || v === thinMm ? i : b), 0);
  const crack = C.find(isCrack), size = 1.5 * (crack?.voxel || 0.005) * 1000; // mm, the class points' size
  tval.textContent = thinMm === Infinity ? 'puna' : `${n1((2 * thinMm + size) / 10)} cm`; tsl.style.setProperty('--p', tsl.value / (THIN.length - 1));
  tsl.setAttribute('aria-valuetext', tval.textContent);
};
tsl.oninput = () => { thinMm = THIN[tsl.value]; tshow(); thinAll(); };
tshow(); tlab.append('Debljina pukotina', tval);
lod.thin = { stats: tstat, set: (mm) => { thinMm = mm; tshow(); thinAll(true); } }; // for the bench (--eval): the bands at once
ph.append(h('span', 'cap', 'Klase oštećenja'), px); pop.append(ph, msg, rows, lab, sl, tlab, tsl, ar); document.body.append(pop);
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

function klass(name, o) { // the class called name, made on first use: the palette's defaults, then o (damage.json's / a find's)
  let c = C.find((x) => x.name === name);
  if (c) return c;
  const crack = name === 'Crack', r = h('div', 'dm-row'), eye = btn('dm-eye', ''); // the whole row toggles; the eye is its button
  c = { name, color: CL[name]?.[1] ?? '#828A92', voxel: crack ? 0.005 : 0.01, measure: crack ? 'length' : 'area', items: 0, total: 0, ...o, g: new THREE.Group(), row: r };
  c.mat = classMat(c.color, c.voxel || 0.01, opacity); // both kinds share it
  c.g.renderOrder = crack ? 1 : 0; // POST: the last write wins, cracks over the areas they cross
  r.append(swatch(c.color), h('span', 'dm-nm', hr(c)), (c.ct = h('span', 'num dm-ct')), (c.tot = h('span', 'num dm-tot')), eye);
  c.show = (v) => { // hidden: both kinds, hollow swatch, --t-off text, eye-off
    c.on = c.g.visible = v; r.classList.toggle('off', !v); eye.innerHTML = svg(v ? EYE : EYE + '<path d="M3 3l18 18"/>');
    eye.setAttribute('aria-label', `${v ? 'Sakrij' : 'Prikaži'} klasu ${hr(c)}`);
    if (!v && sel?.c === c) select(null);
  };
  r.onclick = () => c.show(!c.on);
  c.show(true); root.add(c.g); C.push(c);
  const rank = (x) => (ORDER.includes(x.name) ? ORDER.indexOf(x.name) : ORDER.length);
  rows.replaceChildren(...[...C].sort((a, b) => rank(a) - rank(b)).map((x) => x.row)); tally();
  return c;
}
function tally() { // counts and totals: the app's (damage.json) + the finds'
  for (const c of C) {
    let n = c.items, t = n ? c.total : null; // no damage, or none measured: "—"
    for (const f of finds) if (f.c === c) { n++; if (f.m != null) t = (t ?? 0) + f.m; }
    c.ct.textContent = n0(n); c.tot.textContent = fmt(t, c);
  }
  if (finds.length && msg.textContent === NONE) msg.textContent = '';
}

// ---------- loading: damage.json + .bin, found.json + a .bin per find; either may be missing ----------
async function loadJson() { // its classes, then the palette's (also without it)
  try {
    const r = await jsonP;
    if (r.status === 404) return dev('damage', 'no data (run damage.py)'), false;
    if (!r.ok) throw new Error(`damage.json: HTTP ${r.status}`);
    J = await r.json();
    for (const c of J.classes) klass(c.name, c);
    return true;
  } finally { for (const n of ORDER) klass(n); }
}
async function loadBin() {
  dev('damage', `loading ${J.points.toLocaleString()} points...`);
  const br = await binP;
  if (!br.ok) throw new Error(`damage.bin: HTTP ${br.status}`);
  const buf = await br.arrayBuffer();
  if (buf.byteLength !== J.points * 6) throw new Error(`damage.bin: ${buf.byteLength} B, expected ${J.points * 6}`);
  Q = new Uint16Array(buf);
  B = J.box.slice(0, 3); S = B.map((v, i) => Math.max(J.box[i + 3] - v, 1e-6)); K = S.map((s) => s / 65535);
  for (const jc of J.classes) {
    if (!jc.count) continue;
    const c = klass(jc.name);
    c.g.add((c.appPts = points(new Uint16Array(buf, jc.start * 6, jc.count * 3), c.mat, unitBox(J.box), true)));
    if (CHUNK) { appLod(c, jc); appDraw(c); }
    if (isCrack(c)) thinApp(c, jc);
  }
  J.items.forEach((it, i) => app.push({ ...it, c: klass(J.classes[it.c].name), p: it.p.map(([k, ...r]) => [J.photos[k], ...r]),
    img: `${BASE}img/${i}_`, title: String(it.id), tid: `C-${it.id}` }));
  dev('damage', `${J.items.length.toLocaleString()} items · ${(J.points / 1e6).toFixed(2)} M points`);
}
const classes = loadJson();
const appDone = classes.then((ok) => ok && loadBin()).catch(fail('damage'));

async function loadFind(f) {
  const r = await get(`${FOUND}${f.id}.bin`);
  if (!r.ok) throw new Error(`${f.id}.bin: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength !== f.n * 12) throw new Error(`${f.id}.bin: ${buf.byteLength} B, expected ${f.n * 12}`);
  const id = f.id.toUpperCase(), it = { ...f, xyz: new Float32Array(buf), c: klass(f.class, { voxel: f.voxel, measure: f.measure }),
    img: `${FOUND}img/${f.id}_`, title: id, tid: id };
  if (LOD) progressive(it);
  it.pts = itemPts(it, it.c.mat);
  thinFind(it);
  return it;
}
function drop(gone) { // finds no longer in the store
  for (const f of gone) { if (sel === f) select(null); f.c.g.remove(f.pts); f.pts.geometry.dispose(); }
  finds = finds.filter((f) => !gone.includes(f)); tally();
}
const key = (f) => `${f.id} ${f.time}`; // ids are not reused; a wiped store could
async function sync(rp) { // found.json is the truth: keep the loaded finds, load the new ones, drop the rest
  await classes.catch(() => {});
  const r = await (rp ?? get(FOUND + 'found.json'));
  if (!r.ok && r.status !== 404) throw new Error(`found.json: HTTP ${r.status}`); // 404: no finds yet
  const list = r.ok ? (await r.json()).items : [], old = new Map(finds.map((f) => [key(f), f])), errs = [];
  const now = (await Promise.all(list.map((f) => old.get(key(f)) ?? loadFind(f).catch((e) => void errs.push(e.message))))).filter(Boolean);
  drop(finds.filter((f) => !now.includes(f)));
  for (const f of now) if (!f.pts.parent) f.c.g.add(f.pts);
  finds = now; tally(); dev('found', `${finds.length} items`);
  if (errs.length) throw new Error(errs.join(', '));
}
let queue = Promise.resolve();
const syncFound = (rp) => (queue = queue.then(() => sync(rp)).catch(fail('found'))); // one at a time
Promise.all([classes.catch(() => true), appDone, syncFound(foundP)]).then(([ok]) => {
  if (msg.textContent === LOADING) msg.textContent = '';
  if (ok || finds.length) unhint(); else say(NONE, 'damage', 'no data (run damage.py)', 8000);
});

// selinf.js saved a find (and maybe replaced older ones of it): show it and open it
addEventListener('lod-found', (e) => {
  const { found, replaced = [] } = e.detail || {};
  drop(finds.filter((f) => replaced.includes(f.id)));
  syncFound().then(() => {
    const f = found && finds.find((x) => x.id === found.id);
    if (f) { f.c.on || f.c.show(true); select(f); }
  });
});
async function del(f, b) {
  if (!confirm('Obrisati ovo oštećenje?')) return;
  b.disabled = true;
  try { // text/plain body: no CORS preflight
    const r = await fetch(API + '/found/delete', { method: 'POST', body: JSON.stringify({ id: f.id }) }).catch(() => { throw new Error('server ne odgovara'); });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    drop([f]); await syncFound(); // drop: closes the inspector
  } catch (e) { b.disabled = false; ui.hint(`Brisanje nije uspjelo: ${e.message}`, 8000); }
}

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
const missed = () => { clearTimeout(miss); miss = setTimeout(() => select(null), 350); };
lod.el.addEventListener('pointerup', (e) => {
  const d = tap;
  tap = null;
  if (!d || d.id !== e.pointerId || e.altKey || lod.inferArmed || !(app.length || finds.length)) return; // armed: selinf.js's tap
  const mouse = e.pointerType === 'mouse';
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= (mouse ? 5 : 10) || performance.now() - d.t >= 500) return;
  const ndc = lod.ndcOf(e), hit = lod.pick(ndc);
  if (!hit) return missed();
  const best = pickDamage(ndc, mouse, hit.distance);
  if (!best) return missed();
  select(best);
});
// the damage point nearest the tap ON SCREEN (a 3D radius at the hit shrinks to a pixel in grazing views), among the
// points not behind the surface: t <= the hit's depth + the 1 % the depth pull shows through, + 2 cm. An item is scanned
// only if the ray meets its box (padded by the tap's radius at tmax); a chunked find only in the chunks the ray meets
function pickDamage(ndc, mouse, dist) {
  caster.setFromCamera(ndc, lod.camera);
  const o = lod.w2src(caster.ray.origin), dir = lod.w2src(caster.ray.direction);
  sray.origin.fromArray(o); sray.direction.fromArray(dir);
  const k = (2 * Math.tan((lod.camera.fov * Math.PI) / 360)) / lod.el.clientHeight; // px size / depth
  const rp = mouse ? 8 : 16, tmax = dist * 1.02 + 0.02, pad = rp * k * tmax; // a fingertip is less precise than a cursor
  const meets = (b, q) => {
    ibox.min.set(b[q] - pad, b[q + 1] - pad, b[q + 2] - pad); ibox.max.set(b[q + 3] + pad, b[q + 4] + pad, b[q + 5] + pad);
    return ibox.containsPoint(sray.origin) || (sray.intersectBox(ibox, at) && at.distanceTo(sray.origin) <= tmax);
  };
  let best = null, bs = rp * rp;
  const scan = (it, A, j0, end, b0, s0) => { // point j = b0 + A[j] * s0: a find's floats, the app's run
    for (let j = j0; j < end; j += 3) {
      const x = b0[0] + A[j] * s0[0] - o[0], y = b0[1] + A[j + 1] * s0[1] - o[1], z = b0[2] + A[j + 2] * s0[2] - o[2];
      const t = x * dir[0] + y * dir[1] + z * dir[2];
      if (t <= 0 || t > tmax) continue;
      const s2 = (x * x + y * y + z * z - t * t) / (k * k * t * t); // squared screen distance, px
      if (s2 < bs) { bs = s2; best = it; }
    }
  };
  for (const it of app.concat(finds)) {
    if (!it.c.on || (!it.xyz && it.c.appLod) || !meets(it.b, 0)) continue; // a chunked app class: below
    const L = it.xyz && it.lod?.at ? it.lod : null;
    if (L) { for (let c = 0; c < L.n; c++) if (meets(L.box, c * 6)) for (let i = c; i < L.at.length - 1; i += L.n) scan(it, it.xyz, L.at[i] * 3, L.at[i + 1] * 3, Z, U); }
    else if (it.xyz) scan(it, it.xyz, 0, it.n * 3, Z, U);
    else scan(it, Q, it.s * 3, (it.s + it.n) * 3, B, K);
  }
  // a chunked app class: the points of the chunks the ray meets, through its index (Q's order stays); the item: the run
  // holding the point (its items sorted by start)
  for (const c of C) {
    const A = c.appLod;
    if (!A || !c.on) continue;
    const L = A.all, ix = A.idx.array, s0 = A.jc.start, its = (A.items ??= app.filter((it) => it.c === c).sort((p, q) => p.s - q.s));
    for (let ch = 0; ch < L.n; ch++) {
      if (!meets(L.box, ch * 6)) continue;
      for (let i = ch; i < L.at.length - 1; i += L.n) for (let e = L.at[i], end = L.at[i + 1]; e < end; e++) {
        const p = s0 + ix[e], j = p * 3, x = B[0] + Q[j] * K[0] - o[0], y = B[1] + Q[j + 1] * K[1] - o[1], z = B[2] + Q[j + 2] * K[2] - o[2];
        const t = x * dir[0] + y * dir[1] + z * dir[2];
        if (t <= 0 || t > tmax) continue;
        const s2 = (x * x + y * y + z * z - t * t) / (k * k * t * t);
        if (s2 >= bs) continue;
        let lo = 0, hi = its.length - 1; // the last item starting at or before p
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (its[mid].s <= p) lo = mid; else hi = mid - 1; }
        bs = s2; best = its[lo];
      }
    }
  }
  return best;
}
// for the bench's probe (bench/lod_probe.py): the LOD's parts, the finds and the tap's scan
lod.dm = { finds: () => finds, app: () => ({ app, Q, B, K }), C, chunkLod, c2f, chunkRanges, lodUpdate, pickDamage, tstat, Fr, cumK, isCrack,
  knobs: { LOD, LOD_PX, LOD_BAND, LV, CHUNK, MINPX, MD: !!MD, thinMm: () => thinMm } };
lod.selectDamage = (tid) => select(app.concat(finds).find((x) => x.tid === tid) ?? null); // for the bench (--eval): 'P9', 'C-4'

function select(it) {
  if (it === sel) return; // e.g. the double-click/tap that sets the pivot: keep the panel and its scroll
  if (selPts) { selPts.parent?.remove(selPts); if (!sel?.pts) selPts.geometry.dispose(); selPts = null; }
  sel = it;
  closeView();
  if (!it) return void (panel.style.display = 'none');
  selMat.color.copy(selColor(it.c)); selMat.size = it.c.mat.size;
  if (it.pts) { // a find: its own Points' geometry (its index, thinned band and LOD draw range), so exactly its points
    selPts = new THREE.Points(it.pts.geometry, selMat);
    selPts.onBeforeRender = it.pts.onBeforeRender; selPts.onAfterRender = it.pts.onAfterRender;
  } else { selPts = itemPts(it, selMat); thinSel(); } // the app's: a view of its run in the class's points
  selPts.renderOrder = 1; // in its class's group, just after the class's points
  it.c.g.add(selPts);
  showPanel(it, it.c);
}

// ---------- inspector: right on wide screens, a bottom sheet above the dock on phones ----------
const panel = h('div', 'dm dm-insp');
panel.style.display = 'none'; document.body.append(panel);
let techOpen = false; // "Tehnički podaci" stays as the user left it

const src = (k) => `${sel.img}${k}.jpg`;
function crop(k, color, f = h('div', 'dm-ph')) { // photo k's crop in f, with the damage's box (fractions of the crop) over it
  const [, x0, y0, x1, y1] = sel.p[k], img = h('img'), b = h('span', 'dm-bx');
  img.alt = ''; img.src = src(k);
  img.onerror = () => { img.replaceWith(h('span', 'dm-err', 'Fotografija se nije učitala.')); b.remove(); };
  Object.assign(b.style, { left: x0 * 100 + '%', top: y0 * 100 + '%', width: (x1 - x0) * 100 + '%', height: (y1 - y0) * 100 + '%', borderColor: color });
  f.append(img, b);
  return f;
}
function showPanel(it, c) {
  const head = h('div', 'dm-head'), x = btn('dm-x', 'Zatvori', svg(XP)), ms = h('div', 'dm-ms'), n = it.p.length;
  x.onclick = () => select(null);
  head.append(swatch(c.color), h('h2', '', `${hr(c)} ${it.title}`), x);
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
  kv('ID oštećenja', it.tid); kv('Točke', n0(it.n)); kv('Izvor', it.xyz ? `prepoznavanje · ${it.time}` : 'aplikacija');
  if (n) kv('Fotografije', ...it.p.map((p) => p[0]));
  tech.append(sm, dl); tech.open = techOpen; tech.ontoggle = () => (techOpen = tech.open);
  panel.replaceChildren(head, ms, tile, tech);
  if (it.xyz) { const b = h('button', 'dm-del', 'Obriši oštećenje'); b.type = 'button'; b.onclick = () => del(it, b); panel.append(b); }
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
  const it = sel, c = it.c, n = it.p.length;
  if (vk < 0) { // opening: this item's chip and filmstrip
    chip.replaceChildren(swatch(c.color), `${hr(c)} ${it.title}`);
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
  cap.textContent = it.p[vk][0]; cnt.textContent = `${vk + 1} od ${n}`;
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
  else if (esc && sel && !lod.inferArmed) { select(null); e.stopPropagation(); } // armed: Esc disarms first
}, true);
