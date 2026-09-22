#!/usr/bin/env python3
"""
Vistalia — measured clip gate (v64.2). Numbers, not a vision-model opinion, for
the three customer faults on a GENERATED clip.

v64.2: the Sep-22 smoke test showed a single first→last dense flow cannot
follow Kling's 25-50% pushes (DIS flow saturates, reports zoom ≈ 1.00 and a
huge "residual" that is really uncompensated camera motion, not morph). The
flow is now CHAINED over ~8 sampled frames: each step is small enough to
track, the zoom is the product of the per-step affine scales, the residual is
measured per step (boil/morph shows up in every step; camera motion does not),
and the composed field warps the last frame back for straight-edge persistence.

  zoom            product of per-step affine scales of the chained flow (1.07 = 7% push);
                  zoom_orb is an independent sparse-feature cross-check
  travel_px       mean total displacement first→last at 1080 px width
  rigid_step      worst per-step 1−SSIM after warping the next frame back (blurred frames):
                  morph / boil / redraw
  rigid_total     1−SSIM(first, last warped back through the composed field)
  line_persist    % of frame-0 straight edges (LSD) still present after warping the last frame back
  lum_flicker     std of the per-step change in mean luma (gray levels)

Usage:  clip-gate.py --clip clip.mp4 [--frames 9]    → last stdout line is JSON
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


def ssim(a, b):
    a = a.astype(np.float32); b = b.astype(np.float32)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a = cv2.GaussianBlur(a, (11, 11), 1.5); mu_b = cv2.GaussianBlur(b, (11, 11), 1.5)
    s_aa = cv2.GaussianBlur(a * a, (11, 11), 1.5) - mu_a * mu_a
    s_bb = cv2.GaussianBlur(b * b, (11, 11), 1.5) - mu_b * mu_b
    s_ab = cv2.GaussianBlur(a * b, (11, 11), 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + C1) * (2 * s_ab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (s_aa + s_bb + C2))
    return float(m.mean())


_dis = None
def dense_flow(g0, g1):
    global _dis
    if _dis is None:
        _dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    return _dis.calc(g0, g1, None)


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


def warp_back(img, flow):
    """Sample img at p + flow(p): brings frame k+1 back onto frame k's grid."""
    h, w = flow.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    return cv2.remap(img, xs + flow[..., 0], ys + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)


def compose(acc, step):
    """acc: frame0→frame k field; step: frame k→k+1 field. Returns frame0→k+1."""
    h, w = acc.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    sx = cv2.remap(step[..., 0], xs + acc[..., 0], ys + acc[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    sy = cv2.remap(step[..., 1], xs + acc[..., 0], ys + acc[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    out = acc.copy()
    out[..., 0] += sx; out[..., 1] += sy
    return out


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
    e1 = cv2.dilate(cv2.Canny(g_last_warped, 60, 140), np.ones((3, 3), np.uint8))
    kept = 0
    for x1, y1, x2, y2 in l0:
        n = int(max(8, np.hypot(x2 - x1, y2 - y1) / 3))
        xs = np.clip(np.linspace(x1, x2, n), 0, e1.shape[1] - 1).astype(int)
        ys = np.clip(np.linspace(y1, y2, n), 0, e1.shape[0] - 1).astype(int)
        if (e1[ys, xs] > 0).mean() >= 0.6:
            kept += 1
    return round(100.0 * kept / len(l0), 1), int(len(l0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--frames", type=int, default=9)
    a = ap.parse_args()
    try:
        frames, n = read_frames(a.clip, a.frames)
        g = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]
        gb = [cv2.GaussianBlur(x, (0, 0), 1.2) for x in g]   # rigidity on lightly blurred frames
        acc = None
        scales, steps_rigid, lum = [], [], [float(g[0].mean())]
        for k in range(1, len(g)):
            f = dense_flow(g[k - 1], g[k])
            s = flow_affine_scale(f)
            if s is not None:
                scales.append(s)
            steps_rigid.append(1.0 - ssim(gb[k - 1], warp_back(gb[k], f)))
            lum.append(float(g[k].mean()))
            acc = f if acc is None else compose(acc, f)
        zoom_flow = float(np.prod(scales)) if scales else None
        zo, inl = orb_scale(g[0], g[-1])
        travel = float(np.hypot(acc[..., 0], acc[..., 1]).mean()) * (1080.0 / max(1, g[0].shape[1]))
        rigid_total = 1.0 - ssim(gb[0], warp_back(gb[-1], acc))
        lp, nl = line_persistence(g[0], warp_back(g[-1], acc))
        # zoom: chained flow is the primary (tracks big pushes step by step);
        # a well-supported ORB estimate that disagrees by >8% flags the flow
        # as unreliable, in which case the larger of the two is reported.
        zoom = zoom_flow if zoom_flow is not None else (zo or 1.0)
        flow_ok = True
        if zo is not None and inl >= 60 and zoom_flow is not None and abs(zo - zoom_flow) > 0.08:
            flow_ok = False
            zoom = max(zo, zoom_flow)
        out = {"ok": True, "clip": a.clip, "frames_total": n, "sampled": len(frames),
               "zoom": round(zoom, 3), "zoom_flow": round(zoom_flow, 3) if zoom_flow else None,
               "zoom_orb": round(zo, 3) if zo else None, "orb_inliers": inl, "flow_ok": flow_ok,
               "travel_px": round(travel, 1),
               "rigid_step": round(float(max(steps_rigid)), 3) if steps_rigid else None,
               "rigid_step_med": round(float(np.median(steps_rigid)), 3) if steps_rigid else None,
               "rigid_total": round(rigid_total, 3),
               "line_persist_pct": lp, "lines_f0": nl,
               "lum_flicker": round(float(np.std(np.diff(lum))), 3)}
        emit(out); sys.exit(0)
    except Exception as e:
        emit({"ok": False, "error": str(e)}); sys.exit(3)


if __name__ == "__main__":
    main()
