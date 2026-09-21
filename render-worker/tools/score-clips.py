#!/usr/bin/env python3
"""Numeric scorer for the i2v bake-off (round 3).

Per clip, against its source photo (all frame work at 1280-px width for comparability):
  fidelity_ssim   SSIM of frame 0 vs the source, homography-aligned                     higher = better
  rigid_mid/last  1 - SSIM(frame0, frame_t warped back onto frame0 by DENSE flow)      lower  = better
                  dense-flow compensation absorbs camera motion AND parallax; what is
                  left is texture boil, morphing, invented/removed objects, disocclusion
  line_persist    % of long LSD line segments in frame 0 still found in the flow-
                  compensated last frame (angle<4°, midpoint<10px)                     higher = better
  flow_rough      high-frequency content of the frame0->last flow field / mean flow    lower  = rigid
  zoom_total      affine scale of the frame0->last flow (1.06 = 6% push-in)
  travel_px       mean |flow| frame0->last (how far things moved, px at 1280w)
  flow_jerk       std of step-to-step change in per-step flow magnitude / mean         lower = smoother (NaN if ~no motion)
  sharp_f0/last   Laplacian variance of frame vs the source at clip res                ~1 = as sharp as the photo
  lum_flicker     mean |Δ luminance| between consecutive frames (0-255)                 lower = better
Usage: score_clips.py <clips_dir> <sources_dir> <out_dir>
Clip names: <model>-<scene>.mp4 ; sources map by scene id r1..r6.
"""
import sys, os, json, glob, math
import numpy as np
import cv2
from skimage.metrics import structural_similarity as ssim

SOURCE_MAP = {
    "r1-kitchen-greatroom": "HDR-Real-Estate-Photography-Phoenix-Arizona_10-23.webp",
    "r2-primary-bedroom": "HDR-Real-Estate-Photography-Phoenix-Arizona_10-28.webp",
    "r3-exterior-twilight": "Twilight-Real-Estate-Photos-Phoenix-Metro-Arizona-12.webp",
    "r4-bath-mirrors": "HDR-Real-Estate-Photography-Phoenix-Arizona_10-25.webp",
    "r5-pool-patio": "HDR-Real-Estate-Photography-Phoenix-Arizona_10-31.webp",
    "r6-kitchen-modern": "HDR-Real-Estate-Photography-Phoenix-Arizona_10-35.webp",
}
WORK_W = 1280

def read_frames(path, max_frames=400):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok or len(frames) >= max_frames:
            break
        frames.append(f)
    cap.release()
    return frames

def gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

def fit_to(src, w, h):
    sh, sw = src.shape[:2]
    scale = max(w / sw, h / sh)
    r = cv2.resize(src, (int(round(sw * scale)), int(round(sh * scale))), interpolation=cv2.INTER_AREA)
    rh, rw = r.shape[:2]
    x0 = (rw - w) // 2; y0 = (rh - h) // 2
    return r[y0:y0 + h, x0:x0 + w]

def homography(a, b):
    orb = cv2.ORB_create(4000)
    ka, da = orb.detectAndCompute(a, None)
    kb, db = orb.detectAndCompute(b, None)
    if da is None or db is None or len(ka) < 12 or len(kb) < 12:
        return None, 0.0
    m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(da, db)
    if len(m) < 12:
        return None, 0.0
    m = sorted(m, key=lambda x: x.distance)[:1500]
    pa = np.float32([ka[x.queryIdx].pt for x in m]).reshape(-1, 1, 2)
    pb = np.float32([kb[x.trainIdx].pt for x in m]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(pb, pa, cv2.RANSAC, 3.0)
    return (H, float(mask.mean())) if H is not None else (None, 0.0)

def interior(img, frac=0.05):
    h, w = img.shape[:2]
    return img[int(h * frac):h - int(h * frac), int(w * frac):w - int(w * frac)]

def fidelity(src_g, f0_g):
    H, inl = homography(src_g, f0_g)
    h, w = src_g.shape
    if H is None:
        return float(ssim(src_g, f0_g, data_range=255)), 0.0
    warped = cv2.warpPerspective(f0_g, H, (w, h))
    return float(ssim(interior(src_g), interior(warped), data_range=255)), inl

_dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)

def dense_flow(a, b):
    """Flow from a to b (for each pixel in a, where it went in b)."""
    return _dis.calc(a, b, None)

def warp_back(b, flow):
    """Pull b onto a's grid using flow a->b."""
    h, w = flow.shape[:2]
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(b, xs + flow[..., 0], ys + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

def rigidity(f0, ft):
    flow = dense_flow(f0, ft)
    w = warp_back(ft, flow)
    return 1.0 - float(ssim(interior(f0), interior(w), data_range=255)), flow, w

def lsd_lines(g, min_len=60):
    lsd = cv2.createLineSegmentDetector(0)
    L = lsd.detect(g)[0]
    out = []
    if L is None:
        return out
    for x1, y1, x2, y2 in L[:, 0, :]:
        ln = math.hypot(x2 - x1, y2 - y1)
        if ln < min_len:
            continue
        ang = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0
        out.append(((x1 + x2) / 2, (y1 + y2) / 2, ang, ln))
    return out

def line_persistence(f0, warped_last):
    la = lsd_lines(f0); lb = lsd_lines(warped_last)
    if not la:
        return float("nan"), 0
    if not lb:
        return 0.0, len(la)
    B = np.array([(x, y, a) for x, y, a, _ in lb])
    hit = 0
    for x, y, a, _ in la:
        d = np.hypot(B[:, 0] - x, B[:, 1] - y)
        da = np.abs(((B[:, 2] - a) + 90) % 180 - 90)
        if np.any((d < 10) & (da < 4)):
            hit += 1
    return 100.0 * hit / len(la), len(la)

def flow_affine(flow):
    h, w = flow.shape[:2]
    ys, xs = np.mgrid[0:h:8, 0:w:8]
    X = np.stack([xs.ravel(), ys.ravel(), np.ones(xs.size)], 1).astype(np.float64)
    U = flow[::8, ::8, 0].ravel().astype(np.float64); V = flow[::8, ::8, 1].ravel().astype(np.float64)
    cu, *_ = np.linalg.lstsq(X, U, rcond=None); cv_, *_ = np.linalg.lstsq(X, V, rcond=None)
    A = np.array([[1 + cu[0], cu[1]], [cv_[0], 1 + cv_[1]]])
    return float(np.sqrt(abs(np.linalg.det(A))))

def flow_roughness(flow):
    mag = np.linalg.norm(flow, axis=2)
    lap = np.abs(cv2.Laplacian(cv2.GaussianBlur(flow[..., 0], (5, 5), 0), cv2.CV_32F)) + \
          np.abs(cv2.Laplacian(cv2.GaussianBlur(flow[..., 1], (5, 5), 0), cv2.CV_32F))
    return float(interior(lap).mean() / (interior(mag).mean() + 1e-3)), float(interior(mag).mean())

def step_flow_mags(frames_g, step=2):
    mags = []
    for i in range(0, len(frames_g) - step, step):
        f = dense_flow(frames_g[i], frames_g[i + step])
        mags.append(float(np.linalg.norm(f, axis=2).mean()))
    return np.array(mags)

def lap_var(g):
    return float(cv2.Laplacian(g, cv2.CV_64F).var())

def edge_strength(g):
    """Grain-robust sharpness: mean gradient magnitude over the strongest 2% of pixels
    after a light blur (grain/noise has weak gradients; real edges survive the blur)."""
    b = cv2.GaussianBlur(g, (0, 0), 1.0)
    gx = cv2.Sobel(b, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(b, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    thr = np.percentile(mag, 98)
    return float(mag[mag >= thr].mean())

def frame_at_zoom(frames_g, target=1.06, step=2):
    """Index of the first sampled frame whose cumulative affine zoom vs frame 0 reaches target
    (None if never reached). Used to compare rigidity at MATCHED camera travel."""
    for i in range(step, len(frames_g), step):
        z = flow_affine(dense_flow(frames_g[0], frames_g[i]))
        if z >= target:
            return i
    return None

def blur(g):
    return cv2.GaussianBlur(g, (0, 0), 1.2)

def score_clip(clip_path, src_path, out_dir):
    frames = read_frames(clip_path)
    if len(frames) < 8:
        return {"clip": os.path.basename(clip_path), "error": f"only {len(frames)} frames"}
    H0, W0 = frames[0].shape[:2]
    s = WORK_W / W0
    wk = (WORK_W, int(round(H0 * s)))
    fr = [cv2.resize(f, wk, interpolation=cv2.INTER_AREA) for f in frames]
    fg = [gray(f) for f in fr]
    src = cv2.imread(src_path, cv2.IMREAD_COLOR)
    src_fit = fit_to(src, wk[0], wk[1]); src_g = gray(src_fit)

    fid, fid_inl = fidelity(src_g, fg[0])
    mid = len(fg) // 2
    # rigidity on lightly blurred frames so a soft model can't score "rigid" just by being blurry
    fb = [blur(g) for g in fg]
    rig_mid, _, _ = rigidity(fb[0], fb[mid])
    rig_last, flow_last, warped_last = rigidity(fb[0], fb[-1])
    lp, nlines = line_persistence(fg[0], warp_back(fg[-1], flow_last))
    rough, travel = flow_roughness(flow_last)
    zoom = flow_affine(flow_last)
    # matched-travel rigidity: residual + line persistence at the frame where zoom first hits 1.06
    i6 = frame_at_zoom(fb, 1.05)
    if i6 is not None:
        rig6, flow6, _ = rigidity(fb[0], fb[i6])
        lp6, _ = line_persistence(fg[0], warp_back(fg[i6], flow6))
        t6 = i6 / max(1, len(fg) - 1)
    else:
        rig6, lp6, t6 = None, None, None
    edge_src = edge_strength(src_g)
    edge0 = edge_strength(fg[0]) / (edge_src + 1e-6); edgel = edge_strength(fg[-1]) / (edge_src + 1e-6)
    mags = step_flow_mags(fg, step=2)
    d = np.diff(mags)
    jerk = float(d.std() / mags.mean()) if (len(d) > 2 and mags.mean() > 0.15) else float("nan")

    s_src = lap_var(src_g)
    sharp0 = lap_var(fg[0]) / (s_src + 1e-6); sharpl = lap_var(fg[-1]) / (s_src + 1e-6)
    lum = np.array([float(f.mean()) for f in fg])
    flicker = float(np.abs(np.diff(lum)).mean())

    # strip: source | f0 | mid | last | residual heat (f0 vs flow-compensated last)
    strip_h = 240
    def sm(img):
        return cv2.resize(img, (int(img.shape[1] * strip_h / img.shape[0]), strip_h))
    resid = cv2.absdiff(fg[0], warped_last)
    heat = cv2.applyColorMap(np.clip(resid.astype(np.int32) * 3, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
    strip = np.concatenate([sm(src_fit), sm(fr[0]), sm(fr[mid]), sm(fr[-1]), sm(heat)], axis=1)
    label = os.path.basename(clip_path)
    cv2.putText(strip, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
    cv2.putText(strip, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1)
    cv2.imwrite(os.path.join(out_dir, label.replace(".mp4", "_strip.jpg")), strip, [cv2.IMWRITE_JPEG_QUALITY, 85])

    return {
        "clip": label, "res": f"{W0}x{H0}", "frames": len(frames),
        "fidelity_ssim": round(fid, 3), "fidelity_inliers": round(fid_inl, 2),
        "rigid_mid": round(rig_mid, 3), "rigid_last": round(rig_last, 3),
        "rigid_at6": None if rig6 is None else round(rig6, 3),
        "lines_at6": None if lp6 is None or math.isnan(lp6) else round(lp6, 1),
        "t_at6": None if t6 is None else round(t6, 2),
        "edge_f0": round(edge0, 2), "edge_last": round(edgel, 2),
        "line_persist_pct": None if math.isnan(lp) else round(lp, 1), "lines_f0": nlines,
        "flow_rough": round(rough, 3), "zoom_total": round(zoom, 3), "travel_px": round(travel, 1),
        "flow_jerk": None if math.isnan(jerk) else round(jerk, 3),
        "sharp_f0": round(sharp0, 2), "sharp_last": round(sharpl, 2),
        "lum_flicker": round(flicker, 2),
    }

def main():
    clips_dir, src_dir, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for clip in sorted(glob.glob(os.path.join(clips_dir, "*.mp4"))):
        base = os.path.basename(clip)[:-4]
        scene = next((s for s in SOURCE_MAP if base.endswith(s)), None)
        if scene is None:
            print("skip (no scene match):", base); continue
        src = os.path.join(src_dir, SOURCE_MAP[scene])
        model = base[: -len(scene) - 1]
        try:
            r = score_clip(clip, src, out_dir)
        except Exception as e:
            r = {"clip": os.path.basename(clip), "error": str(e)}
        r["model"] = model; r["scene"] = scene
        rows.append(r)
        print(json.dumps(r))
    with open(os.path.join(out_dir, "scores.json"), "w") as f:
        json.dump(rows, f, indent=1)

if __name__ == "__main__":
    main()
