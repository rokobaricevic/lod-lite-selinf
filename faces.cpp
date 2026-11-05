// faces.cpp -- element prisms: click a bridge element, get it back as one cross-section swept along a straight axis.
// A pybind11 module `faces_core`.
//
// WHAT IT IS. The owner clicks an element of the bridge in the viewer (faces.js); POST /element (selinf.py) asks this
// module for the element there as a PRISM: one cross-section (a polyline in the plane perpendicular to the element's
// axis) swept along the axis between two stations. Its side faces are rectangles, profile edge x [s0, s1], and
// neighbouring faces share their edges by construction (a profile vertex is where two face lines meet), so the
// element is continuous, closed and clean: the scan's noise and holes are never drawn. The answer also lists every
// candidate face line of the section, so the owner can turn faces on and off and refit. Display only, nothing is
// saved. Faces(V, F) is built once from the Survey's bake mesh (selinf_core's Survey.mesh(): the bake frame, Z-up,
// metres): the vertices as float32 relative to the mesh's bbox centre (a double origin, so the precision holds at
// large coordinates), the triangles as int32, per triangle its unit normal, area and centre, and the global frame:
// L, the dominant horizontal direction of the vertical faces (the bridge's long axis), T = Z x L, Z up. No Embree,
// nothing shared with selinf.cpp, no threads, no per-triangle allocation: linear passes over the triangle centres (a
// gather, and one sweep per axis tried), the rest on the few thousand triangles around the click.
//
// THE ALGORITHM. element(point, dir, ...) with the click and the unit view ray, in the bake frame:
//   1. seed: the triangles within 25 cm of the click (50 cm, 1 m if none) that face the viewer; n0 = the area-weighted
//      mean normal of those within 30 deg of the nearest one's, refined to the plane there (the least eigenvector of
//      the scatter of the centres within 1, 2, 4 m that face as n0 and lie within 5 cm of it), snapped onto L / T / Z
//      within 5 deg (a sparse soffit's noisy triangles tilt it by 3: 30 cm off at 6 m). One pass gathers all within 8 m.
//   2. axis a (unless given), perpendicular to n0. Candidates: L, T, Z where nearly perpendicular to n0, and n0 x n_k for
//      the dominant normals n_k within 2 m at 30-150 deg to n0, snapped onto L / T / Z within 3 deg. A prism runs along
//      its faces, so the axis is the candidate across which the clicked plane is narrowest (its triangles within
//      angle_deg and 10 cm of it, in a slab of slab_m along the candidate, holes under 1 m bridged); within 25 % of the
//      narrowest, the one with most side-face area within 2 m (normals within 10 deg of perpendicular). (Side-face area
//      alone puts the road along the cross-beams under it.) Refined as the least eigenvector of sum(A n n^T) over those
//      side faces when they span two directions, snapped again. Refined once more after 7, to the element's own drift.
//   3. section frame: e2 = Z made perpendicular to a ("up"), e1 = e2 x a; for a near-vertical a, e1 = L made
//      perpendicular, e2 = a x e1. P(u, v, s) = origin + u e1 + v e2 + s a, the origin the click to the millimetre.
//   4. candidate segments: the triangles within slab_m of the click along a and window_m of the axis line, normals within
//      25 deg of perpendicular to a, projected. Directions: an area-weighted 1-deg histogram of the 2D normals, greedy
//      peaks, each the mean of the normals within angle_deg, snapped onto e1 / e2 within 4 deg; each triangle to its
//      nearest. Per direction, lines: the modes of the offsets (1 cm bins, smoothed; hills 5 cm apart with a valley under
//      half between), each triangle to the nearest within 8 cm (clutter fills any "empty gap" between a girder's bottom and
//      the soffit above). Per line, segments: where it is seen at >= 35 % of the slab's 16 stations, per 5 cm along it,
//      split where it is not for 25 cm: brackets, posts, stiffeners, a cross-beam's flange meeting a girder's are not
//      the prism's (the seed's bins always count). Each refits its normal (snapped) and offset, its ends clipped to its
//      triangles; under 5 cm of mean width (area / 2 slab_m) it is dropped, the seed's never. Keys: the order by normal
//      angle, offset, start; the same for the same point, axis and tuning.
//   5. the chain. A profile is walked with the material on its left: segment i's end meets segment j's start where the
//      lines cross up to 25 cm beyond both ends but only a little inside either (4-10 cm, a quarter of its length: not
//      a T), or, within 20 deg of parallel, where the ends are within 25 cm: a joint, a short edge between them (round
//      a plate's tip, when nothing is within 2-15 cm beyond it; a step). A corner is convex when j turns into i's
//      material. From the seed segment (the one holding most of the seed's area), a step at each end in turn through the
//      closest link (a segment under 20 cm at a 10 cm handicap) to a segment ending within element_m of the click:
//      through convex corners; through a concave one only into a segment shorter than concave_max_m, which ends that
//      side; never into a ragged segment (rms over 2 cm or 3 % of its length), never so that the profile comes within
//      2 cm of itself. A path, or a cycle when it closes (a pier seen all round). Then the owner's: on (keys), add (the
//      segment nearest each point within 15 cm), off (keys, last). The segments that are on link up into pieces: the
//      chain's links, then the closest that take in a segment the owner turned on.
//   6. the profile: a vertex is where neighbouring lines meet (a joint's two ends sit on one perpendicular to both);
//      an open end is the segment's own end.
//   7. extent: every triangle within 8 cm of a profile edge in the section, its normal within 30 deg of the edge's,
//      counts toward its 25 cm station; a station is present when its covered length (area / 25 cm per edge, at most
//      the edge) is >= presence of the profile's length. From the click both ways until gap_m of absent stations (a
//      girder's web hides 1-2 m behind hangers); the extent ends at the outermost vertex of the last present station's
//      triangles. s0 / s1 replace it when given. An axis not given is then tilted to remove the drift of the edges'
//      offsets along s over the extent (least squares; the real girders run 0.3 deg off L: 15 cm over 30 m), and 3-7
//      are done again with it, at most twice.
//   8. caps: an end gets the main piece's profile closed by its chord when surface looks out of it there (normals within
//      25 deg of -a at s0, +a at s1, within 15 cm of the end, inside that polygon) for >= 30 % of its area, and less
//      than half that looks back (a cross-beam's web where the element meets it).
//   Speed (Mac M5 Pro): 6-16 ms a click on the real 1 M-triangle mesh; ~3 ms on a 1 M-triangle synthetic.
//
// THE ANSWER. JSON, UTF-8, compact. Bake frame, metres; positions and lengths rounded to the millimetre, unit vectors
// unrounded.
//   {"origin", "axis", "e1", "e2": the section frame, P(u, v, s) = origin + u e1 + v e2 + s axis;
//    "s0", "s1": the extent used, "auto": [s0, s1] the automatic one;
//    "segments": [{"key", "on", "auto", "seed", "n": [nu, nv], "c", "t": [t0, t1], "area", "rms"}]: every candidate,
//      its points q(t) = c n + t d, d = (-nv, nu), t in [t0, t1]; on = in the element now, auto = chosen by the chain
//      before the owner's on / off / add, seed = the clicked one; area: its triangles' (m^2), rms: their offsets';
//    "pieces": [{"keys": [segment keys, in order], "edges": [face key per edge], "uv": [[u, v]...], "closed"}]:
//      the profile polylines, uv[i] -> uv[i + 1] is edges[i] (closed: the last edge returns to uv[0]);
//    "faces": [{"key": "s12" | "j3" | "cap0" | "cap1", "seg": 12 | null, "normal", "points", "area", "width",
//      "length", "coverage"}]: side faces have 4 points (edge start and end at s0, then the same at s1), caps the
//      closed profile at s0 / s1; points exact, on the fitted planes; normal outward (the side the survey saw);
//      width x length (caps: the profile's u x v extent); coverage: the share of its area the scan supports;
//    "rms": the supporting triangles' distance to their faces, "tris": their count, "ms": the time taken}
// Bad arguments raise ValueError (selinf.py answers 400); no mesh facing the viewer within 1 m of the click, or no
// side face at it, raise LookupError (422).

#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace py = pybind11;

static constexpr double PI = 3.14159265358979323846;
static constexpr double SEED_R[3] = {0.25, 0.5, 1.0};   // the seed's radius, grown until a triangle faces the viewer
static constexpr double SEED_DEG = 30;                  // the seed: triangles within this of the nearest one's normal
static constexpr double FIT_DEG = 20, FIT_M = 0.05, N0_SNAP_DEG = 5;   // the clicked plane's fit; its snap onto L / T / Z
static constexpr double GATHER_M = 8, CAND_R = 2;       // the gathered sphere; the axis candidates' and scores' sphere
static constexpr double GLOBAL_DEG = 15;                // L / T / Z are candidates within this of perpendicular to n0
static constexpr double SUPPORT_DEG = 10, SNAP_DEG = 3; // a side face of an axis; an axis this close to L / T / Z
static constexpr double PLANE_M = 0.10, BRIDGE_M = 1.0, TIE = 1.25;   // the seed plane's width: offset, holes, ties
static constexpr double SIDE_DEG = 25, SNAP2_DEG = 4;   // section triangles; a direction this close to e1 / e2
static constexpr double OFFSET_BIN = 0.01, MODE_SEP = 0.05, OFFSET_BAND = 0.08;   // a direction's lines: offset modes
static constexpr double ALONG_BIN = 0.05, ALONG_GAP = 0.25, WEAK_M = 0.05, PERSIST = 0.35;
static constexpr int NS = 16;                           // the slab's stations, for a segment's persistence
static constexpr double LINK_M = 0.25, OVER_MIN = 0.04, OVER_M = 0.10, OVER_FRAC = 0.25, PARALLEL_DEG = 20, AHEAD_M = 0.05;
static constexpr double TIP_IN_M = 0.02, TIP_OUT_M = 0.15, TIP_SIDE_M = 0.03;   // the space a plate's tip must have
static constexpr double RMS_M = 0.02, RMS_FRAC = 0.03;  // the chain grows only into segments this straight
static constexpr double SHORT_M = 0.2, SHORT_PEN = 0.1; // a shorter one competes for a link as this much further away
static constexpr double SELF_M = 0.02, LOOSE_M = 0.15;  // a profile never comes this close to itself; but its loose ends
static constexpr double DRIFT_MIN = 1e-4, DRIFT_MAX = 0.035, DRIFT_SPAN = 1.0;   // an auto axis: its tilt (rad), a drift's spread (m)
static constexpr double STATION = 0.25, NEAR_M = 0.08, NEAR_DEG = 30;
static constexpr double CAP_DEG = 25, CAP_M = 0.15, CAP_FILL = 0.3, CAP_BACK = 0.5, ADD_M = 0.15;
static constexpr int NB = 8, BINS = 6 * NB * NB, MAX_PEAKS = 8, MAX_DIRS = 64;

struct NotFound : std::runtime_error { using std::runtime_error::runtime_error; };   // -> LookupError

struct Tune { double window_m = 6, slab_m = 1.5, angle_deg = 15, concave_max_m = 0.5, element_m = 2.5, presence = 0.35, gap_m = 2.0; };

template <class A, class B> static inline double dot(const A* a, const B* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static inline double dot2(const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1]; }
static inline double cross2(const double* a, const double* b) { return a[0] * b[1] - a[1] * b[0]; }
static inline void cross(const double* a, const double* b, double* o) {
    o[0] = a[1] * b[2] - a[2] * b[1], o[1] = a[2] * b[0] - a[0] * b[2], o[2] = a[0] * b[1] - a[1] * b[0];
}
static inline bool normalize(double* a, int k = 3) {   // false: a is zero (left unchanged)
    double l = 0;
    for (int i = 0; i < k; i++) l += a[i] * a[i];
    l = std::sqrt(l);
    if (!(l > 0)) return false;
    for (int i = 0; i < k; i++) a[i] /= l;
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
static void least_eigvec(double m[3][3], double w[3], double out[3]) {   // symmetric 3x3: eigenvalues ascending, the least's vector
    double v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (int sweep = 0; sweep < 32; sweep++) {   // cyclic Jacobi
        const double off = std::fabs(m[0][1]) + std::fabs(m[0][2]) + std::fabs(m[1][2]);
        if (!(off > 1e-15 * (std::fabs(m[0][0]) + std::fabs(m[1][1]) + std::fabs(m[2][2])))) break;
        for (int p = 0; p < 2; p++)
            for (int q = p + 1; q < 3; q++) {
                if (m[p][q] == 0) continue;
                const double th = (m[q][q] - m[p][p]) / (2 * m[p][q]);
                const double t = (th >= 0 ? 1 : -1) / (std::fabs(th) + std::sqrt(th * th + 1)), c = 1 / std::sqrt(t * t + 1), s = t * c;
                for (int k = 0; k < 3; k++) {
                    const double kp = m[k][p], kq = m[k][q];
                    m[k][p] = c * kp - s * kq, m[k][q] = s * kp + c * kq;
                }
                for (int k = 0; k < 3; k++) {
                    const double pk = m[p][k], qk = m[q][k];
                    m[p][k] = c * pk - s * qk, m[q][k] = s * pk + c * qk;
                }
                for (int k = 0; k < 3; k++) {
                    const double kp = v[k][p], kq = v[k][q];
                    v[k][p] = c * kp - s * kq, v[k][q] = s * kp + c * kq;
                }
            }
    }
    int o[3] = {0, 1, 2};
    std::sort(o, o + 3, [&](int x, int y) { return m[x][x] < m[y][y]; });
    for (int k = 0; k < 3; k++) w[k] = m[o[k]][o[k]], out[k] = v[k][o[0]];
}
static void num(std::string& s, double v, double scale) {   // v rounded to 1 / scale (0: not rounded), shortest round trip
    char b[32];
    const auto r = std::to_chars(b, b + sizeof b, (scale > 0 ? std::nearbyint(v * scale) / scale : v) + 0.0);   // + 0.0: no "-0"
    s.append(b, r.ptr);
}
static void vec(std::string& s, const double* v, int k, double scale) {
    for (int i = 0; i < k; i++) s += i ? "," : "[", num(s, v[i], scale);
    s += "]";
}

struct Near { int32_t t; float d2; };   // a triangle near the click: index, squared distance
struct STri {                           // a section triangle: centre, unit 2D normal, vertices, area, the stations it spans
    float q[2], m[2], x[3][2], a;
    uint32_t st;
    int32_t t;
    bool seed;
};
struct Seg { double n[2], c, t0, t1, area, rms, seed, persist; };   // a candidate: the line n.q = c over t in [t0, t1]
struct Link { int i, j; double gap; bool joint, convex; double p[2], q[2]; };   // i's end -> j's start at p (joint: p -> q)
struct Edge { int seg; double a[2], b[2], n[2], d[2], len, c; };   // a profile edge a -> b, outward n, d = (b - a) / len
struct Piece { std::vector<int> segs, edges; std::vector<std::array<double, 2>> uv; bool closed = false; };

static inline void at(const Seg& s, double t, double* o) { o[0] = s.c * s.n[0] - t * s.n[1], o[1] = s.c * s.n[1] + t * s.n[0]; }

class Faces {
  public:
    double O[3] = {0, 0, 0};                                        // the mesh's bbox centre: V and C are relative to it
    double L[3] = {1, 0, 0}, T[3] = {0, 1, 0}, Z[3] = {0, 0, 1};    // the global frame: the long axis, across, up
    double ext[3] = {0, 0, 0};                                      // the bbox's half extents
    std::vector<float> V, N, A, C;      // vertices (n, 3); per triangle: unit normal (0 if degenerate), area, centre
    std::vector<int32_t> F;             // triangles (n, 3)

    Faces(const double* v, size_t nv, const int64_t* f, size_t nt) : V(3 * nv), N(3 * nt), A(nt), C(3 * nt), F(3 * nt) {
        if (nv > (size_t)INT32_MAX || nt > (size_t)INT32_MAX) throw std::invalid_argument("too many vertices or triangles for int32");
        double lo[3] = {INFINITY, INFINITY, INFINITY}, hi[3] = {-INFINITY, -INFINITY, -INFINITY};
        for (size_t i = 0; i < 3 * nv; i++) {
            if (!std::isfinite(v[i])) throw std::invalid_argument("vertex " + std::to_string(i / 3) + " is not finite");
            lo[i % 3] = std::min(lo[i % 3], v[i]), hi[i % 3] = std::max(hi[i % 3], v[i]);
        }
        for (int k = 0; k < 3 && nv; k++) O[k] = (lo[k] + hi[k]) / 2, ext[k] = (hi[k] - lo[k]) / 2;
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
        frame();
    }

    std::string element(const double* point, const double* dir, const double* axis, const std::vector<int64_t>& on,
                        const std::vector<int64_t>& off, const double* add, size_t nadd, const double* s0f, const double* s1f,
                        const Tune& tu) const {
        const auto start = std::chrono::steady_clock::now();
        for (int k = 0; k < 3; k++)
            if (!std::isfinite(point[k]) || !std::isfinite(dir[k]) || (axis && !std::isfinite(axis[k])))
                throw std::invalid_argument("point, dir and axis must be 3 finite numbers");
        Seed sd{};
        Build b;
        std::copy(dir, dir + 3, sd.vd);
        if (!normalize(sd.vd)) throw std::invalid_argument("dir must not be zero");
        if (axis && (std::copy(axis, axis + 3, b.a), std::fabs(dot(b.a, b.a) - 1) > 1e-12 && !normalize(b.a)))   // a unit axis as is
            throw std::invalid_argument("axis must not be zero");
        if (!(tu.window_m > 0 && tu.window_m <= 100) || !(tu.slab_m > 0 && tu.slab_m <= 50) || !(tu.angle_deg >= 1 && tu.angle_deg <= 45) ||
            !(tu.concave_max_m >= 0 && tu.concave_max_m <= 100) || !(tu.element_m > 0 && tu.element_m <= 100) ||
            !(tu.presence >= 0 && tu.presence <= 1) || !(tu.gap_m >= 0 && tu.gap_m <= 100))
            throw std::invalid_argument("window_m must be in (0, 100], slab_m in (0, 50], angle_deg in [1, 45], concave_max_m in [0, 100], "
                                        "element_m in (0, 100], presence in [0, 1], gap_m in [0, 100]");
        if ((s0f && !(std::fabs(*s0f) < 1e6)) || (s1f && !(std::fabs(*s1f) < 1e6)) || (s0f && s1f && !(*s0f < *s1f)))
            throw std::invalid_argument("s0 and s1 must be finite and s0 < s1");
        for (size_t i = 0; i < 3 * nadd; i++)
            if (!std::isfinite(add[i])) throw std::invalid_argument("add must be points of 3 finite numbers");
        double org[3], p[3];   // the origin: the click to the millimetre (world), and relative to O
        for (int k = 0; k < 3; k++) org[k] = std::nearbyint(point[k] * 1000) / 1000, p[k] = org[k] - O[k];
        const float pf[3] = {(float)p[0], (float)p[1], (float)p[2]};

        // 1. everything within reach of the click; the seed: the triangles nearest it that face the viewer, n0
        const double reach = std::max(axis ? SEED_R[2] : GATHER_M, std::hypot(tu.slab_m, tu.window_m)) + 0.01;
        std::vector<Near> near;
        {
            const float r2 = (float)(reach * reach);
            const size_t nt = A.size();
            for (size_t t = 0; t < nt; t++) {
                const float dx = C[3 * t] - pf[0], dy = C[3 * t + 1] - pf[1], dz = C[3 * t + 2] - pf[2], d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= r2) near.push_back({(int32_t)t, d2});
            }
        }
        int32_t nearest = -1;
        for (double r : SEED_R) {
            float best = INFINITY;
            sd.r2 = (float)(r * r);
            for (const Near& q : near)
                if (q.d2 <= sd.r2 && q.d2 < best && A[q.t] > 0 && dot(&N[3 * q.t], sd.vd) < 0) best = q.d2, nearest = q.t;
            if (nearest >= 0) break;
        }
        if (nearest < 0) throw NotFound("no mesh faces the viewer within 1 m of the click");
        sd.nn = &N[3 * nearest], sd.cosine = std::cos(SEED_DEG * PI / 180);
        double n0[3] = {0, 0, 0};
        for (const Near& q : near)
            if (is_seed(q, sd)) for (int k = 0; k < 3; k++) n0[k] += (double)A[q.t] * N[3 * q.t + k];
        if (!normalize(n0)) std::copy(sd.nn, sd.nn + 3, n0);
        plane_fit(near, p, n0);

        // 2. the axis; 3-8 for it. Not given: then refined to the element's own drift along its length (a girder 0.3 deg off
        // the bridge's L leaves its profile 15 cm off 30 m away) and built again, at most twice.
        if (!axis) choose_axis(near, p, n0, tu, b.a);
        section(b, near, p, n0, sd, tu);
        choose(b, on, off, add, nadd, org, tu);
        sweep(b, p, tu);
        for (int round = 0; !axis && round < 2; round++) {
            Build c;
            if (!tilt(b, c.a)) break;
            try {
                section(c, near, p, n0, sd, tu);
            } catch (const NotFound&) {
                break;
            }
            choose(c, on, off, add, nadd, org, tu);
            sweep(c, p, tu);
            b = std::move(c);
        }
        const int K = (int)b.segs.size(), E = (int)b.edges.size();
        for (const auto* ks : {&on, &off})
            for (int64_t k : *ks)
                if (k < 0 || k >= K)
                    throw std::invalid_argument(std::string(ks == &on ? "on" : "off") + ": no segment " + std::to_string(k) + " (there are " +
                                                std::to_string(K) + ")");
        const double S0 = s0f ? *s0f : b.as0, S1 = s1f ? *s1f : b.as1, h = STATION;
        if (!(S0 < S1))
            throw std::invalid_argument("s0 must be < s1 (the automatic extent is [" + std::to_string(b.as0) + ", " + std::to_string(b.as1) + "])");
        std::vector<double> fcov(E, 0.0);
        double rs = 0, ra = 0;
        long tris = 0;
        for (int k = 0; k < b.nb; k++) {   // the stations within [S0, S1], each by its overlap
            const double b0 = (k - b.side) * h, b1 = b0 + h, w = std::min(b1, S1) - std::max(b0, S0);
            if (!(w > 0)) continue;
            for (int e = 0; e < E; e++) fcov[e] += std::min(b.cov[(size_t)k * E + e] / h, b.edges[e].len) * w;
            if (w >= h / 2) rs += b.sd[k], ra += b.sa[k], tris += b.cnt[k];
        }
        bool caps[2] = {false, false};   // an end face looking out (-a at s0, +a at s1), and nothing beyond it looking back:
        double capcov[2] = {0, 0};       // the end of an element that meets another (a cross-beam's web) is not capped
        if (std::fabs(b.poly_area) >= 0.01) {
            for (int end = 0; end < 2; end++) {
                const double se = end ? S1 : S0, out_sign = end ? 1 : -1;
                double got = 0, back = 0;
                for (const CapTri& c : b.capt)
                    if (std::fabs(c.s - se) <= CAP_M) (c.na * out_sign > 0 ? got : back) += c.a;
                capcov[end] = std::min(1.0, got / std::fabs(b.poly_area));
                caps[end] = capcov[end] >= CAP_FILL && back < CAP_BACK * got;
            }
        }

        // the answer
        const double* a = b.a;
        const double* e1 = b.e1;
        const double* e2 = b.e2;
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        auto P = [&](const double* uv, double s, double* o) { for (int k = 0; k < 3; k++) o[k] = org[k] + uv[0] * e1[k] + uv[1] * e2[k] + s * a[k]; };
        std::string out = "{\"origin\":";
        vec(out, org, 3, 1e3), out += ",\"axis\":", vec(out, a, 3, 0), out += ",\"e1\":", vec(out, e1, 3, 0), out += ",\"e2\":", vec(out, e2, 3, 0);
        out += ",\"s0\":", num(out, S0, 1e3), out += ",\"s1\":", num(out, S1, 1e3);
        out += ",\"auto\":[", num(out, b.as0, 1e3), out += ",", num(out, b.as1, 1e3), out += "],\"segments\":[";
        for (int k = 0; k < K; k++) {
            const Seg& g = b.segs[k];
            out += k ? ",{\"key\":" : "{\"key\":", out += std::to_string(k);
            out += b.ons[k] ? ",\"on\":true" : ",\"on\":false", out += b.autos[k] ? ",\"auto\":true" : ",\"auto\":false";
            out += k == b.seed ? ",\"seed\":true,\"n\":" : ",\"seed\":false,\"n\":", vec(out, g.n, 2, 0);
            out += ",\"c\":", num(out, g.c, 1e3), out += ",\"t\":[", num(out, g.t0, 1e3), out += ",", num(out, g.t1, 1e3);
            out += "],\"area\":", num(out, g.area, 1e4), out += ",\"rms\":", num(out, g.rms, 1e4), out += "}";
        }
        out += "],\"pieces\":[";
        for (size_t i = 0; i < b.pieces.size(); i++) {
            const Piece& pc = b.pieces[i];
            out += i ? ",{\"keys\":[" : "{\"keys\":[";
            for (size_t j = 0; j < pc.segs.size(); j++) out += j ? "," : "", out += std::to_string(pc.segs[j]);
            out += "],\"edges\":[";
            for (size_t j = 0; j < pc.edges.size(); j++) out += j ? ",\"" : "\"", out += b.keys[pc.edges[j]], out += "\"";
            out += "],\"uv\":[";
            for (size_t j = 0; j < pc.uv.size(); j++) out += j ? "," : "", vec(out, pc.uv[j].data(), 2, 1e3);
            out += pc.closed ? "],\"closed\":true}" : "],\"closed\":false}";
        }
        out += "],\"faces\":[";
        const double len = S1 - S0;
        bool first = true;
        for (int e = 0; e < E; e++) {
            const Edge& g = b.edges[e];
            double n3[3], q[4][3];
            for (int k = 0; k < 3; k++) n3[k] = g.n[0] * e1[k] + g.n[1] * e2[k];
            P(g.a, S0, q[0]), P(g.b, S0, q[1]), P(g.a, S1, q[2]), P(g.b, S1, q[3]);
            out += first ? "{\"key\":\"" : ",{\"key\":\"", first = false, out += b.keys[e];
            out += g.seg >= 0 ? "\",\"seg\":" + std::to_string(g.seg) : std::string("\",\"seg\":null");
            out += ",\"normal\":", vec(out, n3, 3, 0), out += ",\"points\":[";
            for (int j = 0; j < 4; j++) out += j ? "," : "", vec(out, q[j], 3, 1e3);
            out += "],\"area\":", num(out, g.len * len, 1e4), out += ",\"width\":", num(out, g.len, 1e3), out += ",\"length\":", num(out, len, 1e3);
            out += ",\"coverage\":", num(out, g.len > 0 ? std::min(1.0, fcov[e] / (g.len * len)) : 0.0, 1e3), out += "}";
        }
        for (int end = 0; end < 2; end++) {
            if (!caps[end]) continue;
            const double se = end ? S1 : S0, sign = end ? 1 : -1;
            double n3[3] = {sign * a[0], sign * a[1], sign * a[2]}, u0 = INFINITY, u1 = -INFINITY, v0 = INFINITY, v1 = -INFINITY;
            std::vector<std::array<double, 2>> pg = b.poly;
            if ((b.poly_area > 0) != (sign > 0)) std::reverse(pg.begin(), pg.end());   // counter-clockwise in (e1, e2) faces +a
            out += first ? "{\"key\":\"cap" : ",{\"key\":\"cap", first = false, out += std::to_string(end), out += "\",\"seg\":null,\"normal\":";
            vec(out, n3, 3, 0), out += ",\"points\":[";
            for (size_t j = 0; j < pg.size(); j++) {
                double q[3];
                P(pg[j].data(), se, q);
                out += j ? "," : "", vec(out, q, 3, 1e3);
                u0 = std::min(u0, pg[j][0]), u1 = std::max(u1, pg[j][0]), v0 = std::min(v0, pg[j][1]), v1 = std::max(v1, pg[j][1]);
            }
            out += "],\"area\":", num(out, std::fabs(b.poly_area), 1e4), out += ",\"width\":", num(out, u1 - u0, 1e3);
            out += ",\"length\":", num(out, v1 - v0, 1e3), out += ",\"coverage\":", num(out, capcov[end], 1e3), out += "}";
        }
        out += "],\"rms\":", num(out, ra > 0 ? std::sqrt(rs / ra) : 0.0, 1e4), out += ",\"tris\":" + std::to_string(tris);
        out += ",\"ms\":", num(out, ms, 100), out += "}";
        return out;
    }

  private:
    struct Seed { const float* nn; float r2; double vd[3], cosine; };   // the seed: near the click, facing the viewer, as nn
    struct CapTri { float s, a, na; };
    struct Build {   // what one axis gives: the section, the choices, the sweep along it
        double a[3] = {0, 0, 0}, e1[3] = {0, 0, 0}, e2[3] = {0, 0, 0};
        std::vector<STri> st;
        std::vector<Seg> segs;
        int seed = -1;
        std::vector<Link> links;
        std::vector<char> autos, ons;
        std::vector<Piece> pieces;
        std::vector<Edge> edges;
        std::vector<std::string> keys;
        std::vector<std::array<double, 2>> poly;   // the main piece's profile closed by its chord
        double poly_area = 0, total_len = 0, as0 = 0, as1 = 0;
        int side = 0, nb = 0;   // stations k - side: [(k - side) h, (k - side + 1) h)
        std::vector<double> cov, sa, sd, drift;   // per station: per edge its supported area; area, area x dist^2; per edge 5 sums
        std::vector<int32_t> cnt;
        std::vector<float> vmin, vmax;
        std::vector<CapTri> capt;
    };

    bool is_seed(const Near& q, const Seed& sd) const {
        return q.d2 <= sd.r2 && A[q.t] > 0 && dot(&N[3 * q.t], sd.vd) < 0 && dot(&N[3 * q.t], sd.nn) >= sd.cosine;
    }

    // 3. the section frame of b.a; 4. its candidate segments, the seed's, the keys
    void section(Build& b, const std::vector<Near>& near, const double* p, const double* n0, const Seed& sd, const Tune& tu) const {
        double* a = b.a;
        if (std::fabs(a[2]) < 0.9) {
            for (int k = 0; k < 3; k++) b.e2[k] = Z[k] - a[2] * a[k];
            normalize(b.e2), cross(b.e2, a, b.e1);
        } else {
            const double la = dot(L, a);
            for (int k = 0; k < 3; k++) b.e1[k] = L[k] - la * a[k];
            normalize(b.e1), cross(a, b.e1, b.e2);
        }
        const float pf[3] = {(float)p[0], (float)p[1], (float)p[2]}, af[3] = {(float)a[0], (float)a[1], (float)a[2]},
                    e1f[3] = {(float)b.e1[0], (float)b.e1[1], (float)b.e1[2]}, e2f[3] = {(float)b.e2[0], (float)b.e2[1], (float)b.e2[2]};
        const float side = (float)std::sin(SIDE_DEG * PI / 180), slab = (float)tu.slab_m, win2 = (float)(tu.window_m * tu.window_m);
        const float sw = (float)(NS / (2 * tu.slab_m));
        for (const Near& q : near) {
            const float* c = &C[3 * q.t];
            const float d[3] = {c[0] - pf[0], c[1] - pf[1], c[2] - pf[2]};
            const float* n = &N[3 * q.t];
            if (std::fabs(dot(d, af)) > slab || !(A[q.t] > 0) || !(std::fabs(dot(n, af)) < side)) continue;
            const float u = (float)dot(d, e1f), v = (float)dot(d, e2f);
            if (u * u + v * v > win2) continue;
            const float m[2] = {(float)dot(n, e1f), (float)dot(n, e2f)}, l = std::sqrt(m[0] * m[0] + m[1] * m[1]);
            STri x{{u, v}, {m[0] / l, m[1] / l}, {}, A[q.t], 0, q.t, is_seed(q, sd)};
            float s0 = INFINITY, s1 = -INFINITY;
            for (int j = 0; j < 3; j++) {
                const float* y = &V[3 * (size_t)F[3 * (size_t)q.t + j]];
                const float w[3] = {y[0] - pf[0], y[1] - pf[1], y[2] - pf[2]}, s = (float)dot(w, af);
                x.x[j][0] = (float)dot(w, e1f), x.x[j][1] = (float)dot(w, e2f), s0 = std::min(s0, s), s1 = std::max(s1, s);
            }
            const int b0 = std::clamp((int)std::floor((s0 + slab) * sw), 0, NS - 1), b1 = std::clamp((int)std::floor((s1 + slab) * sw), 0, NS - 1);
            for (int k = b0; k <= b1; k++) x.st |= 1u << k;
            b.st.push_back(x);
        }
        std::vector<Seg> segs = segments(b.st, tu);
        double s0n[2] = {dot(n0, b.e1), dot(n0, b.e2)};
        int seed = -1;
        for (size_t i = 0; i < segs.size(); i++)
            if (segs[i].seed > 0 && (seed < 0 || segs[i].seed > segs[seed].seed)) seed = (int)i;
        if (seed < 0 && normalize(s0n, 2)) {   // no seed triangle in a segment: the nearest one facing as n0, within 25 cm
            double best = LINK_M;
            for (size_t i = 0; i < segs.size(); i++) {
                const double dd = dist_to(segs[i], 0, 0);
                if (dot2(segs[i].n, s0n) >= sd.cosine && dd <= best) best = dd, seed = (int)i;
            }
        }
        if (seed < 0) throw NotFound("no side face at the click (it faces along the axis)");
        const double weak = 2 * tu.slab_m * WEAK_M;   // the weak ones out (never the seed); the keys: by normal angle, offset, start
        std::vector<Seg> kept;
        int s2 = -1;
        for (size_t i = 0; i < segs.size(); i++)
            if ((int)i == seed || (segs[i].area >= weak && segs[i].persist >= PERSIST)) {
                if ((int)i == seed) s2 = (int)kept.size();
                kept.push_back(segs[i]);
            }
        std::vector<int> o(kept.size());
        std::vector<double> ang(kept.size());
        for (size_t i = 0; i < kept.size(); i++) {
            o[i] = (int)i;
            ang[i] = std::atan2(kept[i].n[1], kept[i].n[0]) * 180 / PI;
            if (ang[i] < 0) ang[i] += 360;
        }
        std::sort(o.begin(), o.end(), [&](int x, int y) {
            if (ang[x] != ang[y]) return ang[x] < ang[y];
            if (kept[x].c != kept[y].c) return kept[x].c < kept[y].c;
            return kept[x].t0 < kept[y].t0;
        });
        for (size_t k = 0; k < o.size(); k++) {
            if (o[k] == s2) b.seed = (int)k;
            b.segs.push_back(kept[o[k]]);
        }
    }

    // 5. the links, the auto chain, the owner's choices (unknown keys are refused later), the pieces; 6. their edges
    void choose(Build& b, const std::vector<int64_t>& on, const std::vector<int64_t>& off, const double* add, size_t nadd,
                const double* org, const Tune& tu) const {
        const int K = (int)b.segs.size();
        b.links = link_all(b.segs, b.st);
        std::vector<int> chain = grow(b.segs, b.links, b.seed, tu);
        bool closed = false;
        b.autos.assign(K, 0), b.ons.assign(K, 0);
        for (int k : chain) if (k >= 0) b.autos[k] = b.ons[k] = 1;
        if (!chain.empty() && chain.back() == -1) closed = true, chain.pop_back();
        for (int64_t k : on) if (k >= 0 && k < K) b.ons[k] = 1;
        for (size_t i = 0; i < nadd; i++) {
            const double d[3] = {add[3 * i] - org[0], add[3 * i + 1] - org[1], add[3 * i + 2] - org[2]};
            const double u = dot(d, b.e1), v = dot(d, b.e2);
            int best = -1;
            double bd = ADD_M;
            for (int k = 0; k < K; k++) {
                const double dd = dist_to(b.segs[k], u, v);
                if (dd <= bd) bd = dd, best = k;
            }
            if (best >= 0) b.ons[best] = 1;
        }
        for (int64_t k : off) if (k >= 0 && k < K) b.ons[k] = 0;
        b.pieces = assemble(b.segs, b.links, chain, closed, b.ons, b.autos, b.seed);
        int njoints = 0;
        for (Piece& pc : b.pieces) {
            const size_t ne = pc.closed ? pc.uv.size() : pc.uv.size() - 1;
            for (size_t i = 0; i < ne; i++) {
                const auto& q = pc.uv[(i + 1) % pc.uv.size()];
                Edge e{pc.edges[i], {pc.uv[i][0], pc.uv[i][1]}, {q[0], q[1]}, {0, 0}, {0, 0}, 0, 0};
                e.d[0] = e.b[0] - e.a[0], e.d[1] = e.b[1] - e.a[1];
                e.len = std::hypot(e.d[0], e.d[1]);
                if (e.len > 0) e.d[0] /= e.len, e.d[1] /= e.len;
                if (e.seg >= 0) e.n[0] = b.segs[e.seg].n[0], e.n[1] = b.segs[e.seg].n[1];
                else e.n[0] = e.d[1], e.n[1] = -e.d[0];   // a joint: the right of its direction (the material on the left)
                e.c = dot2(e.n, e.a);
                b.keys.push_back(e.seg >= 0 ? "s" + std::to_string(e.seg) : "j" + std::to_string(njoints++));
                pc.edges[i] = (int)b.edges.size();
                b.edges.push_back(e), b.total_len += e.len;
            }
        }
        const Piece* main = nullptr;
        for (const Piece& pc : b.pieces)
            if (std::find(pc.segs.begin(), pc.segs.end(), b.seed) != pc.segs.end()) main = &pc;
        if (!main && !b.pieces.empty()) main = &b.pieces[0];
        if (main) {
            b.poly = main->uv;
            for (size_t i = 0; i < b.poly.size(); i++) {
                const auto& x = b.poly[i];
                const auto& y = b.poly[(i + 1) % b.poly.size()];
                b.poly_area += (x[0] * y[1] - x[1] * y[0]) / 2;
            }
        }
    }

    // 7. one pass over every triangle near the profile: per station its coverage, the triangles' reach along the axis and
    // each edge's offsets (for the drift); 8. the end faces inside the main piece. Then the automatic extent.
    void sweep(Build& b, const double* p, const Tune& tu) const {
        const double h = STATION;
        double smax = 0;   // the stations: the mesh's bbox along the axis, both ways from the click
        for (int c = 0; c < 8; c++) {
            double r = 0;
            for (int k = 0; k < 3; k++) r += (((c >> k & 1) ? ext[k] : -ext[k]) - p[k]) * b.a[k];
            smax = std::max(smax, std::fabs(r));
        }
        const int E = (int)b.edges.size();
        b.side = (int)std::ceil(smax / h) + 2, b.nb = 2 * b.side;
        b.cov.assign((size_t)b.nb * std::max(E, 1), 0.0), b.drift.assign((size_t)b.nb * std::max(E, 1) * 5, 0.0);
        b.sa.assign(b.nb, 0.0), b.sd.assign(b.nb, 0.0), b.cnt.assign(b.nb, 0), b.vmin.assign(b.nb, INFINITY), b.vmax.assign(b.nb, -INFINITY);
        b.as0 = -h / 2, b.as1 = h / 2;   // no present station at all: 25 cm around the click
        if (!E) return;
        double bb[4] = {INFINITY, -INFINITY, INFINITY, -INFINITY};
        for (const Edge& e : b.edges)
            for (const double* x : {e.a, e.b})
                bb[0] = std::min(bb[0], x[0]), bb[1] = std::max(bb[1], x[0]), bb[2] = std::min(bb[2], x[1]), bb[3] = std::max(bb[3], x[1]);
        const float u0 = (float)(bb[0] - NEAR_M), u1 = (float)(bb[1] + NEAR_M), v0 = (float)(bb[2] - NEAR_M), v1 = (float)(bb[3] + NEAR_M);
        const float capcos = (float)std::cos(CAP_DEG * PI / 180), nearcos = (float)std::cos(NEAR_DEG * PI / 180), nearm = (float)NEAR_M;
        const float pf[3] = {(float)p[0], (float)p[1], (float)p[2]}, af[3] = {(float)b.a[0], (float)b.a[1], (float)b.a[2]},
                    e1f[3] = {(float)b.e1[0], (float)b.e1[1], (float)b.e1[2]}, e2f[3] = {(float)b.e2[0], (float)b.e2[1], (float)b.e2[2]};
        struct EF { float n[2], d[2], a[2], len, c; };
        std::vector<EF> ef;
        for (const Edge& e : b.edges)
            ef.push_back({{(float)e.n[0], (float)e.n[1]}, {(float)e.d[0], (float)e.d[1]}, {(float)e.a[0], (float)e.a[1]}, (float)e.len, (float)e.c});
        const size_t nt = A.size();
        for (size_t t = 0; t < nt; t++) {
            const float* c = &C[3 * t];
            const float dx = c[0] - pf[0], dy = c[1] - pf[1], dz = c[2] - pf[2];
            const float u = dx * e1f[0] + dy * e1f[1] + dz * e1f[2];
            if (u < u0 || u > u1) continue;
            const float v = dx * e2f[0] + dy * e2f[1] + dz * e2f[2];
            if (v < v0 || v > v1 || !(A[t] > 0)) continue;
            const float s = dx * af[0] + dy * af[1] + dz * af[2];
            const float* n = &N[3 * t];
            const float na = n[0] * af[0] + n[1] * af[1] + n[2] * af[2];
            if (std::fabs(na) >= capcos) {
                if (b.poly.size() >= 3 && inside(b.poly, u, v)) b.capt.push_back({s, A[t], na});
                continue;
            }
            const float nu = n[0] * e1f[0] + n[1] * e1f[1] + n[2] * e1f[2], nv = n[0] * e2f[0] + n[1] * e2f[1] + n[2] * e2f[2];
            int best = -1;
            float bd = nearm, off = 0;
            for (int e = 0; e < E; e++) {
                const EF& g = ef[e];
                if (nu * g.n[0] + nv * g.n[1] < nearcos) continue;
                const float o = u * g.n[0] + v * g.n[1] - g.c;
                if (std::fabs(o) > bd) continue;
                const float tt = (u - g.a[0]) * g.d[0] + (v - g.a[1]) * g.d[1];
                if (tt < -nearm || tt > g.len + nearm) continue;
                best = e, bd = std::fabs(o), off = o;
            }
            if (best < 0) continue;
            const int k = std::clamp((int)std::floor(s / h) + b.side, 0, b.nb - 1);
            const double w = A[t];
            double* dr = &b.drift[((size_t)k * E + best) * 5];
            b.cov[(size_t)k * E + best] += w, b.sa[k] += w, b.sd[k] += w * bd * bd, b.cnt[k]++;
            dr[0] += w, dr[1] += w * s, dr[2] += w * s * s, dr[3] += w * off, dr[4] += w * off * s;
            for (int j = 0; j < 3; j++) {
                const float* x = &V[3 * (size_t)F[3 * t + j]];
                const float sv = (x[0] - pf[0]) * af[0] + (x[1] - pf[1]) * af[1] + (x[2] - pf[2]) * af[2];
                b.vmin[k] = std::min(b.vmin[k], sv), b.vmax[k] = std::max(b.vmax[k], sv);
            }
        }
        auto present = [&](int k) {
            if (!(b.total_len > 0)) return false;
            double got = 0;
            for (int e = 0; e < E; e++) got += std::min(b.cov[(size_t)k * E + e] / h, b.edges[e].len);
            return got >= tu.presence * b.total_len;
        };
        int last = -1;
        for (int k = b.side, gap = 0; k < b.nb; k++) {
            if (present(k)) last = k, gap = 0;
            else if (++gap * h >= tu.gap_m - 1e-9) break;
        }
        if (last >= 0) b.as1 = std::max((double)b.vmax[last], (last - b.side) * h);
        last = -1;
        for (int k = b.side - 1, gap = 0; k >= 0; k--) {
            if (present(k)) last = k, gap = 0;
            else if (++gap * h >= tu.gap_m - 1e-9) break;
        }
        if (last >= 0) b.as0 = std::min((double)b.vmin[last], (last - b.side + 1) * h);
        b.as0 = std::nearbyint(b.as0 * 1000) / 1000, b.as1 = std::nearbyint(b.as1 * 1000) / 1000;
    }

    // the axis the element's own faces say: each edge's offset drifts by k_e per metre along it (a least-squares line over
    // the automatic extent); the tilt tau of the axis in (e1, e2) with n_e . tau = k_e (least squares, weighted by area)
    // removes it. False: under DRIFT_MIN, or nothing long enough to measure it.
    bool tilt(const Build& b, double* a2) const {
        const int E = (int)b.edges.size();
        double m[3] = {0, 0, 0}, r[2] = {0, 0};   // the normal equations: [m0 m1; m1 m2] tau = r
        for (int e = 0; e < E; e++) {
            double w = 0, ws = 0, wss = 0, wo = 0, wos = 0;
            for (int k = 0; k < b.nb; k++) {
                const double sc = (k - b.side + 0.5) * STATION;
                if (sc < b.as0 || sc > b.as1) continue;
                const double* dr = &b.drift[((size_t)k * E + e) * 5];
                w += dr[0], ws += dr[1], wss += dr[2], wo += dr[3], wos += dr[4];
            }
            const double var = w * wss - ws * ws;   // w^2 times the variance of s
            if (!(w > 0) || !(var > DRIFT_SPAN * DRIFT_SPAN * w * w)) continue;
            const double k = (w * wos - ws * wo) / var, * n = b.edges[e].n;
            m[0] += w * n[0] * n[0], m[1] += w * n[0] * n[1], m[2] += w * n[1] * n[1], r[0] += w * k * n[0], r[1] += w * k * n[1];
        }
        const double ridge = 1e-6 * (m[0] + m[2]), d = (m[0] + ridge) * (m[2] + ridge) - m[1] * m[1];
        if (!(m[0] + m[2] > 0) || !(d > 0)) return false;
        double tau[2] = {((m[2] + ridge) * r[0] - m[1] * r[1]) / d, ((m[0] + ridge) * r[1] - m[1] * r[0]) / d};
        const double l = std::hypot(tau[0], tau[1]);
        if (!(l >= DRIFT_MIN)) return false;
        if (l > DRIFT_MAX) tau[0] *= DRIFT_MAX / l, tau[1] *= DRIFT_MAX / l;
        for (int k = 0; k < 3; k++) a2[k] = b.a[k] + tau[0] * b.e1[k] + tau[1] * b.e2[k];
        return normalize(a2);
    }

    void frame() {   // L: the dominant azimuth (mod 90 deg) of the near-vertical faces, by area; T = Z x L
        const size_t nt = A.size();
        std::vector<double> hist(90, 0.0);
        auto az = [&](size_t t) {
            double x = std::fmod(std::atan2((double)N[3 * t + 1], (double)N[3 * t]) * 180 / PI, 90.0);
            return x < 0 ? x + 90 : x;
        };
        for (size_t t = 0; t < nt; t++)
            if (std::fabs(N[3 * t + 2]) < 0.3f && A[t] > 0) hist[std::min(89, (int)az(t))] += A[t];
        const int pk = (int)(std::max_element(hist.begin(), hist.end()) - hist.begin());
        if (!(hist[pk] > 0)) return;   // no vertical faces: L = x, T = y
        double th = pk + 0.5, sw = 0, sx = 0;
        for (size_t t = 0; t < nt; t++) {   // refined: the mean azimuth within 2 deg of the peak bin's centre
            if (!(std::fabs(N[3 * t + 2]) < 0.3f && A[t] > 0)) continue;
            double d = az(t) - th;
            d -= 90 * std::floor((d + 45) / 90);
            if (std::fabs(d) <= 2) sw += A[t], sx += A[t] * d;
        }
        th = std::fmod(th + (sw > 0 ? sx / sw : 0) + 90, 90.0) * PI / 180;
        L[0] = std::cos(th), L[1] = std::sin(th), L[2] = 0, T[0] = -L[1], T[1] = L[0], T[2] = 0;
    }

    // n0 refined to the clicked plane: the least eigenvector of the area-weighted scatter of the triangle centres within
    // 1, 2, 4 m that face as n0 (within 20 deg) and lie within 5 cm of the plane through the click. The mean of a few
    // noisy normals is off by degrees (a sparse soffit's: 6), which puts the plane 10 cm off the surface 1.5 m away.
    void plane_fit(const std::vector<Near>& near, const double* p, double* n0) const {
        const double cmax = std::cos(FIT_DEG * PI / 180);
        for (double r : {1.0, 2.0, 4.0}) {
            const float r2 = (float)(r * r);
            double w = 0, m[3] = {0, 0, 0}, s[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
            int cnt = 0;
            for (int pass = 0; pass < 2; pass++)   // the mean, then the scatter about it
                for (const Near& q : near) {
                    const float* c = &C[3 * q.t];
                    const double d[3] = {c[0] - p[0], c[1] - p[1], c[2] - p[2]};
                    if (q.d2 > r2 || !(A[q.t] > 0) || dot(&N[3 * q.t], n0) < cmax || std::fabs(dot(d, n0)) > FIT_M) continue;
                    if (pass == 0) {
                        w += A[q.t], cnt++;
                        for (int k = 0; k < 3; k++) m[k] += A[q.t] * d[k];
                    } else
                        for (int i = 0; i < 3; i++)
                            for (int j = 0; j < 3; j++) s[i][j] += A[q.t] * (d[i] - m[i] / w) * (d[j] - m[j] / w);
                }
            if (cnt < 6) break;
            double ev[3], v[3];
            least_eigvec(s, ev, v);
            if (ev[1] < 9 * ev[0]) break;   // a strip, not a plane: its tilt across is noise
            if (dot(v, n0) < 0) for (int k = 0; k < 3; k++) v[k] = -v[k];
            if (dot(v, n0) < cmax) break;
            std::copy(v, v + 3, n0);
        }
        const double* G[3] = {L, T, Z};   // a bridge's faces are square to it: within N0_SNAP_DEG, exactly (a sparse soffit's
        for (const double* g : G)         // big noisy triangles still tilt the fit by 3 deg, 30 cm at 6 m)
            if (std::fabs(dot(g, n0)) >= std::cos(N0_SNAP_DEG * PI / 180)) {
                const double sg = dot(g, n0) > 0 ? 1 : -1;
                for (int k = 0; k < 3; k++) n0[k] = sg * g[k];
            }
    }

    void snap_axis(double* c) const {   // onto L / T / Z within SNAP_DEG; the sign along the nearest of them
        const double* G[3] = {L, T, Z};
        int g = 0;
        for (int k = 1; k < 3; k++) if (std::fabs(dot(c, G[k])) > std::fabs(dot(c, G[g]))) g = k;
        if (dot(c, G[g]) < 0) for (int k = 0; k < 3; k++) c[k] = -c[k];
        if (dot(c, G[g]) >= std::cos(SNAP_DEG * PI / 180)) std::copy(G[g], G[g] + 3, c);
    }

    // 2. the axis: across the clicked face's narrowest extent, among its candidates; ties by the side-face area within 2 m
    void choose_axis(const std::vector<Near>& near, const double* p, const double* n0, const Tune& tu, double* out) const {
        std::vector<std::array<double, 3>> cand;
        auto put = [&](double* c) {
            if (!normalize(c)) return;
            snap_axis(c);
            for (const auto& o : cand) if (std::fabs(dot(o.data(), c)) >= std::cos(SNAP_DEG * PI / 180)) return;
            cand.push_back({c[0], c[1], c[2]});
        };
        const double* G[3] = {L, T, Z};
        for (const double* g : G)
            if (std::fabs(dot(g, n0)) < std::sin(GLOBAL_DEG * PI / 180)) {
                double c[3];
                for (int k = 0; k < 3; k++) c[k] = g[k] - dot(g, n0) * n0[k];
                put(c);
            }
        std::vector<int32_t> close;   // within CAND_R
        const float r2 = (float)(CAND_R * CAND_R);
        for (const Near& q : near) if (q.d2 <= r2 && A[q.t] > 0) close.push_back(q.t);
        {   // the dominant normals within CAND_R: cube-map bins, the heaviest's mean with its neighbours within 15 deg
            std::vector<double> bw(4 * BINS, 0.0);
            double total = 0;
            for (int32_t t : close) {
                const int b = bin_of(&N[3 * t]);
                bw[4 * b] += A[t], total += A[t];
                for (int k = 0; k < 3; k++) bw[4 * b + 1 + k] += (double)A[t] * N[3 * t + k];
            }
            std::vector<char> alive(BINS, 1);
            const double c15 = std::cos(15 * PI / 180), c30 = std::cos(30 * PI / 180);
            for (int pk = 0; pk < MAX_PEAKS; pk++) {
                int b = -1;
                for (int j = 0; j < BINS; j++) if (alive[j] && bw[4 * j] > 0 && (b < 0 || bw[4 * j] > bw[4 * b])) b = j;
                if (b < 0 || bw[4 * b] < 0.02 * total) break;
                double m[3] = {bw[4 * b + 1], bw[4 * b + 2], bw[4 * b + 3]}, acc[3] = {0, 0, 0};
                if (!normalize(m)) { alive[b] = 0; continue; }
                for (int j = 0; j < BINS; j++) {
                    double mj[3] = {bw[4 * j + 1], bw[4 * j + 2], bw[4 * j + 3]};
                    if (!alive[j] || !normalize(mj) || dot(mj, m) < c15) continue;
                    for (int k = 0; k < 3; k++) acc[k] += bw[4 * j + 1 + k];
                    alive[j] = 0;
                }
                alive[b] = 0;
                if (!normalize(acc) || std::fabs(dot(acc, n0)) > c30) continue;
                double c[3];
                cross(n0, acc, c);
                put(c);
            }
        }
        if (cand.empty()) {   // nothing structural: the global axis most nearly perpendicular to n0
            int g = 0;
            for (int k = 1; k < 3; k++) if (std::fabs(dot(G[k], n0)) < std::fabs(dot(G[g], n0))) g = k;
            double c[3];
            for (int k = 0; k < 3; k++) c[k] = G[g][k] - dot(G[g], n0) * n0[k];
            put(c);
        }
        if (cand.empty()) throw NotFound("no axis at the click");
        const double sup = std::sin(SUPPORT_DEG * PI / 180);
        size_t pick = 0;
        if (cand.size() > 1) {
            std::vector<int32_t> plane;   // n0's plane: the triangles within angle_deg of n0, within PLANE_M of the click's plane
            const double ca = std::cos(tu.angle_deg * PI / 180);
            for (const Near& q : near) {
                const float* c = &C[3 * q.t];
                const double d[3] = {c[0] - p[0], c[1] - p[1], c[2] - p[2]};
                if (A[q.t] > 0 && dot(&N[3 * q.t], n0) >= ca && std::fabs(dot(d, n0)) <= PLANE_M) plane.push_back(q.t);
            }
            std::vector<double> width(cand.size()), score(cand.size(), 0.0);
            std::vector<std::pair<float, float>> iv;
            for (size_t i = 0; i < cand.size(); i++) {
                const double* c = cand[i].data();
                double w[3];
                cross(c, n0, w);
                normalize(w);
                iv.clear();
                for (int32_t t : plane) {
                    const float* x = &C[3 * t];
                    const double d[3] = {x[0] - p[0], x[1] - p[1], x[2] - p[2]};
                    if (std::fabs(dot(d, c)) > tu.slab_m) continue;
                    float lo = INFINITY, hi = -INFINITY;
                    for (int j = 0; j < 3; j++) {
                        const float* y = &V[3 * (size_t)F[3 * t + j]];
                        const float s = (float)((y[0] - p[0]) * w[0] + (y[1] - p[1]) * w[1] + (y[2] - p[2]) * w[2]);
                        lo = std::min(lo, s), hi = std::max(hi, s);
                    }
                    lo = std::max(lo, (float)-tu.window_m), hi = std::min(hi, (float)tu.window_m);
                    if (lo <= hi) iv.push_back({lo, hi});
                }
                std::sort(iv.begin(), iv.end());
                double best = INFINITY, wid = 0;   // the run nearest the click
                for (size_t j = 0; j < iv.size();) {
                    double lo = iv[j].first, hi = iv[j].second;
                    for (j++; j < iv.size() && iv[j].first <= hi + BRIDGE_M; j++) hi = std::max(hi, (double)iv[j].second);
                    const double dd = lo > 0 ? lo : hi < 0 ? -hi : 0;
                    if (dd < best) best = dd, wid = hi - lo;
                }
                width[i] = wid;
                for (int32_t t : close) if (std::fabs(dot(&N[3 * t], c)) < sup) score[i] += A[t];
            }
            const double wmin = *std::min_element(width.begin(), width.end());
            for (size_t i = 0; i < cand.size(); i++)
                if (width[i] <= TIE * wmin + 0.05 && (width[pick] > TIE * wmin + 0.05 || score[i] > score[pick])) pick = i;
        }
        double c[3] = {cand[pick][0], cand[pick][1], cand[pick][2]}, m[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}, w[3], v[3];
        for (int32_t t : close) {   // refined: the least eigenvector of its side faces' sum(A n n^T), when they span two directions
            const float* n = &N[3 * t];
            if (!(std::fabs(dot(n, c)) < sup)) continue;
            for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) m[i][j] += (double)A[t] * n[i] * n[j];
        }
        least_eigvec(m, w, v);
        if (w[1] > 0.05 * w[2] && std::fabs(dot(v, c)) >= std::cos(SUPPORT_DEG * PI / 180)) {
            if (dot(v, c) < 0) for (int k = 0; k < 3; k++) v[k] = -v[k];
            std::copy(v, v + 3, c);
        }
        snap_axis(c);
        std::copy(c, c + 3, out);
    }

    // 4. the section's candidate segments (unsorted; seed = the area of seed triangles in each)
    static std::vector<Seg> segments(const std::vector<STri>& st, const Tune& tu) {
        std::vector<Seg> segs;
        if (st.empty()) return segs;
        const double ca = std::cos(tu.angle_deg * PI / 180), snap = std::cos(SNAP2_DEG * PI / 180);
        double hb[360][3] = {};
        for (const STri& x : st) {
            double ang = std::atan2((double)x.m[1], (double)x.m[0]) * 180 / PI;
            if (ang < 0) ang += 360;
            const int b = std::min(359, (int)ang);
            hb[b][0] += x.a, hb[b][1] += (double)x.a * x.m[0], hb[b][2] += (double)x.a * x.m[1];
        }
        auto centre = [](int b, double* o) { const double r = (b + 0.5) * PI / 180; o[0] = std::cos(r), o[1] = std::sin(r); };
        std::vector<char> alive(360, 1);
        std::vector<std::array<double, 2>> dirs;
        const double min_area = 2 * tu.slab_m * WEAK_M;
        while ((int)dirs.size() < MAX_DIRS) {   // greedy peaks: the heaviest 7-degree window, its mean within angle_deg
            int b = -1;
            double bw = 0;
            for (int j = 0; j < 360; j++) {
                if (!alive[j]) continue;
                double w = 0;
                for (int k = -3; k <= 3; k++) if (alive[(j + k + 360) % 360]) w += hb[(j + k + 360) % 360][0];
                if (w > bw) bw = w, b = j;
            }
            if (b < 0 || bw < min_area) break;
            double m[2];
            centre(b, m);
            for (int rep = 0; rep < 2; rep++) {
                double acc[2] = {0, 0}, cj[2];
                for (int j = 0; j < 360; j++) {
                    centre(j, cj);
                    if (alive[j] && dot2(cj, m) >= ca) acc[0] += hb[j][1], acc[1] += hb[j][2];
                }
                if (normalize(acc, 2)) m[0] = acc[0], m[1] = acc[1];
            }
            alive[b] = 0;
            for (int j = 0; j < 360; j++) {
                double cj[2];
                centre(j, cj);
                if (dot2(cj, m) >= ca) alive[j] = 0;
            }
            snap2(m, snap);
            dirs.push_back({m[0], m[1]});
        }
        const int nd = (int)dirs.size();
        std::vector<std::vector<int>> by(nd);   // each triangle to its nearest direction within angle_deg
        for (size_t i = 0; i < st.size(); i++) {
            int best = -1;
            double bc = ca;
            for (int d = 0; d < nd; d++) {
                const double c = st[i].m[0] * dirs[d][0] + st[i].m[1] * dirs[d][1];
                if (c >= bc) bc = c, best = d;
            }
            if (best >= 0) by[best].push_back((int)i);
        }
        std::vector<double> hist, hs;
        std::vector<int> peaks, modes;
        std::vector<std::vector<int>> lines;
        struct Iv { float lo, hi; int i; };
        std::vector<Iv> iv;
        std::vector<int> run;
        std::vector<uint32_t> mask;
        std::vector<uint8_t> keep;
        for (int d = 0; d < nd; d++) {
            const std::vector<int>& ids = by[d];
            if (ids.empty()) continue;
            const double* D = dirs[d].data();
            // its lines: the modes of the offsets' area histogram (1 cm bins, smoothed), the highest first, each one a hill
            // of its own (at least MODE_SEP from the others, with a valley below half its height between); each triangle
            // to the nearest within OFFSET_BAND. (Not "split where 8 cm are empty": clutter between a girder's bottom and
            // the soffit 43 cm above fills every gap.)
            double lo = INFINITY, hi = -INFINITY;
            for (int i : ids) {
                const double o = st[i].q[0] * D[0] + st[i].q[1] * D[1];
                lo = std::min(lo, o), hi = std::max(hi, o);
            }
            lo -= 3 * OFFSET_BIN;
            const int nb = (int)((hi - lo) / OFFSET_BIN) + 4;
            hist.assign(nb, 0.0), hs.assign(nb, 0.0);
            for (int i : ids) hist[(int)((st[i].q[0] * D[0] + st[i].q[1] * D[1] - lo) / OFFSET_BIN)] += st[i].a;
            for (int b = 0; b < nb; b++)
                for (int k = -2; k <= 2; k++)
                    if (b + k >= 0 && b + k < nb) hs[b] += (3 - std::abs(k)) * hist[b + k] / 9;
            peaks.clear(), modes.clear();
            for (int b = 0; b < nb; b++)
                if (hs[b] > 0 && (b == 0 || hs[b] > hs[b - 1]) && (b == nb - 1 || hs[b] >= hs[b + 1])) peaks.push_back(b);
            std::stable_sort(peaks.begin(), peaks.end(), [&](int x, int y) { return hs[x] > hs[y]; });
            const int sep = (int)std::lround(MODE_SEP / OFFSET_BIN);
            for (int b : peaks) {
                bool own = true;
                for (int k : modes) {
                    if (std::abs(b - k) < sep) { own = false; break; }
                    double low = INFINITY;
                    for (int j = std::min(b, k); j <= std::max(b, k); j++) low = std::min(low, hs[j]);
                    if (low >= 0.5 * hs[b]) { own = false; break; }
                }
                if (own) modes.push_back(b);
            }
            lines.assign(modes.size(), {});
            for (int i : ids) {
                const double o = (st[i].q[0] * D[0] + st[i].q[1] * D[1] - lo) / OFFSET_BIN - 0.5;
                int best = -1;
                double bd = OFFSET_BAND / OFFSET_BIN;
                for (size_t k = 0; k < modes.size(); k++)
                    if (std::fabs(o - modes[k]) <= bd) bd = std::fabs(o - modes[k]), best = (int)k;
                if (best >= 0) lines[best].push_back(i);
            }
            const double dd[2] = {-D[1], D[0]};
            for (size_t k = 0; k < lines.size(); k++) {
                // its segments: where the line is persistent -- seen at >= PERSIST of the slab's stations, per 5 cm along
                // it --, split where it is not for ALONG_GAP. A bracket, a post, a stiffener, a cross-beam's flange meeting
                // a girder's at its level: at a few stations only, they are not the prism's (the seed's own bins always are).
                const std::vector<int>& line = lines[k];
                if (line.empty()) continue;
                iv.clear();
                double t0 = INFINITY, t1 = -INFINITY;
                for (int i : line) {
                    float a, b;
                    span(st[i], dd, a, b);
                    iv.push_back({a, b, i});
                    t0 = std::min(t0, (double)a), t1 = std::max(t1, (double)b);
                }
                const int nt = (int)((t1 - t0) / ALONG_BIN) + 1, need = (int)std::ceil(PERSIST * NS - 1e-9);
                mask.assign(nt, 0), keep.assign(nt, 0);
                for (const Iv& x : iv) {
                    const int b0 = (int)((x.lo - t0) / ALONG_BIN), b1 = std::min(nt - 1, (int)((x.hi - t0) / ALONG_BIN));
                    for (int b = b0; b <= b1; b++) mask[b] |= st[x.i].st, keep[b] |= st[x.i].seed;
                }
                for (int b = 0; b < nt; b++) keep[b] |= popcount(mask[b]) >= need;
                const double off = lo + (modes[k] + 0.5) * OFFSET_BIN;
                const int gap = (int)std::lround(ALONG_GAP / ALONG_BIN);
                for (int b = 0; b < nt;) {
                    if (!keep[b]) { b++; continue; }
                    int last = b, e = b + 1;
                    for (; e < nt && e - last <= gap; e++) if (keep[e]) last = e;
                    double r0 = t0 + b * ALONG_BIN, r1 = t0 + (last + 1) * ALONG_BIN, v0 = INFINITY, v1 = -INFINITY;
                    run.clear();
                    for (const Iv& x : iv) {
                        const double tc = st[x.i].q[0] * dd[0] + st[x.i].q[1] * dd[1];
                        if (tc >= r0 && tc <= r1) run.push_back(x.i), v0 = std::min(v0, (double)x.lo), v1 = std::max(v1, (double)x.hi);
                    }
                    r0 = std::max(r0, v0), r1 = std::min(r1, v1);   // no further than its own triangles reach
                    if (!run.empty() && r1 > r0) {
                        const double p0[2] = {off * D[0] + r0 * dd[0], off * D[1] + r0 * dd[1]};
                        const double p1[2] = {off * D[0] + r1 * dd[0], off * D[1] + r1 * dd[1]};
                        segs.push_back(fit(st, run, p0, p1, snap));
                    }
                    b = last + 1;
                }
            }
        }
        return segs;
    }

    static int popcount(uint32_t x) {
        int n = 0;
        for (; x; x &= x - 1) n++;
        return n;
    }

    static void snap2(double* m, double snap) {   // a 2D unit normal onto +-e1 / +-e2 within the snap cosine
        for (int k = 0; k < 2; k++)
            if (std::fabs(m[k]) >= snap) { m[k] = m[k] > 0 ? 1 : -1, m[1 - k] = 0; return; }
    }

    static void span(const STri& x, const double* d, float& lo, float& hi) {   // its vertices along the 2D direction d
        lo = INFINITY, hi = -INFINITY;
        for (int j = 0; j < 3; j++) {
            const float s = (float)(x.x[j][0] * d[0] + x.x[j][1] * d[1]);
            lo = std::min(lo, s), hi = std::max(hi, s);
        }
    }

    // a segment of its triangles: its own normal (snapped) and offset; its extent the run p0 -> p1 projected onto it
    static Seg fit(const std::vector<STri>& st, const std::vector<int>& run, const double* p0, const double* p1, double snap) {
        Seg g{{0, 0}, 0, 0, 0, 0, 0, 0, 0};
        uint32_t seen = 0;
        for (int i : run) g.n[0] += (double)st[i].a * st[i].m[0], g.n[1] += (double)st[i].a * st[i].m[1], g.area += st[i].a, seen |= st[i].st;
        normalize(g.n, 2);
        snap2(g.n, snap);
        const double d[2] = {-g.n[1], g.n[0]};
        for (int i : run) g.c += (double)st[i].a * (st[i].q[0] * g.n[0] + st[i].q[1] * g.n[1]), g.seed += st[i].seed ? st[i].a : 0;
        g.c /= g.area;
        for (int i : run) {
            const double r = st[i].q[0] * g.n[0] + st[i].q[1] * g.n[1] - g.c;
            g.rms += st[i].a * r * r;
        }
        g.rms = std::sqrt(g.rms / g.area);
        g.t0 = std::min(dot2(d, p0), dot2(d, p1)), g.t1 = std::max(dot2(d, p0), dot2(d, p1));
        for (int b = 0; b < NS; b++) g.persist += (seen >> b & 1) / (double)NS;
        return g;
    }

    static double dist_to(const Seg& g, double u, double v) {   // a 2D point's distance to segment g
        const double t = std::clamp(-g.n[1] * u + g.n[0] * v, g.t0, g.t1);
        double q[2];
        at(g, t, q);
        return std::hypot(u - q[0], v - q[1]);
    }

    // 5. every link i's end -> j's start
    static std::vector<Link> link_all(const std::vector<Seg>& segs, const std::vector<STri>& st) {
        std::vector<Link> links;
        const double par = std::sin(PARALLEL_DEG * PI / 180);
        const int K = (int)segs.size();
        for (int i = 0; i < K; i++)
            for (int j = 0; j < K; j++) {
                if (i == j) continue;
                const Seg &si = segs[i], &sj = segs[j];
                const double x = cross2(si.n, sj.n), da[2] = {-si.n[1], si.n[0]}, db[2] = {-sj.n[1], sj.n[0]};
                Link l{i, j, 0, false, false, {0, 0}, {0, 0}};
                if (std::fabs(x) >= par) {   // a corner where the lines cross
                    l.p[0] = l.q[0] = (si.c * sj.n[1] - sj.c * si.n[1]) / x, l.p[1] = l.q[1] = (si.n[0] * sj.c - sj.n[0] * si.c) / x;
                    // X up to LINK_M beyond i's end and before j's start (a corner's triangles bend away: the faces' own
                    // ends fall short), only a little inside either (no corner in the middle of a 30 cm flange: a T)
                    const double gi = dot2(da, l.p) - si.t1, gj = sj.t0 - dot2(db, l.p);
                    const double oi = std::clamp(OVER_FRAC * (si.t1 - si.t0), OVER_MIN, OVER_M);
                    const double oj = std::clamp(OVER_FRAC * (sj.t1 - sj.t0), OVER_MIN, OVER_M);
                    if (gi > LINK_M || gi < -oi || gj > LINK_M || gj < -oj) continue;
                    l.gap = std::fabs(gi) + std::fabs(gj), l.convex = x > 0;   // j turns into i's material: n_i . d_j < 0
                } else {   // near-parallel: a joint between the ends, on one perpendicular to both
                    double ei[2], ej[2], m[2] = {da[0] + (dot2(da, db) >= 0 ? db[0] : -db[0]), da[1] + (dot2(da, db) >= 0 ? db[1] : -db[1])};
                    at(si, si.t1, ei), at(sj, sj.t0, ej);
                    const double J[2] = {ej[0] - ei[0], ej[1] - ei[1]};
                    if (std::hypot(J[0], J[1]) > LINK_M) continue;
                    const bool same = dot2(si.n, sj.n) > 0;
                    if (same && dot2(da, J) < -AHEAD_M) continue;     // j starts behind i's end: one surface twice
                    if (!same && dot2(si.n, J) >= 0) continue;         // two skins facing apart: no plate between them
                    normalize(m, 2);
                    const double tm = (dot2(m, ei) + dot2(m, ej)) / 2;   // both ends moved onto the mean station along m
                    line_at(si, m, tm, l.p), line_at(sj, m, tm, l.q);
                    l.joint = true, l.gap = std::hypot(J[0], J[1]);
                    const double Jn[2] = {l.q[0] - l.p[0], l.q[1] - l.p[1]}, jl = std::hypot(Jn[0], Jn[1]);
                    if (!same && !free_tip(st, l.p, l.q, 0.1 * std::min(si.area, sj.area))) continue;
                    // convex: around a plate's tip, or a bend outward; a step (one corner concave) is concave; straight on: convex
                    l.convex = (dot2(si.n, Jn) < 0 && dot2(sj.n, Jn) > 0) || (same && std::fabs(dot2(si.n, Jn)) <= par * jl);
                }
                links.push_back(l);
            }
        return links;
    }

    // a plate's tip p -> q (the material on the left) is free: under `area` of section surface just beyond it. (Both skins
    // of a girder's web end where its bottom flange starts, of a cross-beam's where the haunches start: not a tip.)
    static bool free_tip(const std::vector<STri>& st, const double* p, const double* q, double area) {
        double J[2] = {q[0] - p[0], q[1] - p[1]};
        const double half = std::hypot(J[0], J[1]) / 2 + TIP_SIDE_M, mid[2] = {(p[0] + q[0]) / 2, (p[1] + q[1]) / 2};
        if (!normalize(J, 2)) return false;
        const double o[2] = {J[1], -J[0]};   // outward: the right of p -> q
        double got = 0;
        for (const STri& x : st) {
            const double w[2] = {x.q[0] - mid[0], x.q[1] - mid[1]}, along = dot2(w, o);
            if (along >= TIP_IN_M && along <= TIP_OUT_M && std::fabs(dot2(w, J)) <= half) got += x.a;
        }
        return got < area;
    }

    static void line_at(const Seg& g, const double* m, double tm, double* o) {   // where g's line meets m . x = tm
        const double d[2] = {-g.n[1], g.n[0]}, dm = dot2(d, m);
        double q[2];
        at(g, 0, q);
        const double t = std::fabs(dm) > 1e-9 ? (tm - dot2(q, m)) / dm : 0;
        o[0] = q[0] + t * d[0], o[1] = q[1] + t * d[1];
    }

    // the auto chain from the seed: segments in walking order (a trailing -1: it closed into a cycle)
    static std::vector<int> grow(const std::vector<Seg>& segs, const std::vector<Link>& links, int seed, const Tune& tu) {
        std::vector<int> chain{seed};
        std::vector<char> in(segs.size(), 0);
        in[seed] = 1;
        auto near_ok = [&](const Seg& g, double t) { double q[2]; at(g, t, q); return std::hypot(q[0], q[1]) <= tu.element_m; };
        auto ok = [&](const Link& l, int k) {   // convex, or concave into a short segment; never into a ragged one
            const double len = segs[k].t1 - segs[k].t0;
            return (l.convex || len < tu.concave_max_m) && segs[k].rms <= std::max(RMS_M, RMS_FRAC * len);
        };
        // the closest link wins, a segment under SHORT_M at a handicap (a corner's 18 cm bevel that the next face overlaps
        // would end the chain there); a short concave face ends the chain on its side: past it lies another element; and
        // the profile never touches itself (an edge beam's inner face run on up a railing post's base, past its top's corner)
        auto rank = [&](const Link& l, int k) { return l.gap + (segs[k].t1 - segs[k].t0 < SHORT_M ? SHORT_PEN : 0); };
        std::vector<const Link*> used;   // used[k]: chain[k] -> chain[k + 1]
        bool fwd = true, bwd = true;     // a step at each end in turn: the faces nearest the click first
        while (fwd || bwd) {
            if (fwd) {   // forward from the chain's end, to a segment ending within element_m (or closing it)
                const Link* b = nullptr;
                for (const Link& l : links)
                    if (l.i == chain.back() && (l.j == chain.front() || (!in[l.j] && near_ok(segs[l.j], segs[l.j].t1))) &&
                        (!b || rank(l, l.j) < rank(*b, b->j)))
                        b = &l;
                fwd = b && ok(*b, b->j);
                if (fwd) {
                    const bool closes = b->j == chain.front();
                    std::vector<int> c2 = chain;
                    std::vector<const Link*> u2 = used;
                    if (!closes) c2.push_back(b->j);
                    u2.push_back(b);
                    fwd = !touches(segs, c2, u2, closes);
                    if (fwd && closes) { chain.push_back(-1); return chain; }
                    if (fwd) chain = c2, used = u2, in[b->j] = 1, fwd = b->convex;
                }
            }
            if (bwd) {   // backward from its start
                const Link* b = nullptr;
                for (const Link& l : links)
                    if (l.j == chain.front() && !in[l.i] && near_ok(segs[l.i], segs[l.i].t0) && (!b || rank(l, l.i) < rank(*b, b->i))) b = &l;
                bwd = b && ok(*b, b->i);
                if (bwd) {
                    std::vector<int> c2 = chain;
                    std::vector<const Link*> u2 = used;
                    c2.insert(c2.begin(), b->i), u2.insert(u2.begin(), b);
                    bwd = !touches(segs, c2, u2, false);
                    if (bwd) chain = c2, used = u2, in[b->i] = 1, bwd = b->convex;
                }
            }
        }
        return chain;
    }

    // the chain's profile (closed: its last link back to the first segment) comes within SELF_M of itself
    static bool touches(const std::vector<Seg>& segs, const std::vector<int>& chain, const std::vector<const Link*>& used, bool closed) {
        std::vector<std::array<double, 2>> pts;
        double q[2];
        if (closed) pts.push_back({used.back()->q[0], used.back()->q[1]});
        else at(segs[chain[0]], segs[chain[0]].t0, q), pts.push_back({q[0], q[1]});
        for (size_t k = 0; k < used.size(); k++) {
            const Link* l = used[k];
            if (closed && k + 1 == used.size()) {   // the closing link: its corner is the first point (a joint: its start too)
                if (l->joint) pts.push_back({l->p[0], l->p[1]});
                break;
            }
            pts.push_back({l->p[0], l->p[1]});
            if (l->joint) pts.push_back({l->q[0], l->q[1]});
        }
        if (!closed) at(segs[chain.back()], segs[chain.back()].t1, q), pts.push_back({q[0], q[1]});
        const size_t n = pts.size(), ne = closed ? n : n - 1;
        for (size_t i = 0; i < ne; i++)
            for (size_t j = i + 2; j < ne; j++) {
                if (closed && i == 0 && j == ne - 1) continue;   // adjacent across the closure
                double cp[2], cq[2];
                if (contact(pts[i].data(), pts[(i + 1) % n].data(), pts[j].data(), pts[(j + 1) % n].data(), cp, cq) >= SELF_M) continue;
                // an open chain's two loose ends meeting is a loop about to close, not a touch
                if (!closed && i == 0 && j == ne - 1 && std::hypot(cp[0] - pts[0][0], cp[1] - pts[0][1]) < LOOSE_M &&
                    std::hypot(cq[0] - pts[n - 1][0], cq[1] - pts[n - 1][1]) < LOOSE_M)
                    continue;
                return true;
            }
        return false;
    }

    // two 2D segments ab, cd: their distance, and where on each it is (cp on ab, cq on cd)
    static double contact(const double* a, const double* b, const double* c, const double* d, double* cp, double* cq) {
        auto side = [](const double* p, const double* q, const double* r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); };
        const double s1 = side(a, b, c), s2 = side(a, b, d);
        if (s1 * s2 < 0 && side(c, d, a) * side(c, d, b) < 0) {   // they cross
            const double t = s1 / (s1 - s2);
            cp[0] = cq[0] = c[0] + t * (d[0] - c[0]), cp[1] = cq[1] = c[1] + t * (d[1] - c[1]);
            return 0;
        }
        double best = INFINITY;
        auto pt = [&](const double* p, const double* s, const double* e, bool on_ab) {   // point p against segment se
            const double dx = e[0] - s[0], dy = e[1] - s[1], l2 = dx * dx + dy * dy;
            const double t = l2 > 0 ? std::clamp(((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2, 0.0, 1.0) : 0;
            const double x = s[0] + t * dx, y = s[1] + t * dy, dd = std::hypot(p[0] - x, p[1] - y);
            if (dd >= best) return;
            best = dd;
            double* mine = on_ab ? cq : cp;   // p is on the other segment; (x, y) on se
            double* other = on_ab ? cp : cq;
            other[0] = p[0], other[1] = p[1], mine[0] = x, mine[1] = y;
        };
        pt(a, c, d, true), pt(b, c, d, true), pt(c, a, b, false), pt(d, a, b, false);
        return best;
    }

    // the segments that are on, linked into pieces: the chain's links first, then the closest that take in a segment the
    // owner turned on (two of the chain's are linked as it linked them, or not at all); the seed's piece first
    static std::vector<Piece> assemble(const std::vector<Seg>& segs, const std::vector<Link>& links, const std::vector<int>& chain,
                                       bool closed, const std::vector<char>& ons, const std::vector<char>& autos, int seed) {
        const int K = (int)segs.size();
        std::vector<const Link*> out(K, nullptr), inl(K, nullptr), cand;
        auto find = [&](int i, int j) -> const Link* {
            const Link* b = nullptr;
            for (const Link& l : links) if (l.i == i && l.j == j && (!b || l.gap < b->gap)) b = &l;
            return b;
        };
        const size_t nc = chain.size();
        for (size_t k = 0; k + 1 < nc + (closed ? 1 : 0); k++) {
            const int i = chain[k], j = chain[(k + 1) % nc];
            if (ons[i] && ons[j] && !out[i] && !inl[j]) out[i] = inl[j] = find(i, j);
        }
        for (const Link& l : links) if (ons[l.i] && ons[l.j] && !(autos[l.i] && autos[l.j])) cand.push_back(&l);
        std::stable_sort(cand.begin(), cand.end(), [](const Link* x, const Link* y) { return x->gap < y->gap; });
        for (const Link* l : cand)   // one link out of and into each segment: paths and cycles
            if (!out[l->i] && !inl[l->j]) out[l->i] = inl[l->j] = l;
        std::vector<Piece> pieces;
        std::vector<char> done(K, 0);
        auto trace = [&](int s0, bool cyc) {
            Piece pc;
            pc.closed = cyc;
            int s = s0;
            double q[2];
            if (!cyc) at(segs[s], segs[s].t0, q), pc.uv.push_back({q[0], q[1]});
            else {   // a cycle starts at its first segment's start: the incoming link's end
                const Link* l = inl[s];
                pc.uv.push_back({l->q[0], l->q[1]});
            }
            for (;;) {
                done[s] = 1;
                pc.segs.push_back(s);
                const Link* l = out[s];
                if (!l) {   // an open end: the segment's own
                    at(segs[s], segs[s].t1, q);
                    pc.uv.push_back({q[0], q[1]}), pc.edges.push_back(s);
                    break;
                }
                const bool back = cyc && l->j == s0;
                if (!(back && !l->joint)) pc.uv.push_back({l->p[0], l->p[1]});   // the closing corner is uv[0]
                pc.edges.push_back(s);
                if (l->joint) {
                    if (!back) pc.uv.push_back({l->q[0], l->q[1]});
                    pc.edges.push_back(-1);
                }
                if (back) break;
                s = l->j;
            }
            pieces.push_back(pc);
        };
        for (int s = 0; s < K; s++) if (ons[s] && !inl[s]) trace(s, false);
        for (int s = 0; s < K; s++) if (ons[s] && !done[s]) trace(s, true);
        std::stable_sort(pieces.begin(), pieces.end(), [&](const Piece& x, const Piece& y) {
            const bool sx = std::find(x.segs.begin(), x.segs.end(), seed) != x.segs.end();
            const bool sy = std::find(y.segs.begin(), y.segs.end(), seed) != y.segs.end();
            return sx && !sy;
        });
        return pieces;
    }

    static bool inside(const std::vector<std::array<double, 2>>& pg, double u, double v) {   // crossing test
        bool in = false;
        for (size_t i = 0, j = pg.size() - 1; i < pg.size(); j = i++)
            if ((pg[i][1] > v) != (pg[j][1] > v) && u < (pg[j][0] - pg[i][0]) * (v - pg[i][1]) / (pg[j][1] - pg[i][1]) + pg[i][0]) in = !in;
        return in;
    }
};

using DArr = py::array_t<double, py::array::c_style | py::array::forcecast>;
using IArr = py::array_t<int64_t, py::array::c_style | py::array::forcecast>;

static DArr vec3(const py::object& o, const char* name) {   // a (3,) float64 array, or ValueError
    DArr x = DArr::ensure(o);
    if (!x || x.ndim() != 1 || x.shape(0) != 3) throw std::invalid_argument(std::string(name) + " must be 3 numbers");
    return x;
}

PYBIND11_MODULE(faces_core, m) {
    m.doc() = "element prisms: click an element of the bake mesh, get it as one cross-section swept along an axis (see faces.cpp)";
    py::register_exception_translator([](std::exception_ptr p) {
        try {
            if (p) std::rethrow_exception(p);
        } catch (const NotFound& e) {
            PyErr_SetString(PyExc_LookupError, e.what());
        }
    });
    py::class_<Faces>(m, "Faces")
        .def(py::init([](DArr V, IArr F) {
            if (V.ndim() != 2 || V.shape(1) != 3 || F.ndim() != 2 || F.shape(1) != 3) throw std::invalid_argument("V and F must be (n, 3)");
            py::gil_scoped_release nogil;
            return std::make_unique<Faces>(V.data(), (size_t)V.shape(0), F.data(), (size_t)F.shape(0));
        }), py::arg("V"), py::arg("F"))
        .def_property_readonly("tris", [](const Faces& f) { return f.A.size(); })
        .def_property_readonly("frame", [](const Faces& f) {   // (L, T, Z): the bridge's long axis, across, up
            auto t = [](const double* v) { return py::make_tuple(v[0], v[1], v[2]); };
            return py::make_tuple(t(f.L), t(f.T), t(f.Z));
        })
        .def("element", [](const Faces& f, const py::object& point, const py::object& dir, const py::object& axis, std::vector<int64_t> on,
                           std::vector<int64_t> off, const py::object& add, std::optional<double> s0, std::optional<double> s1,
                           double window_m, double slab_m, double angle_deg, double concave_max_m, double element_m, double presence,
                           double gap_m) {
            DArr P = vec3(point, "point"), D = vec3(dir, "dir"), X;
            if (!axis.is_none()) X = vec3(axis, "axis");
            DArr Q = DArr::ensure(add);
            if (!Q || !(Q.size() == 0 || (Q.ndim() == 2 && Q.shape(1) == 3))) throw std::invalid_argument("add must be a list of points of 3 numbers");
            const Tune tu{window_m, slab_m, angle_deg, concave_max_m, element_m, presence, gap_m};
            std::string out;
            {
                py::gil_scoped_release nogil;
                out = f.element(P.data(), D.data(), axis.is_none() ? nullptr : X.data(), on, off, Q.size() ? Q.data() : nullptr,
                                Q.size() ? (size_t)Q.shape(0) : 0, s0 ? &*s0 : nullptr, s1 ? &*s1 : nullptr, tu);
            }
            return py::bytes(out);
        }, py::arg("point"), py::arg("dir"), py::arg("axis") = py::none(), py::arg("on") = std::vector<int64_t>(),
           py::arg("off") = std::vector<int64_t>(), py::arg("add") = py::tuple(), py::arg("s0") = py::none(), py::arg("s1") = py::none(),
           py::arg("window_m") = 6.0, py::arg("slab_m") = 1.5, py::arg("angle_deg") = 15.0, py::arg("concave_max_m") = 0.5,
           py::arg("element_m") = 2.5, py::arg("presence") = 0.35, py::arg("gap_m") = 2.0);
}
