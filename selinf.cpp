// selinf.cpp -- selective inference, everything except the models: a pybind11 module `selinf_core`.
//
// WHAT IT IS. A click on the bridge (a camera ray in the bake frame = the OBJ's Z-up frame = lod-lite's source
// frame) is turned into the defect under it by running the damage models only on the photos around the click
// instead of on all 1614. This file loads the survey from the pipeline's own files (bake mesh, cameras, the job's
// frozen parameters, photos.json), casts the ray (Embree), follows the defect from photo to photo, bakes the
// result with bakeobj.run_bake's rule and keeps the cluster at the click. The one thing it calls back into Python
// for is infer(photo_path, classes, tiles), i.e. the models (selinf.py: Models.infer, plus the HTTP front).
// lod-lite's selinf.js decodes the answer.
//
// HOW TO RUN (X = experiments/selective_inference):
//   ./test.sh         PC: stage this folder, build selinf_core with MSVC, run test_selinf.py there; then swap it in
//                     for the running server, start selinf.py (GPU), tunnel it to 127.0.0.1:8765, open the viewer
//                     (alt-click the bridge)
//   ./test.sh test    Mac: fetch pybind11 + Embree headers into the git-ignored build/ (once), build with one
//                     clang++ command, run test_selinf.py (19 tests; SELINF_REPO=~/dev/lynceus is the reference)
//   ./test.sh stop    stop the PC server and the tunnel
//
// THE LOOP (the experiment's; numbers measured on Petrinja, docs/DECISIONS.md 2026-10-28):
//   1. the photo that sees the click best (near its centre, fine GSD, face-on); nothing within 15 cm of the click
//      -> the next best (2 retries); only the box at the click is inferred until a class is found;
//   2. follow the click's class (from now on only its model runs; a tiled one, Crack, only on its grid tiles
//      within ROI_M = 1 m of the followed blobs, grown until they are covered): blobs touching the click, later
//      blobs touching what is already tracked; blob pixels at a frame edge are the frontier (cracks: pieces up to
//      30 cm apart are one crack, and its two ends are frontier too);
//   3. next photo = sees the most open frontier well inside its frame, least overlap with what is already covered;
//      until no frontier is open or 30 photos;
//   4. confirm: extra views of the tracked defect until each spot has 3 (<= 4 more); cracks (one photo's mask
//      finds 17-66 % of a crack) fill holes instead: the next fine view of the least-seen part from a new
//      direction, until 3 in a row add < 5 % new area (<= 8 views); every such view also grows the defect (and
//      may reopen the frontier);
//   5. bake the photos' masks of that class by bakeobj.run_bake's rule, in-process (1 vote: the full run's 3-vote
//      floor deletes almost everything with a handful of photos); keep the cluster at the click, by the cook's
//      rule (single linkage within cluster_distance_m, >= min_cluster_points).
//
// THE ANSWER. uint32 LE n, n bytes of JSON header padded with spaces to a multiple of 4 ({"seed", "class", "stop",
// "photos", "points": {class: count}, "full": {class: count}, "seconds"}), then each layer's float32 xyz (points,
// then full = the same class and the app's own cluster(s) at the click, from points.bin), rounded to the
// millimetre, at most MAX_RETURN points per layer. A click off the mesh answers {"error": "the click missed the
// bake mesh"} with no layers; one no photo sees answers stop = "no photo sees the click", class null, no points.
// A wrong infer result (a class missing, or not uint8 (H, W)) raises, naming the photo stem and the class.
//
// THE CRACK-TILE RULE. Crack's model runs tile by tile (grid 450 / overlap 128). On a Crack look, infer is given
// only the grid tiles within ROI_M of the followed blobs, and the probabilities it returns are exact, i.e.
// bit-equal to the whole photo's, on those tiles' exact pixels and 0 elsewhere. When the crack runs on, grow asks
// for the next tiles. The result is the same as the 6d2ad156 ROI rule's, which gives the same photos and
// 97.8-100 % of the whole-photo result's points on 9 clicks, with 33 % of the tiles.
//
// EXACTNESS. The answer must be the Python's (commit 6d2ad156's selinf.py), so every value that feeds a
// comparison, a truncation or a rounding is computed with the same floating-point operations that numpy /
// OpenCV / trimesh / Embree use, per machine:
//   - no contraction: clang -ffp-contract=off, MSVC /fp:precise (no /arch:AVX2, no /fp:contract); an FMA only
//     where the code says std::fma; `#if defined(__aarch64__)` selects the Mac column, else the PC's.
//   - Embree: the venv's own binary (embreex 4.4.0), the same device and scene flag (ROBUST), one triangle
//     geometry, rtcIntersect1 per ray.
//   numpy (chain = fma(a2,b2, fma(a1,b1, a0*b0)); plain = (a0*b0 + a1*b1) + a2*b2), measured on both machines:
//     -R_wc.T @ tv (camera origin)                 Mac chain                       PC plain
//     R_c2w @ b.T (pixel_dirs), ray @ ray[done].T  chain                           chain
//     einsum "knj,kji->kni" (project)              chain                           plain
//     einsum "knj,nj->kn" (visible's cos)          fma(a2,b2, a0*b0) + a1*b1       (a0*b0 + a2*b2) + a1*b1
//     .sum(axis) over 3, np.linalg.norm, np.dot(x*y, ones)   plain, then sqrt      same
//     x ** 2 = x*x; x ** 3, ** 0.5 = std::pow; cos(radians(75)) = 0.25881904510252074; arccos = std::acos;
//     degrees = x * (180 / M_PI)
//   So numpy itself does these sums in a different order on arm64 and x86-64, in exactly three expressions.
//   Accepted as inexact (they touch photo choice only in near-ties; none showed up): the crack-ends axis
//   (np.linalg.svd done as the top eigenvector of the 2x2 scatter, and its (n,2)@(2,) product), np.argsort tie
//   order (std::stable_sort), cKDTree at a distance of exactly tol.
//   Measured results and speed: docs/DECISIONS.md, the 2026-10-29 entry.
//
// Sections: constants, arithmetic, errors, JSON reader, file helpers, loaders, geometry (Embree), Survey (+ the
// bake), clusters, kept (the DS-grid image ops), numpy's reductions, the follow loop, infer through Python,
// click + encode, module.

#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <embree4/rtcore.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <ctime>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace py = pybind11;

// ------------------------------------------------------------------------------------------------
// constants (the experiment's, unchanged; the pipeline's below them)
// ------------------------------------------------------------------------------------------------
inline constexpr int MAX_PHOTOS = 30, RETRIES = 2, CONFIRM_VIEWS = 3, CONFIRM_EXTRA = 4;
inline constexpr double RADIUS_M = 15.0, SEED_M = 0.15;    // follow up to 15 m from the click; "at the click" = 15 cm
inline constexpr double EDGE = 0.03, INNER = 0.12;         // frontier band / "well inside", fraction of the frame
inline constexpr int DS = 4, LINK = 2, SAMPLE = 16;        // mask downsample, blob gap bridging, tracked sample spacing
inline constexpr double FILL_MIN = 0.05;
inline constexpr int FILL_DRY = 3, FILL_MAX = 8;
inline constexpr double FILL_GSD = 1.5, FILL_ANGLE = 40.0;
inline constexpr double ROI_M = 1.0;                       // default of Survey's roi_m
inline constexpr int FOOT_X = 32, FOOT_Y = 24;
inline constexpr double FOOT_CELL = 0.25;
inline constexpr int MAX_RETURN = 600000;
inline constexpr int RAY_CHUNK = 20000, SPILL_PARTITIONS = 64, SPILL_TILE_SHIFT = 6;   // the pipeline's
inline constexpr double NORMAL_OFFSET = 0.01;
static double gap_m(const std::string& cls) { return cls == "Crack" ? 0.3 : 0.0; }   // GAP_M = {Crack: 0.3}; 0 = not in it
static bool in_gap_m(const std::string& cls) { return gap_m(cls) > 0; }
static bool in_grow_all(const std::string& cls) { return cls == "Crack"; }           // GROW_ALL = {Crack}

// ------------------------------------------------------------------------------------------------
// arithmetic: numpy's operation order per machine (measured; see the table in the header)
// ------------------------------------------------------------------------------------------------
// the two orders by name, for a = (a0, a1, a2), b = (b0, b1, b2)
static inline double chain3(double a0, double a1, double a2, double b0, double b1, double b2) {
    return std::fma(a2, b2, std::fma(a1, b1, a0 * b0));
}
static inline double plain3(double a0, double a1, double a2, double b0, double b1, double b2) {
    return (a0 * b0 + a1 * b1) + a2 * b2;   // also .sum(axis) over 3, np.linalg.norm, trimesh's diagonal_dot
}
// numpy's 3-term dot where arm64 chains and x86-64 does not: `-R_wc.T @ tv` (camera origin) and
// einsum("knj,kji->kni") (project)
static inline double dot3_np(double a0, double a1, double a2, double b0, double b1, double b2) {
#if defined(__aarch64__)
    return chain3(a0, a1, a2, b0, b1, b2);
#else
    return plain3(a0, a1, a2, b0, b1, b2);
#endif
}
// einsum("knj,nj->kn") (visible's cos)
static inline double dot3_einsum_nj(double a0, double a1, double a2, double b0, double b1, double b2) {
#if defined(__aarch64__)
    return std::fma(a2, b2, a0 * b0) + a1 * b1;
#else
    return (a0 * b0 + a2 * b2) + a1 * b1;
#endif
}

// ------------------------------------------------------------------------------------------------
// errors
// ------------------------------------------------------------------------------------------------
[[noreturn]] static void fail(const std::string& path, const std::string& what) {
    throw std::runtime_error(path + ": " + what);
}

// ------------------------------------------------------------------------------------------------
// JSON reader: objects (keys kept in order), arrays, strings, numbers, true / false / null.
// Reads from a stream and can stop right after a top-level key (damage_points.json is GBs).
// ------------------------------------------------------------------------------------------------
struct Json {
    enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Json> a;
    std::vector<std::pair<std::string, Json>> o;

    const Json* find(const std::string& key) const {
        for (auto& kv : o)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
};

class JsonReader {
public:
    JsonReader(std::istream& in, std::string path) : in_(in), path_(std::move(path)) {}

    // the whole top-level value; for an object with stop_after set, returns as soon as the value of that
    // key is complete (the object holds the members read so far)
    Json parse(const std::string& stop_after = "") {
        ws();
        Json v = value(stop_after, true);
        return v;
    }

private:
    std::istream& in_;
    std::string path_;
    long pos_ = 0;

    [[noreturn]] void bad(const std::string& what) { fail(path_, "invalid JSON at byte " + std::to_string(pos_) + ": " + what); }
    int peek() { return in_.peek(); }
    int get() {
        int c = in_.get();
        if (c != EOF) pos_++;
        return c;
    }
    void ws() {
        for (int c = peek(); c == ' ' || c == '\t' || c == '\n' || c == '\r'; c = peek()) get();
    }
    void expect(char want) {
        int c = get();
        if (c != want) bad(std::string("expected '") + want + "'");
    }
    void literal(const char* word) {
        for (const char* p = word; *p; p++)
            if (get() != *p) bad(std::string("expected ") + word);
    }

    Json value(const std::string& stop_after, bool top) {
        ws();
        int c = peek();
        Json v;
        if (c == '{') return object(stop_after, top);
        if (c == '[') return array();
        if (c == '"') {
            v.type = Json::Str;
            v.s = string();
        } else if (c == 't') {
            literal("true");
            v.type = Json::Bool;
            v.b = true;
        } else if (c == 'f') {
            literal("false");
            v.type = Json::Bool;
        } else if (c == 'n') {
            literal("null");
        } else if (c == '-' || (c >= '0' && c <= '9')) {
            std::string tok;
            for (c = peek(); c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || (c >= '0' && c <= '9'); c = peek()) {
                tok += (char)get();
            }
            char* end = nullptr;
            v.n = std::strtod(tok.c_str(), &end);
            if (end != tok.c_str() + tok.size()) bad("bad number '" + tok + "'");
            v.type = Json::Num;
        } else {
            bad(c == EOF ? "unexpected end of file" : "unexpected character");
        }
        return v;
    }

    Json object(const std::string& stop_after, bool top) {
        Json v;
        v.type = Json::Obj;
        expect('{');
        ws();
        if (peek() == '}') {
            get();
            return v;
        }
        for (;;) {
            ws();
            if (peek() != '"') bad("expected a key");
            std::string key = string();
            ws();
            expect(':');
            Json member = value("", false);
            v.o.emplace_back(key, std::move(member));
            if (top && !stop_after.empty() && key == stop_after) return v;
            ws();
            int c = get();
            if (c == '}') return v;
            if (c != ',') bad("expected ',' or '}'");
        }
    }

    Json array() {
        Json v;
        v.type = Json::Arr;
        expect('[');
        ws();
        if (peek() == ']') {
            get();
            return v;
        }
        for (;;) {
            v.a.push_back(value("", false));
            ws();
            int c = get();
            if (c == ']') return v;
            if (c != ',') bad("expected ',' or ']'");
        }
    }

    static void utf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += (char)cp;
        } else if (cp < 0x800) {
            out += (char)(0xC0 | (cp >> 6));
            out += (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += (char)(0xE0 | (cp >> 12));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        } else {
            out += (char)(0xF0 | (cp >> 18));
            out += (char)(0x80 | ((cp >> 12) & 0x3F));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        }
    }
    unsigned hex4() {
        unsigned x = 0;
        for (int i = 0; i < 4; i++) {
            int c = get();
            x <<= 4;
            if (c >= '0' && c <= '9') x |= c - '0';
            else if (c >= 'a' && c <= 'f') x |= c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') x |= c - 'A' + 10;
            else bad("bad \\u escape");
        }
        return x;
    }
    std::string string() {
        expect('"');
        std::string out;
        for (;;) {
            int c = get();
            if (c == EOF) bad("unterminated string");
            if (c == '"') return out;
            if (c != '\\') {
                out += (char)c;
                continue;
            }
            c = get();
            switch (c) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp = hex4();
                    if (cp >= 0xD800 && cp < 0xDC00) {   // a surrogate pair
                        if (get() != '\\' || get() != 'u') bad("lone surrogate");
                        unsigned lo = hex4();
                        if (lo < 0xDC00 || lo > 0xDFFF) bad("bad surrogate pair");
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    utf8(out, cp);
                    break;
                }
                default: bad("bad escape");
            }
        }
    }
};

static Json read_json(const std::string& path, const std::string& stop_after = "") {
    std::ifstream f(path, std::ios::binary);
    if (!f) fail(path, "cannot open");
    return JsonReader(f, path).parse(stop_after);
}

// ------------------------------------------------------------------------------------------------
// small file / text helpers
// ------------------------------------------------------------------------------------------------
static std::string read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) fail(path, "cannot open");
    return std::string(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
}

static std::vector<std::string_view> split_ws(std::string_view line) {
    std::vector<std::string_view> t;
    size_t i = 0, n = line.size();
    auto sp = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f'; };
    while (i < n) {
        while (i < n && sp(line[i])) i++;
        size_t j = i;
        while (j < n && !sp(line[j])) j++;
        if (j > i) t.push_back(line.substr(i, j - i));
        i = j;
    }
    return t;
}

static bool to_double(std::string_view t, double& v) {   // = Python float(), for the forms files hold
    std::string s(t);
    char* end = nullptr;
    v = std::strtod(s.c_str(), &end);
    return !s.empty() && end == s.c_str() + s.size();
}
static bool to_int(std::string_view t, long long& v) {   // = Python int()
    std::string s(t);
    char* end = nullptr;
    v = std::strtoll(s.c_str(), &end, 10);
    return !s.empty() && end == s.c_str() + s.size();
}

// Path(name).stem, the part after the last '/' or '\\' minus its last extension
static std::string stem_of(const std::string& name) {
    size_t k = name.find_last_of("/\\");
    std::string base = k == std::string::npos ? name : name.substr(k + 1);
    size_t d = base.rfind('.');
    if (d != std::string::npos && d > 0 && d + 1 < base.size()) base.resize(d);
    return base;
}
static std::string lower(std::string s) {
    for (auto& c : s)
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    return s;
}

// base _per_class(values.get(key), cls, default): a table {cls: v, "*": v}, one number for every class, or the default
static double per_class(const Json& values, const std::string& key, const std::string& cls, double dflt) {
    const Json* v = values.find(key);
    if (v && v->type == Json::Obj) {
        const Json* e = v->find(cls);
        if (!e) e = v->find("*");
        return e && e->type == Json::Num ? e->n : dflt;
    }
    return v && v->type == Json::Num ? v->n : dflt;
}

// ------------------------------------------------------------------------------------------------
// loaders
// ------------------------------------------------------------------------------------------------
struct Camera {   // one photo, in the bake frame
    double origin[3];
    double R[9];   // R_c2w, row-major
    double fx, fy, cx, cy;
    double dist[5];
    int W, H;
};

// bakeobj.AXIS
static const double* axis_matrix(const std::string& name, const std::string& path) {
    static const double identity[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    static const double zup_to_yup[9] = {1, 0, 0, 0, 0, 1, 0, -1, 0};
    static const double yup_to_zup[9] = {1, 0, 0, 0, 0, -1, 0, 1, 0};
    if (name == "identity") return identity;
    if (name == "zup_to_yup") return zup_to_yup;
    if (name == "yup_to_zup") return yup_to_zup;
    fail(path, "unknown alignment axis '" + name + "'");
}

// trimesh's OBJ load with process=False: the vertices are the referenced `v` lines in file order,
// faces renumbered to them
static void load_obj(const std::string& path, std::vector<double>& V, std::vector<int64_t>& F) {
    std::ifstream f(path, std::ios::binary);
    if (!f) fail(path, "cannot open");
    std::vector<double> all;                // every v line
    std::vector<int64_t> raw;               // 1-based indices, triangles
    std::string line;
    long ln = 0;
    while (std::getline(f, line)) {
        ln++;
        std::string_view sv(line);
        size_t b = sv.find_first_not_of(" \t\r");
        if (b == std::string_view::npos) continue;
        sv.remove_prefix(b);
        char c0 = sv[0];
        bool is_v = c0 == 'v' && sv.size() > 1 && (sv[1] == ' ' || sv[1] == '\t');
        bool is_f = c0 == 'f' && sv.size() > 1 && (sv[1] == ' ' || sv[1] == '\t');
        if (!is_v && !is_f) continue;   // vn vt g usemtl mtllib o s # and the rest
        auto t = split_ws(sv);
        if (is_v) {
            if (t.size() < 4) fail(path, "line " + std::to_string(ln) + ": a vertex needs 3 coordinates");
            for (int i = 1; i <= 3; i++) {
                double x;
                if (!to_double(t[i], x)) fail(path, "line " + std::to_string(ln) + ": bad vertex coordinate");
                all.push_back(x);
            }
        } else {
            if (t.size() < 4) fail(path, "line " + std::to_string(ln) + ": a face needs 3 vertices");
            std::vector<int64_t> idx;
            for (size_t i = 1; i < t.size(); i++) {
                std::string_view tok = t[i].substr(0, t[i].find('/'));
                long long k;
                if (!to_int(tok, k)) fail(path, "line " + std::to_string(ln) + ": bad face index");
                if (k <= 0) fail(path, "line " + std::to_string(ln) + ": face index " + std::to_string(k) + " is not positive");
                idx.push_back(k);
            }
            for (size_t i = 1; i + 1 < idx.size(); i++) {   // a fan, as trimesh triangulates
                raw.push_back(idx[0]);
                raw.push_back(idx[i]);
                raw.push_back(idx[i + 1]);
            }
        }
    }
    int64_t nv = (int64_t)(all.size() / 3);
    std::vector<int64_t> remap(nv, -1);
    for (int64_t k : raw) {
        if (k > nv) fail(path, "face index " + std::to_string(k) + " is out of range (" + std::to_string(nv) + " vertices)");
        remap[k - 1] = 0;
    }
    int64_t m = 0;
    for (int64_t i = 0; i < nv; i++)
        if (remap[i] == 0) {
            remap[i] = m++;
            V.insert(V.end(), all.begin() + 3 * i, all.begin() + 3 * i + 3);
        }
    F.resize(raw.size());
    for (size_t i = 0; i < raw.size(); i++) F[i] = remap[raw[i] - 1];
    if (F.empty()) fail(path, "the mesh has no faces");
}

struct Intrinsics {
    double fx, fy, cx, cy, dist[5];
    int W, H;
};

// bakeobj._colmap_intrinsics (the models it handles)
static Intrinsics colmap_intrinsics(const std::string& model, int w, int h, const std::vector<double>& p, const std::string& path) {
    Intrinsics k{};
    k.W = w;
    k.H = h;
    auto need = [&](size_t n) {
        if (p.size() < n) fail(path, model + " needs " + std::to_string(n) + " parameters");
    };
    if (model == "SIMPLE_PINHOLE") {
        need(3);
        k.fx = k.fy = p[0], k.cx = p[1], k.cy = p[2];
    } else if (model == "PINHOLE") {
        need(4);
        k.fx = p[0], k.fy = p[1], k.cx = p[2], k.cy = p[3];
    } else if (model == "SIMPLE_RADIAL") {
        need(4);
        k.fx = k.fy = p[0], k.cx = p[1], k.cy = p[2], k.dist[0] = p[3];
    } else if (model == "RADIAL") {
        need(5);
        k.fx = k.fy = p[0], k.cx = p[1], k.cy = p[2], k.dist[0] = p[3], k.dist[1] = p[4];
    } else if (model == "OPENCV") {
        need(8);
        k.fx = p[0], k.fy = p[1], k.cx = p[2], k.cy = p[3];
        for (int i = 0; i < 4; i++) k.dist[i] = p[4 + i];
    } else if (model == "FULL_OPENCV") {
        need(9);
        k.fx = p[0], k.fy = p[1], k.cx = p[2], k.cy = p[3];
        for (int i = 0; i < 5; i++) k.dist[i] = p[4 + i];
    } else {
        fail(path, "unsupported COLMAP camera model: " + model);
    }
    return k;
}

// bakeobj._qvec2rotmat, Python's order of operations: 2*y*y is (2*y)*y, then left to right
static void qvec2rotmat(const double q[4], double R[9]) {
    double w = q[0], x = q[1], y = q[2], z = q[3];
    R[0] = (1 - (2 * y) * y) - (2 * z) * z;
    R[1] = (2 * x) * y - (2 * z) * w;
    R[2] = (2 * x) * z + (2 * y) * w;
    R[3] = (2 * x) * y + (2 * z) * w;
    R[4] = (1 - (2 * x) * x) - (2 * z) * z;
    R[5] = (2 * y) * z - (2 * x) * w;
    R[6] = (2 * x) * z - (2 * y) * w;
    R[7] = (2 * y) * z + (2 * x) * w;
    R[8] = (1 - (2 * x) * x) - (2 * y) * y;
}

// bakeobj.load_cameras_colmap: key = stem lowercased
static std::map<std::string, Camera> load_cameras_colmap(const std::string& dir) {
    const std::string cam_path = dir + "/cameras.txt", img_path = dir + "/images.txt";
    std::map<long long, Intrinsics> intr;
    {
        std::ifstream f(cam_path, std::ios::binary);
        if (!f) fail(cam_path, "cannot open");
        std::string line;
        while (std::getline(f, line)) {
            auto t = split_ws(line);
            if (t.empty() || line[0] == '#') continue;
            long long id, w, h;
            if (t.size() < 4 || !to_int(t[0], id) || !to_int(t[2], w) || !to_int(t[3], h)) fail(cam_path, "bad camera line");
            std::vector<double> p;
            for (size_t i = 4; i < t.size(); i++) {
                double x;
                if (!to_double(t[i], x)) fail(cam_path, "bad camera parameter '" + std::string(t[i]) + "'");
                p.push_back(x);
            }
            intr[id] = colmap_intrinsics(std::string(t[1]), (int)w, (int)h, p, cam_path);
        }
    }
    std::ifstream f(img_path, std::ios::binary);
    if (!f) fail(img_path, "cannot open");
    std::map<std::string, Camera> cams;
    std::string line;
    while (std::getline(f, line)) {
        auto t = split_ws(line);
        if (t.empty() || t[0][0] == '#') continue;
        // images.txt alternates pose line / POINTS2D line, but an image with no observations has an empty
        // second line: detect pose lines by shape (>= 10 tokens, int, 7 floats, int camera id that exists, '.' in token 9)
        if (t.size() < 10) continue;
        long long id, cid;
        double v[7];
        bool ok = to_int(t[0], id) && to_int(t[8], cid);
        for (int i = 0; ok && i < 7; i++) ok = to_double(t[1 + i], v[i]);
        if (!ok || !intr.count(cid) || t[9].find('.') == std::string_view::npos) continue;
        std::string name(t[9]);
        for (size_t i = 10; i < t.size(); i++) name += " " + std::string(t[i]);
        const Intrinsics& k = intr[cid];
        double R_wc[9];
        qvec2rotmat(v, R_wc);   // world -> camera
        Camera c{};
        for (int i = 0; i < 3; i++) {   // origin = -R_wc.T @ tv; R_c2w = R_wc.T
            double row[3] = {-R_wc[i], -R_wc[3 + i], -R_wc[6 + i]};
            c.origin[i] = dot3_np(row[0], row[1], row[2], v[4], v[5], v[6]);
            for (int j = 0; j < 3; j++) c.R[3 * i + j] = R_wc[3 * j + i];
        }
        c.fx = k.fx, c.fy = k.fy, c.cx = k.cx, c.cy = k.cy, c.W = k.W, c.H = k.H;
        std::copy(k.dist, k.dist + 5, c.dist);
        cams[lower(stem_of(name))] = c;
    }
    return cams;
}

// ------------------------------------------------------------------------------------------------
// geometry: the Embree scene, face normals, the lens model's inverse, voxel keys
// ------------------------------------------------------------------------------------------------
// trimesh's RayMeshIntersector + _EmbreeWrap (trimesh 4.12.2 on embreex 4.4.0, the venv's own Embree):
// the vertices moved to their min corner and scaled to a 100-unit bounding-box diagonal, as float32;
// one triangle geometry in a robust scene, one rtcIntersect1 per ray.
class EmbreeScene {
public:
    double origin[3], scale;

    EmbreeScene(const std::vector<double>& V, const std::vector<int64_t>& F) {
        const size_t nv = V.size() / 3, nf = F.size() / 3;
        double hi[3];
        for (int j = 0; j < 3; j++) {
            origin[j] = hi[j] = V[j];
            for (size_t i = 1; i < nv; i++) {
                origin[j] = std::min(origin[j], V[3 * i + j]);
                hi[j] = std::max(hi[j], V[3 * i + j]);
            }
        }
        // 100 / mesh.scale, mesh.scale = float((extents ** 2).sum() ** 0.5) (1.0 below tol.zero); every
        // vertex is referenced after load_obj, so mesh.bounds = the min / max over all of them
        const double e[3] = {hi[0] - origin[0], hi[1] - origin[1], hi[2] - origin[2]};
        double diag = std::pow((e[0] * e[0] + e[1] * e[1]) + e[2] * e[2], 0.5);
        if (diag < 1e-13) diag = 1.0;
        scale = 100.0 / diag;

        device_ = rtcNewDevice(nullptr);
        if (!device_) throw std::runtime_error("embree: rtcNewDevice failed");
        scene_ = rtcNewScene(device_);
        rtcSetSceneFlags(scene_, RTC_SCENE_FLAG_ROBUST);
        RTCGeometry g = rtcNewGeometry(device_, RTC_GEOMETRY_TYPE_TRIANGLE);
        float* vb = (float*)rtcSetNewGeometryBuffer(g, RTC_BUFFER_TYPE_VERTEX, 0, RTC_FORMAT_FLOAT3, 4 * sizeof(float), nv);
        unsigned* ib = (unsigned*)rtcSetNewGeometryBuffer(g, RTC_BUFFER_TYPE_INDEX, 0, RTC_FORMAT_UINT3, 3 * sizeof(unsigned), nf);
        if (!vb || !ib) throw std::runtime_error("embree: cannot allocate the mesh buffers");
        for (size_t i = 0; i < nv; i++) {
            for (int j = 0; j < 3; j++) vb[4 * i + j] = (float)((V[3 * i + j] - origin[j]) * scale);
            vb[4 * i + 3] = 0.0f;
        }
        for (size_t i = 0; i < 3 * nf; i++) ib[i] = (unsigned)(int32_t)F[i];   // faces.astype(np.int32)
        rtcCommitGeometry(g);
        rtcAttachGeometry(scene_, g);
        rtcReleaseGeometry(g);
        rtcCommitScene(scene_);
        if (RTCError err = rtcGetDeviceError(device_); err != RTC_ERROR_NONE)
            throw std::runtime_error(std::string("embree: building the scene failed: ") + rtcGetErrorString(err));
    }
    ~EmbreeScene() {
        rtcReleaseScene(scene_);
        rtcReleaseDevice(device_);
    }
    EmbreeScene(const EmbreeScene&) = delete;
    EmbreeScene& operator=(const EmbreeScene&) = delete;

    // embreex's scene.run for one ray (o in the mesh frame, d unitized): the first hit's primID, or -1
    int64_t first_hit(const double o[3], const double d[3]) const {
        RTCRayHit rh;
        rh.ray.org_x = (float)((o[0] - origin[0]) * scale);
        rh.ray.org_y = (float)((o[1] - origin[1]) * scale);
        rh.ray.org_z = (float)((o[2] - origin[2]) * scale);
        rh.ray.dir_x = (float)d[0];
        rh.ray.dir_y = (float)d[1];
        rh.ray.dir_z = (float)d[2];
        rh.ray.tnear = 0.0f;
        rh.ray.tfar = 1e37f;
        rh.ray.mask = 0xFFFFFFFFu;
        rh.ray.id = 0;
        rh.ray.flags = 0;
        rh.ray.time = 0.0f;
        rh.hit.geomID = rh.hit.primID = rh.hit.instID[0] = RTC_INVALID_GEOMETRY_ID;
        rtcIntersect1(scene_, &rh, nullptr);
        return (int32_t)rh.hit.primID;   // as embreex returns it: int32, -1 for a miss
    }

private:
    RTCDevice device_;
    RTCScene scene_;
};

// trimesh's util.unitize for one row: v * (1 / norm), norm = sqrt(np.dot(v * v, ones)); a row whose norm is
// <= TOL_ZERO (1e-13) is multiplied by its norm instead (unitize leaves that reciprocal out)
static inline void unitize3(const double v[3], double out[3]) {
    double norm = std::sqrt(plain3(v[0], v[1], v[2], v[0], v[1], v[2]));
    if (norm > 1e-13) norm = 1.0 / norm;   // norm[valid] **= -1
    for (int j = 0; j < 3; j++) out[j] = v[j] * norm;
}

// mesh.face_normals: np.cross(v1 - v0, v2 - v1) unitized; a face whose cross product is <= 1e-13 gets 0
static std::vector<double> face_normals(const std::vector<double>& V, const std::vector<int64_t>& F) {
    std::vector<double> N(F.size(), 0.0);
    for (size_t f = 0; f < F.size() / 3; f++) {
        const double* v0 = &V[3 * F[3 * f]];
        const double* v1 = &V[3 * F[3 * f + 1]];
        const double* v2 = &V[3 * F[3 * f + 2]];
        const double a[3] = {v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]};
        const double b[3] = {v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]};
        const double c[3] = {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
        const double norm = std::sqrt(plain3(c[0], c[1], c[2], c[0], c[1], c[2]));
        if (norm > 1e-13) {
            const double inv = 1.0 / norm;
            for (int j = 0; j < 3; j++) N[3 * f + j] = c[j] * inv;
        }
    }
    return N;
}

// cv::undistortPoints(pts, K, dist) for one pixel, as bakeobj.pixel_dirs calls it: no R, no P, the default
// criteria (TermCriteria::COUNT, 5 iterations), dist = (k1, k2, p1, p2, k3). Ported line by line from
// undistortPointsInternal in OpenCV 4.14.0 modules/calib3d/src/undistort.dispatch.cpp; k[5..13] stay in
// the formulas as OpenCV writes them (all 0 here), and the tilt step (k[12] = k[13] = 0: invMatTilt = I,
// invProj = 1) is an exact identity, so x0 = x, y0 = y.
static inline void undistort_point(const Camera& c, double px, double py, double& x_out, double& y_out) {
    const double k[14] = {c.dist[0], c.dist[1], c.dist[2], c.dist[3], c.dist[4], 0, 0, 0, 0, 0, 0, 0, 0, 0};
    const double fx = c.fx, fy = c.fy, cx = c.cx, cy = c.cy;
    const double ifx = 1. / fx, ify = 1. / fy;
    double x = px, y = py, x0, y0, u, v;
    u = x;
    v = y;
    x = (x - cx) * ifx;
    y = (y - cy) * ify;
    x0 = x;
    y0 = y;
    double alpha = 1.;
    for (int j = 0; j < 5; j++) {
#if defined(__aarch64__)
#pragma clang fp contract(on)   // OpenCV's arm64 wheel is built with clang's default contraction
#endif
        double r2 = x * x + y * y;
        double icdist = (1 + ((k[7] * r2 + k[6]) * r2 + k[5]) * r2) / (1 + ((k[4] * r2 + k[1]) * r2 + k[0]) * r2);
        if (icdist < 0) {   // test: undistortPoints.regression_14583
            x = (u - cx) * ifx;
            y = (v - cy) * ify;
            break;
        }
        double deltaX = 2 * k[2] * x * y + k[3] * (r2 + 2 * x * x) + k[8] * r2 + k[9] * r2 * r2;
        double deltaY = k[2] * (r2 + 2 * y * y) + 2 * k[3] * x * y + k[10] * r2 + k[11] * r2 * r2;
        double new_x = (1. - alpha) * x + alpha * (x0 - deltaX) * icdist;
        double new_y = (1. - alpha) * y + alpha * (y0 - deltaY) * icdist;
        // no EPS criterion: error stays DBL_MAX, never > prevError, so the step is always taken
        x = new_x;
        y = new_y;
    }
    x_out = x;
    y_out = y;
}

// selinf.py's keys(P, cell): floor(P / cell) + 2^20 per axis, packed 42 / 21 / 0 bits (int64 shifts and ors)
static inline int64_t key3(const double p[3], double cell) {
    uint64_t k[3];
    for (int j = 0; j < 3; j++) k[j] = (uint64_t)((int64_t)std::floor(p[j] / cell) + (1 << 20));
    return (int64_t)((k[0] << 42) | (k[1] << 21) | k[2]);
}

// ray hits, in ray order: hit point, face normal, ray index, distance from the ray's origin
struct Hits {
    std::vector<double> loc, normal, dist;
    std::vector<int64_t> ray;
};

// visible(): per (camera, point), row-major (k, n)
struct Visibility {
    std::vector<uint8_t> ok;
    std::vector<double> uv, dist, cos;   // uv (k, n, 2)
};

// ------------------------------------------------------------------------------------------------
// Survey: the loaded state every later step works on
// ------------------------------------------------------------------------------------------------
class Survey {
public:
    // inputs
    std::string data_root, work, job_dir, project_id, job_id;
    std::map<std::string, std::pair<int, int>> grids;   // tiled class -> (tile, overlap)
    double roi_m;
    Json values;
    double max_dist;   // bake.ray_max_distance_m

    // inference/
    std::vector<std::string> classes;        // classes.txt order
    std::map<std::string, int> floor_of;     // max(1, int(threshold * 255))

    // bake/: the mesh, and the cameras in the bake frame (index = photo index, names sorted)
    std::vector<double> V;    // (n,3)
    std::vector<int64_t> F;   // (m,3)
    std::vector<std::string> names;
    std::vector<Camera> cams;
    std::vector<std::string> photo_path, photo_stem;   // per photo index; "" when photos.json has no such photo

    // geometry, built from the mesh and cameras above
    std::vector<double> normals;            // (m,3) mesh.face_normals
    std::unique_ptr<EmbreeScene> embree;    // = bakeobj.make_intersector(mesh)
    struct Footprint {
        std::vector<int64_t> cells, inner;  // np.unique(keys(pos, FOOT_CELL)) of all / the inner footprint rays
    };
    std::vector<Footprint> foot;            // per photo index

    // content/: the full run as the app shows it
    std::vector<float> full_pos;   // (n,3), y negated when handedness_fix == "negate_y"
    std::vector<int32_t> full_class, full_cluster;
    std::vector<std::string> full_class_names;
    double cluster_distance_m = 0;   // cluster_rule = (cluster_distance_m, min_cluster_points)
    int min_cluster_points = 0;

    Survey(const std::string& data_root_, const std::string& work_, std::map<std::string, std::pair<int, int>> grids_, double roi_m_)
        : data_root(data_root_), work(work_), grids(std::move(grids_)), roi_m(roi_m_) {
        // the job's frozen parameters
        const std::string params_path = work + "/job_params.json";
        Json params = read_json(params_path);
        auto text = [&](const char* key) {
            const Json* j = params.find(key);
            if (!j || j->type != Json::Str) fail(params_path, std::string("missing '") + key + "'");
            return j->s;
        };
        project_id = text("project_id");
        job_id = text("job_id");
        if (const Json* v = params.find("values")) values = *v;
        else fail(params_path, "missing 'values'");
        const Json* md = values.find("bake.ray_max_distance_m");
        max_dist = md && md->type == Json::Num ? md->n : 30.0;

        job_dir = data_root + "/projects/" + project_id + "/pipeline/" + job_id;
        const std::string content = data_root + "/projects/" + project_id + "/content";

        // alignment: the bake's meta, nothing else of damage_points.json is read
        const std::string dp_path = job_dir + "/bake/damage_points.json";
        Json dp = read_json(dp_path, "meta");
        const Json* meta = dp.find("meta");
        const Json* al = meta ? meta->find("alignment") : nullptr;
        if (!al || al->type != Json::Obj) fail(dp_path, "no meta.alignment");
        const Json* rot = al->find("rotation");
        if (!rot || rot->type != Json::Str || rot->s != "direct")
            fail(dp_path, "meta.alignment is not the forced-axis form the bake can reproduce (rotation \"direct\")");
        const Json* ax = al->find("axis");
        const Json* off = al->find("offset");
        if (!ax || ax->type != Json::Str || !off || off->type != Json::Arr || off->a.size() != 3) fail(dp_path, "bad meta.alignment axis / offset");
        const double* S = axis_matrix(ax->s, dp_path);
        double offset[3];
        for (int i = 0; i < 3; i++) {
            if (off->a[i].type != Json::Num) fail(dp_path, "bad meta.alignment offset");
            offset[i] = off->a[i].n;
        }

        // inference/
        const std::string cls_path = job_dir + "/inference/classes.txt";
        const std::string cls_text = read_file(cls_path);
        for (auto t : split_ws(cls_text)) classes.emplace_back(t);
        const std::string th_path = job_dir + "/inference/thresholds.json";
        Json th = read_json(th_path);
        const Json* applied = th.find("classes");
        if (!applied) fail(th_path, "missing 'classes'");
        for (auto& c : classes) {
            const Json* e = applied->find(c);
            const Json* t = e ? e->find("threshold") : nullptr;
            if (!t || t->type != Json::Num) fail(th_path, "no threshold for class '" + c + "'");
            floor_of[c] = std::max(1, (int)(t->n * 255));   // = mask_compress
        }

        // bake/
        load_obj(job_dir + "/bake/mesh.obj", V, F);
        auto raw = load_cameras_colmap(job_dir + "/bake/colmap");   // apply_world_to_mesh: S @ (origin - offset), S @ R_c2w
        for (auto& kv : raw) {
            Camera c = kv.second, m = c;
            double d[3] = {c.origin[0] - offset[0], c.origin[1] - offset[1], c.origin[2] - offset[2]};
            for (int i = 0; i < 3; i++) {
                m.origin[i] = (S[3 * i] * d[0] + S[3 * i + 1] * d[1]) + S[3 * i + 2] * d[2];
                for (int j = 0; j < 3; j++)
                    m.R[3 * i + j] = (S[3 * i] * c.R[j] + S[3 * i + 1] * c.R[3 + j]) + S[3 * i + 2] * c.R[6 + j];
            }
            names.push_back(kv.first);   // std::map: sorted keys
            cams.push_back(m);
        }

        // photos
        const std::string ph_path = work + "/photos.json";
        Json photos = read_json(ph_path);
        if (photos.type != Json::Arr) fail(ph_path, "expected an array");
        std::map<std::string, std::pair<std::string, std::string>> by_stem;   // lowercase stem -> (path, stem)
#if defined(_WIN32)
        const std::string sep = "\\";   // the photo path infer gets = the base's str(data_root / "assets" / ...)
#else
        const std::string sep = "/";
#endif
        for (auto& p : photos.a) {
            const Json* name = p.find("name");
            const Json* sha = p.find("sha256");
            if (!name || name->type != Json::Str || !sha || sha->type != Json::Str || sha->s.size() < 5) fail(ph_path, "bad photo entry");
            std::string st = stem_of(name->s);
            by_stem[lower(st)] = {data_root + sep + "assets" + sep + sha->s.substr(0, 2) + sep + sha->s.substr(2, 2) + sep + sha->s, st};
        }
        for (auto& n : names) {
            auto it = by_stem.find(n);
            photo_path.push_back(it == by_stem.end() ? "" : it->second.first);
            photo_stem.push_back(it == by_stem.end() ? "" : it->second.second);
        }

        // geometry (base setup)
        normals = face_normals(V, F);
        embree = std::make_unique<EmbreeScene>(V, F);
        build_footprints();

        load_full(content);
    }

    py::tuple mesh() const {
        py::array_t<double> v({(py::ssize_t)(V.size() / 3), (py::ssize_t)3});
        py::array_t<int64_t> f({(py::ssize_t)(F.size() / 3), (py::ssize_t)3});
        std::memcpy(v.mutable_data(), V.data(), V.size() * sizeof(double));
        std::memcpy(f.mutable_data(), F.data(), F.size() * sizeof(int64_t));
        return py::make_tuple(v, f);
    }

    py::dict cameras() const {
        py::dict out;
        for (size_t i = 0; i < names.size(); i++) {
            const Camera& c = cams[i];
            py::array_t<double> o(3), r({3, 3}), d(5);
            std::memcpy(o.mutable_data(), c.origin, sizeof c.origin);
            std::memcpy(r.mutable_data(), c.R, sizeof c.R);
            std::memcpy(d.mutable_data(), c.dist, sizeof c.dist);
            py::dict e;
            e["origin"] = o;
            e["R_c2w"] = r;
            e["fx"] = c.fx, e["fy"] = c.fy, e["cx"] = c.cx, e["cy"] = c.cy;
            e["dist"] = d;
            e["W"] = c.W, e["H"] = c.H;
            out[py::str(names[i])] = e;
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------- geometry
    // = base Survey.cast: trimesh's intersects_id(o, d, multiple_hits=False, return_locations=True) (unitized
    // float64 directions, the first hit's face, the hit point by intersections.planes_lines), then
    // dist = np.linalg.norm(loc - o[ray]) <= max_dist. o, d: (n,3)
    Hits cast(const double* o, const double* d, size_t n) const {
        Hits h;
        for (size_t r = 0; r < n; r++) {
            const double* oo = o + 3 * r;
            double du[3];
            unitize3(d + 3 * r, du);
            const int64_t t = embree->first_hit(oo, du);
            if (t == -1) continue;
            const double* p0 = &V[3 * F[3 * t]];   // plane_origins = mesh.triangles[:, 0, :]
            const double* nn = &normals[3 * t];
            const double ov[3] = {p0[0] - oo[0], p0[1] - oo[1], p0[2] - oo[2]};
            const double proj_ori = plain3(ov[0], ov[1], ov[2], nn[0], nn[1], nn[2]);
            const double proj_dir = plain3(du[0], du[1], du[2], nn[0], nn[1], nn[2]);
            if (!(std::abs(proj_dir) > 1e-5)) continue;
            const double distance = proj_ori / proj_dir;
            double loc[3], rel[3];
            for (int j = 0; j < 3; j++) {
                loc[j] = du[j] * distance + oo[j];   // on_plane = d * distance; on_plane += o
                rel[j] = loc[j] - oo[j];
            }
            const double dist = std::sqrt(plain3(rel[0], rel[1], rel[2], rel[0], rel[1], rel[2]));
            if (!(dist <= max_dist)) continue;
            h.loc.insert(h.loc.end(), loc, loc + 3);
            h.normal.insert(h.normal.end(), nn, nn + 3);
            h.ray.push_back((int64_t)r);
            h.dist.push_back(dist);
        }
        return h;
    }

    // = bakeobj.pixel_dirs(cams[names[i]], px, py) with UNDISTORT = True: (n,3) unit rays in the bake frame
    std::vector<double> pixel_dirs(size_t i, const double* px, const double* py, size_t n) const {
        const Camera& c = cams[i];
        bool distorted = false;
        for (double k : c.dist) distorted = distorted || k != 0;   // np.any(cam["dist"])
        std::vector<double> out(3 * n);
        for (size_t r = 0; r < n; r++) {
            double x, y;
            if (distorted) {
                undistort_point(c, px[r], py[r], x, y);
            } else {
                x = (px[r] - c.cx) / c.fx;
                y = (py[r] - c.cy) / c.fy;
            }
            const double nb = std::sqrt(plain3(x, y, 1.0, x, y, 1.0));   // b /= np.linalg.norm(b, axis=1)
            const double b0 = x / nb, b1 = y / nb, b2 = 1.0 / nb;
            for (int j = 0; j < 3; j++) out[3 * r + j] = chain3(c.R[3 * j], c.R[3 * j + 1], c.R[3 * j + 2], b0, b1, b2);   // R_c2w @ b.T
        }
        return out;
    }

    // = base Survey.back_project: photo i's pixels cast from its origin
    Hits back_project(size_t i, const double* px, const double* py, size_t n) const {
        std::vector<double> d = pixel_dirs(i, px, py, n), o(3 * n);
        for (size_t r = 0; r < n; r++) std::copy(cams[i].origin, cams[i].origin + 3, &o[3 * r]);
        return cast(o.data(), d.data(), n);
    }

    // = base Survey.bake: rays [(photo, xs, ys)] of one class -> what bakeobj.run_bake(min_observations=1) writes, in
    // its order (spill partition, then voxel): per voxel the best hit ((1/(1+dist))*|cos|, earliest on ties) at
    // NORMAL_OFFSET, to 4 decimals, and bit j = "rays[j] hit it"
    struct Baked {
        std::vector<double> P;
        std::vector<uint64_t> bits;
    };
    Baked bake(const std::vector<std::tuple<int64_t, std::vector<double>, std::vector<double>>>& rays, const std::string& cls) const {
        const double vox = per_class(values, "bake.voxel_size_m", cls, 0.01);
        int64_t cls_index = -1;
        for (size_t c = 0; c < classes.size(); c++)
            if (classes[c] == cls) cls_index = (int64_t)c;
        if (cls_index < 0) throw std::invalid_argument("unknown class '" + cls + "'");
        std::vector<double> P, C;
        std::vector<uint64_t> B;
        for (size_t j = 0; j < rays.size(); j++) {
            const int64_t i = std::get<0>(rays[j]);
            const auto& xs = std::get<1>(rays[j]);
            const auto& ys = std::get<2>(rays[j]);
            if (i < 0 || (size_t)i >= cams.size()) throw std::out_of_range("photo index " + std::to_string(i) + " is out of range");
            if (xs.size() != ys.size()) throw std::invalid_argument("xs and ys differ in length");
            const double* O = cams[i].origin;
            for (size_t c = 0; c < xs.size(); c += RAY_CHUNK) {   // run_bake's chunks
                const size_t m = std::min((size_t)RAY_CHUNK, xs.size() - c);
                const std::vector<double> d = pixel_dirs((size_t)i, &xs[c], &ys[c], m);
                std::vector<double> o(3 * m);
                for (size_t r = 0; r < m; r++) std::copy(O, O + 3, &o[3 * r]);
                const Hits h = cast(o.data(), d.data(), m);
                for (size_t r = 0; r < h.ray.size(); r++) {
                    const double* loc = &h.loc[3 * r];
                    const double* nrm = &h.normal[3 * r];
                    const double md = std::max(h.dist[r], 1e-9);
                    double t[3];
                    for (int a = 0; a < 3; a++) {
                        P.push_back(loc[a] + nrm[a] * NORMAL_OFFSET);
                        t[a] = (loc[a] - O[a]) / md * nrm[a];
                    }
                    C.push_back(1.0 / (1.0 + h.dist[r]) * std::abs((t[0] + t[1]) + t[2]));
                    B.push_back((uint64_t)1 << j);
                }
            }
        }
        const size_t n = C.size();
        std::vector<int64_t> key(n), part(n);
        for (size_t r = 0; r < n; r++) {
            key[r] = key3(&P[3 * r], vox);
            int64_t k[3];
            for (int a = 0; a < 3; a++) k[a] = (int64_t)std::floor(P[3 * r + a] / vox) >> SPILL_TILE_SHIFT;
            const uint64_t h = ((uint64_t)k[0] * 73856093ULL) ^ ((uint64_t)k[1] * 19349663ULL) ^ ((uint64_t)k[2] * 83492791ULL) ^
                               ((uint64_t)cls_index * 2654435761ULL);
            part[r] = (int64_t)((h & 0x7FFFFFFFFFFFFFFFULL) % (uint64_t)SPILL_PARTITIONS);
        }
        std::vector<size_t> o(n);
        for (size_t r = 0; r < n; r++) o[r] = r;
        std::stable_sort(o.begin(), o.end(), [&](size_t a, size_t b) {   // np.lexsort((-C, key, part))
            if (part[a] != part[b]) return part[a] < part[b];
            if (key[a] != key[b]) return key[a] < key[b];
            return -C[a] < -C[b];
        });
        Baked out;
        for (size_t s = 0; s < n;) {
            size_t e = s;
            uint64_t bits = 0;
            while (e < n && key[o[e]] == key[o[s]]) bits |= B[o[e++]];
            for (int a = 0; a < 3; a++) {   // np.round(x, 4), and Python's round(x, 4) where x * 1e4 is a hair from a half
                const double x = P[3 * o[s] + a], y = x * 1e4;
                double mod = std::fmod(y, 1.0);
                if (mod != 0 && mod < 0) mod += 1.0;
                double r = std::nearbyint(y) / 1e4;
                if (std::abs(mod - 0.5) < 1e-6) {
                    char buf[400];
                    std::snprintf(buf, sizeof buf, "%.4f", x);
                    r = std::strtod(buf, nullptr);
                }
                out.P.push_back(r);
            }
            out.bits.push_back(bits);
            s = e;
        }
        return out;
    }

    // = base Survey.project: points P (n,3) -> pixels by OpenCV's distortion model, per camera ci (k):
    // uv (k,n,2), z (k,n)
    void project(const double* P, size_t n, const int64_t* ci, size_t k, std::vector<double>& uv, std::vector<double>& z) const {
        uv.assign(2 * k * n, 0.0);
        z.assign(k * n, 0.0);
        for (size_t a = 0; a < k; a++) {
            const Camera& c = cams[ci[a]];
            const double* R = c.R;
            const double k1 = c.dist[0], k2 = c.dist[1], p1 = c.dist[2], p2 = c.dist[3], k3 = c.dist[4];
            for (size_t b = 0; b < n; b++) {
                const double q0 = P[3 * b] - c.origin[0], q1 = P[3 * b + 1] - c.origin[1], q2 = P[3 * b + 2] - c.origin[2];
                double pc[3];
                for (int i = 0; i < 3; i++) pc[i] = dot3_np(q0, q1, q2, R[i], R[3 + i], R[6 + i]);
                const double zz = pc[2] > 1e-6 ? pc[2] : 1;
                const double x = pc[0] / zz, y = pc[1] / zz;
                const double r2 = x * x + y * y;
                const double rad = 1 + k1 * r2 + k2 * (r2 * r2) + k3 * std::pow(r2, 3.0);
                const double u = c.fx * (x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)) + c.cx;
                const double v = c.fy * (y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y) + c.cy;
                uv[2 * (a * n + b)] = u;
                uv[2 * (a * n + b) + 1] = v;
                z[a * n + b] = pc[2];
            }
        }
    }

    // = base Survey.visible: (k,n) in frame (shrunk by margin), facing within 75 deg, <= ray distance, unoccluded
    Visibility visible(const double* P, const double* N, size_t n, const int64_t* ci, size_t k, double margin) const {
        Visibility vis;
        std::vector<double> z;
        project(P, n, ci, k, vis.uv, z);
        vis.ok.assign(k * n, 0);
        vis.dist.assign(k * n, 0.0);
        vis.cos.assign(k * n, 0.0);
        const double facing = 0.25881904510252074;   // np.cos(np.radians(75))
        std::vector<size_t> kk, nn;                  // np.nonzero(ok)
        for (size_t a = 0; a < k; a++) {
            const Camera& c = cams[ci[a]];
            const double W = c.W, H = c.H;
            for (size_t b = 0; b < n; b++) {
                const size_t e = a * n + b;
                const double r0 = c.origin[0] - P[3 * b], r1 = c.origin[1] - P[3 * b + 1], r2 = c.origin[2] - P[3 * b + 2];
                const double dist = std::sqrt(plain3(r0, r1, r2, r0, r1, r2));
                const double cos = dot3_einsum_nj(r0, r1, r2, N[3 * b], N[3 * b + 1], N[3 * b + 2]) / std::max(dist, 1e-9);
                const double u = vis.uv[2 * e], v = vis.uv[2 * e + 1];
                const bool ok = (z[e] > 0) & (u >= W * margin) & (u < W * (1 - margin)) & (v >= H * margin) &
                                (v < H * (1 - margin)) & (dist <= max_dist) & (cos > facing);
                vis.dist[e] = dist;
                vis.cos[e] = cos;
                vis.ok[e] = ok;
                if (ok) kk.push_back(a), nn.push_back(b);
            }
        }
        if (!kk.empty()) {   // occlusion: a hit nearer than the point (by more than 3 cm) on the ray to it
            const size_t m = kk.size();
            std::vector<double> o(3 * m), d(3 * m);
            for (size_t q = 0; q < m; q++) {
                const double* O = cams[ci[kk[q]]].origin;
                const double dd = vis.dist[kk[q] * n + nn[q]];
                for (int j = 0; j < 3; j++) {
                    o[3 * q + j] = O[j];
                    d[3 * q + j] = (P[3 * nn[q] + j] - O[j]) / dd;
                }
            }
            const Hits h = cast(o.data(), d.data(), m);
            std::vector<double> hit(m, std::numeric_limits<double>::infinity());
            for (size_t t = 0; t < h.ray.size(); t++) hit[h.ray[t]] = h.dist[t];
            for (size_t q = 0; q < m; q++) {
                const size_t e = kk[q] * n + nn[q];
                if (hit[q] < vis.dist[e] - 0.03) vis.ok[e] = 0;
            }
        }
        return vis;
    }

private:
    // base setup: per photo, the cells (FOOT_CELL) its coarse FOOT ray grid hits, all and the inner ones
    void build_footprints() {
        const int gx = FOOT_X, gy = FOOT_Y;
        std::vector<double> X(gx * gy), Y(gx * gy);   // np.meshgrid(...), raveled
        for (size_t i = 0; i < cams.size(); i++) {
            const double W = cams[i].W, H = cams[i].H;
            for (int r = 0; r < gy; r++)
                for (int c = 0; c < gx; c++) {
                    X[r * gx + c] = ((c + .5) * W) / gx;
                    Y[r * gx + c] = ((r + .5) * H) / gy;
                }
            const Hits h = back_project(i, X.data(), Y.data(), X.size());
            Footprint f;
            for (size_t t = 0; t < h.ray.size(); t++) {
                const int64_t key = key3(&h.loc[3 * t], FOOT_CELL);
                f.cells.push_back(key);
                const int64_t rr = h.ray[t];
                if (std::abs(X[rr] / W - .5) < .5 - INNER && std::abs(Y[rr] / H - .5) < .5 - INNER) f.inner.push_back(key);
            }
            for (auto* v : {&f.cells, &f.inner}) {   // np.unique
                std::sort(v->begin(), v->end());
                v->erase(std::unique(v->begin(), v->end()), v->end());
            }
            foot.push_back(std::move(f));
        }
    }

    // points.json + points.bin: position (float32), class_id, cluster_id (int32)
    void load_full(const std::string& content) {
        const std::string hp = content + "/points.json", bp = content + "/points.bin";
        Json hdr = read_json(hp);
        const Json* arrays = hdr.find("arrays");
        if (!arrays) fail(hp, "missing 'arrays'");
        std::string bin = read_file(bp);
        auto get = [&](const char* key, const char* dtype, size_t width, size_t cols, void* dst_vec, auto resize) {
            const Json* a = arrays->find(key);
            const Json* dt = a ? a->find("dtype") : nullptr;
            const Json* shape = a ? a->find("shape") : nullptr;
            const Json* off = a ? a->find("offset") : nullptr;
            if (!a || !dt || !shape || !off || shape->type != Json::Arr || shape->a.empty() || off->type != Json::Num)
                fail(hp, std::string("bad array '") + key + "'");
            if (dt->type != Json::Str || dt->s != dtype) fail(hp, std::string("array '") + key + "' is not " + dtype);
            size_t count = 1;
            for (auto& d : shape->a) count *= (size_t)d.n;
            if (shape->a.size() != (cols > 1 ? 2u : 1u) || (cols > 1 && (size_t)shape->a[1].n != cols))
                fail(hp, std::string("array '") + key + "' has an unexpected shape");
            size_t o = (size_t)off->n;
            if (o + count * width > bin.size()) fail(bp, std::string("too short for array '") + key + "'");
            resize(dst_vec, count);
            return std::make_pair(bin.data() + o, count * width);
        };
        auto p = get("position", "float32", 4, 3, &full_pos, [](void* v, size_t n) { ((std::vector<float>*)v)->resize(n); });
        std::memcpy(full_pos.data(), p.first, p.second);
        auto c = get("class_id", "int32", 4, 1, &full_class, [](void* v, size_t n) { ((std::vector<int32_t>*)v)->resize(n); });
        std::memcpy(full_class.data(), c.first, c.second);
        auto u = get("cluster_id", "int32", 4, 1, &full_cluster, [](void* v, size_t n) { ((std::vector<int32_t>*)v)->resize(n); });
        std::memcpy(full_cluster.data(), u.first, u.second);
        if (full_class.size() != full_pos.size() / 3 || full_cluster.size() != full_pos.size() / 3)
            fail(hp, "class_id / cluster_id do not have one row per position row");
        const Json* hf = hdr.find("handedness_fix");
        if (hf && hf->type == Json::Str && hf->s == "negate_y")
            for (size_t i = 1; i < full_pos.size(); i += 3) full_pos[i] *= -1;
        const Json* cd = hdr.find("cluster_distance_m");
        const Json* mp = hdr.find("min_cluster_points");
        const Json* cn = hdr.find("class_names");
        if (!cd || cd->type != Json::Num || !mp || mp->type != Json::Num || !cn || cn->type != Json::Arr) fail(hp, "missing cluster rule or class_names");
        cluster_distance_m = cd->n;
        min_cluster_points = (int)mp->n;
        for (auto& s : cn->a) full_class_names.push_back(s.s);
    }
};

// = base clusters(P, t, min_pts), which equals the cook's _grid_cluster(P, one class, t, min_pts): single linkage over
// points within t of each other (squared distance <= t*t, in t-cells that are neighbours), groups numbered by their
// smallest member, small ones -1. The fast way: points in the same or a face-adjacent t/3 cell are < t apart, so their
// cells are linked untested; the other cell pairs in reach are tested point by point, faces first then nearest first,
// only while the two cells are in different components.
static std::vector<int32_t> clusters(const double* P, size_t n, double t, int min_pts) {
    std::vector<int32_t> out(n, -1);
    if (!n) return out;
    t = std::max(t, 1e-6);
    std::vector<int64_t> C(3 * n);   // the cook's cells
    for (size_t i = 0; i < 3 * n; i++) C[i] = (int64_t)std::floor(P[i] / t);
    const double cell3 = t / 3;
    std::vector<int64_t> pkey(n);
    for (size_t i = 0; i < n; i++) pkey[i] = key3(&P[3 * i], cell3);
    std::vector<int64_t> uk(pkey);   // np.unique(keys(P, t / 3)): the cells
    std::sort(uk.begin(), uk.end());
    uk.erase(std::unique(uk.begin(), uk.end()), uk.end());
    const size_t m = uk.size();
    std::unordered_map<int64_t, uint32_t> cell_of;
    cell_of.reserve(2 * m);
    for (size_t c = 0; c < m; c++) cell_of.emplace(uk[c], (uint32_t)c);
    std::vector<uint32_t> cell(n), cnt(m, 0), start(m + 1, 0), order(n);   // the points of each cell, by index
    for (size_t i = 0; i < n; i++) cnt[cell[i] = cell_of[pkey[i]]]++;
    for (size_t c = 0; c < m; c++) start[c + 1] = start[c] + cnt[c];
    {
        std::vector<uint32_t> at(start.begin(), start.end() - 1);
        for (size_t i = 0; i < n; i++) order[at[cell[i]]++] = (uint32_t)i;
    }
    // the offsets in reach: one of +-D, gap^2 <= 9 in t/3 units, faces first, then nearest first
    struct Off { int d[3]; int gap, sum; };
    std::vector<Off> D;
    for (int x = -4; x <= 4; x++)
        for (int y = -4; y <= 4; y++)
            for (int z = -4; z <= 4; z++) {
                int g = 0;
                for (int v : {x, y, z}) g += std::max(std::abs(v) - 1, 0) * std::max(std::abs(v) - 1, 0);
                if (81 * x + 9 * y + z > 0 && g <= 9) D.push_back({{x, y, z}, g, std::abs(x) + std::abs(y) + std::abs(z)});
            }
    std::stable_sort(D.begin(), D.end(), [](const Off& a, const Off& b) { return 10 * a.gap + a.sum < 10 * b.gap + b.sum; });
    std::vector<uint32_t> parent(m);
    for (size_t c = 0; c < m; c++) parent[c] = (uint32_t)c;
    auto find = [&](uint32_t x) {
        while (parent[x] != x) x = parent[x] = parent[parent[x]];
        return x;
    };
    const double tt = t * t;
    for (const Off& d : D) {
        const int64_t delta = d.d[0] * ((int64_t)1 << 42) + d.d[1] * ((int64_t)1 << 21) + d.d[2];
        for (size_t a = 0; a < m; a++) {
            auto it = cell_of.find(uk[a] + delta);
            if (it == cell_of.end()) continue;
            const uint32_t b = it->second;
            uint32_t ra = find((uint32_t)a), rb = find(b);
            if (ra == rb) continue;
            bool link = d.sum <= 1;   // a face: linked untested
            for (uint32_t u = start[a]; !link && u < start[a + 1]; u++) {
                const size_t i = order[u];
                for (uint32_t w = start[b]; w < start[b + 1]; w++) {
                    const size_t j = order[w];
                    const double o0 = P[3 * i] - P[3 * j], o1 = P[3 * i + 1] - P[3 * j + 1], o2 = P[3 * i + 2] - P[3 * j + 2];
                    if (plain3(o0, o1, o2, o0, o1, o2) <= tt && std::abs(C[3 * i] - C[3 * j]) <= 1 &&
                        std::abs(C[3 * i + 1] - C[3 * j + 1]) <= 1 && std::abs(C[3 * i + 2] - C[3 * j + 2]) <= 1) {
                        link = true;
                        break;
                    }
                }
            }
            if (link) parent[std::max(ra, rb)] = std::min(ra, rb);
        }
    }
    // _renumber_clusters: groups ordered by their smallest member index, groups below min_pts dropped
    std::vector<size_t> size(m, 0);
    for (size_t c = 0; c < m; c++) size[find((uint32_t)c)] += cnt[c];
    std::vector<int32_t> id(m, -2);
    int32_t next = 0;
    for (size_t i = 0; i < n; i++) {
        const uint32_t r = find(cell[i]);
        if (id[r] == -2) id[r] = size[r] >= (size_t)min_pts ? next++ : -1;
        out[i] = id[r];
    }
    return out;
}

// = base at_click: the points in the cluster(s) at the click: those with a point within SEED_M of it, else the
// nearest cluster within 0.5 m, else none
template <class C>   // the cluster ids' integer type: int32 from clusters() and points.bin, int64 from the test binding
static std::vector<uint8_t> at_click(const double* P, const C* cluster, size_t n, const double seed[3]) {
    std::vector<double> d(n);
    double dmin = std::numeric_limits<double>::infinity();
    bool any_ok = false;
    for (size_t i = 0; i < n; i++) {
        const double a = P[3 * i] - seed[0], b = P[3 * i + 1] - seed[1], c = P[3 * i + 2] - seed[2];
        d[i] = std::sqrt(plain3(a, b, c, a, b, c));
        if (cluster[i] >= 0) {
            any_ok = true;
            dmin = std::min(dmin, d[i]);
        }
    }
    std::vector<uint8_t> near(n, 0);
    bool any_near = false;
    for (size_t i = 0; i < n; i++)
        if (cluster[i] >= 0 && d[i] <= SEED_M) near[i] = any_near = true;
    if (!any_near && any_ok && dmin <= 0.5)
        for (size_t i = 0; i < n; i++)
            if (cluster[i] >= 0 && d[i] == dmin) near[i] = true;
    std::set<C> hit;
    for (size_t i = 0; i < n; i++)
        if (near[i]) hit.insert(cluster[i]);
    std::vector<uint8_t> out(n, 0);
    for (size_t i = 0; i < n; i++) out[i] = cluster[i] >= 0 && hit.count(cluster[i]);
    return out;
}

// ------------------------------------------------------------------------------------------------
// kept: the blob rule on the DS grid (base Survey.kept)
// ------------------------------------------------------------------------------------------------
// cv::getStructuringElement(MORPH_ELLIPSE, (2r+1)^2): row dy = -r..r spans columns c-dx .. c+dx; returns dx per row
static std::vector<int> ellipse_halfwidths(int r) {
    const int c = r, ksize = 2 * r + 1;
    const double inv_r2 = r ? 1. / ((double)r * r) : 0.;
    std::vector<int> hw(ksize);
    for (int i = 0; i < ksize; i++) {
        const int dy = i - r;
        hw[i] = (int)std::nearbyint(c * std::sqrt((double)(r * r - dy * dy) * inv_r2));   // cvRound: half to even
    }
    return hw;
}

// maxpool over full DS x DS blocks, thresholded: (H/DS, W/DS) of 0/1
static std::vector<uint8_t> pool_threshold(const uint8_t* m, int H, int W, int floor_v) {
    const int h = H / DS, w = W / DS;
    std::vector<uint8_t> b((size_t)h * w);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            uint8_t mx = 0;
            for (int dy = 0; dy < DS; dy++) {
                const uint8_t* row = m + (size_t)(y * DS + dy) * W + x * DS;
                for (int dx = 0; dx < DS; dx++) mx = std::max(mx, row[dx]);
            }
            b[(size_t)y * w + x] = mx >= floor_v;
        }
    return b;
}

// cv2.dilate(b, ellipse(2r+1)) of a 0/1 image; the border adds nothing
static std::vector<uint8_t> dilate_ellipse(const std::vector<uint8_t>& b, int h, int w, int r) {
    const std::vector<int> hw = ellipse_halfwidths(r);
    std::vector<int> slot(r + 1, -1);   // half-width -> index of its horizontally dilated copy
    int nd = 0;
    for (int dx : hw) if (slot[dx] < 0) slot[dx] = nd++;
    std::vector<uint8_t> rowany(h);
    for (int y = 0; y < h; y++)
        rowany[y] = std::any_of(b.begin() + (size_t)y * w, b.begin() + (size_t)(y + 1) * w, [](uint8_t v) { return v != 0; });
    // every non-empty row, dilated horizontally by every distinct half-width (via prefix counts)
    std::vector<std::vector<uint8_t>> hd(nd, std::vector<uint8_t>((size_t)h * w, 0));
    std::vector<int> cnt(w + 1);
    for (int y = 0; y < h; y++) {
        if (!rowany[y]) continue;
        const uint8_t* br = &b[(size_t)y * w];
        cnt[0] = 0;
        for (int x = 0; x < w; x++) cnt[x + 1] = cnt[x] + (br[x] != 0);
        for (int d = 0; d <= r; d++) {
            if (slot[d] < 0) continue;
            uint8_t* o = &hd[slot[d]][(size_t)y * w];
            for (int x = 0; x < w; x++) o[x] = cnt[std::min(x + d + 1, w)] > cnt[std::max(x - d, 0)];
        }
    }
    std::vector<uint8_t> out((size_t)h * w, 0);
    for (int y = 0; y < h; y++) {
        uint8_t* o = &out[(size_t)y * w];
        for (int dy = -r; dy <= r; dy++) {
            const int yy = y + dy;
            if (yy < 0 || yy >= h || !rowany[yy]) continue;
            const uint8_t* src = &hd[slot[hw[dy + r]]][(size_t)yy * w];
            for (int x = 0; x < w; x++) o[x] |= src[x];
        }
    }
    return out;
}

// cv2.connectedComponents(img, connectivity=8): labels 1.. (not OpenCV's numbering; only membership is used)
static std::vector<int32_t> components8(const std::vector<uint8_t>& img, int h, int w) {
    std::vector<int32_t> lab((size_t)h * w, 0), parent(1, 0);
    auto find = [&](int32_t a) { while (parent[a] != a) a = parent[a] = parent[parent[a]]; return a; };
    auto unite = [&](int32_t a, int32_t b) { a = find(a), b = find(b); if (a != b) parent[std::max(a, b)] = std::min(a, b); };
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            const size_t i = (size_t)y * w + x;
            if (!img[i]) continue;
            int32_t l = 0;
            auto take = [&](int yy, int xx) {
                if (yy < 0 || xx < 0 || xx >= w) return;
                const int32_t n = lab[(size_t)yy * w + xx];
                if (!n) return;
                if (!l) l = n; else unite(l, n);
            };
            take(y, x - 1), take(y - 1, x - 1), take(y - 1, x), take(y - 1, x + 1);
            if (!l) { l = (int32_t)parent.size(); parent.push_back(l); }
            lab[i] = l;
        }
    for (auto& v : lab) if (v) v = find(v);
    return lab;
}

// = base Survey.kept with the link radius r (cells) already chosen: the cells of the blobs of `mask` (H, W uint8)
// that touch q (n, 2) as (x, y) +- rr (indices clamped to the grid); near_gap: "touch" is within r of the blob.
// Returns (H/DS, W/DS) of 0/1.
static std::vector<uint8_t> kept_cells(const uint8_t* mask, int H, int W, int floor_v, int r, bool near_gap,
                                       const int64_t* q, size_t n, int rr) {
    const int h = H / DS, w = W / DS;
    const std::vector<uint8_t> b = pool_threshold(mask, H, W, floor_v);
    std::vector<uint8_t> out((size_t)h * w, 0);
    if (!h || !w) return out;
    const std::vector<int32_t> lab = components8(dilate_ellipse(b, h, w, r), h, w);
    std::set<int32_t> keep;
    for (size_t k = 0; k < n; k++)
        for (int dy = -rr; dy <= rr; dy++) {
            const int64_t y = std::min<int64_t>(std::max<int64_t>(q[2 * k + 1] + dy, 0), h - 1);
            for (int dx = -rr; dx <= rr; dx++) {
                const int64_t x = std::min<int64_t>(std::max<int64_t>(q[2 * k] + dx, 0), w - 1);
                const size_t i = (size_t)y * w + x;
                if (lab[i] > 0 && (near_gap || b[i])) keep.insert(lab[i]);   // else base's L is the zeroed lab
            }
        }
    for (size_t i = 0; i < out.size(); i++) out[i] = b[i] && keep.count(lab[i]);
    return out;
}

// the link radius: LINK, or for a GAP_M class half the gap in photo i's cells at the seed's distance
static int kept_radius(const Survey& s, const std::string& cls, size_t i, const double* seed) {
    if (!in_gap_m(cls)) return LINK;
    const double* o = s.cams[i].origin;
    const double d0 = o[0] - seed[0], d1 = o[1] - seed[1], d2 = o[2] - seed[2];
    const double dist = std::sqrt((d0 * d0 + d1 * d1) + d2 * d2);
    const double r = gap_m(cls) / 2 * s.cams[i].fx / dist / DS;
    return (int)std::min(std::max(r, (double)LINK), 80.0);
}

// ------------------------------------------------------------------------------------------------
// numpy's reductions and order statistics, where the follow loop compares or truncates their results
// ------------------------------------------------------------------------------------------------
// np.add.reduce along a contiguous axis (a 1-D .sum(), .sum(1) of a C-ordered array): numpy's pairwise sum, 8
// accumulators up to 128 values, halves cut at a multiple of 8 above (measured identical on numpy 2.4.6)
static double pairwise_sum(const double* a, size_t n) {
    if (n < 8) {
        double r = -0.0;
        for (size_t i = 0; i < n; i++) r += a[i];
        return r;
    }
    if (n <= 128) {
        double r[8];
        for (int k = 0; k < 8; k++) r[k] = a[k];
        size_t i = 8;
        for (; i < n - n % 8; i += 8)
            for (int k = 0; k < 8; k++) r[k] += a[i + k];
        double res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        for (; i < n; i++) res += a[i];
        return res;
    }
    size_t n2 = n / 2;
    n2 -= n2 % 8;
    return pairwise_sum(a, n2) + pairwise_sum(a + n2, n - n2);
}

// np.linspace(0, n - 1, m).astype(int), m <= n: trunc(k * ((n - 1) / (m - 1))), the last one n - 1; m = 1 -> [0]
static std::vector<size_t> linspace_index(size_t n, size_t m) {
    std::vector<size_t> out(m, 0);
    if (m > 1) {
        const double step = (double)(n - 1) / (double)(m - 1);
        for (size_t k = 0; k < m; k++) out[k] = (size_t)((double)k * step);
        out[m - 1] = n - 1;
    }
    return out;
}

// np.percentile(a, 100 * q) of a sorted, by the default linear method as numpy's _quantile computes it: the virtual
// index (n - 1) * q, its neighbours (_get_indexes: -1 = the last one), gamma = index - previous (_get_gamma), _lerp
static double percentile_linear(const std::vector<double>& sorted, double q) {
    const size_t n = sorted.size();
    const double vi = (double)(n - 1) * q;
    double prev = std::floor(vi), next = prev + 1;
    if (vi >= (double)(n - 1)) prev = next = -1;
    if (vi < 0) prev = next = 0;
    const double a = sorted[prev < 0 ? n - 1 : (size_t)prev], b = sorted[next < 0 ? n - 1 : (size_t)next];
    const double t = vi - prev, diff = b - a;
    return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
}

// np.median: the middle value, or the mean of the two middle ones, (lo + hi) / 2
static double median(std::vector<double> a) {
    const size_t h = a.size() / 2;
    std::nth_element(a.begin(), a.begin() + (std::ptrdiff_t)h, a.end());
    if (a.size() % 2) return a[h];
    return (*std::max_element(a.begin(), a.begin() + (std::ptrdiff_t)h) + a[h]) / 2;
}

// np.argsort(-x) (stable on ties, where numpy's quicksort may order them otherwise: accepted), np.argmax (the first)
static std::vector<size_t> argsort_desc(const std::vector<double>& x) {
    std::vector<size_t> o(x.size());
    std::iota(o.begin(), o.end(), (size_t)0);
    std::stable_sort(o.begin(), o.end(), [&](size_t a, size_t b) { return -x[a] < -x[b]; });
    return o;
}
static size_t argmax_first(const std::vector<double>& x) {
    size_t b = 0;
    for (size_t i = 1; i < x.size(); i++)
        if (x[i] > x[b]) b = i;
    return b;
}

static inline double dist_to(const double* a, const double* b) {   // np.linalg.norm(a - b)
    const double d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
    return std::sqrt(plain3(d0, d1, d2, d0, d1, d2));
}

// cKDTree(T).query(p, distance_upper_bound=tol)[0] <= tol: some point of T at squared distance < tol * tol (at exactly
// tol cKDTree's own arithmetic may decide otherwise: accepted). A hash grid of cell tol, the 27 cells around p.
class NearGrid {
public:
    NearGrid(const std::vector<double>& T, double tol) : T_(T), tol_(tol) {
        for (size_t k = 0; k < T.size() / 3; k++) cells_[cell(&T[3 * k], 0, 0, 0)].push_back(k);
    }
    bool any_within(const double* p) const {
        for (int dx = -1; dx <= 1; dx++)
            for (int dy = -1; dy <= 1; dy++)
                for (int dz = -1; dz <= 1; dz++) {
                    auto it = cells_.find(cell(p, dx, dy, dz));
                    if (it == cells_.end()) continue;
                    for (size_t k : it->second) {
                        const double a = p[0] - T_[3 * k], b = p[1] - T_[3 * k + 1], c = p[2] - T_[3 * k + 2];
                        if (plain3(a, b, c, a, b, c) < tol_ * tol_) return true;
                    }
                }
        return false;
    }

private:
    struct Cell {
        int64_t x, y, z;
        bool operator==(const Cell& o) const { return x == o.x && y == o.y && z == o.z; }
    };
    struct CellHash {
        size_t operator()(const Cell& c) const {
            return std::hash<uint64_t>()(((uint64_t)c.x * 73856093ULL) ^ ((uint64_t)c.y * 19349663ULL) ^ ((uint64_t)c.z * 83492791ULL));
        }
    };
    Cell cell(const double* p, int dx, int dy, int dz) const {
        return {(int64_t)std::floor(p[0] / tol_) + dx, (int64_t)std::floor(p[1] / tol_) + dy, (int64_t)std::floor(p[2] / tol_) + dz};
    }
    const std::vector<double>& T_;
    double tol_;
    std::unordered_map<Cell, std::vector<size_t>, CellHash> cells_;
};

// ------------------------------------------------------------------------------------------------
// the follow loop: base Survey.follow, next_photo, _views, confirm_pick and confirm, line by line, with these reads:
// the first look runs the grid tiles over the box at the click; a tiled class's later reads grow on its tile grid
// ------------------------------------------------------------------------------------------------
using Tile = std::pair<int, int>;                            // a grid tile's origin (y, x)
using Masks = std::map<std::string, std::vector<uint8_t>>;   // class -> its (H, W) uint8 mask of the photo
// the models: infer(photo, classes, the grid tiles to run or null = every tile) -> each class's mask
using Infer = std::function<Masks(size_t, const std::vector<std::string>&, const std::vector<Tile>*)>;
using Photos = std::vector<std::pair<int64_t, std::string>>;   // (photo, phase) in the order they were taken

struct Followed {
    Photos photos;
    std::vector<int> tiles;              // per photos entry: the grid tiles its class read ran, -1 = null (not grown)
    std::optional<std::string> cls;      // the class followed; none = nothing at the click
    std::string stop;
    std::vector<double> tracked;         // (n,3) samples of the followed defect
    std::vector<std::tuple<int64_t, std::vector<double>, std::vector<double>>> rays;   // per class read, in read order: (photo, xs, ys)
};

// sliding_window.tile_origins
static std::vector<int> tile_origins(int extent, int tile, int overlap) {
    if (extent <= tile) return {0};
    const int step = std::max(1, tile - overlap);
    std::vector<int> xs;
    for (int x = 0; x <= extent - tile; x += step) xs.push_back(x);
    if (xs.back() != extent - tile) xs.push_back(extent - tile);
    return xs;
}

// photo i's tiles of class cls's grid, rows of tile_origins(H) outer; none when cls has no grid or the photo is
// smaller than a tile (its reads then run every tile: tiles = None)
static std::vector<Tile> photo_grid(const Survey& s, const std::string& cls, size_t i) {
    auto g = s.grids.find(cls);
    const Camera& c = s.cams[i];
    if (g == s.grids.end() || std::min(c.H, c.W) < g->second.first || std::min(c.H, c.W) < DS) return {};
    std::vector<Tile> out;
    for (int y : tile_origins(c.H, g->second.first, g->second.second))
        for (int x : tile_origins(c.W, g->second.first, g->second.second)) out.emplace_back(y, x);
    return out;
}

static int64_t min_mask_area(const Survey& s) {   // int(values.get("inference.min_mask_area_px", 64))
    const Json* v = s.values.find("inference.min_mask_area_px");
    return v && v->type == Json::Num ? (int64_t)v->n : 64;
}

// the first look's tiles: those of the tiled class's grid over the box (y0, y1, x0, x1) grown by min_mask_area_px on
// each side, clipped (the base inferred that much around the box); null when no class asked for has a grid, two have
// different ones, or the photo is smaller than a tile
static std::optional<std::vector<Tile>> box_tiles(const Survey& s, size_t i, const std::vector<std::string>& classes,
                                                  int64_t y0, int64_t y1, int64_t x0, int64_t x1) {
    const std::string* tiled = nullptr;
    for (const auto& c : classes) {
        auto g = s.grids.find(c);
        if (g == s.grids.end()) continue;
        if (tiled && s.grids.at(*tiled) != g->second) return std::nullopt;
        tiled = &c;
    }
    const std::vector<Tile> grid = tiled ? photo_grid(s, *tiled, i) : std::vector<Tile>();
    if (grid.empty()) return std::nullopt;
    const int64_t pad = min_mask_area(s), T = s.grids.at(*tiled).first, H = s.cams[i].H, W = s.cams[i].W;
    const int64_t Y0 = std::max<int64_t>(0, y0 - pad), Y1 = std::min(H, y1 + pad);
    const int64_t X0 = std::max<int64_t>(0, x0 - pad), X1 = std::min(W, x1 + pad);
    std::vector<Tile> out;
    for (const Tile& g : grid)
        if (g.first < Y1 && g.first + T > Y0 && g.second < X1 && g.second + T > X0) out.push_back(g);
    return out;
}

// base _views: which photos see which tracked spots (every max(1, n // 3000)-th; normals from the first photo's rays),
// and which photos are done
struct Views {
    Visibility vis;              // (photos, n)
    size_t n;
    std::vector<uint8_t> done;   // per photo
};
static Views views(const Survey& s, const std::vector<double>& tracked, const Photos& photos) {
    const size_t nt = tracked.size() / 3, step = std::max<size_t>(1, nt / 3000), K = s.cams.size();
    std::vector<double> T;
    for (size_t k = 0; k < nt; k += step) T.insert(T.end(), &tracked[3 * k], &tracked[3 * k] + 3);
    const size_t n = T.size() / 3;
    const double* O = s.cams[photos[0].first].origin;
    std::vector<double> o(3 * n), d(3 * n), N(3 * n);
    for (size_t k = 0; k < n; k++) {
        const double r[3] = {T[3 * k] - O[0], T[3 * k + 1] - O[1], T[3 * k + 2] - O[2]};
        const double nr = std::sqrt(plain3(r[0], r[1], r[2], r[0], r[1], r[2]));
        for (int a = 0; a < 3; a++) {
            o[3 * k + a] = O[a];
            d[3 * k + a] = r[a] / nr;
            N[3 * k + a] = -r[a] / nr;
        }
    }
    const Hits h = s.cast(o.data(), d.data(), n);
    for (size_t t = 0; t < h.ray.size(); t++) std::copy(&h.normal[3 * t], &h.normal[3 * t] + 3, &N[3 * h.ray[t]]);
    std::vector<int64_t> all(K);
    std::iota(all.begin(), all.end(), (int64_t)0);
    Views v{s.visible(T.data(), N.data(), n, all.data(), K, 0.0), n, std::vector<uint8_t>(K, 0)};
    for (const auto& p : photos) v.done[p.first] = 1;
    return v;
}

// base next_photo: the photo not yet taken that sees the most open frontier (P, N; every max(1, n // 400)-th) well
// inside its frame (else anywhere in it), weighted by cos and GSD, least overlapping what is observed; -1 = none
static int64_t next_photo(const Survey& s, const std::vector<double>& P0, const std::vector<double>& N0,
                          const std::vector<int64_t>& done, const std::vector<int64_t>& observed) {
    const size_t n0 = P0.size() / 3, step = std::max<size_t>(1, n0 / 400);
    std::vector<double> P, N;
    for (size_t k = 0; k < n0; k += step) {
        P.insert(P.end(), &P0[3 * k], &P0[3 * k] + 3);
        N.insert(N.end(), &N0[3 * k], &N0[3 * k] + 3);
    }
    std::vector<int64_t> cand;   // np.setdiff1d(arange, done)
    for (int64_t k = 0; k < (int64_t)s.cams.size(); k++)
        if (std::find(done.begin(), done.end(), k) == done.end()) cand.push_back(k);
    const size_t n = P.size() / 3, nc = cand.size();
    if (!nc) return -1;
    for (double margin : {INNER, 0.0}) {
        const Visibility v = s.visible(P.data(), N.data(), n, cand.data(), nc, margin);
        std::vector<double> gsd(nc * n), seen, gain(nc, 0.0), row(n);
        for (size_t a = 0; a < nc; a++)
            for (size_t b = 0; b < n; b++) {
                gsd[a * n + b] = v.dist[a * n + b] / s.cams[cand[a]].fx;
                if (v.ok[a * n + b]) seen.push_back(gsd[a * n + b]);
            }
        if (!seen.empty()) {   // (vis * cos * clip(median(gsd[vis]) / gsd, 0, 1) ** 2).sum(1), C-ordered: pairwise
            const double med = median(seen);
            for (size_t a = 0; a < nc; a++) {
                for (size_t b = 0; b < n; b++) {
                    const double c = std::min(std::max(med / gsd[a * n + b], 0.0), 1.0);
                    row[b] = ((v.ok[a * n + b] ? 1.0 : 0.0) * v.cos[a * n + b]) * (c * c);
                }
                gain[a] = pairwise_sum(row.data(), n);
            }
        }
        if (gain[argmax_first(gain)] > 0) {
            std::vector<size_t> top = argsort_desc(gain);
            top.resize(std::min<size_t>(top.size(), 64));
            std::vector<double> score(top.size());
            for (size_t j = 0; j < top.size(); j++) {   // overlap = np.isin(footprint, observed).mean(), 1 for none
                const std::vector<int64_t>& cells = s.foot[cand[top[j]]].cells;
                size_t hit = 0;
                for (int64_t k : cells) hit += std::binary_search(observed.begin(), observed.end(), k);
                const double ov = cells.empty() ? 1.0 : (double)hit / (double)cells.size();
                score[j] = gain[top[j]] * ((1 - ov) * (1 - ov));
            }
            return cand[top[argmax_first(score)]];
        }
    }
    return -1;
}

// base confirm_pick (holes): the photo that best re-sees the tracked defect where it was seen least, from a new
// direction; -1 = none
static int64_t confirm_pick(const Survey& s, const std::vector<double>& tracked, const Photos& photos, const double* seed) {
    if (tracked.empty()) return -1;
    const Views V = views(s, tracked, photos);
    const size_t K = s.cams.size(), n = V.n;
    std::vector<double> res(K * n), top(n, -std::numeric_limits<double>::infinity());   // px per m = 1 / GSD
    std::vector<int64_t> seen(n, 0);                                                    // vis[done].sum(0)
    for (size_t k = 0; k < K; k++)
        for (size_t j = 0; j < n; j++) {
            const size_t e = k * n + j;
            res[e] = V.vis.ok[e] ? s.cams[k].fx / std::max(V.vis.dist[e], 1e-9) : 0;
            top[j] = std::max(top[j], res[e]);
            if (V.done[k]) seen[j] += V.vis.ok[e];
        }
    std::vector<double> ray(3 * K);
    for (size_t k = 0; k < K; k++) {
        const double nr = dist_to(s.cams[k].origin, seed);
        for (int a = 0; a < 3; a++) ray[3 * k + a] = (s.cams[k].origin[a] - seed[a]) / nr;
    }
    std::vector<double> gain(K, 0.0), row(n);
    for (size_t k = 0; k < K; k++) {
        if (V.done[k]) continue;   // np.where(done, 0, ...)
        double near = -std::numeric_limits<double>::infinity();   // (ray @ ray[done].T).max(1)
        for (size_t d = 0; d < K; d++)
            if (V.done[d])
                near = std::max(near, chain3(ray[3 * k], ray[3 * k + 1], ray[3 * k + 2], ray[3 * d], ray[3 * d + 1], ray[3 * d + 2]));
        const double angle = std::acos(std::min(std::max(near, -1.0), 1.0)) * (180.0 / M_PI);
        for (size_t j = 0; j < n; j++) {
            const size_t e = k * n + j;
            const double r = res[e] / std::max(top[j], 1e-9);
            const double fine = res[e] * FILL_GSD >= top[j] ? r * r : 0;
            row[j] = V.vis.cos[e] * fine / (double)(1 + seen[j]);
        }
        gain[k] = std::min(1.0, angle / FILL_ANGLE) * pairwise_sum(row.data(), n);   // C-ordered: pairwise
    }
    const size_t best = argmax_first(gain);
    return gain[best] > 0 ? (int64_t)best : -1;
}

// base confirm (classes not in GROW_ALL): extra views until each tracked spot has CONFIRM_VIEWS (<= CONFIRM_EXTRA more)
static void confirm(const Survey& s, const std::vector<double>& tracked, Photos& photos, const std::function<void(size_t)>& read) {
    if (tracked.empty()) return;
    Views V = views(s, tracked, photos);
    const size_t K = s.cams.size(), n = V.n;
    std::vector<int64_t> seen(n, 0);
    for (size_t k = 0; k < K; k++)
        if (V.done[k])
            for (size_t j = 0; j < n; j++) seen[j] += V.vis.ok[k * n + j];
    for (int it = 0; it < CONFIRM_EXTRA; it++) {
        std::vector<size_t> need;
        for (size_t j = 0; j < n; j++)
            if (seen[j] < CONFIRM_VIEWS) need.push_back(j);
        // (vis[:, need] * cos[:, need]).sum(1): that product is F-ordered, so numpy sums each row left to right from 0
        // (pairwise only for a single photo, where the row is contiguous)
        std::vector<double> gain(K, 0.0), row(need.size());
        for (size_t k = 0; k < K; k++) {
            for (size_t j = 0; j < need.size(); j++) row[j] = (V.vis.ok[k * n + need[j]] ? 1.0 : 0.0) * V.vis.cos[k * n + need[j]];
            double g = 0.0;
            if (K > 1)
                for (double x : row) g += x;
            else
                g = pairwise_sum(row.data(), row.size());
            gain[k] = V.done[k] ? 0 : g;
        }
        const size_t j = argmax_first(gain);
        if (need.empty() || gain[j] <= 0) break;
        read(j);
        photos.emplace_back((int64_t)j, "confirm");
        V.done[j] = 1;
        for (size_t t = 0; t < n; t++) seen[t] += V.vis.ok[j * n + t];
    }
}

// base Survey.follow: from the seed (a point on the mesh and its normal), photo to photo
class FollowLoop {
public:
    FollowLoop(const Survey& s, const double* seed, const double* normal, const Infer& infer) : s(s), infer(infer) {
        std::copy(seed, seed + 3, this->seed);
        std::copy(normal, normal + 3, this->normal);
    }

    Followed run() {
        const size_t K = s.cams.size();
        std::vector<int64_t> all(K);
        std::iota(all.begin(), all.end(), (int64_t)0);
        v0 = s.visible(seed, normal, 1, all.data(), K, 0.0);
        std::vector<int64_t> cand;
        for (size_t k = 0; k < K; k++)
            if (v0.ok[k]) cand.push_back((int64_t)k);
        if (cand.empty()) return finish("no photo sees the click");
        // 1. the photo that sees the click best (near its centre, fine GSD, face-on), then the next best (RETRIES)
        std::vector<double> gsd(cand.size()), score(cand.size());
        double gmin = std::numeric_limits<double>::infinity();
        for (size_t j = 0; j < cand.size(); j++) gmin = std::min(gmin, gsd[j] = v0.dist[cand[j]] / s.cams[cand[j]].fx);
        for (size_t j = 0; j < cand.size(); j++) {
            const Camera& c = s.cams[cand[j]];
            const double hx = c.W / 2.0, hy = c.H / 2.0, dx = v0.uv[2 * cand[j]] - hx, dy = v0.uv[2 * cand[j] + 1] - hy;
            const double r = std::sqrt(dx * dx + dy * dy) / std::sqrt(hx * hx + hy * hy), g = gmin / gsd[j];
            score[j] = gsd[j] > 3 * gmin ? -1 : g * g * v0.cos[cand[j]] * (1 - r * r);
        }
        const std::vector<size_t> order = argsort_desc(score);
        for (size_t t = 0; t < std::min(order.size(), (size_t)(1 + RETRIES)) && !cls; t++) {
            out.photos.emplace_back(cand[order[t]], "grow");
            cls = first_look((size_t)cand[order[t]]);
        }
        if (!cls) return finish("no damage at the click");

        // 2. follow the class: from now on only its mask, around the click first
        std::vector<uint8_t> mask;
        for (const auto& p : out.photos) {
            const Source src = at_first((size_t)p.first);
            mask = read((size_t)p.first, &src);
        }
        size_t i = (size_t)out.photos.back().first;
        Source src = at_first(i);
        int dry = 0;
        const int floor_v = s.floor_of.at(*cls);
        std::string stop;
        for (;;) {
            const Camera& c = s.cams[i];
            const int h = c.H / DS, w = c.W / DS;
            const std::vector<uint8_t> t = kept_cells(mask.data(), c.H, c.W, floor_v, kept_radius(s, *cls, i, seed),
                                                      src.near && in_gap_m(*cls), src.q.data(), src.q.size() / 2, src.rr);
            std::vector<int64_t> merged;   // observed = np.union1d(observed, foot[i] inner)
            std::set_union(observed.begin(), observed.end(), s.foot[i].inner.begin(), s.foot[i].inner.end(), std::back_inserter(merged));
            observed.swap(merged);
            int64_t added = 0;
            std::vector<int64_t> ys, xs;   // np.nonzero(t)
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                    if (t[(size_t)y * w + x]) ys.push_back(y), xs.push_back(x);
            if (!ys.empty()) {
                added = track(i, ys, xs, w);
                frontier(i, t, h, w, ys, xs);
            }
            if (out.photos.back().second == "confirm")   // holes: did this extra view still add area?
                dry = (double)added < FILL_MIN * (double)area ? dry + 1 : 0;
            std::vector<size_t> o;   // closed only by another photo looking past it
            for (size_t k = 0; k < Fopen.size(); k++)
                if (Fopen[k] && Fsrc[k] != (int64_t)i) o.push_back(k);
            if (!o.empty()) {
                std::vector<double> P, N;
                for (size_t k : o) P.insert(P.end(), &F[3 * k], &F[3 * k] + 3), N.insert(N.end(), &FN[3 * k], &FN[3 * k] + 3);
                const int64_t ci = (int64_t)i;
                const Visibility v = s.visible(P.data(), N.data(), o.size(), &ci, 1, INNER);
                for (size_t b = 0; b < o.size(); b++)
                    if (v.ok[b]) Fopen[o[b]] = 0;
            }
            if (out.photos.size() >= (size_t)MAX_PHOTOS) {
                stop = "photo budget";
                break;
            }
            // 3. the next photo: the open frontier's best view; else (GROW_ALL) another view of the defect
            const bool open = std::any_of(Fopen.begin(), Fopen.end(), [](uint8_t b) { return b != 0; });
            int64_t nxt = -1;
            std::string phase = "grow";
            if (open) {
                std::vector<double> P, N;
                for (size_t k = 0; k < Fopen.size(); k++)
                    if (Fopen[k]) P.insert(P.end(), &F[3 * k], &F[3 * k] + 3), N.insert(N.end(), &FN[3 * k], &FN[3 * k] + 3);
                std::vector<int64_t> done;
                for (const auto& p : out.photos) done.push_back(p.first);
                nxt = next_photo(s, P, N, done, observed);
            }
            const auto confirms = std::count_if(out.photos.begin(), out.photos.end(), [](const auto& p) { return p.second == "confirm"; });
            const bool fill = in_grow_all(*cls) && dry < FILL_DRY && confirms < FILL_MAX;
            if (nxt < 0 && fill) nxt = confirm_pick(s, tracked, out.photos, seed), phase = "confirm";
            if (nxt < 0) {
                stop = open ? "frontier out of sight" : "complete";
                break;
            }
            i = (size_t)nxt;
            src = at_later(i);
            mask = read(i, &src);
            out.photos.emplace_back((int64_t)i, phase);
        }
        // 4. confirm: extra views of the tracked defect (GROW_ALL classes filled holes instead)
        if (!in_grow_all(*cls)) confirm(s, tracked, out.photos, [&](size_t j) { read(j, nullptr); });
        return finish(stop);
    }

private:
    struct Source {   // base at(): the cells (x, y) photo i follows the defect from, +-rr cells, near
        std::vector<int64_t> q;
        int rr;
        bool near;
    };

    const Survey& s;
    const Infer& infer;
    double seed[3], normal[3];
    Visibility v0;                     // every photo's view of the seed
    std::optional<std::string> cls;
    Followed out;
    std::map<int64_t, int> tiles_of;   // per photo: its class read's tiles (base: tiles[i], the last read's)
    std::vector<double> tracked;       // tracked samples; tkeys: their 3 cm cells
    std::unordered_set<int64_t> tkeys;
    int64_t area = 0;                  // samples, minus repeats
    std::vector<double> F, FN;         // frontier points, normals, open, and the photo that found them
    std::vector<uint8_t> Fopen;
    std::vector<int64_t> Fsrc;
    std::vector<int64_t> observed;     // np.union1d of the taken photos' inner footprint cells

    Followed finish(const std::string& stop) {
        out.cls = cls;
        out.stop = stop;
        out.tracked = tracked;
        for (const auto& p : out.photos) {
            auto it = tiles_of.find(p.first);
            out.tiles.push_back(it == tiles_of.end() ? -1 : it->second);
        }
        return std::move(out);
    }

    // base lines 246-259: every class's mask around the click (the box at SEED_M); the class whose mask comes
    // closest to the clicked pixel (a thin crack must not lose to the wet patch around it on pixel count), if any
    std::optional<std::string> first_look(size_t i) {
        const Camera& c = s.cams[i];
        const double rad = SEED_M * c.fx / v0.dist[i], u = v0.uv[2 * i], v = v0.uv[2 * i + 1];
        const int64_t y0 = std::max<int64_t>(0, (int64_t)(v - rad)), y1 = std::min<int64_t>(c.H, (int64_t)(v + rad) + 1);
        const int64_t x0 = std::max<int64_t>(0, (int64_t)(u - rad)), x1 = std::min<int64_t>(c.W, (int64_t)(u + rad) + 1);
        const std::optional<std::vector<Tile>> tiles = box_tiles(s, i, s.classes, y0, y1, x0, x1);
        const Masks masks = infer(i, s.classes, tiles ? &*tiles : nullptr);
        std::optional<std::string> best;
        double best_d2 = 0;
        for (const auto& cl : s.classes) {
            const std::vector<uint8_t>& m = masks.at(cl);
            const int floor_v = s.floor_of.at(cl);
            bool on = false;
            double near = std::numeric_limits<double>::infinity();
            for (int64_t y = y0; y < y1; y++)
                for (int64_t x = x0; x < x1; x++) {
                    const double dy = (double)y - v, dx = (double)x - u, d2 = dy * dy + dx * dx;
                    if (m[(size_t)y * c.W + x] >= floor_v && d2 <= rad * rad) on = true, near = std::min(near, d2);
                }
            if (on && (!best || near < best_d2)) best = cl, best_d2 = near;   // min(near, key=near.get): the first
        }
        return best;
    }

    Source at_first(size_t i) const {   // the click's cell, +- SEED_M
        const Camera& c = s.cams[i];
        return {{(int64_t)(v0.uv[2 * i] / DS), (int64_t)(v0.uv[2 * i + 1] / DS)}, (int)std::ceil(SEED_M * c.fx / v0.dist[i] / DS), false};
    }

    // the blobs touching what is tracked or still open: those points projected into photo i, unoccluded (5 cm), +-1 cell
    Source at_later(size_t i) const {
        std::vector<double> P;
        const size_t nt = tracked.size() / 3, step = std::max<size_t>(1, nt / 3000);
        for (size_t k = 0; k < nt; k += step) P.insert(P.end(), &tracked[3 * k], &tracked[3 * k] + 3);
        for (size_t k = 0; k < Fopen.size(); k++)
            if (Fopen[k]) P.insert(P.end(), &F[3 * k], &F[3 * k] + 3);
        const size_t n = P.size() / 3;
        const int64_t ci = (int64_t)i;
        const Camera& c = s.cams[i];
        std::vector<double> uv, z;
        s.project(P.data(), n, &ci, 1, uv, z);
        std::vector<size_t> ok;
        for (size_t k = 0; k < n; k++)
            if (z[k] > 0 && uv[2 * k] >= 0 && uv[2 * k] < c.W && uv[2 * k + 1] >= 0 && uv[2 * k + 1] < c.H) ok.push_back(k);
        std::vector<double> o(3 * ok.size()), d(3 * ok.size()), dd(ok.size());
        for (size_t j = 0; j < ok.size(); j++) {
            const double r[3] = {P[3 * ok[j]] - c.origin[0], P[3 * ok[j] + 1] - c.origin[1], P[3 * ok[j] + 2] - c.origin[2]};
            dd[j] = std::sqrt(plain3(r[0], r[1], r[2], r[0], r[1], r[2]));
            for (int a = 0; a < 3; a++) o[3 * j + a] = c.origin[a], d[3 * j + a] = r[a] / std::max(dd[j], 1e-9);
        }
        const Hits h = s.cast(o.data(), d.data(), ok.size());
        Source src{{}, 1, true};
        for (size_t t = 0; t < h.ray.size(); t++)
            if (std::abs(h.dist[t] - dd[h.ray[t]]) < 0.05) {
                const size_t k = ok[h.ray[t]];
                src.q.push_back((int64_t)(uv[2 * k] / DS));
                src.q.push_back((int64_t)(uv[2 * k + 1] / DS));
            }
        return src;
    }

    // base read(i, cls, need=need(i, *src)) / read(i, cls): photo i's mask of the followed class. With a source, a
    // tiled class grows on its grid (base grow() + need()): from no tiles, every tile whose cells lie within pad of a
    // needed cell (the blobs kept from the mask so far, and the source cells) runs, again while that adds tiles. Records
    // the tiles run (-1: not grown) and the mask's bake rays (= mask_compress: row-major, every st-th).
    std::vector<uint8_t> read(size_t i, const Source* src) {
        const Camera& c = s.cams[i];
        const std::string& C = *cls;
        const int floor_v = s.floor_of.at(C);
        const std::vector<Tile> grid = src ? photo_grid(s, C, i) : std::vector<Tile>();
        std::vector<uint8_t> m;
        int ran = -1;
        if (grid.empty()) {
            Masks r = infer(i, {C}, nullptr);
            m = std::move(r.at(C));
        } else {
            const int T = s.grids.at(C).first, h = c.H / DS, w = c.W / DS;
            const int pad = src->rr + (int)std::ceil((double)min_mask_area(s) / DS) + 1 + (int)(s.roi_m * c.fx / dist_to(c.origin, seed) / DS);
            const int r = kept_radius(s, C, i, seed);
            const size_t nq = src->q.size() / 2;
            std::vector<uint8_t> run(grid.size(), 0);
            std::vector<Tile> tiles;
            std::vector<int32_t> S((size_t)(h + 1) * (w + 1), 0);   // prefix sums of the needed cells
            m.assign((size_t)c.H * c.W, 0);                          // the mask of no tiles
            for (;;) {
                std::vector<uint8_t> need = kept_cells(m.data(), c.H, c.W, floor_v, r, src->near && in_gap_m(C), src->q.data(), nq, src->rr);
                for (size_t k = 0; k < nq; k++)
                    need[(size_t)std::min<int64_t>(std::max<int64_t>(src->q[2 * k + 1], 0), h - 1) * w +
                         (size_t)std::min<int64_t>(std::max<int64_t>(src->q[2 * k], 0), w - 1)] = 1;
                for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++)
                        S[(size_t)(y + 1) * (w + 1) + x + 1] = S[(size_t)y * (w + 1) + x + 1] + S[(size_t)(y + 1) * (w + 1) + x] -
                                                               S[(size_t)y * (w + 1) + x] + need[(size_t)y * w + x];
                bool more = false;
                for (size_t g = 0; g < grid.size(); g++) {   // the tile's pixel rows / columns, as cells (the last
                    if (run[g]) continue;                     // cell row / column stands for the remainder), +- pad
                    const int y0 = std::max(0, std::min(grid[g].first / DS, h - 1) - pad);
                    const int y1 = std::min(h - 1, std::min((grid[g].first + T - 1) / DS, h - 1) + pad);
                    const int x0 = std::max(0, std::min(grid[g].second / DS, w - 1) - pad);
                    const int x1 = std::min(w - 1, std::min((grid[g].second + T - 1) / DS, w - 1) + pad);
                    const int64_t inside = (int64_t)S[(size_t)(y1 + 1) * (w + 1) + x1 + 1] - S[(size_t)y0 * (w + 1) + x1 + 1] -
                                           S[(size_t)(y1 + 1) * (w + 1) + x0] + S[(size_t)y0 * (w + 1) + x0];
                    if (inside > 0) run[g] = 1, more = true;
                }
                if (!more) break;
                tiles.clear();
                for (size_t g = 0; g < grid.size(); g++)
                    if (run[g]) tiles.push_back(grid[g]);
                Masks got = infer(i, {C}, &tiles);
                m = std::move(got.at(C));
            }
            ran = (int)tiles.size();
        }
        tiles_of[(int64_t)i] = ran;
        const int64_t st = std::max<int64_t>(1, (int64_t)per_class(s.values, "mask_compress.subsample_step", C, 12));
        std::vector<double> xs, ys;
        int64_t k = 0;
        for (size_t p = 0; p < m.size(); p++)
            if (m[p] >= floor_v && k++ % st == 0) xs.push_back((double)(p % c.W)), ys.push_back((double)(p / c.W));
        out.rays.emplace_back((int64_t)i, std::move(xs), std::move(ys));
        return m;
    }

    // new samples of the defect: one per occupied SAMPLE px block of the kept cells (a regular grid would skip thin
    // cracks), back-projected, kept unless their 3 cm cell is tracked already; -> those beyond 1.5 sample spacings
    // of every tracked one (new area)
    int64_t track(size_t i, const std::vector<int64_t>& ys, const std::vector<int64_t>& xs, int w) {
        const int64_t st = SAMPLE / DS;
        std::vector<std::pair<int64_t, size_t>> key(ys.size());   // np.unique(..., return_index=True): ascending,
        for (size_t k = 0; k < ys.size(); k++) key[k] = {(ys[k] / st) * (w + 1) + xs[k] / st, k};   // first occurrence
        std::sort(key.begin(), key.end());
        std::vector<double> px, py;
        for (size_t k = 0; k < key.size(); k++)
            if (k == 0 || key[k].first != key[k - 1].first) {
                px.push_back((xs[key[k].second] + .5) * DS);
                py.push_back((ys[key[k].second] + .5) * DS);
            }
        const Hits pos = s.back_project(i, px.data(), py.data(), px.size());
        const size_t n = pos.ray.size();
        int64_t added = (int64_t)n;
        if (!tracked.empty()) {
            const double tol = 1.5 * SAMPLE * dist_to(s.cams[i].origin, seed) / s.cams[i].fx;
            const NearGrid near(tracked, tol);
            added = 0;
            for (size_t r = 0; r < n; r++) added += !near.any_within(&pos.loc[3 * r]);
        }
        area += added;
        std::vector<int64_t> k(n);
        for (size_t r = 0; r < n; r++) k[r] = key3(&pos.loc[3 * r], 0.03);
        for (size_t r = 0; r < n; r++)   // ~np.isin(k, tkeys) against the cells tracked before this photo
            if (!tkeys.count(k[r])) tracked.insert(tracked.end(), &pos.loc[3 * r], &pos.loc[3 * r] + 3);
        tkeys.insert(k.begin(), k.end());
        return added;
    }

    // the frontier: kept cells in the frame-edge band (<= 160 of them), and for a GAP_M class its two ends (<= 40 cells
    // at or past the 1st / 99th percentile along its axis: mid-photo it is more often a missed stretch than the end of
    // the crack), back-projected; open while within RADIUS_M of the seed and not seen well inside an earlier photo
    void frontier(size_t i, const std::vector<uint8_t>& t, int h, int w, const std::vector<int64_t>& ys, const std::vector<int64_t>& xs) {
        const int m = std::max(1, (int)std::nearbyint(EDGE * std::min(h, w)));   // Python's round: half to even
        std::vector<int64_t> fy, fx;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                if (t[(size_t)y * w + x] && !(y >= m && y < h - m && x >= m && x < w - m)) fy.push_back(y), fx.push_back(x);
        std::vector<double> px, py;
        for (size_t k : linspace_index(fy.size(), std::min<size_t>(fy.size(), 160))) {
            px.push_back((fx[k] + .5) * DS);
            py.push_back((fy[k] + .5) * DS);
        }
        if (in_gap_m(*cls) && ys.size() > 10) {
            const size_t n = ys.size();
            double sx = 0, sy = 0;   // xy.mean(0): integer sums, exact in any order
            for (size_t k = 0; k < n; k++) sx += (double)xs[k], sy += (double)ys[k];
            const double mx = sx / (double)n, my = sy / (double)n;
            std::vector<double> cx(n), cy(n);
            double sxx = 0, sxy = 0, syy = 0;
            for (size_t k = 0; k < n; k++) {
                cx[k] = (double)xs[k] - mx, cy[k] = (double)ys[k] - my;
                sxx += cx[k] * cx[k], sxy += cx[k] * cy[k], syy += cy[k] * cy[k];
            }
            // the axis: np.linalg.svd(...)[2][0] = the top eigenvector of the 2x2 scatter (up to sign and the last
            // bits: accepted, it decides only near-ties at the percentiles)
            const double l = (sxx + syy) / 2 + std::sqrt(((sxx - syy) / 2) * ((sxx - syy) / 2) + sxy * sxy);
            double a0 = l - syy, a1 = sxy;
            if (a0 * a0 + a1 * a1 < sxy * sxy + (l - sxx) * (l - sxx)) a0 = sxy, a1 = l - sxx;
            const double na = std::sqrt(a0 * a0 + a1 * a1);
            if (na > 0) a0 /= na, a1 /= na;
            else a0 = 1, a1 = 0;
            std::vector<double> a(n);
            for (size_t k = 0; k < n; k++) a[k] = cx[k] * a0 + cy[k] * a1;
            std::vector<double> sorted(a);
            std::sort(sorted.begin(), sorted.end());
            const double lo = percentile_linear(sorted, 1.0 / 100), hi = percentile_linear(sorted, 99.0 / 100);
            std::vector<size_t> e;
            for (size_t k = 0; k < n; k++)
                if (a[k] <= lo || a[k] >= hi) e.push_back(k);
            for (size_t k : linspace_index(e.size(), std::min<size_t>(e.size(), 40))) {
                px.push_back((xs[e[k]] + .5) * DS);
                py.push_back((ys[e[k]] + .5) * DS);
            }
        }
        const Hits pos = s.back_project(i, px.data(), py.data(), px.size());
        const size_t n = pos.ray.size();
        std::vector<uint8_t> open(n);
        std::vector<size_t> sel;
        for (size_t r = 0; r < n; r++)
            if ((open[r] = dist_to(&pos.loc[3 * r], seed) <= RADIUS_M)) sel.push_back(r);
        std::vector<int64_t> earlier;
        for (size_t p = 0; p + 1 < out.photos.size(); p++) earlier.push_back(out.photos[p].first);
        if (!earlier.empty() && !sel.empty()) {   // already looked past it from an earlier photo
            std::vector<double> P, N;
            for (size_t r : sel) P.insert(P.end(), &pos.loc[3 * r], &pos.loc[3 * r] + 3), N.insert(N.end(), &pos.normal[3 * r], &pos.normal[3 * r] + 3);
            const Visibility v = s.visible(P.data(), N.data(), sel.size(), earlier.data(), earlier.size(), INNER);
            for (size_t b = 0; b < sel.size(); b++) {
                bool seen = false;
                for (size_t a = 0; a < earlier.size(); a++) seen = seen || v.ok[a * sel.size() + b];
                open[sel[b]] = !seen;
            }
        }
        F.insert(F.end(), pos.loc.begin(), pos.loc.end());
        FN.insert(FN.end(), pos.normal.begin(), pos.normal.end());
        Fopen.insert(Fopen.end(), open.begin(), open.end());
        Fsrc.insert(Fsrc.end(), n, (int64_t)i);
    }
};

static Followed follow(const Survey& s, const double* seed, const double* normal, const Infer& infer) {
    return FollowLoop(s, seed, normal, infer).run();
}

// ------------------------------------------------------------------------------------------------
// infer through Python: the one place the callback is called, its answer checked and copied out once per read
// ------------------------------------------------------------------------------------------------
static Masks masks_of(const Survey& s, size_t i, const std::vector<std::string>& classes, const py::object& got) {
    const std::string& stem = s.photo_stem[i].empty() ? s.names[i] : s.photo_stem[i];
    const int H = s.cams[i].H, W = s.cams[i].W;
    Masks out;
    for (const auto& c : classes) {
        if (!py::isinstance<py::dict>(got) || !py::reinterpret_borrow<py::dict>(got).contains(c))
            throw std::runtime_error(stem + ": infer gave no mask for " + c);
        const py::object v = py::reinterpret_borrow<py::dict>(got)[py::str(c)];
        const bool arr = py::isinstance<py::array>(v);
        const py::array a = arr ? py::reinterpret_borrow<py::array>(v) : py::array();
        const bool contiguous = arr && (a.flags() & py::array::c_style);
        if (!arr || a.dtype().kind() != 'u' || a.itemsize() != 1 || a.ndim() != 2 || a.shape(0) != H || a.shape(1) != W || !contiguous) {
            std::string what = std::string(py::str(py::type::handle_of(v).attr("__name__")));
            if (arr) {
                what = std::string(py::str(a.dtype())) + " (";
                for (py::ssize_t d = 0; d < a.ndim(); d++) what += (d ? ", " : "") + std::to_string(a.shape(d));
                what += a.ndim() == 1 ? ",)" : ")";
                if (!contiguous) what += " not C-contiguous";
            }
            throw std::runtime_error(stem + ": infer's " + c + " mask is " + what + ", not uint8 (" + std::to_string(H) + ", " + std::to_string(W) + ")");
        }
        const uint8_t* p = (const uint8_t*)a.data();
        out[c].assign(p, p + (size_t)H * W);
    }
    return out;
}

// infer(path, classes, tiles: list[(y, x)] | None) -> {class: uint8 (H, W)}, called with the GIL held
static Infer python_infer(const Survey& s, const py::function& f) {
    return [&s, &f](size_t i, const std::vector<std::string>& classes, const std::vector<Tile>* tiles) {
        py::gil_scoped_acquire gil;   // the click runs without the GIL; it is held here and for every Python object (a
                                      // Python exception leaves as error_already_set, which takes the GIL to die)
        if (s.photo_path[i].empty()) throw std::runtime_error(s.names[i] + ": the photo is not in photos.json");
        const py::object got = f(s.photo_path[i], classes, tiles ? py::cast(*tiles) : py::object(py::none()));
        return masks_of(s, i, classes, got);
    };
}


// ------------------------------------------------------------------------------------------------
// click: base Survey.click + encode + the clicks.jsonl line
// ------------------------------------------------------------------------------------------------
static std::string jnum(double v) {   // Python's repr of a float, as json.dumps writes it: shortest round trip
    if (std::isnan(v)) return "NaN";
    if (std::isinf(v)) return v < 0 ? "-Infinity" : "Infinity";
    char buf[40];
    const auto r = std::to_chars(buf, buf + sizeof buf, v);
    std::string t(buf, r.ptr);
    if (t.find_first_of(".e") == std::string::npos) t += ".0";
    return t;
}
static std::string jstr(const std::string& s) {
    std::string r = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') r += '\\', r += (char)c;
        else if (c == '\n') r += "\\n";
        else if (c == '\r') r += "\\r";
        else if (c == '\t') r += "\\t";
        else if (c < 0x20) {
            char b[8];
            std::snprintf(b, sizeof b, "\\u%04x", c);
            r += b;
        } else r += (char)c;
    }
    return r + "\"";
}
static double round2(double v) { return std::nearbyint(v * 100) / 100; }

// np.round(v[::step].astype(float), 3).astype("<f4") of n xyz rows, step as the base: at most MAX_RETURN rows
static void layer(const double* v, size_t n, std::vector<float>& out) {
    const size_t step = std::max<size_t>(1, (n + MAX_RETURN - 1) / MAX_RETURN);
    for (size_t r = 0; r < n; r += step)
        for (int a = 0; a < 3; a++) out.push_back((float)(std::nearbyint(v[3 * r + a] * 1000) / 1000));
}

// the answer: header length (uint32 LE), the JSON header padded with spaces to a multiple of 4, the layers' float32 xyz
static std::string encode(std::string head, const std::vector<float>& xyz) {
    head.append((4 - head.size() % 4) % 4, ' ');
    const uint32_t n = (uint32_t)head.size();
    std::string out;
    for (int k = 0; k < 4; k++) out += (char)((n >> (8 * k)) & 255);
    out += head;
    out.append((const char*)xyz.data(), xyz.size() * sizeof(float));
    return out;
}

static std::string click(const Survey& s, const double origin[3], const double direction[3], const Infer& infer_in) {
    using Clock = std::chrono::steady_clock;
    const auto secs_since = [](Clock::time_point t) { return std::chrono::duration<double>(Clock::now() - t).count(); };
    const auto t0 = Clock::now();
    double models = 0;
    const Infer infer = [&](size_t i, const std::vector<std::string>& classes, const std::vector<Tile>* tiles) {
        const auto t = Clock::now();
        Masks m = infer_in(i, classes, tiles);
        models += secs_since(t);
        return m;
    };
    double d[3];
    const double nd = std::sqrt((direction[0] * direction[0] + direction[1] * direction[1]) + direction[2] * direction[2]);
    for (int a = 0; a < 3; a++) d[a] = direction[a] / nd;
    const Hits hit = s.cast(origin, d, 1);
    if (hit.ray.empty()) return encode("{\"error\": \"the click missed the bake mesh\"}", {});
    const double seed[3] = {hit.loc[0], hit.loc[1], hit.loc[2]};
    const Followed f = follow(s, seed, &hit.normal[0], infer);

    // only the clicked class is baked and returned: its points in the cluster(s) at the click
    const auto tb = Clock::now();
    std::vector<float> xyz;
    size_t n_points = 0;
    if (f.cls) {
        const Survey::Baked b = s.bake(f.rays, *f.cls);
        const size_t n = b.bits.size();
        const std::vector<int32_t> cl = clusters(b.P.data(), n, in_gap_m(*f.cls) ? gap_m(*f.cls) : s.cluster_distance_m, s.min_cluster_points);
        const std::vector<uint8_t> at = at_click(b.P.data(), cl.data(), n, seed);
        std::vector<double> P;
        for (size_t r = 0; r < n; r++)
            if (at[r]) P.insert(P.end(), &b.P[3 * r], &b.P[3 * r] + 3);
        layer(P.data(), P.size() / 3, xyz);
        n_points = xyz.size() / 3;
    }
    const double t_bake = secs_since(tb);

    // the full run: same class, the app's own cluster(s) at the click
    size_t n_full = 0;
    bool has_full = false;
    if (f.cls) {
        const auto it = std::find(s.full_class_names.begin(), s.full_class_names.end(), *f.cls);
        if (it != s.full_class_names.end()) {
            has_full = true;
            const int32_t c = (int32_t)(it - s.full_class_names.begin());
            std::vector<double> FP;
            std::vector<int32_t> FC;
            for (size_t r = 0; r < s.full_class.size(); r++)
                if (s.full_class[r] == c) {
                    for (int a = 0; a < 3; a++) FP.push_back((double)s.full_pos[3 * r + a]);
                    FC.push_back(s.full_cluster[r]);
                }
            const std::vector<uint8_t> at = at_click(FP.data(), FC.data(), FC.size(), seed);
            std::vector<double> sel;
            for (size_t r = 0; r < FC.size(); r++)
                if (at[r]) sel.insert(sel.end(), &FP[3 * r], &FP[3 * r] + 3);
            layer(sel.data(), sel.size() / 3, xyz);
            n_full = xyz.size() / 3 - n_points;
        }
    }

    std::string photos = "[";
    for (size_t k = 0; k < f.photos.size(); k++) {
        const size_t i = (size_t)f.photos[k].first;
        photos += std::string(k ? ", " : "") + "{\"name\": " + jstr(s.photo_stem[i].empty() ? s.names[i] : s.photo_stem[i]) +
                  ", \"phase\": " + jstr(f.photos[k].second) + ", \"tiles\": " + (f.tiles[k] < 0 ? "null" : std::to_string(f.tiles[k])) + "}";
    }
    photos += "]";
    const auto vec3 = [](const double v[3]) { return "[" + jnum(v[0]) + ", " + jnum(v[1]) + ", " + jnum(v[2]) + "]"; };
    const std::string seed_j = vec3(seed);
    const std::string cls_j = f.cls ? jstr(*f.cls) : "null";
    const std::string points_j = f.cls ? "{" + jstr(*f.cls) + ": " + std::to_string(n_points) + "}" : "{}";
    const std::string full_j = has_full ? "{" + jstr(*f.cls) + ": " + std::to_string(n_full) + "}" : "{}";
    const std::string seconds = "{\"models\": " + jnum(round2(models)) + ", \"bake\": " + jnum(round2(t_bake)) + ", \"total\": " + jnum(round2(secs_since(t0))) + "}";
    const std::string head = "{\"seed\": " + seed_j + ", \"class\": " + cls_j + ", \"stop\": " + jstr(f.stop) + ", \"points\": " + points_j +
                             ", \"photos\": " + photos + ", \"full\": " + full_j + ", \"seconds\": " + seconds + "}";

    // every click, replayable from the stored masks
    char when[32];
    const std::time_t now = std::time(nullptr);
    std::strftime(when, sizeof when, "%Y-%m-%d %H:%M:%S", std::localtime(&now));
    std::ofstream log(s.work + "/clicks.jsonl", std::ios::app | std::ios::binary);
    log << "{\"time\": \"" << when << "\", \"origin\": " << vec3(origin) << ", \"direction\": " << vec3(direction) << ", \"seed\": " << seed_j
        << ", \"class\": " << cls_j << ", \"stop\": " << jstr(f.stop) << ", \"photos\": " << photos << ", \"seconds\": " << seconds
        << ", \"points\": " << points_j << "}\n";
    log.flush();
    if (!log) throw std::runtime_error("cannot append to " + s.work + "/clicks.jsonl");
    return encode(head, xyz);
}

// ------------------------------------------------------------------------------------------------
// the module
// ------------------------------------------------------------------------------------------------
using DArr = py::array_t<double, py::array::c_style | py::array::forcecast>;
using IArr = py::array_t<int64_t, py::array::c_style | py::array::forcecast>;

static size_t rows3(const DArr& a, const char* what) {   // an (n,3) array's n
    if (a.ndim() != 2 || a.shape(1) != 3) throw std::invalid_argument(std::string(what) + " must be (n, 3)");
    return (size_t)a.shape(0);
}
static size_t count1(const py::array& a, const char* what) {   // a 1-D array's length
    if (a.ndim() != 1) throw std::invalid_argument(std::string(what) + " must be 1-D");
    return (size_t)a.shape(0);
}
static void check_cameras(const Survey& s, const int64_t* ci, size_t k) {
    for (size_t a = 0; a < k; a++)
        if (ci[a] < 0 || (size_t)ci[a] >= s.cams.size())
            throw std::out_of_range("camera index " + std::to_string(ci[a]) + " is out of range (" + std::to_string(s.cams.size()) + " photos)");
}
template <class T, class U>   // T: the numpy dtype, U: the vector's (same size; bool from uint8_t)
static py::array_t<T> to_numpy(const std::vector<U>& v, std::vector<py::ssize_t> shape) {
    static_assert(sizeof(T) == sizeof(U), "same element size");
    py::array_t<T> a(shape);
    if (!v.empty()) std::memcpy(a.mutable_data(), v.data(), v.size() * sizeof(U));
    return a;
}

PYBIND11_MODULE(selinf_core, m) {
    m.doc() = "selective inference: the survey, the follow loop and the bake in C++ (see selinf.cpp)";
    py::class_<Survey>(m, "Survey")
        .def(py::init<const std::string&, const std::string&, std::map<std::string, std::pair<int, int>>, double>(),
             py::arg("data_root"), py::arg("work"), py::arg("grids"), py::arg("roi_m") = ROI_M)
        .def("mesh", &Survey::mesh)
        .def("cameras", &Survey::cameras)
        .def_readonly("names", &Survey::names)
        .def("pixel_dirs", [](const Survey& s, int64_t i, DArr px, DArr py) {
            const size_t n = count1(px, "px");
            if (count1(py, "py") != n) throw std::invalid_argument("px and py differ in length");
            check_cameras(s, &i, 1);
            return to_numpy<double>(s.pixel_dirs((size_t)i, px.data(), py.data(), n), {(py::ssize_t)n, 3});
        }, py::arg("i"), py::arg("px"), py::arg("py"))
        .def("cast", [](const Survey& s, DArr o, DArr d) {
            const size_t n = rows3(o, "o");
            if (rows3(d, "d") != n) throw std::invalid_argument("Ray origin and direction don't match!");
            const Hits h = s.cast(o.data(), d.data(), n);
            const py::ssize_t k = (py::ssize_t)h.ray.size();
            return py::make_tuple(to_numpy<double>(h.loc, {k, 3}), to_numpy<double>(h.normal, {k, 3}),
                                  to_numpy<int64_t>(h.ray, {k}), to_numpy<double>(h.dist, {k}));
        }, py::arg("o"), py::arg("d"))
        .def("bake", [](const Survey& s, const std::vector<std::tuple<int64_t, IArr, IArr>>& rays, const std::string& cls) {
            std::vector<std::tuple<int64_t, std::vector<double>, std::vector<double>>> r;
            for (auto& [i, xs, ys] : rays) {
                std::vector<double> x(xs.data(), xs.data() + count1(xs, "xs")), y(ys.data(), ys.data() + count1(ys, "ys"));
                r.emplace_back(i, std::move(x), std::move(y));
            }
            if (r.size() > 64) throw std::invalid_argument("at most 64 ray sets");
            const Survey::Baked b = s.bake(r, cls);
            return py::make_tuple(to_numpy<double>(b.P, {(py::ssize_t)b.bits.size(), 3}), to_numpy<uint64_t>(b.bits, {(py::ssize_t)b.bits.size()}));
        }, py::arg("rays"), py::arg("cls"))
        .def("project", [](const Survey& s, DArr P, IArr ci) {
            const size_t n = rows3(P, "P"), k = count1(ci, "ci");
            check_cameras(s, ci.data(), k);
            std::vector<double> uv, z;
            s.project(P.data(), n, ci.data(), k, uv, z);
            return py::make_tuple(to_numpy<double>(uv, {(py::ssize_t)k, (py::ssize_t)n, 2}),
                                  to_numpy<double>(z, {(py::ssize_t)k, (py::ssize_t)n}));
        }, py::arg("P"), py::arg("ci"))
        .def("kept", [](const Survey& s, py::array_t<uint8_t, py::array::c_style> mask, const std::string& cls, int64_t i,
                        DArr seed, IArr q, int rr, bool near) {
            if (mask.ndim() != 2) throw std::invalid_argument("mask must be 2-D uint8");
            if (count1(seed, "seed") != 3) throw std::invalid_argument("seed must have 3 values");
            if (q.ndim() != 2 || q.shape(1) != 2) throw std::invalid_argument("q must be (n, 2)");
            auto fl = s.floor_of.find(cls);
            if (fl == s.floor_of.end()) throw std::invalid_argument("unknown class " + cls);
            check_cameras(s, &i, 1);
            const int H = (int)mask.shape(0), W = (int)mask.shape(1);
            const int r = kept_radius(s, cls, (size_t)i, seed.data());
            const auto out = kept_cells(mask.data(), H, W, fl->second, r, near && in_gap_m(cls), q.data(), (size_t)q.shape(0), rr);
            return to_numpy<bool>(out, {(py::ssize_t)(H / DS), (py::ssize_t)(W / DS)});
        }, py::arg("mask"), py::arg("cls"), py::arg("i"), py::arg("seed"), py::arg("q"), py::arg("rr"), py::arg("near"))
        .def("visible", [](const Survey& s, DArr P, DArr N, IArr ci, double margin) {
            const size_t n = rows3(P, "P"), k = count1(ci, "ci");
            if (rows3(N, "N") != n) throw std::invalid_argument("P and N differ in length");
            check_cameras(s, ci.data(), k);
            const Visibility v = s.visible(P.data(), N.data(), n, ci.data(), k, margin);
            const py::ssize_t K = (py::ssize_t)k, Nn = (py::ssize_t)n;
            return py::make_tuple(to_numpy<bool>(v.ok, {K, Nn}), to_numpy<double>(v.uv, {K, Nn, 2}),
                                  to_numpy<double>(v.dist, {K, Nn}), to_numpy<double>(v.cos, {K, Nn}));
        }, py::arg("P"), py::arg("N"), py::arg("ci"), py::arg("margin") = 0.0)
        .def("follow", [](const Survey& s, DArr seed, DArr normal, py::function infer) {
            if (count1(seed, "seed") != 3 || count1(normal, "normal") != 3) throw std::invalid_argument("seed and normal must have 3 values");
            const Followed f = follow(s, seed.data(), normal.data(), python_infer(s, infer));
            return py::make_tuple(f.photos, f.cls ? py::object(py::str(*f.cls)) : py::object(py::none()), f.stop,
                                  to_numpy<double>(f.tracked, {(py::ssize_t)(f.tracked.size() / 3), 3}));
        }, py::arg("seed"), py::arg("normal"), py::arg("infer"))
        .def("click", [](const Survey& s, DArr origin, DArr direction, py::function infer) {
            if (count1(origin, "origin") != 3 || count1(direction, "direction") != 3) throw std::invalid_argument("origin and direction must have 3 values");
            std::string out;
            {
                py::gil_scoped_release nogil;   // python_infer takes the GIL back for each call to the models
                out = click(s, origin.data(), direction.data(), python_infer(s, infer));
            }
            return py::bytes(out);
        }, py::arg("origin"), py::arg("direction"), py::arg("infer"));
    m.attr("MAX_PHOTOS") = MAX_PHOTOS;
    m.attr("RETRIES") = RETRIES;
    m.attr("FILL_DRY") = FILL_DRY;
    m.def("clusters", [](DArr P, double t, int min_pts) {
        const size_t n = P.size() ? rows3(P, "P") : 0;
        return to_numpy<int32_t>(clusters(P.data(), n, t, min_pts), {(py::ssize_t)n});
    }, py::arg("P"), py::arg("t"), py::arg("min_pts"));
    m.def("at_click", [](DArr P, IArr cluster, DArr seed) {
        const size_t n = P.size() ? rows3(P, "P") : 0;
        if (count1(cluster, "cluster") != n) throw std::invalid_argument("P and cluster differ in length");
        if (count1(seed, "seed") != 3) throw std::invalid_argument("seed must have 3 values");
        return to_numpy<bool>(at_click(P.data(), cluster.data(), n, seed.data()), {(py::ssize_t)n});
    }, py::arg("P"), py::arg("cluster"), py::arg("seed"));
}
