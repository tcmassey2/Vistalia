#!/usr/bin/env python3
"""
Vistalia — measured clip gate (v64). Numbers, not a vision-model opinion, for
the three customer faults on a GENERATED clip:

  motion wrong   zoom_orb / zoom_flow  — affine magnification first→last frame
                 travel_px             — mean flow magnitude first→last
  morph/invent   rigid_last            — 1 − SSIM(frame0, last frame warped back by
                                         dense optical flow), on lightly blurred
                                         frames; camera motion and parallax are
                                         absorbed, what remains is morph/boil
                 line_persist_pct      — long straight edges (LSD) of frame 0 still
                                         present in the flow-compensated last frame
  flicker        lum_flicker           — std of mean luma across sampled frames

Calibrated on the Sep-20/21 bake-off (MODEL_BAKEOFF_SEP2026.md §3/§4b): a
static re-encode scores rigid 0.00 / lines 99%; a synthetic 6% zoom of the
same photo 0.004 / ~78%; Kling v3 Pro on the 9:16 crops 0.02–0.27 / 25–69%.
Analysis runs at ~540 px wide so a 5 s clip takes ~1–2 s.

Usage:  clip-gate.py --clip clip.mp4 [--frames 8]    → last stdout line is JSON
"""
import argparse, json, sys

def emit(o):
    print("[gate] " + json.dumps(o), flush=True)

try:
    import numpy as np
    import cv2
except Exception as e:  # pragma: no cover
    emit({"ok": False, "error": f"python deps missing: {e}"}); sys.exit(2)


def read_frames(path, n_samples, width=540):
    cap = cv2.VideoCapture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if n < 2:
        raise RuntimeError("clip has fewer than 2 frames")
    idx = sorted(set(int(round(i)) for i in np.linspace(0, n - 1, n_samples)))
    out = []
    for i in idx:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, f = cap.read()
        if not ok:
            continue
        h, w = f.shape[:2]
        if w > width:
            f = cv2.resize(f, (width, int(round(h * width / w))), interpolation=cv2.INTER_AREA)
        out.append(f)
    cap.release()
    if len(out) < 2:
        raise RuntimeError("could not decode clip frames")
    return out, n


def gray(f):
    return cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)


def ssim(a, b):
    """Gaussian-window SSIM on float gray images (skimage-equivalent, no dependency)."""
    a = a.astype(np.float32); b = b.astype(np.float32)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a = cv2.GaussianBlur(a, (11, 11), 1.5); mu_b = cv2.GaussianBlur(b, (11, 11), 1.5)
    s_aa = cv2.GaussianBlur(a * a, (11, 11), 1.5) - mu_a * mu_a
    s_bb = cv2.GaussianBlur(b * b, (11, 11), 1.5) - mu_b * mu_b
    s_ab = cv2.GaussianBlur(a * b, (11, 11), 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + C1) * (2 * s_ab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (s_aa + s_bb + C2))
    return float(m.mean())


def dense_flow(g0, g1):
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    return dis.calc(g0, g1, None)


def flow_affine_scale(flow):
    h, w = flow.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    src = np.stack([xs.ravel(), ys.ravel()], 1)
    dst = src + flow.reshape(-1, 2)
    sel = np.random.RandomState(0).choice(len(src), min(20000, len(src)), replace=False)
    M, _ = cv2.estimateAffinePartial2D(src[sel], dst[sel], method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if M is None:
        return None
    return float(np.sqrt(M[0, 0] ** 2 + M[0, 1] ** 2))


def orb_scale(g0, g1):
    orb = cv2.ORB_create(3000)
    k0, d0 = orb.detectAndCompute(g0, None); k1, d1 = orb.detectAndCompute(g1, None)
    if d0 is None or d1 is None or len(k0) < 20 or len(k1) < 20:
        return None, 0
    m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d0, d1)
    m = sorted(m, key=lambda x: x.distance)[:600]
    if len(m) < 12:
        return None, len(m)
    p0 = np.float32([k0[x.queryIdx].pt for x in m]); p1 = np.float32([k1[x.trainIdx].pt for x in m])
    M, inl = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None:
        return None, 0
    return float(np.sqrt(M[0, 0] ** 2 + M[0, 1] ** 2)), int(inl.sum())


def line_persistence(g0, g_last_warped, min_len=40):
    try:
        lsd = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    except Exception:
        return None, 0
    l0 = lsd.detect(g0)[0]
    if l0 is None:
        return None, 0
    l0 = l0.reshape(-1, 4)
    L = np.hypot(l0[:, 2] - l0[:, 0], l0[:, 3] - l0[:, 1])
    l0 = l0[L >= min_len]
    if len(l0) == 0:
        return None, 0
    e1 = cv2.Canny(g_last_warped, 60, 140)
    e1 = cv2.dilate(e1, np.ones((3, 3), np.uint8))
    kept = 0
    for x1, y1, x2, y2 in l0:
        n = int(max(8, np.hypot(x2 - x1, y2 - y1) / 3))
        xs = np.clip(np.linspace(x1, x2, n), 0, e1.shape[1] - 1).astype(int)
        ys = np.clip(np.linspace(y1, y2, n), 0, e1.shape[0] - 1).astype(int)
        if (e1[ys, xs] > 0).mean() >= 0.6:
            kept += 1
    return round(100.0 * kept / len(l0), 1), int(len(l0))


def warp_back(img, flow):
    h, w = flow.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    return cv2.remap(img, xs + flow[..., 0], ys + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--frames", type=int, default=8)
    a = ap.parse_args()
    try:
        frames, n = read_frames(a.clip, a.frames)
        g = [gray(f) for f in frames]
        g0, gl = g[0], g[-1]
        flow = dense_flow(g0, gl)
        travel = float(np.hypot(flow[..., 0], flow[..., 1]).mean())
        zf = flow_affine_scale(flow)
        zo, inl = orb_scale(g0, gl)
        # rigidity on lightly blurred frames: soft engines can't score rigid by being blurry
        b0 = cv2.GaussianBlur(g0, (0, 0), 1.2); bl = cv2.GaussianBlur(gl, (0, 0), 1.2)
        rigid = round(1.0 - ssim(b0, warp_back(bl, flow)), 3)
        lp, nl = line_persistence(g0, warp_back(gl, flow))
        lum = [float(x.mean()) for x in g]
        flicker = round(float(np.std(np.diff(lum))), 3)
        # scale zoom back to the shipped frame size is not needed: affine scale is dimensionless
        out = {"ok": True, "clip": a.clip, "frames_total": n, "sampled": len(frames),
               "zoom_flow": round(zf, 3) if zf else None, "zoom_orb": round(zo, 3) if zo else None, "orb_inliers": inl,
               "zoom": round(zo if (zo and inl >= 40) else (zf or 1.0), 3),
               "travel_px": round(travel * (1080.0 / max(1, g0.shape[1])), 1),
               "rigid_last": rigid, "line_persist_pct": lp, "lines_f0": nl, "lum_flicker": flicker}
        emit(out); sys.exit(0)
    except Exception as e:
        emit({"ok": False, "error": str(e)}); sys.exit(3)


if __name__ == "__main__":
    main()
