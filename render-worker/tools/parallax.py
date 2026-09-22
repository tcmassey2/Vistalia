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

v64.3 "living parallax": lateral TRUCKS and ARCS (truck + a yaw that keeps the
mid-depth centre framed) at Reel-E amplitude. Two things make that possible:
  · MARGINS — the Node side crops the photo WIDER than the delivery frame
    (--margin MX,MY frame-px on each side) so a truck reveals real photo at the
    frame edge instead of zooming in; the frame is the centred W×H window of
    the working canvas. When the photo has no room, --overscan pre-zoom covers
    the shortfall.
  · A REAL PLATE — the disocclusion strip (exactly the t=1 hole set, mapped
    back to source pixels) is inpainted once per scene with LaMa (ONNX,
    --lama), which continues cabinet lines and walls instead of smearing them;
    Telea remains the fallback.

Usage (the Node wrapper in src/parallax-job.mjs builds this):
  parallax.py --src photo.png --out clip.mp4 --seconds 5.0 [--fps 30]
              [--out-size 1080x1920] [--margin 108,40] [--zoom 1.07]
              [--truck-x 70] [--truck-y 0] [--arc] [--yaw 0.4] [--pitch -0.2]
              [--near-ratio 4] [--map-every 3] [--layers 32]
              [--model models/dav2_small.onnx] [--lama models/lama_fp32.onnx]
              [--report r.json] [--depth-out d.png]
  parallax.py --check [--model ...] [--lama ...]   # dependency / model probe, JSON out

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


def forward_xy(xs, ys, w, cx, cy, Tz, Tx, Ty=0.0):
    den = 1.0 - Tz * w
    return cx + (xs - cx - Tx * w) / den, cy + (ys - cy - Ty * w) / den


def line_bend(segments, w, cx, cy, Tz, Tx, Ty=0.0, n_samples=40):
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
            if float(ww.max() - ww.min()) > 0.15:
                continue      # this side crosses an occlusion step: the edge is legitimately broken there, not bent
            qx, qy = forward_xy(px, py, ww, cx, cy, Tz, Tx, Ty)
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


def background_disparity(w, k=31):
    """Local background disparity: the farthest surface within k px."""
    return cv2.erode(w, np.ones((k, k), np.uint8))


_lama = None
def load_lama(path):
    global _lama
    if _lama is None and path and os.path.exists(path):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
        so.log_severity_level = 3
        _lama = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    return _lama


def lama_inpaint(bgr, mask, sess, tile=512, overlap=128):
    """Big-LaMa (Carve ONNX export, fixed 512x512, image 0..1 in, 0..255 out).
    One regular grid of overlapping tiles over the mask's bounding box; only
    tiles that contain mask pixels run; masked pixels are pasted back."""
    h, w = bgr.shape[:2]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    if h < tile or w < tile:
        rgb = cv2.copyMakeBorder(rgb, 0, max(0, tile - h), 0, max(0, tile - w), cv2.BORDER_REFLECT_101)
        mask = cv2.copyMakeBorder(mask, 0, max(0, tile - h), 0, max(0, tile - w), cv2.BORDER_CONSTANT, value=0)
    H, W = rgb.shape[:2]
    out = rgb.copy()
    m = (mask > 0).astype(np.uint8)
    ys_, xs_ = np.where(m > 0)
    if len(ys_) == 0:
        return bgr, 0
    y0, y1 = max(0, ys_.min() - 48), min(H, ys_.max() + 49)
    x0, x1 = max(0, xs_.min() - 48), min(W, xs_.max() + 49)
    step = tile - overlap
    ty_list = list(range(y0, max(y0 + 1, y1 - tile + 1), step)) + [max(0, min(y1 - tile, H - tile))]
    tx_list = list(range(x0, max(x0 + 1, x1 - tile + 1), step)) + [max(0, min(x1 - tile, W - tile))]
    done = np.zeros((H, W), bool)
    tiles = 0
    for ty in sorted(set(max(0, min(t, H - tile)) for t in ty_list)):
        for tx in sorted(set(max(0, min(t, W - tile)) for t in tx_list)):
            sub_m = m[ty:ty + tile, tx:tx + tile]
            sel = sub_m.astype(bool) & ~done[ty:ty + tile, tx:tx + tile]
            if not sel.any():
                continue
            x_in = np.transpose(out[ty:ty + tile, tx:tx + tile], (2, 0, 1))[None].astype(np.float32)
            res = sess.run(None, {"image": x_in, "mask": sub_m[None, None].astype(np.float32)})[0][0]
            res = np.clip(np.transpose(res, (1, 2, 0)) / 255.0, 0, 1)
            out[ty:ty + tile, tx:tx + tile][sel] = res[sel]
            done[ty:ty + tile, tx:tx + tile] |= sel
            tiles += 1
    out = cv2.cvtColor((out[:h, :w] * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    return out, tiles


def build_plate(bgr, mask, lama_sess, plate_scale=0.5):
    """Inpaint `mask` (uint8, 1 = paint) in bgr. LaMa at plate_scale (the fill
    only ever shows in thin revealed strips, so half resolution is plenty and
    4x cheaper), composited back at full res; Telea if LaMa is unavailable."""
    if not mask.any():
        return bgr, "none", 0
    if lama_sess is not None:
        h, w = bgr.shape[:2]
        sw, sh = max(512, int(round(w * plate_scale))), max(512, int(round(h * plate_scale)))
        small = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)
        msmall = cv2.dilate(cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_NEAREST), np.ones((3, 3), np.uint8))
        filled, tiles = lama_inpaint(small, msmall, lama_sess)
        up = cv2.resize(filled, (w, h), interpolation=cv2.INTER_CUBIC)
        plate = bgr.copy()
        sel = mask.astype(bool)
        plate[sel] = up[sel]
        return plate, "lama", tiles
    return cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA), "telea", 0


def hollow_frame_cards(d, bg0, fg, bgr, min_area=1500):
    """For each near component: classify its interior pixels by colour as
    "fixture rim" vs "surrounding background"; interior pixels that look like
    the background get the background depth. Returns (d, pixels_hollowed)."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, 8)
    out = d.copy()
    hollowed = 0
    k3, k8, k15 = np.ones((3, 3), np.uint8), np.ones((17, 17), np.uint8), np.ones((31, 31), np.uint8)
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_area:
            continue
        x, y, bw, bh = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP], stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        x0, y0 = max(0, x - 20), max(0, y - 20); x1, y1 = min(d.shape[1], x + bw + 20), min(d.shape[0], y + bh + 20)
        comp = (labels[y0:y1, x0:x1] == i).astype(np.uint8)
        interior = cv2.erode(comp, k8)
        if interior.sum() < 0.15 * area:
            continue                                    # already thin, nothing to hollow
        rim = (comp > 0) & (interior == 0)
        ring = (cv2.dilate(comp, k15) > 0) & (cv2.dilate(comp, k3) == 0) & (fg[y0:y1, x0:x1] == 0)
        if rim.sum() < 50 or ring.sum() < 50:
            continue
        L = lab[y0:y1, x0:x1]
        m_rim, s_rim = L[rim].mean(0), L[rim].std(0) + 4.0
        m_bg, s_bg = L[ring].mean(0), L[ring].std(0) + 4.0
        Li = L[interior > 0]
        d_rim = (((Li - m_rim) / s_rim) ** 2).sum(1)
        d_bg = (((Li - m_bg) / s_bg) ** 2).sum(1)
        is_bg = d_bg < d_rim
        if is_bg.mean() < 0.35:
            continue                                    # a solid object (sofa, stool): keep the card
        sel = np.zeros(comp.shape, bool)
        sel[interior > 0] = is_bg
        # only contiguous background pockets, cleaned
        sel_u8 = cv2.morphologyEx(sel.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        sub = out[y0:y1, x0:x1]
        sub[sel_u8 > 0] = bg0[y0:y1, x0:x1][sel_u8 > 0]
        hollowed += int(sel_u8.sum())
    return out.astype(np.float32), hollowed


def build_maps(w, cx, cy, Tz, Tx, Ty, layers, grid, w_bg, tol):
    """Layered inverse mapping with a z-test.
    For each destination pixel q and depth layer w_k the inverse camera map is
    closed-form (a similarity): p_k = c + (q-c)(1-Tz·w_k) + T·w_k. A layer is
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
        py = cy + (ys - cy) * den + Ty * wk
        ws = cv2.remap(w, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        ok = (np.abs(ws - wk) <= tol) & (ws > best_w)
        best_x[ok] = px[ok]; best_y[ok] = py[ok]; best_w[ok] = ws[ok]
    hole = np.isnan(best_x)
    # de-speckle: a 3x3 majority on the hole mask and a 3x3 median on the
    # winner coordinates remove the single-pixel layer flips along depth
    # edges (the "confetti"); coordinates are locally smooth within a layer,
    # so the median simply votes for the majority layer at a boundary.
    hole_u8 = hole.astype(np.uint8)
    hole_u8 = cv2.morphologyEx(cv2.morphologyEx(hole_u8, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    hole = hole_u8.astype(bool)
    fx = cv2.medianBlur(np.nan_to_num(best_x, nan=0.0).astype(np.float32), 3)
    fy = cv2.medianBlur(np.nan_to_num(best_y, nan=0.0).astype(np.float32), 3)
    best_x = np.where(hole, np.nan, fx).astype(np.float32)
    best_y = np.where(hole, np.nan, fy).astype(np.float32)
    for _ in range(2):
        ws = cv2.remap(w, np.nan_to_num(best_x), np.nan_to_num(best_y), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        den = 1.0 - Tz * ws
        best_x = np.where(hole, best_x, cx + (xs - cx) * den + Tx * ws)
        best_y = np.where(hole, best_y, cy + (ys - cy) * den + Ty * ws)
    if hole.any():
        best_x[hole] = (cx + (xs - cx) * (1.0 - Tz * w_bg) + Tx * w_bg)[hole]
        best_y[hole] = (cy + (ys - cy) * (1.0 - Tz * w_bg) + Ty * w_bg)[hole]
    return best_x, best_y, hole


def parse_pair(s, default=(0, 0)):
    if not s:
        return default
    a, b = str(s).replace("x", ",").split(",")
    return int(a), int(b)


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
    frame_w, frame_h = parse_size(args.out_size) or (fw, fh)
    mx, my = parse_pair(args.margin)
    # working canvas = frame + margins, at frame scale; the source is that canvas supersampled
    wd, h = frame_w + 2 * mx, frame_h + 2 * my
    bgr = cv2.resize(full, (wd, h), interpolation=cv2.INTER_AREA) if (wd, h) != (fw, fh) else full
    sx_src, sy_src = fw / wd, fh / h
    if not os.path.exists(args.model):
        fail(f"depth model missing: {args.model}")
    sess = load_depth_session(args.model)
    d = normalise_disparity(predict_disparity(sess, bgr, args.depth_res), bgr)
    # Only true occlusion steps get hardened (tol 0.15); smaller transitions
    # are surface gradients, and snapping those into staircases makes a
    # single object move as several patches (Sep-22 pendant tearing). Then an
    # edge-preserving smooth inside surfaces (bilateral on w itself).
    d = sharpen_depth_steps(d, tol=0.15)
    d = cv2.bilateralFilter(d.astype(np.float32), 9, 0.08, 6)
    # Objects own their edges: the depth silhouette sits within ±2 px of the
    # colour edge, and where it falls short the object's anti-aliased rim
    # travels with the background and speckles. Growing the near surface by
    # 2 px (grey dilation) makes the rim move with the object; the cost is a
    # 2 px sliver of background travelling with it, far less visible.
    d = cv2.dilate(d, np.ones((5, 5), np.uint8))
    # Thin near structures (pendant bars, cords, chair legs — anything under
    # ~17 px wide that stands well in front of its surroundings) tear under a
    # lateral move: the depth model cannot place a 12 px bar to the pixel, so
    # parts of it land on different layers. Pin them to the local background
    # instead — they lose their parallax (a keen eye sees a light "painted"
    # on the wall) but they stay whole, which is the lesser evil by far.
    bg0 = cv2.erode(d, np.ones((31, 31), np.uint8))
    fg = ((d - bg0) > 0.08).astype(np.uint8)
    # Frame-shaped fixtures (linear pendants, chandeliers, open shelving): the
    # depth model returns a SOLID near card that swallows the ceiling seen
    # through the frame, so the ceiling would travel with the fixture and the
    # bars tear at the card's edge. Give the card's interior back to the
    # background wherever its colour matches the surroundings rather than
    # the fixture's own rim; what remains is the thin frame, which the
    # thin-structure rule below then pins.
    hollowed_px = 0
    if args.hollow:
        d, hollowed_px = hollow_frame_cards(d, bg0, fg, bgr)
        fg = ((d - bg0) > 0.08).astype(np.uint8)
    thin_px = 0
    if args.thin_pin:
        core = cv2.dilate(cv2.erode(fg, np.ones((17, 17), np.uint8)), np.ones((19, 19), np.uint8))
        thin = (fg > 0) & (core == 0)
        thin_px = int(thin.sum())
        if thin_px:
            d = np.where(thin, bg0, d).astype(np.float32)
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
    Tx_end = float(args.truck_x if args.truck_x is not None else args.truck)
    Ty_end = float(args.truck_y or 0.0)
    lo, hi = float(w.min()), float(w.max())
    focal = 0.85 * max(frame_w, frame_h)
    # ARC: a truck plus the yaw that keeps the mid-depth centre framed, so the
    # background slides one way and the foreground the other (the Reel-E move).
    yaw_end, pitch_end = float(args.yaw), float(args.pitch)
    if args.arc and abs(Tx_end) > 1e-6:
        w_mid = float(np.median(w))
        # rotated_grid maps output px -> unrotated px; a yaw that moves the
        # centre sample by +Tx·w_mid cancels the truck's shift of the centre.
        probe = rotated_grid(np.array([[cx]], np.float32), np.array([[cy]], np.float32), cx, cy, focal, 1.0, 0.0)[0][0, 0] - cx
        yaw_end += float(np.rad2deg(np.arctan((Tx_end * w_mid) / focal))) * (1.0 if probe > 0 else -1.0)
    layers = np.linspace(lo, hi, args.layers).astype(np.float32)
    layer_tol = 0.5 * float(layers[1] - layers[0]) + 0.01 if len(layers) > 1 else 0.05
    hist, edges = np.histogram(w, bins=args.layers, range=(lo, hi + 1e-6))
    keep = hist > 0.0002 * w.size
    if keep.sum() >= 2:
        layers = layers[keep]
    w_bg = background_disparity(w)
    ys_g, xs_g = np.mgrid[0:h, 0:wd].astype(np.float32)
    # Overscan: what the move needs at the FRAME edge beyond what the margins
    # give. Foreground at the edge shifts by the full truck; the far plane by
    # focal·tan(angle) minus the little it zooms. Shortfall -> pre-zoom s0.
    far_zoom_end = 1.0 / (1.0 - Tz * lo)
    need_x = abs(Tx_end) + abs(focal * np.tan(np.deg2rad(yaw_end))) + 4
    need_y = abs(Ty_end) + abs(focal * np.tan(np.deg2rad(pitch_end))) + 4
    avail_x = mx + (far_zoom_end - 1.0) * (frame_w / 2.0)
    avail_y = my + (far_zoom_end - 1.0) * (frame_h / 2.0)
    overscan = max(1.0, 1.0 + (need_x - avail_x) / (frame_w / 2.0), 1.0 + (need_y - avail_y) / (frame_h / 2.0))
    n = int(round(args.seconds * args.fps))
    bend = line_bend(segs, w, cx, cy, Tz, Tx_end, Ty_end) if len(segs) else {"segments": 0, "bend_mean_px": 0, "bend_p95_px": 0, "bend_max_px": 0}

    def pre_scale(gx, gy):
        if overscan <= 1.0:
            return gx, gy
        return (cx + (gx - cx) / overscan).astype(np.float32), (cy + (gy - cy) / overscan).astype(np.float32)

    def maps_at_t(t):
        gx, gy = rotated_grid(xs_g, ys_g, cx, cy, focal, yaw_end * t, pitch_end * t)
        gx, gy = pre_scale(gx, gy)
        return build_maps(w, cx, cy, Tz * t, Tx_end * t, Ty_end * t, layers, (gx, gy), w_bg, layer_tol)

    # ── the plate: exactly the pixels the move will reveal, inpainted once ──
    t_plate0 = time.time()
    mx_end, my_end, hole_end = maps_at_t(1.0)
    plate_mask = np.zeros((h, wd), np.uint8)
    if hole_end.any():
        hx = np.clip(np.rint(mx_end[hole_end]), 0, wd - 1).astype(np.int32)
        hy = np.clip(np.rint(my_end[hole_end]), 0, h - 1).astype(np.int32)
        plate_mask[hy, hx] = 1
        # Grow the mask by about half the move: LaMa only repaints masked
        # pixels, and a foreground object that is only partly masked leaves
        # its other half in the plate — which then shows up as a ghost copy
        # behind the moved object (Sep-22 pendant). A generous band removes
        # the whole object where it will be revealed.
        reach = int(min(61, 11 + 0.5 * max(abs(Tx_end), abs(Ty_end), (args.zoom - 1.0) * frame_w / 2.0)))
        plate_mask = cv2.dilate(plate_mask, np.ones((reach | 1, reach | 1), np.uint8))
        plate_mask = cv2.morphologyEx(plate_mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    lama = load_lama(args.lama) if args.lama else None
    plate, plate_engine, plate_tiles = build_plate(bgr, plate_mask, lama)
    t_plate = time.time() - t_plate0
    print(f"[parallax] {fw}x{fh} -> canvas {wd}x{h} frame {frame_w}x{frame_h} margin {mx},{my} depth {t_depth:.1f}s lines {n_lines}/{len(segs)} "
          f"layers {len(layers)} Tz {Tz:.4f} (near x{1/(1-Tz):.3f}, far x{far_zoom_end:.3f}) truck {Tx_end:.0f},{Ty_end:.0f} yaw {yaw_end:.2f} pitch {pitch_end:.2f} "
          f"overscan {overscan:.3f} plate {plate_engine} {plate_tiles} tiles {int(plate_mask.sum())}px {t_plate:.1f}s bend p95 {bend['bend_p95_px']} max {bend['bend_max_px']}", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{frame_w}x{frame_h}",
           "-r", str(args.fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(args.fps), args.out]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    except Exception as e:
        fail(f"ffmpeg spawn failed: {e}")
    holes = 0
    oob_last = 0
    every = max(1, int(args.map_every))
    key = {n - 1: (mx_end, my_end, hole_end)}   # reuse the t=1 maps for the last keyframe

    def maps_at(i):
        t = ease(i / max(1, n - 1), args.ease)
        if t <= 0:
            return None
        if i == n - 1:
            return key[n - 1]
        return maps_at_t(t)

    id_x, id_y = pre_scale(xs_g, ys_g)
    identity = (id_x, id_y, np.zeros((h, wd), bool))
    crop = (slice(my, my + frame_h), slice(mx, mx + frame_w))
    frame0 = cv2.remap(full, id_x * sx_src, id_y * sy_src, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT_101)[crop]
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
            if m0 is None:
                m0 = identity
            a = 0.0 if k1 == k0 else (i - k0) / (k1 - k0)
            if a <= 0:
                mxx, myy, hole = m0
            elif a >= 1:
                mxx, myy, hole = m1
            else:
                mxx = m0[0] * (1 - a) + m1[0] * a
                myy = m0[1] * (1 - a) + m1[1] * a
                hole = m0[2] | m1[2]
            if i == n - 1:
                fx, fy = mxx[crop], myy[crop]
                oob_last = int(((fx < 0) | (fx > wd - 1) | (fy < 0) | (fy > h - 1)).sum())
            frame = cv2.remap(full, mxx * sx_src, myy * sy_src, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT_101)
            if hole.any():
                holes += int(hole[crop].sum())
                fill = cv2.remap(plate, mxx, myy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
                # soft edge on the fill: the hole boundary is quantised by the
                # depth layers, a 1.5 px feather hides the sawtooth along it
                alpha = cv2.GaussianBlur(hole.astype(np.float32), (0, 0), 1.2)[..., None]
                frame = (frame.astype(np.float32) * (1.0 - alpha) + fill.astype(np.float32) * alpha).astype(np.uint8)
            frame = frame[crop]
        proc.stdin.write(np.ascontiguousarray(frame).tobytes())
        for kk in [k for k in key if k < k0 and k != n - 1]:
            del key[kk]
    proc.stdin.close()
    rc = proc.wait()
    summary = {"ok": rc == 0, "out": args.out, "width": frame_w, "height": frame_h, "canvas_width": wd, "canvas_height": h,
               "margin": [mx, my], "src_width": fw, "src_height": fh,
               "seconds": args.seconds, "fps": args.fps, "frames": n, "zoom": args.zoom, "truck": [Tx_end, Ty_end], "arc": bool(args.arc),
               "yaw": round(yaw_end, 3), "pitch": round(pitch_end, 3), "Tz": round(Tz, 5), "overscan": round(float(overscan), 4), "layers": int(len(layers)),
               "lines_regularised": n_lines, "thin_px": thin_px, "hollowed_px": hollowed_px, "mean_hole_px": int(holes / max(1, n)), "oob_last_px": oob_last,
               "plate": plate_engine, "plate_tiles": plate_tiles, "plate_px": int(plate_mask.sum()), "plate_s": round(t_plate, 1),
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
    info["lama"] = os.path.abspath(args.lama) if args.lama else None
    info["lama_present"] = bool(args.lama and os.path.exists(args.lama))
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
    ap.add_argument("--truck", type=float, default=0.0, help="(legacy) lateral parallax at the nearest pixel, frame px (+ camera right)")
    ap.add_argument("--truck-x", type=float, default=None, help="lateral camera move: frame px the NEAREST pixel shifts (+ camera right)")
    ap.add_argument("--truck-y", type=float, default=0.0, help="vertical camera move: frame px the nearest pixel shifts (+ camera down)")
    ap.add_argument("--arc", action="store_true", help="add the yaw that keeps the mid-depth centre framed during a truck")
    ap.add_argument("--margin", default="0,0", help="MX,MY: frame-px of extra photo on each side of the frame inside the source (from the Node crop)")
    ap.add_argument("--lama", default=os.path.join(here, "..", "models", "lama_fp32.onnx"), help="LaMa ONNX for the background plate; Telea if missing")
    ap.add_argument("--hollow", type=int, default=0, help="1: give frame-shaped near cards' background-coloured interior back to the background")
    ap.add_argument("--thin-pin", type=int, default=0, help="1: pin near structures thinner than ~17 px to the background")
    ap.add_argument("--yaw", type=float, default=0.0, help="camera yaw at the end, degrees")
    ap.add_argument("--pitch", type=float, default=0.0, help="camera pitch at the end, degrees")
    ap.add_argument("--near-ratio", type=float, default=4.0, help="assumed far/near depth ratio (relative depth shift)")
    ap.add_argument("--ease", type=float, default=0.15)
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--depth-res", type=int, default=770)
    ap.add_argument("--min-seg", type=int, default=70)
    ap.add_argument("--layers", type=int, default=32)
    ap.add_argument("--map-every", type=int, default=4, help="compute warp maps every N frames, interpolate between (4 = maps at 7.5 fps; the move is smooth so the lerp is exact to <0.5 px)")
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
