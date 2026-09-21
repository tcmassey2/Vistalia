#!/usr/bin/env python3
"""
Vistalia — 2.5D depth-parallax photo motion (v64, the "depth floor" and the
interior default when PARALLAX_MODE says so). One photo in, one rigid camera
move out, every pixel from the customer's photo, straight lines straight.

    photo ─► Depth Anything V2 small (ONNX, CPU, ~1-3 s)      relative inverse depth
          ─► normalise + light joint-bilateral edge snap + hard depth steps
          ─► LINE-AWARE regularisation: along every long straight edge (LSD)
             the disparity is replaced by a per-side affine fit, so the exact
             pinhole dolly below maps that edge to a straight line. (v37
             lesson: a per-pixel depth warp with sloppy depth bends cabinet
             edges; an affine 1/Z along a line + a linear-fractional camera
             map keeps it straight — provable, and self-checked below.)
          ─► per frame: exact camera translation (+ optional small rotation)
                 u' = cx + (u - cx - Tx·w) / (1 - Tz·w)        w = inverse depth
             solved as a LAYERED INVERSE with a z-test (no splat gaps, sub-pixel);
             disocclusions sample an inpainted background plate (no ghosts)
          ─► cv2.remap Lanczos from the full-res source ─► ffmpeg libx264
          ─► self-check: bend (px) of the photo's own straight edges in the last
             frame, reported in the JSON summary the worker reads.

Usage (the Node wrapper in src/parallax-job.mjs builds this):
  parallax.py --src photo.png --out clip.mp4 --seconds 5.0 [--fps 30]
              [--out-size 1080x1920] [--zoom 1.07] [--yaw 0.4] [--pitch -0.2]
              [--truck 0] [--near-ratio 4] [--map-every 2] [--layers 32]
              [--model models/dav2_small.onnx] [--report r.json] [--depth-out d.png]
  parallax.py --check [--model ...]        # dependency / model probe, JSON out

The last stdout line is always a JSON object: {"ok": true, ...metrics} or
{"ok": false, "error": "..."}; exit code 0 only when ok.
"""
import argparse, json, os, subprocess, sys, time

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def emit(obj):
    print("[parallax] " + json.dumps(obj), flush=True)


def fail(msg, code=2):
    emit({"ok": False, "error": str(msg)})
    sys.exit(code)


try:
    import numpy as np
    import cv2
except Exception as e:  # pragma: no cover
    fail(f"python deps missing: {e}")


# ───────────────────────────── depth ─────────────────────────────
def load_depth_session(model_path):
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    so.log_severity_level = 3
    return ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])


def predict_disparity(sess, bgr, long_side=770):
    h, w = bgr.shape[:2]
    scale = long_side / max(h, w)
    nh = max(14, int(round(h * scale / 14)) * 14)
    nw = max(14, int(round(w * scale / 14)) * 14)
    rgb = cv2.cvtColor(cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255.0 - np.array(IMAGENET_MEAN, np.float32)) / np.array(IMAGENET_STD, np.float32)
    x = np.transpose(x, (2, 0, 1))[None]
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    d = out[0] if out.ndim == 3 else out[0, 0]
    return cv2.resize(d.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)


def normalise_disparity(disp, bgr):
    """0..1 relative inverse depth, lightly snapped to colour edges.
    (Sep 21: a strong guided filter SPREADS depth into halos along thin
    fixtures — pendant bars — so only a small joint-bilateral pass is used.)"""
    d = disp.astype(np.float32)
    lo, hi = np.percentile(d, 0.5), np.percentile(d, 99.5)
    d = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)
    try:
        d = cv2.ximgproc.jointBilateralFilter(bgr.astype(np.float32), d, 9, 8.0, 3.0)
    except Exception:
        pass
    d = cv2.medianBlur((np.clip(d, 0, 1) * 255).astype(np.uint8), 5).astype(np.float32) / 255.0
    return np.clip(d, 0, 1)


def sharpen_depth_steps(w, tol=0.06, kernels=(3, 5)):
    """Blurred depth steps -> hard steps. Intermediate values across an
    occlusion edge are upsampling artefacts; the layered renderer would see
    them as phantom mid-depth slivers and slice the edge into a sawtooth."""
    out = w.copy()
    for k in kernels:
        ker = np.ones((k, k), np.uint8)
        lo = cv2.erode(out, ker); hi = cv2.dilate(out, ker)
        band = (hi - lo) > tol
        snap = np.where(out >= 0.5 * (lo + hi), hi, lo)
        out = np.where(band, snap, out).astype(np.float32)
    return out


# ─────────────────────── straight-edge handling ───────────────────────
def detect_segments(bgr, min_len=70):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    try:
        lsd = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
        lines = lsd.detect(g)[0]
    except Exception:
        lines = None
    if lines is None:
        return np.zeros((0, 4), np.float32)
    lines = lines.reshape(-1, 4).astype(np.float32)
    L = np.hypot(lines[:, 2] - lines[:, 0], lines[:, 3] - lines[:, 1])
    return lines[L >= min_len]


def robust_linefit(lam, val):
    A = np.stack([lam, np.ones_like(lam)], 1)
    keep = np.ones(len(lam), bool)
    sol = np.array([0.0, float(val.mean())])
    for _ in range(3):
        sol, *_ = np.linalg.lstsq(A[keep], val[keep], rcond=None)
        res = np.abs(A @ sol - val)
        thr = max(0.02, 2.5 * float(np.median(res[keep])) + 1e-6)
        nk = res <= thr
        if nk.sum() < max(6, 0.5 * len(lam)) or np.array_equal(nk, keep):
            break
        keep = nk
    return sol


def regularise_lines(w, segments, band=3.0, feather=7.0, side_off=3.0):
    """Make w affine along each straight edge, separately on each side of it.
    Nearest segment wins (no averaging). Sides are fitted separately so an
    occlusion edge keeps its foreground/background step."""
    h, wd = w.shape
    best_d = np.full(w.shape, np.inf, np.float32)
    best_fit = w.copy()
    ys, xs = np.mgrid[0:h, 0:wd].astype(np.float32)
    n_used = 0
    reach = band + feather
    for x1, y1, x2, y2 in segments:
        dx, dy = x2 - x1, y2 - y1
        L = float(np.hypot(dx, dy))
        if L < 2:
            continue
        ux, uy = dx / L, dy / L
        nx, ny = -uy, ux
        lam = np.linspace(0, L, max(8, int(L)))
        px = x1 + ux * lam
        py = y1 + uy * lam
        x0 = int(max(0, min(x1, x2) - reach - 1)); x3 = int(min(wd, max(x1, x2) + reach + 2))
        y0 = int(max(0, min(y1, y2) - reach - 1)); y3 = int(min(h, max(y1, y2) + reach + 2))
        if x3 <= x0 or y3 <= y0:
            continue
        X = xs[y0:y3, x0:x3]; Y = ys[y0:y3, x0:x3]
        t = (X - x1) * ux + (Y - y1) * uy
        s_signed = (X - x1) * nx + (Y - y1) * ny
        along = (t >= 0) & (t <= L)
        for sgn in (1.0, -1.0):
            sx = np.clip(px + sgn * side_off * nx, 0, wd - 1)
            sy = np.clip(py + sgn * side_off * ny, 0, h - 1)
            vals = w[sy.astype(np.int32), sx.astype(np.int32)]
            a, b = robust_linefit(lam, vals)
            s = s_signed * sgn
            win = along & (s >= 0) & (s <= reach)
            sub_d = best_d[y0:y3, x0:x3]
            better = win & (s < sub_d)
            if not better.any():
                continue
            fit = a * t + b
            sub_f = best_fit[y0:y3, x0:x3]
            sub_f[better] = fit[better]
            sub_d[better] = s[better]
        n_used += 1
    alpha = np.where(best_d <= band, 1.0, np.clip(1.0 - (best_d - band) / feather, 0, 1)).astype(np.float32)
    alpha[~np.isfinite(best_d)] = 0.0
    out = alpha * best_fit + (1.0 - alpha) * w
    return np.clip(out, 0, 1), n_used


def forward_xy(xs, ys, w, cx, cy, Tz, Tx):
    den = 1.0 - Tz * w
    return cx + (xs - cx - Tx * w) / den, cy + (ys - cy) / den


def line_bend(segments, w, cx, cy, Tz, Tx, n_samples=40):
    """Max deviation (px) of each mapped straight edge from a straight line in
    the last frame, each side of the edge separately."""
    h, wd = w.shape
    devs = []
    for x1, y1, x2, y2 in segments:
        L0 = float(np.hypot(x2 - x1, y2 - y1)) + 1e-6
        nx, ny = -(y2 - y1) / L0, (x2 - x1) / L0
        worst = 0.0
        for sgn in (3.0, -3.0):
            lam = np.linspace(0.03, 0.97, n_samples)
            px = x1 + (x2 - x1) * lam + sgn * nx; py = y1 + (y2 - y1) * lam + sgn * ny
            ww = w[np.clip(py, 0, h - 1).astype(np.int32), np.clip(px, 0, wd - 1).astype(np.int32)]
            qx, qy = forward_xy(px, py, ww, cx, cy, Tz, Tx)
            ax, ay = qx[0], qy[0]; bx, by = qx[-1], qy[-1]
            L = np.hypot(bx - ax, by - ay) + 1e-6
            d = np.abs((bx - ax) * (ay - qy) - (ax - qx) * (by - ay)) / L
            worst = max(worst, float(d.max()))
        devs.append(worst)
    devs = np.array(devs) if devs else np.zeros(1)
    return {"segments": int(len(segments)), "bend_mean_px": round(float(devs.mean()), 3),
            "bend_p95_px": round(float(np.percentile(devs, 95)), 3), "bend_max_px": round(float(devs.max()), 3)}


# ───────────────────────────── camera ─────────────────────────────
def ease(t, e=0.15):
    """Constant-velocity move with short smooth start/stop ramps (fraction e)."""
    a = min(0.5, max(1e-6, e))
    if t < a:
        s = 0.5 * t * t / a
    elif t < 1 - a:
        s = 0.5 * a + (t - a)
    else:
        u = 1 - t
        s = 1 - a - 0.5 * u * u / a
    return s / (1 - a)


def rotated_grid(xs, ys, cx, cy, f, yaw_deg, pitch_deg):
    """Destination grid seen through a small camera rotation (exact for any
    depth: H = K·R·K⁻¹) — the coordinates in the un-rotated view each output
    pixel looks at."""
    if abs(yaw_deg) < 1e-6 and abs(pitch_deg) < 1e-6:
        return xs, ys
    yaw = np.deg2rad(yaw_deg); pitch = np.deg2rad(pitch_deg)
    cyw, syw = np.cos(yaw), np.sin(yaw); cp, sp = np.cos(pitch), np.sin(pitch)
    Ry = np.array([[cyw, 0, syw], [0, 1, 0], [-syw, 0, cyw]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]]); Kinv = np.linalg.inv(K)
    Hinv = np.linalg.inv(K @ (Rx @ Ry) @ Kinv)
    X = Hinv[0, 0] * xs + Hinv[0, 1] * ys + Hinv[0, 2]
    Y = Hinv[1, 0] * xs + Hinv[1, 1] * ys + Hinv[1, 2]
    D = Hinv[2, 0] * xs + Hinv[2, 1] * ys + Hinv[2, 2]
    return (X / D).astype(np.float32), (Y / D).astype(np.float32)


def background_model(w, bgr, tol=0.08, k=31, grow=9):
    """Local background disparity + an inpainted background plate (pixels much
    nearer than their surroundings — object boundary bands, whole thin objects —
    painted over from the background) so disocclusions show plausible
    background instead of foreground ghosts, stable across frames."""
    w_bg = cv2.erode(w, np.ones((k, k), np.uint8))
    fg = ((w - w_bg) > tol).astype(np.uint8)
    fg = cv2.dilate(fg, np.ones((grow, grow), np.uint8))
    plate = cv2.inpaint(bgr, fg, 5, cv2.INPAINT_TELEA) if fg.any() else bgr
    return w_bg, plate


def build_maps(w, cx, cy, Tz, Tx, layers, grid, w_bg, tol):
    """Layered inverse mapping with a z-test.
    For each destination pixel q and depth layer w_k the inverse camera map is
    closed-form (a similarity): p_k = c + (q-c)(1-Tz·w_k) + Tx·w_k. A layer is
    consistent at q if the source it points at really has disparity ≈ w_k.
    Nearest consistent layer wins; two fixed-point refinements give sub-layer
    accuracy; pixels with no consistent layer are disocclusions and take the
    background inverse (sampled from the inpainted plate by the caller)."""
    xs, ys = grid
    h, wd = w.shape
    best_x = np.full((h, wd), np.nan, np.float32)
    best_y = np.full((h, wd), np.nan, np.float32)
    best_w = np.full((h, wd), -1.0, np.float32)
    for wk in layers:
        den = 1.0 - Tz * wk
        px = cx + (xs - cx) * den + Tx * wk
        py = cy + (ys - cy) * den
        ws = cv2.remap(w, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        ok = (np.abs(ws - wk) <= tol) & (ws > best_w)
        best_x[ok] = px[ok]; best_y[ok] = py[ok]; best_w[ok] = ws[ok]
    hole = np.isnan(best_x)
    for _ in range(2):
        ws = cv2.remap(w, np.nan_to_num(best_x), np.nan_to_num(best_y), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        den = 1.0 - Tz * ws
        best_x = np.where(hole, best_x, cx + (xs - cx) * den + Tx * ws)
        best_y = np.where(hole, best_y, cy + (ys - cy) * den)
    if hole.any():
        best_x[hole] = (cx + (xs - cx) * (1.0 - Tz * w_bg) + Tx * w_bg)[hole]
        best_y[hole] = (cy + (ys - cy) * (1.0 - Tz * w_bg))[hole]
    return best_x, best_y, hole


def parse_size(s):
    if not s:
        return None
    a, b = s.lower().split("x")
    return int(a), int(b)


def render(args):
    t0 = time.time()
    full = cv2.imread(args.src, cv2.IMREAD_COLOR)
    if full is None:
        fail(f"cannot read {args.src}")
    fh, fw = full.shape[:2]
    out_size = parse_size(args.out_size)
    if out_size and (out_size[0] != fw or out_size[1] != fh):
        wd, h = out_size
        bgr = cv2.resize(full, (wd, h), interpolation=cv2.INTER_AREA)
    else:
        wd, h = fw, fh
        bgr = full
    sx_src, sy_src = fw / wd, fh / h          # map coordinates (out res) -> source pixels
    if not os.path.exists(args.model):
        fail(f"depth model missing: {args.model}")
    sess = load_depth_session(args.model)
    d = normalise_disparity(predict_disparity(sess, bgr, args.depth_res), bgr)
    d = sharpen_depth_steps(d)
    t_depth = time.time() - t0
    beta = 1.0 / max(1.05, args.near_ratio - 1.0)     # relative depth's unknown shift
    w = ((d + beta) / (1.0 + beta)).astype(np.float32)
    segs = detect_segments(bgr, args.min_seg)
    n_lines = 0
    if len(segs):
        w, n_lines = regularise_lines(w, segs)
    if args.depth_out:
        cv2.imwrite(args.depth_out, (w * 255).astype(np.uint8))
    cx, cy = (wd - 1) / 2.0, (h - 1) / 2.0
    Tz = (args.zoom - 1.0) / float(w.mean())
    for _ in range(6):
        z = float(np.mean(1.0 / (1.0 - Tz * w)))
        Tz *= (args.zoom - 1.0) / max(1e-6, z - 1.0)
    Tx_end = float(args.truck)
    lo, hi = float(w.min()), float(w.max())
    layers = np.linspace(lo, hi, args.layers).astype(np.float32)
    layer_tol = 0.5 * float(layers[1] - layers[0]) + 0.01 if len(layers) > 1 else 0.05
    # drop layers nothing lives on (saves a remap each per frame)
    hist, edges = np.histogram(w, bins=args.layers, range=(lo, hi + 1e-6))
    keep = hist > 0.0002 * w.size
    if keep.sum() >= 2:
        layers = layers[keep]
    w_bg, plate = background_model(w, bgr)
    ys_g, xs_g = np.mgrid[0:h, 0:wd].astype(np.float32)
    focal = 0.85 * max(wd, h)
    n = int(round(args.seconds * args.fps))
    bend = line_bend(segs, w, cx, cy, Tz, Tx_end) if len(segs) else {"segments": 0, "bend_mean_px": 0, "bend_p95_px": 0, "bend_max_px": 0}
    print(f"[parallax] {fw}x{fh} -> {wd}x{h} depth {t_depth:.1f}s lines {n_lines}/{len(segs)} layers {len(layers)} "
          f"Tz {Tz:.4f} (near x{1/(1-Tz):.3f}, far x{1/(1-Tz*lo):.3f}) bend p95 {bend['bend_p95_px']} max {bend['bend_max_px']}", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{wd}x{h}",
           "-r", str(args.fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(args.fps), args.out]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    except Exception as e:
        fail(f"ffmpeg spawn failed: {e}")
    holes = 0
    every = max(1, int(args.map_every))
    key = {}

    def maps_at(i):
        t = ease(i / max(1, n - 1), args.ease)
        if t <= 0:
            return None
        grid = rotated_grid(xs_g, ys_g, cx, cy, focal, args.yaw * t, args.pitch * t)
        return build_maps(w, cx, cy, Tz * t, Tx_end * t, layers, grid, w_bg, layer_tol)

    frame0 = bgr if (wd, h) == (fw, fh) else cv2.resize(full, (wd, h), interpolation=cv2.INTER_AREA)
    for i in range(n):
        k0 = (i // every) * every
        k1 = min(n - 1, k0 + every)
        if k0 not in key:
            key[k0] = maps_at(k0)
        if k1 not in key:
            key[k1] = maps_at(k1)
        m0, m1 = key[k0], key[k1]
        if m0 is None and m1 is None:
            frame = frame0
        else:
            if m0 is None:                   # first keyframe is the identity map
                m0 = (xs_g, ys_g, np.zeros((h, wd), bool))
            a = 0.0 if k1 == k0 else (i - k0) / (k1 - k0)
            if a <= 0:
                mx, my, hole = m0
            elif a >= 1:
                mx, my, hole = m1
            else:
                mx = m0[0] * (1 - a) + m1[0] * a
                my = m0[1] * (1 - a) + m1[1] * a
                hole = m0[2] | m1[2]
            frame = cv2.remap(full, mx * sx_src, my * sy_src, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT_101)
            if hole.any():
                holes += int(hole.sum())
                fill = cv2.remap(plate, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
                frame[hole] = fill[hole]
        proc.stdin.write(frame.tobytes())
        for kk in [k for k in key if k < k0]:
            del key[kk]
    proc.stdin.close()
    rc = proc.wait()
    summary = {"ok": rc == 0, "out": args.out, "width": wd, "height": h, "src_width": fw, "src_height": fh,
               "seconds": args.seconds, "fps": args.fps, "frames": n, "zoom": args.zoom, "truck": Tx_end,
               "yaw": args.yaw, "pitch": args.pitch, "Tz": round(Tz, 5), "layers": int(len(layers)),
               "lines_regularised": n_lines, "mean_hole_px": int(holes / max(1, n)),
               "depth_s": round(t_depth, 1), "elapsed_s": round(time.time() - t0, 1), **bend}
    if rc != 0:
        summary["error"] = f"ffmpeg exited {rc}"
    if args.report:
        with open(args.report, "w") as f:
            json.dump(summary, f)
    emit(summary)
    sys.exit(0 if rc == 0 else 3)


def check(args):
    info = {"ok": True, "python": sys.version.split()[0], "cv2": cv2.__version__,
            "ximgproc": hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "jointBilateralFilter"),
            "lsd": hasattr(cv2, "createLineSegmentDetector"), "model": os.path.abspath(args.model),
            "model_present": os.path.exists(args.model)}
    try:
        import onnxruntime as ort
        info["onnxruntime"] = ort.__version__
    except Exception as e:
        info["ok"] = False; info["error"] = f"onnxruntime missing: {e}"
    if not info["model_present"]:
        info["ok"] = False; info["error"] = "depth model missing"
    emit(info)
    sys.exit(0 if info["ok"] else 2)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--src")
    ap.add_argument("--out")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--out-size", default=None, help="WxH of the clip; the source may be larger (supersampled)")
    ap.add_argument("--zoom", type=float, default=1.07, help="affine-fit magnification at the end of the clip")
    ap.add_argument("--truck", type=float, default=0.0, help="lateral parallax at the nearest pixel, px (+ camera right)")
    ap.add_argument("--yaw", type=float, default=0.0, help="camera yaw at the end, degrees")
    ap.add_argument("--pitch", type=float, default=0.0, help="camera pitch at the end, degrees")
    ap.add_argument("--near-ratio", type=float, default=4.0, help="assumed far/near depth ratio (relative depth shift)")
    ap.add_argument("--ease", type=float, default=0.15)
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--depth-res", type=int, default=770)
    ap.add_argument("--min-seg", type=int, default=70)
    ap.add_argument("--layers", type=int, default=32)
    ap.add_argument("--map-every", type=int, default=2, help="compute warp maps every N frames, interpolate between")
    ap.add_argument("--model", default=os.path.join(here, "..", "models", "dav2_small.onnx"))
    ap.add_argument("--depth-out", default=None)
    ap.add_argument("--report", default=None)
    args = ap.parse_args()
    if args.check:
        check(args)
    if not args.src or not args.out:
        fail("--src and --out are required")
    render(args)


if __name__ == "__main__":
    main()
