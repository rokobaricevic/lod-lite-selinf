// faces.cpp -- element faces: the flat faces of the bake mesh inside a box. A pybind11 module `faces_core`.
//
// WHAT IT IS. The owner draws an oriented box around a bridge element (a girder, a pier...) in the viewer; POST /faces
// (selinf.py) asks this module to split the mesh surface inside it into flat faces (soffit, webs, flanges...), which the
// viewer's faces.js draws. They are only displayed, never saved. Faces(V, F) is built once from the Survey's bake mesh
// (selinf_core's Survey.mesh(): the bake frame, Z-up, metres): the vertices as float32 relative to the mesh's bbox
// centre (a double origin, so the precision holds at large coordinates), the triangles as int32, and per triangle its
// unit normal, area and centre. No Embree, nothing shared with selinf.cpp, no threads, no per-triangle allocation.
//
// THE ALGORITHM. split(center, axes, half, angle_deg=20, gap_m=0.05, cell_m=0.05, min_area_m2=0.05), the box's centre,
// axes (3 orthonormal rows) and half-sizes in the bake frame:
//   1. the triangles whose centre is inside the box: one linear pass over the centres;
//   2. the main directions, by area: the normals binned on a cube map (6 x 8 x 8); from the heaviest bin's mean
//      normal, twice the area-weighted mean of the unassigned normals within angle_deg of it; those within angle_deg
//      of the result are its triangles. Until the unassigned area is < min_area_m2 (no face can be left in it) or 16
//      directions; the rest is dropped. (Not "until < 5 % is unassigned": that drops real faces, e.g. a 1 x 2 x 10 m
//      beam's end cap, 3 % of its area. Noise is rejected per face, in 4.);
//   3. per direction, the planes: an area histogram of the offsets n.c in 1 cm bins, split wherever >= gap_m is
//      empty; each run is a plane, its normal the area-weighted mean of its triangles' normals, d = that normal . their
//      area-weighted mean centre;
//   4. per plane (of >= min_area_m2): u = the box axis closest to the plane, v = n x u; a grid of cell_m (whole
//      millimetres; enlarged until a side has <= 1024 cells) over its triangles, clipped to the box's shadow; each
//      triangle rasterized (the cells whose centre it covers, and always the cell of its own centre: a decimated
//      triangle can be bigger than a cell); 4-connected components; one whose triangles (by their centre's cell) sum
//      to >= min_area_m2 and cover >= half its cells is a face (less: the few triangles of other faces that noise
//      tilted past angle_deg, scattered over them), its mask cropped to its own bounding rectangle.
//   Speed (Mac M5 Pro): 1 M triangles in the box in ~35 ms (~45 ms with +-2 mm noise on 1 cm triangles); the
//   selection pass ~3 ms per 10 M triangles of the mesh.
//
// THE ANSWER. uint32 LE n, n bytes of JSON header padded with spaces to a multiple of 4, then each face's mask in header
// order, unpadded: w*h uint8 (1 = covered), row-major, rows along v (j), columns along u (i).
//   {"faces": [{"normal", "d", "origin", "u", "v", "cell", "w", "h", "area", "tris"}], "tris", "ms"}
// normal: the unit outward normal (the side the survey saw), the plane is normal.p = d; origin: the world corner of
// cell (0, 0), cell (i, j) covers origin + [i, i+1] cell u + [j, j+1] cell v; u x v = normal; area: the face's summed
// triangle area (m^2), tris: its triangle count; faces largest first. The top-level tris: the triangles in the box;
// ms: the split's time. Bake frame, metres; positions and lengths rounded to the millimetre, unit vectors unrounded.
// Bad arguments raise ValueError (selinf.py answers 400 {"error": ...}, framed the same way, no masks).

#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace py = pybind11;

static constexpr int NB = 8, BINS = 6 * NB * NB;      // normal bins: a cube map, 8 x 8 per side
static constexpr int MAX_DIRS = 16, MAX_SIDE = 1024;   // directions; grid cells per side
static constexpr float BIN_M = 0.01f;                  // the plane offsets' histogram bin
static constexpr double MIN_FILL = 0.5;                // a face's triangle area / its cells' area, at least
static constexpr double PI = 3.14159265358979323846;

struct Tri { float n[3], a, c[3]; int32_t t; };   // a triangle in the box: unit normal, area, centre, index
struct Comp { int i0, i1, j0, j1, cells, tris; double area; };
struct Face { double n[3], d, o[3], u[3], v[3], cell, area; int w, h, tris; size_t at; };

template <class A, class B> static inline double dot(const A* a, const B* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static inline float dotf(const float* a, const float* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static inline void cross(const double* a, const double* b, double* o) {
    o[0] = a[1] * b[2] - a[2] * b[1], o[1] = a[2] * b[0] - a[0] * b[2], o[2] = a[0] * b[1] - a[1] * b[0];
}
static inline bool normalize(double* a) {   // false: a is zero (left unchanged)
    const double l = std::sqrt(dot(a, a));
    if (!(l > 0)) return false;
    for (int k = 0; k < 3; k++) a[k] /= l;
    return true;
}
static int bin_of(const float* n) {   // the cube-map bin of a unit normal
    const float x = std::fabs(n[0]), y = std::fabs(n[1]), z = std::fabs(n[2]);
    const int k = x >= y && x >= z ? 0 : y >= z ? 1 : 2;
    const float m = std::fabs(n[k]);
    if (!(m > 0)) return 0;
    auto q = [m](float c) { return std::min(NB - 1, (int)((c / m + 1) * 0.5f * NB)); };
    return ((2 * k + (n[k] < 0)) * NB + q(n[(k + 1) % 3])) * NB + q(n[(k + 2) % 3]);
}
// positions p sorted by key[p] in 0..m-1 (others dropped): out; first[r] .. first[r + 1] is key r's range
static void bucket(const std::vector<int32_t>& key, int m, std::vector<int32_t>& first, std::vector<int32_t>& out) {
    first.assign(m + 1, 0);
    for (int32_t r : key) if (r >= 0 && r < m) first[r + 1]++;
    for (int r = 0; r < m; r++) first[r + 1] += first[r];
    out.resize(first[m]);
    std::vector<int32_t> at(first.begin(), first.end() - 1);
    for (size_t p = 0; p < key.size(); p++) if (key[p] >= 0 && key[p] < m) out[at[key[p]]++] = (int32_t)p;
}
static void num(std::string& s, double v, double scale) {   // v rounded to 1 / scale (0: not rounded), shortest round trip
    char b[32];
    const auto r = std::to_chars(b, b + sizeof b, (scale > 0 ? std::nearbyint(v * scale) / scale : v) + 0.0);   // + 0.0: no "-0"
    s.append(b, r.ptr);
}
static void vec(std::string& s, const double* v, double scale) {
    for (int k = 0; k < 3; k++) s += k ? ", " : "[", num(s, v[k], scale);
    s += "]";
}

struct Scratch { std::vector<float> xy; std::vector<int32_t> cell, lab, stack; std::vector<uint8_t> occ; std::vector<Comp> comps; };

class Faces {
  public:
    double O[3] = {0, 0, 0};            // the mesh's bbox centre: V and C are relative to it
    std::vector<float> V, N, A, C;      // vertices (n, 3); per triangle: unit normal (0 if degenerate), area, centre
    std::vector<int32_t> F;             // triangles (n, 3)

    Faces(const double* v, size_t nv, const int64_t* f, size_t nt) : V(3 * nv), N(3 * nt), A(nt), C(3 * nt), F(3 * nt) {
        if (nv > (size_t)INT32_MAX || nt > (size_t)INT32_MAX) throw std::invalid_argument("too many vertices or triangles for int32");
        double lo[3] = {INFINITY, INFINITY, INFINITY}, hi[3] = {-INFINITY, -INFINITY, -INFINITY};
        for (size_t i = 0; i < 3 * nv; i++) {
            if (!std::isfinite(v[i])) throw std::invalid_argument("vertex " + std::to_string(i / 3) + " is not finite");
            lo[i % 3] = std::min(lo[i % 3], v[i]), hi[i % 3] = std::max(hi[i % 3], v[i]);
        }
        for (int k = 0; k < 3 && nv; k++) O[k] = (lo[k] + hi[k]) / 2;
        for (size_t i = 0; i < 3 * nv; i++) V[i] = (float)(v[i] - O[i % 3]);
        for (size_t t = 0; t < nt; t++) {
            double p[3][3], e1[3], e2[3], x[3];
            for (int j = 0; j < 3; j++) {
                const int64_t i = f[3 * t + j];
                if (i < 0 || (size_t)i >= nv)
                    throw std::invalid_argument("triangle " + std::to_string(t) + " has vertex " + std::to_string(i) + " of " + std::to_string(nv));
                F[3 * t + j] = (int32_t)i;
                for (int k = 0; k < 3; k++) p[j][k] = v[3 * i + k] - O[k];
            }
            for (int k = 0; k < 3; k++) e1[k] = p[1][k] - p[0][k], e2[k] = p[2][k] - p[0][k];
            cross(e1, e2, x);
            const double l = std::sqrt(dot(x, x));
            A[t] = (float)(l / 2);
            for (int k = 0; k < 3; k++) N[3 * t + k] = l > 0 ? (float)(x[k] / l) : 0.f, C[3 * t + k] = (float)((p[0][k] + p[1][k] + p[2][k]) / 3);
        }
    }

    std::string split(const double* ctr, const double* ax, const double* half, double angle_deg, double gap_m, double cell_m,
                      double min_area) const {
        const auto start = std::chrono::steady_clock::now();
        for (int k = 0; k < 3; k++) {
            if (!std::isfinite(ctr[k]) || !(half[k] > 0 && half[k] < 1e6)) throw std::invalid_argument("center must be finite and half in (0, 1e6)");
            for (int j = 0; j < 3; j++)
                if (!(std::fabs(dot(ax + 3 * k, ax + 3 * j) - (k == j)) <= 1e-3)) throw std::invalid_argument("axes must be 3 orthonormal rows");
        }
        if (!(angle_deg > 0 && angle_deg < 90) || !(gap_m >= 0.01 && gap_m <= 1000) || !(cell_m > 0 && cell_m <= 1000) ||
            !(min_area >= 0 && min_area < 1e12))
            throw std::invalid_argument("angle_deg must be in (0, 90), gap_m in [0.01, 1000], cell_m in (0, 1000], min_area_m2 >= 0");
        double c0[3];   // the box's centre, relative to O
        float cf[3], af[9], hf[3], lo[3], hi[3];
        for (int k = 0; k < 3; k++) {
            c0[k] = ctr[k] - O[k], cf[k] = (float)c0[k], hf[k] = (float)half[k];
            double r = 0;
            for (int j = 0; j < 3; j++) af[3 * k + j] = (float)ax[3 * k + j], r += std::fabs(ax[3 * j + k]) * half[j];
            lo[k] = (float)(c0[k] - r * 1.0001), hi[k] = (float)(c0[k] + r * 1.0001);   // the box's bounding box
        }

        // 1. the triangles whose centre is inside the box
        std::vector<Tri> s;
        for (size_t t = 0; t < A.size(); t++) {
            const float* c = &C[3 * t];
            if (c[0] < lo[0] || c[0] > hi[0] || c[1] < lo[1] || c[1] > hi[1] || c[2] < lo[2] || c[2] > hi[2]) continue;
            const float d[3] = {c[0] - cf[0], c[1] - cf[1], c[2] - cf[2]};
            if (std::fabs(dotf(d, af)) > hf[0] || std::fabs(dotf(d, af + 3)) > hf[1] || std::fabs(dotf(d, af + 6)) > hf[2]) continue;
            s.push_back({{N[3 * t], N[3 * t + 1], N[3 * t + 2]}, A[t], {c[0], c[1], c[2]}, (int32_t)t});
        }
        const size_t k = s.size();

        // 2. the main directions
        const float cosA = (float)std::cos(angle_deg * PI / 180);
        std::vector<double> bw(4 * BINS, 0.0);   // per bin: the unassigned area, and its area-weighted normal
        std::vector<int32_t> bn(BINS, 0), bin(k), open(k), dir(k, -1);
        double total = 0, D[MAX_DIRS][3];
        for (size_t i = 0; i < k; i++) {
            const int b = bin[i] = bin_of(s[i].n);
            bw[4 * b] += s[i].a, bn[b]++, total += s[i].a, open[i] = (int32_t)i;
            for (int j = 0; j < 3; j++) bw[4 * b + 1 + j] += (double)s[i].a * s[i].n[j];
        }
        double left = total;
        int nd = 0;
        while (nd < MAX_DIRS && left > 0 && left >= min_area && !open.empty()) {
            int b = -1;
            for (int j = 0; j < BINS; j++) if (bn[j] > 0 && (b < 0 || bw[4 * j] > bw[4 * b])) b = j;
            if (b < 0) break;
            double d[3] = {bw[4 * b + 1], bw[4 * b + 2], bw[4 * b + 3]};
            if (!normalize(d)) { bn[b] = 0; continue; }   // only zero-area triangles left in it
            for (int rep = 0; rep < 2; rep++) {   // the mean of the unassigned normals within angle_deg, refined once
                const float df[3] = {(float)d[0], (float)d[1], (float)d[2]};
                double m[3] = {0, 0, 0};
                for (int32_t i : open)
                    if (dotf(s[i].n, df) >= cosA) for (int j = 0; j < 3; j++) m[j] += (double)s[i].a * s[i].n[j];
                if (normalize(m)) std::copy(m, m + 3, d);
            }
            const float df[3] = {(float)d[0], (float)d[1], (float)d[2]};
            size_t kept = 0;
            for (int32_t i : open) {
                if (dotf(s[i].n, df) < cosA) { open[kept++] = i; continue; }
                const int bb = bin[i];
                dir[i] = nd, left -= s[i].a, bw[4 * bb] -= s[i].a, bn[bb]--;
                for (int j = 0; j < 3; j++) bw[4 * bb + 1 + j] -= (double)s[i].a * s[i].n[j];
            }
            if (kept == open.size()) { bn[b] = 0; continue; }   // nothing near this bin's mean: never picked again
            open.resize(kept);
            std::copy(d, d + 3, D[nd++]);
        }

        // 3. per direction, the planes by offset; 4. per plane, its faces
        std::vector<int32_t> dfirst, dord, rfirst, rord, key, ids;
        std::vector<float> off;
        std::vector<double> hist, acc;
        std::vector<Face> faces;
        std::string blob;
        Scratch w;
        const int gap_bins = std::max(1, (int)std::lround(gap_m / BIN_M));
        const double cell = std::max(1.0, std::nearbyint(cell_m * 1000)) / 1000;
        bucket(dir, nd, dfirst, dord);
        for (int r = 0; r < nd; r++) {
            const int32_t* T = dord.data() + dfirst[r];
            const size_t m = (size_t)(dfirst[r + 1] - dfirst[r]);
            const float nf[3] = {(float)D[r][0], (float)D[r][1], (float)D[r][2]};
            off.resize(m);
            float mn = INFINITY, mx = -INFINITY;
            for (size_t p = 0; p < m; p++) off[p] = dotf(nf, s[T[p]].c), mn = std::min(mn, off[p]), mx = std::max(mx, off[p]);
            const size_t nbins = (size_t)((mx - mn) / BIN_M) + 1;
            hist.assign(nbins, 0.0);
            for (size_t p = 0; p < m; p++) hist[(size_t)((off[p] - mn) / BIN_M)] += s[T[p]].a;
            std::vector<int32_t> run_of(nbins);   // a run: occupied bins less than gap_m apart
            int nr = 0, empty = 0;
            for (size_t b = 0; b < nbins; b++) {
                if (hist[b] > 0) nr += b > 0 && empty + 1 >= gap_bins, empty = 0;   // occupied bins >= gap_m apart
                else empty++;
                run_of[b] = nr;
            }
            nr++;
            key.resize(m);
            acc.assign(7 * (size_t)nr, 0.0);   // per run: area, area-weighted normal, area-weighted centre
            for (size_t p = 0; p < m; p++) {
                const Tri& q = s[T[p]];
                const int32_t g = key[p] = run_of[(size_t)((off[p] - mn) / BIN_M)];
                acc[7 * g] += q.a;
                for (int j = 0; j < 3; j++) acc[7 * g + 1 + j] += (double)q.a * q.n[j], acc[7 * g + 4 + j] += (double)q.a * q.c[j];
            }
            bucket(key, nr, rfirst, rord);
            for (int g = 0; g < nr; g++) {
                const double a = acc[7 * g];
                double n[3] = {acc[7 * g + 1], acc[7 * g + 2], acc[7 * g + 3]};
                if (!(a > 0 && a >= min_area) || !normalize(n)) continue;
                const double cen[3] = {acc[7 * g + 4] / a, acc[7 * g + 5] / a, acc[7 * g + 6] / a};
                ids.resize(rfirst[g + 1] - rfirst[g]);
                for (size_t p = 0; p < ids.size(); p++) ids[p] = T[rord[rfirst[g] + p]];
                plane(s, ids, n, dot(n, cen), c0, ax, half, cell, min_area, w, faces, blob);
            }
        }

        std::stable_sort(faces.begin(), faces.end(), [](const Face& a, const Face& b) { return a.area > b.area; });
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        std::string h = "{\"faces\": [";
        for (size_t i = 0; i < faces.size(); i++) {
            const Face& f = faces[i];
            h += i ? ", {\"normal\": " : "{\"normal\": ", vec(h, f.n, 0);
            h += ", \"d\": ", num(h, f.d, 1e3), h += ", \"origin\": ", vec(h, f.o, 1e3);
            h += ", \"u\": ", vec(h, f.u, 0), h += ", \"v\": ", vec(h, f.v, 0), h += ", \"cell\": ", num(h, f.cell, 1e3);
            h += ", \"w\": " + std::to_string(f.w) + ", \"h\": " + std::to_string(f.h) + ", \"area\": ", num(h, f.area, 1e4);
            h += ", \"tris\": " + std::to_string(f.tris) + "}";
        }
        h += "], \"tris\": " + std::to_string(k) + ", \"ms\": ", num(h, ms, 100), h += "}";
        h.append((4 - h.size() % 4) % 4, ' ');
        std::string out;
        for (int b = 0; b < 4; b++) out += (char)((h.size() >> (8 * b)) & 255);
        out += h;
        for (const Face& f : faces) out.append(blob, f.at, (size_t)f.w * f.h);
        return out;
    }

  private:
    // one plane, n.p = d (unit n, p relative to O), of the triangles s[ids]: its faces -> faces, their masks -> blob
    void plane(const std::vector<Tri>& s, const std::vector<int32_t>& ids, const double* n, double d, const double* c0,
               const double* ax, const double* half, double cell, double min_area, Scratch& w, std::vector<Face>& faces,
               std::string& blob) const {
        int e = 0;   // u: the box axis closest to the plane; v = n x u
        for (int j = 1; j < 3; j++) if (std::fabs(dot(ax + 3 * j, n)) < std::fabs(dot(ax + 3 * e, n))) e = j;
        double u[3], v[3], ru = 0, rv = 0;
        for (int k = 0; k < 3; k++) u[k] = ax[3 * e + k] - dot(ax + 3 * e, n) * n[k];
        normalize(u), cross(n, u, v);
        for (int j = 0; j < 3; j++) ru += std::fabs(dot(ax + 3 * j, u)) * half[j], rv += std::fabs(dot(ax + 3 * j, v)) * half[j];
        const float uf[3] = {(float)u[0], (float)u[1], (float)u[2]}, vf[3] = {(float)v[0], (float)v[1], (float)v[2]};
        const size_t m = ids.size();
        w.xy.resize(6 * m);
        float x0 = INFINITY, x1 = -INFINITY, y0 = INFINITY, y1 = -INFINITY;
        for (size_t p = 0; p < m; p++)
            for (int j = 0; j < 3; j++) {
                const float* q = &V[3 * (size_t)F[3 * (size_t)s[ids[p]].t + j]];
                const float x = w.xy[6 * p + 2 * j] = dotf(q, uf), y = w.xy[6 * p + 2 * j + 1] = dotf(q, vf);
                x0 = std::min(x0, x), x1 = std::max(x1, x), y0 = std::min(y0, y), y1 = std::max(y1, y);
            }
        // the grid: over the triangles, clipped to the box's shadow; a side of at most MAX_SIDE cells
        const double s0 = std::max<double>(x0, dot(c0, u) - ru), s1 = std::min<double>(x1, dot(c0, u) + ru);
        const double t0 = std::max<double>(y0, dot(c0, v) - rv), t1 = std::min<double>(y1, dot(c0, v) + rv);
        const double ext = std::max(s1 - s0, t1 - t0);
        if (ext > MAX_SIDE * cell) cell = std::ceil(ext / MAX_SIDE * 1000) / 1000;
        const int W = std::clamp((int)std::ceil((s1 - s0) / cell), 1, MAX_SIDE), H = std::clamp((int)std::ceil((t1 - t0) / cell), 1, MAX_SIDE);
        const float inv = (float)(1 / cell), fs0 = (float)s0, ft0 = (float)t0;
        auto at = [](float x, int hi) { return (int)std::clamp(std::floor(x), 0.f, (float)hi); };
        w.occ.assign((size_t)W * H, 0);
        w.cell.resize(m);
        for (size_t p = 0; p < m; p++) {   // rasterize: its centre's cell, and the cells whose centre it covers
            const Tri& q = s[ids[p]];
            float* x = &w.xy[6 * p];
            for (int j = 0; j < 3; j++) x[2 * j] = (x[2 * j] - fs0) * inv, x[2 * j + 1] = (x[2 * j + 1] - ft0) * inv;
            const int ci = at((dotf(q.c, uf) - fs0) * inv, W - 1), cj = at((dotf(q.c, vf) - ft0) * inv, H - 1);
            w.occ[w.cell[p] = cj * W + ci] = 1;
            const int i0 = at(std::min({x[0], x[2], x[4]}), W - 1), i1 = at(std::max({x[0], x[2], x[4]}), W - 1);
            const int j0 = at(std::min({x[1], x[3], x[5]}), H - 1), j1 = at(std::max({x[1], x[3], x[5]}), H - 1);
            if (i0 == i1 && j0 == j1) continue;
            const float sg = (x[2] - x[0]) * (x[5] - x[1]) - (x[3] - x[1]) * (x[4] - x[0]) < 0 ? -1.f : 1.f;
            auto edge = [&](int a, int b, float px, float py) { return sg * ((x[b] - x[a]) * (py - x[a + 1]) - (x[b + 1] - x[a + 1]) * (px - x[a])); };
            for (int j = j0; j <= j1; j++)
                for (int i = i0; i <= i1; i++) {
                    const float px = i + 0.5f, py = j + 0.5f;
                    if (edge(0, 2, px, py) >= 0 && edge(2, 4, px, py) >= 0 && edge(4, 0, px, py) >= 0) w.occ[(size_t)j * W + i] = 1;
                }
        }
        w.lab.assign((size_t)W * H, 0);   // 4-connected components, numbered from 1
        w.comps.clear();
        for (int c = 0; c < W * H; c++) {
            if (!w.occ[c] || w.lab[c]) continue;
            const int id = (int)w.comps.size() + 1;
            Comp cp{W, -1, H, -1, 0, 0, 0.0};
            w.stack.assign(1, c), w.lab[c] = id;
            while (!w.stack.empty()) {
                const int x = w.stack.back(), i = x % W, j = x / W;
                w.stack.pop_back();
                cp.cells++, cp.i0 = std::min(cp.i0, i), cp.i1 = std::max(cp.i1, i), cp.j0 = std::min(cp.j0, j), cp.j1 = std::max(cp.j1, j);
                const int nb[4] = {i > 0 ? x - 1 : -1, i < W - 1 ? x + 1 : -1, j > 0 ? x - W : -1, j < H - 1 ? x + W : -1};
                for (int y : nb) if (y >= 0 && w.occ[y] && !w.lab[y]) w.lab[y] = id, w.stack.push_back(y);
            }
            w.comps.push_back(cp);
        }
        for (size_t p = 0; p < m; p++) {   // a triangle belongs to its centre's component
            Comp& cp = w.comps[w.lab[w.cell[p]] - 1];
            cp.area += s[ids[p]].a, cp.tris++;
        }
        for (size_t id = 1; id <= w.comps.size(); id++) {
            const Comp& cp = w.comps[id - 1];
            if (!(cp.area >= min_area && cp.area >= MIN_FILL * cp.cells * cell * cell)) continue;
            Face f{};
            const double si = s0 + cp.i0 * cell, tj = t0 + cp.j0 * cell;
            for (int k = 0; k < 3; k++) f.n[k] = n[k], f.u[k] = u[k], f.v[k] = v[k], f.o[k] = O[k] + n[k] * d + u[k] * si + v[k] * tj;
            f.d = d + dot(n, O), f.cell = cell, f.area = cp.area, f.tris = cp.tris, f.at = blob.size();
            f.w = cp.i1 - cp.i0 + 1, f.h = cp.j1 - cp.j0 + 1;
            for (int j = cp.j0; j <= cp.j1; j++)
                for (int i = cp.i0; i <= cp.i1; i++) blob += (char)(w.lab[(size_t)j * W + i] == (int)id);
            faces.push_back(f);
        }
    }
};

using DArr = py::array_t<double, py::array::c_style | py::array::forcecast>;
using IArr = py::array_t<int64_t, py::array::c_style | py::array::forcecast>;

PYBIND11_MODULE(faces_core, m) {
    m.doc() = "element faces: the flat faces of the bake mesh inside a box (see faces.cpp)";
    py::class_<Faces>(m, "Faces")
        .def(py::init([](DArr V, IArr F) {
            if (V.ndim() != 2 || V.shape(1) != 3 || F.ndim() != 2 || F.shape(1) != 3) throw std::invalid_argument("V and F must be (n, 3)");
            py::gil_scoped_release nogil;
            return std::make_unique<Faces>(V.data(), (size_t)V.shape(0), F.data(), (size_t)F.shape(0));
        }), py::arg("V"), py::arg("F"))
        .def_property_readonly("tris", [](const Faces& f) { return f.A.size(); })
        .def("split", [](const Faces& f, DArr center, DArr axes, DArr half, double angle_deg, double gap_m, double cell_m,
                         double min_area_m2) {
            if (center.ndim() != 1 || center.shape(0) != 3 || half.ndim() != 1 || half.shape(0) != 3 || axes.ndim() != 2 ||
                axes.shape(0) != 3 || axes.shape(1) != 3)
                throw std::invalid_argument("center and half must have 3 values, axes 3 rows of 3");
            std::string out;
            {
                py::gil_scoped_release nogil;
                out = f.split(center.data(), axes.data(), half.data(), angle_deg, gap_m, cell_m, min_area_m2);
            }
            return py::bytes(out);
        }, py::arg("center"), py::arg("axes"), py::arg("half"), py::arg("angle_deg") = 20.0, py::arg("gap_m") = 0.05,
           py::arg("cell_m") = 0.05, py::arg("min_area_m2") = 0.05);
}
