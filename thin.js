// Crack thinning: for every point of a crack, its distance to the crack's centreline, so damage.js can draw only the core
// of the photo segmentation's mask (drawn 5-10x wider than the crack). The points themselves are never changed: damage.js
// only orders them by this distance (a GPU index) and draws the ones within the chosen half-width.
// Per crack item, as lynceus measures a crack's length (damage_measure.crack_length_m, unwrap_vector.crack_centrelines):
// the points in their best-fit plane (PCA), rasterised at the class voxel, a 1-cell closing, Zhang-Suen thinning and a
// simple-point cleanup -> a 1-px skeleton; spurs (a dead end shorter than ~2 local half-widths, from a bump of the mask's
// edge) pruned, the dead ends then extended along the crack to the mask's edge, the branches smoothed; then each point's
// distance to that polyline network. Runs in a module Worker (damage.js) and in node (test_thin.mjs).

export const UNIT = 0.25e-3, FAR = 255; // t is in UNIT steps (0.25 mm); FAR: farther than 254 steps (63.5 mm)
const T_MAX = 254 * UNIT, MAX_PX = 1 << 22; // a bigger raster gets a coarser cell

function eig3(c) { // symmetric 3x3 (row-major) -> [eigenvalues, eigenvectors as columns of V], Jacobi
  const A = [[c[0], c[1], c[2]], [c[3], c[4], c[5]], [c[6], c[7], c[8]]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2, diag = A[0][0] ** 2 + A[1][1] ** 2 + A[2][2] ** 2;
    if (off <= 1e-24 * diag || off === 0) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (A[p][q] === 0) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = cs * a - sn * b; A[k][q] = sn * a + cs * b; }
      for (let k = 0; k < 3; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = cs * a - sn * b; A[q][k] = sn * a + cs * b; }
      for (let k = 0; k < 3; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = cs * a - sn * b; V[k][q] = sn * a + cs * b; }
    }
  }
  return [[A[0][0], A[1][1], A[2][2]], V];
}

// (n, 3) points -> (n, 2) in their best-fit plane (the two largest principal axes, centred on the mean)
export function planeUV(P, n) {
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < 3 * n; i += 3) { mx += P[i]; my += P[i + 1]; mz += P[i + 2]; }
  mx /= n; my /= n; mz /= n;
  const c = new Float64Array(9);
  for (let i = 0; i < 3 * n; i += 3) {
    const x = P[i] - mx, y = P[i + 1] - my, z = P[i + 2] - mz;
    c[0] += x * x; c[1] += x * y; c[2] += x * z; c[4] += y * y; c[5] += y * z; c[8] += z * z;
  }
  c[3] = c[1]; c[6] = c[2]; c[7] = c[5];
  const [w, V] = eig3(c), o = [0, 1, 2].sort((a, b) => w[b] - w[a]), [a, b] = [o[0], o[1]];
  const uv = new Float64Array(2 * n);
  for (let i = 0, j = 0; i < 3 * n; i += 3, j += 2) {
    const x = P[i] - mx, y = P[i + 1] - my, z = P[i + 2] - mz;
    uv[j] = x * V[0][a] + y * V[1][a] + z * V[2][a]; uv[j + 1] = x * V[0][b] + y * V[1][b] + z * V[2][b];
  }
  return uv;
}

// Yokoi's 8-connectivity number of pixel p (1: removing p keeps the skeleton's connectivity) and its 8-neighbour count
function nbrs(img, p, W) { // x1..x8: E, NE, N, NW, W, SW, S, SE
  return [img[p + 1], img[p - W + 1], img[p - W], img[p - W - 1], img[p - 1], img[p + W - 1], img[p + W], img[p + W + 1]];
}
function simple(x) {
  let n = 0;
  for (let k = 0; k < 8; k += 2) { const a = 1 - x[k], b = 1 - x[k + 1], c = 1 - x[(k + 2) & 7]; n += a - a * b * c; }
  return n === 1;
}

// the 1-px skeleton of img (1 = foreground, 0 elsewhere, a clear border), in place; layer[p]: the pass that removed p,
// i.e. ~ its distance to the background in cells
function skeleton(img, W, fg, layer) {
  let list = fg;
  for (let pass = 1, changed = true; changed && pass < 65535; pass++) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del = [];
      for (const p of list) {
        if (!img[p]) continue;
        const P2 = img[p - W], P3 = img[p - W + 1], P4 = img[p + 1], P5 = img[p + W + 1], P6 = img[p + W], P7 = img[p + W - 1];
        const P8 = img[p - 1], P9 = img[p - W - 1], B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9;
        if (B < 2 || B > 6) continue;
        const A = (!P2 && P3) + (!P3 && P4) + (!P4 && P5) + (!P5 && P6) + (!P6 && P7) + (!P7 && P8) + (!P8 && P9) + (!P9 && P2);
        if (A !== 1) continue;
        if (step === 0 ? P2 * P4 * P6 || P4 * P6 * P8 : P2 * P4 * P8 || P2 * P6 * P8) continue;
        del.push(p);
      }
      for (const p of del) { img[p] = 0; layer[p] = pass; }
      if (del.length) changed = true;
    }
    list = list.filter((p) => img[p]);
  }
  // Zhang-Suen leaves 2-px staircases and corner pixels: drop every simple pixel that is not a dead end
  for (let changed = true; changed;) {
    changed = false;
    for (const p of list) {
      if (!img[p]) continue;
      const x = nbrs(img, p, W), B = x[0] + x[1] + x[2] + x[3] + x[4] + x[5] + x[6] + x[7];
      if (B >= 2 && simple(x)) { img[p] = 0; changed = true; }
    }
    list = list.filter((p) => img[p]);
  }
  return list;
}

const deg = (img, p, W) => img[p + 1] + img[p - W + 1] + img[p - W] + img[p - W - 1] + img[p - 1] + img[p + W - 1] + img[p + W] + img[p + W + 1];
function walk(img, W, a, b, D8) { // from node a through b along degree-2 pixels to the next node -> [a, b, ..., node]
  const path = [a, b];
  for (let prev = a, cur = b; deg(img, cur, W) === 2;) {
    let next = -1;
    for (const d of D8) if (img[cur + d] && cur + d !== prev) { next = cur + d; break; }
    if (next < 0 || next === a) { if (next === a) path.push(a); break; }
    path.push(next); prev = cur; cur = next;
    if (path.length > 1e7) break;
  }
  return path;
}
const steps = (path, W) => { let L = 0; for (let i = 1; i < path.length; i++) { const d = Math.abs(path[i] - path[i - 1]); L += d === 1 || d === W ? 1 : Math.SQRT2; } return L; };

// distance (metres) from each of the n points P (xyz) to the centreline of the crack they make: t[i] in UNIT steps
// (FAR: beyond 63.5 mm). voxel: the class's bake voxel; the raster cell. Returns t (and, for tests, o.paths: the
// centreline polylines in plane coordinates, and o.uv: the points in them).
export function centreDist(P, n, voxel, t = new Uint8Array(n), o = {}) {
  if (n === 0) return t;
  if (n < 3) { t.fill(0); return t; }
  const uv = planeUV(P, n);
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let j = 0; j < 2 * n; j += 2) { u0 = Math.min(u0, uv[j]); u1 = Math.max(u1, uv[j]); v0 = Math.min(v0, uv[j + 1]); v1 = Math.max(v1, uv[j + 1]); }
  const PAD = 3;
  let c = o.cell ?? voxel, W, H;
  for (;;) {
    W = Math.ceil((u1 - u0) / c) + 1 + 2 * PAD; H = Math.ceil((v1 - v0) / c) + 1 + 2 * PAD;
    if (W * H <= MAX_PX) break;
    c *= Math.sqrt((W * H) / MAX_PX) * 1.01;
  }
  const ox = u0 - PAD * c, oy = v0 - PAD * c, N = W * H;
  const D8 = [1, -W + 1, -W, -W - 1, -1, W - 1, W, W + 1], pix = new Int32Array(n), occ = new Uint8Array(N), tmp = new Uint8Array(N);
  for (let i = 0, j = 0; i < n; i++, j += 2) { const p = Math.floor((uv[j + 1] - oy) / c) * W + Math.floor((uv[j] - ox) / c); pix[i] = p; occ[p] = 1; }
  // closing (3x3 dilate, then 3x3 erode): fills the 1-cell holes between points; never removes a cell
  for (let y = 1; y < H - 1; y++) for (let x = 1, p = y * W + 1; x < W - 1; x++, p++) tmp[p] = occ[p - 1] | occ[p] | occ[p + 1];
  for (let y = 1; y < H - 1; y++) for (let x = 1, p = y * W + 1; x < W - 1; x++, p++) occ[p] = tmp[p - W] | tmp[p] | tmp[p + W];
  for (let y = 1; y < H - 1; y++) for (let x = 1, p = y * W + 1; x < W - 1; x++, p++) tmp[p] = occ[p - 1] & occ[p] & occ[p + 1];
  const fg = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1, p = y * W + 1; x < W - 1; x++, p++) { occ[p] = tmp[p - W] & tmp[p] & tmp[p + W]; if (occ[p]) fg.push(p); }
  // holes: background the border cannot reach (4-connected); the small ones (up to ~5 x 5 cm) are gaps in the mask,
  // not cells enclosed by cracks: filled, so the centreline makes no loop around them
  const holeMax = o.holeMax ?? Math.round((0.05 / c) ** 2);
  if (holeMax > 0) {
    tmp.fill(0); // 1: outside, 2: a hole's
    const st = [];
    for (let x = 0; x < W; x++) st.push(x, (H - 1) * W + x);
    for (let y = 0; y < H; y++) st.push(y * W, y * W + W - 1);
    while (st.length) {
      const p = st.pop();
      if (p < 0 || p >= N || tmp[p] || occ[p]) continue;
      tmp[p] = 1;
      const x = p % W;
      if (x > 0) st.push(p - 1);
      if (x < W - 1) st.push(p + 1);
      st.push(p - W, p + W);
    }
    for (let p = 0; p < N; p++) {
      if (occ[p] || tmp[p]) continue;
      const hole = [], q = [p];
      tmp[p] = 2;
      while (q.length) { const a = q.pop(); hole.push(a); for (const b of [a - 1, a + 1, a - W, a + W]) if (!occ[b] && !tmp[b]) { tmp[b] = 2; q.push(b); } }
      if (hole.length <= holeMax) for (const a of hole) { occ[a] = 1; fg.push(a); }
    }
  }
  const mask = occ.slice(), layer = new Uint16Array(N), img = occ; // img: thinned in place; mask: the closed mask
  let sk = skeleton(img, W, fg, layer);
  const half = (p) => { // a skeleton pixel's half-width (metres): the deepest layer around it
    let m = 0;
    for (const d of D8) m = Math.max(m, layer[p + d]);
    return (m + 0.5) * c;
  };
  // spurs: a dead end to a junction, shorter than 2 half-widths at the junction (+1 cell), all cut at once. Once only:
  // a forked tip loses both prongs and its junction becomes the dead end, which must not be cut in turn (it would eat
  // the crack back to the next junction); the extension below takes the new end to the mask's edge
  const spurK = o.spurK ?? 2, cut = [];
  for (const e of sk) {
    if (deg(img, e, W) !== 1) continue;
    let b = -1;
    for (const d of D8) if (img[e + d]) b = e + d;
    const path = walk(img, W, e, b, D8), j = path[path.length - 1];
    if (deg(img, j, W) >= 3 && steps(path, W) * c < spurK * half(j) + c) cut.push(path.slice(0, -1));
  }
  for (const path of cut) for (const p of path) img[p] = 0;
  sk = sk.filter((p) => img[p]);
  // branches: node to node (nodes: degree != 2), then the loops left over
  const xy = (p) => [ox + ((p % W) + 0.5) * c, oy + (Math.floor(p / W) + 0.5) * c];
  const seen = new Uint8Array(N), paths = [];
  for (const a of sk) {
    if (deg(img, a, W) === 2) continue;
    if (deg(img, a, W) === 0) { paths.push([a]); continue; }
    for (const d of D8) {
      const b = a + d;
      if (!img[b] || (deg(img, b, W) === 2 && seen[b])) continue;
      const path = walk(img, W, a, b, D8);
      for (let i = 1; i < path.length - 1; i++) seen[path[i]] = 1;
      paths.push(path);
    }
  }
  for (const a of sk) {
    if (seen[a] || deg(img, a, W) !== 2) continue;
    let b = -1;
    for (const d of D8) if (img[a + d]) { b = a + d; break; }
    const path = walk(img, W, a, b, D8);
    for (const p of path) seen[p] = 1;
    paths.push(path);
  }
  // centre (thinning leaves the skeleton up to a cell off the middle of an even-width band): each vertex moved along its
  // normal to halfway between the mask's two edges, unless a ray runs into another branch; then smooth (moving average
  // over +-m cells, nodes fixed), and the dead ends extended along the crack to the mask's edge
  const inMask = (x, y) => mask[Math.floor((y - oy) / c) * W + Math.floor((x - ox) / c)] === 1;
  const edge = (x, y, dx, dy, lim) => { let s = 0; while (s < lim && inMask(x + dx * (s + c / 4), y + dy * (s + c / 4))) s += c / 4; return s + c / 8; };
  const m = o.smooth ?? 2, lines = [];
  for (const path of paths) {
    let q = path.map(xy);
    const k = q.length;
    if (o.centre !== false) {
      const cq = q.map((v) => v.slice());
      for (let i = 1; i < k - 1; i++) {
        const a = q[Math.max(0, i - 2)], b = q[Math.min(k - 1, i + 2)], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!L) continue;
        const nx = (a[1] - b[1]) / L, ny = (b[0] - a[0]) / L, hw = half(path[i]), lim = 2 * hw + c;
        const dp = edge(q[i][0], q[i][1], nx, ny, lim), dm = edge(q[i][0], q[i][1], -nx, -ny, lim);
        if (Math.max(dp, dm) >= lim) continue;
        const sh = Math.max(-c, Math.min(c, (dp - dm) / 2));
        cq[i] = [q[i][0] + sh * nx, q[i][1] + sh * ny];
      }
      q = cq;
    }
    const s = q.map((v) => v.slice());
    for (let i = 1; i < k - 1; i++) {
      const r = Math.min(m, i, k - 1 - i);
      let sx = 0, sy = 0;
      for (let j = i - r; j <= i + r; j++) { sx += q[j][0]; sy += q[j][1]; }
      s[i] = [sx / (2 * r + 1), sy / (2 * r + 1)];
    }
    if (o.extend !== false && k >= 3) {
      for (const [end, back] of [[0, 1], [k - 1, -1]]) {
        if (deg(img, path[end], W) !== 1) continue;
        const from = s[Math.max(0, Math.min(k - 1, end + back * Math.max(2, Math.round(half(path[end]) / c))))];
        let dx = s[end][0] - from[0], dy = s[end][1] - from[1];
        const L = Math.hypot(dx, dy);
        if (!L) continue;
        dx /= L; dy /= L;
        let x = s[end][0], y = s[end][1];
        for (let g = 0; g < 400; g++) {
          const nx = x + dx * c * 0.5, ny = y + dy * c * 0.5, p = Math.floor((ny - oy) / c) * W + Math.floor((nx - ox) / c);
          if (!mask[p]) break;
          x = nx; y = ny;
        }
        if (end === 0) s.unshift([x, y]); else s.push([x, y]);
      }
    }
    lines.push(s);
  }
  o.paths = lines; o.uv = uv; o.cell = c;
  // each point's distance to the nearest segment: a grid of segments (bins of G), searched ring by ring
  const G = 4 * c, gw = Math.ceil((W * c) / G) + 1, gh = Math.ceil((H * c) / G) + 1, cnt = new Int32Array(gw * gh + 1);
  const seg = [];
  for (const s of lines) {
    if (s.length === 1) seg.push(s[0][0], s[0][1], s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) seg.push(s[i - 1][0], s[i - 1][1], s[i][0], s[i][1]);
  }
  const S = Float64Array.from(seg), ns = S.length / 4, gx = (x) => Math.floor((x - ox) / G), gy = (y) => Math.floor((y - oy) / G);
  const each = (k, fn) => {
    const ax = gx(Math.min(S[4 * k], S[4 * k + 2])), ay = gy(Math.min(S[4 * k + 1], S[4 * k + 3]));
    const bx = gx(Math.max(S[4 * k], S[4 * k + 2])), by = gy(Math.max(S[4 * k + 1], S[4 * k + 3]));
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) fn(y * gw + x);
  };
  for (let k = 0; k < ns; k++) each(k, (b) => cnt[b + 1]++);
  for (let b = 0; b < gw * gh; b++) cnt[b + 1] += cnt[b];
  const fill = cnt.slice(0, -1), ids = new Int32Array(cnt[gw * gh]);
  for (let k = 0; k < ns; k++) each(k, (b) => (ids[fill[b]++] = k));
  const rings = Math.ceil(T_MAX / G) + 1;
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const px = uv[j], py = uv[j + 1], bx = gx(px), by = gy(py);
    let best = Infinity;
    for (let r = 0; r <= rings; r++) {
      for (let y = by - r; y <= by + r; y++) {
        if (y < 0 || y >= gh) continue;
        const edge = y === by - r || y === by + r;
        for (let x = bx - r; x <= bx + r; x += edge || r === 0 ? 1 : 2 * r) {
          if (x < 0 || x >= gw) continue;
          for (let q = cnt[y * gw + x], e = cnt[y * gw + x + 1]; q < e; q++) {
            const k = 4 * ids[q], ax = S[k], ay = S[k + 1], dx = S[k + 2] - ax, dy = S[k + 3] - ay, L2 = dx * dx + dy * dy;
            const f = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
            const ex = ax + f * dx - px, ey = ay + f * dy - py, d2 = ex * ex + ey * ey;
            if (d2 < best) best = d2;
          }
        }
      }
      if (Math.sqrt(best) <= r * G || r * G > T_MAX) break;
    }
    const d = Math.sqrt(best);
    t[i] = d > T_MAX ? FAR : Math.round(d / UNIT);
  }
  // the spine: the point nearest each half-cell step along the centreline gets t = 0, so even the thinnest band has a
  // point every few mm (the points are ~5 mm apart, irregularly: a band of +-3 mm alone would break into dashes)
  if (o.spine !== false) {
    const pc = new Int32Array(gw * gh + 1);
    for (let j = 0; j < 2 * n; j += 2) pc[gy(uv[j + 1]) * gw + gx(uv[j]) + 1]++;
    for (let b = 0; b < gw * gh; b++) pc[b + 1] += pc[b];
    const pf = pc.slice(0, -1), pi = new Int32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 2) pi[pf[gy(uv[j + 1]) * gw + gx(uv[j])]++] = i;
    const near = (sx, sy) => { // the nearest point within G of (sx, sy), or -1
      const bx = gx(sx), by = gy(sy);
      let best = G * G, k = -1;
      for (let y = Math.max(0, by - 1); y <= Math.min(gh - 1, by + 1); y++) for (let x = Math.max(0, bx - 1); x <= Math.min(gw - 1, bx + 1); x++) {
        for (let q = pc[y * gw + x], e = pc[y * gw + x + 1]; q < e; q++) {
          const i = pi[q], dx = uv[2 * i] - sx, dy = uv[2 * i + 1] - sy, d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; k = i; }
        }
      }
      return k;
    };
    for (let k = 0; k < ns; k++) {
      const ax = S[4 * k], ay = S[4 * k + 1], dx = S[4 * k + 2] - ax, dy = S[4 * k + 3] - ay, m = Math.ceil(Math.hypot(dx, dy) / (0.5 * c));
      for (let q = 0; q <= m; q++) { const i = near(ax + (dx * q) / Math.max(m, 1), ay + (dy * q) / Math.max(m, 1)); if (i >= 0) t[i] = 0; }
    }
  }
  return t;
}

// a Worker's job: {id, pos: Float32Array xyz | Uint16Array (quantised: p = base + v * scale), runs: [start, count, ...]
// in points, voxel, base, scale} -> {id, t: Uint8Array (FAR outside the runs), ms}
export function job({ pos, runs, voxel, base, scale }) {
  const t = new Uint8Array(pos.length / 3).fill(FAR), q = pos instanceof Uint16Array;
  let buf = new Float64Array(0);
  for (let r = 0; r < runs.length; r += 2) {
    const s = runs[r], n = runs[r + 1];
    if (buf.length < 3 * n) buf = new Float64Array(3 * n);
    for (let i = 0, k = 3 * s; i < 3 * n; i++, k++) buf[i] = q ? base[i % 3] + pos[k] * scale[i % 3] : pos[k];
    centreDist(buf, n, voxel, t.subarray(s, s + n));
  }
  return t;
}
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = (e) => {
    const t0 = performance.now();
    try {
      const t = job(e.data);
      globalThis.postMessage({ id: e.data.id, t, ms: performance.now() - t0 }, [t.buffer]);
    } catch (err) { globalThis.postMessage({ id: e.data.id, error: String(err?.stack || err) }); }
  };
}
