#!/usr/bin/env python3
"""
extract_floorplan.py — MoveViz 점구름(PLY)에서 평면도(floor plan) 추출 [실험용]

ARKit 좌표계 가정: Y축이 위(up). 바닥 평면 = X-Z.

사용법:
    python extract_floorplan.py scan.ply
    python extract_floorplan.py scan.ply --out plan.png --res 0.03 --band 0.3 0.3

파이프라인:
  1) PLY 로드 (ascii / binary_little_endian)
  2) Y 히스토그램으로 바닥/천장 높이 추정
  3) 벽 후보 = 바닥~천장 사이 수평 슬라이스 → X-Z로 투영
  4) 방 회전각 추정(맨해튼 정렬) 후 점들을 축에 정렬
  5) 정렬된 점유 분포의 행/열 투영 피크 = 벽 선
  6) 방 치수 계산 + 평면도 PNG 렌더 + JSON 저장

알고리즘이 확정되면 이 로직을 Swift(ScanManager/PLYExporter 쪽)로 포팅하면 됩니다.
"""
import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ----------------------------- PLY 로더 -----------------------------
def load_ply(path):
    """ascii / binary_little_endian PLY → (xyz[N,3] float64, rgb[N,3] or None)."""
    raw = Path(path).read_bytes()
    hdr_end = raw.find(b"end_header")
    if hdr_end < 0:
        raise ValueError("PLY 헤더(end_header)를 찾을 수 없습니다.")
    header = raw[:hdr_end].decode("ascii", "replace").splitlines()
    body = raw[raw.find(b"\n", hdr_end) + 1:]

    fmt = "ascii"
    n_vertex = 0
    props = []  # (name, type) — vertex element 의 속성만
    in_vertex = False
    for line in header:
        t = line.split()
        if not t:
            continue
        if t[0] == "format":
            fmt = t[1]
        elif t[0] == "element":
            in_vertex = t[1] == "vertex"
            if in_vertex:
                n_vertex = int(t[2])
        elif t[0] == "property" and in_vertex:
            props.append((t[-1], t[1]))

    names = [p[0] for p in props]
    for c in ("x", "y", "z"):
        if c not in names:
            raise ValueError(f"PLY 에 '{c}' 속성이 없습니다.")
    ix, iy, iz = names.index("x"), names.index("y"), names.index("z")
    has_rgb = all(c in names for c in ("red", "green", "blue"))

    if fmt == "ascii":
        tok = body.split()
        ncol = len(props)
        arr = np.array(tok[: n_vertex * ncol], dtype=float).reshape(-1, ncol)
    else:  # binary_little_endian / big 은 little 만 지원
        typemap = {"float": "f", "float32": "f", "double": "d",
                   "uchar": "B", "uint8": "B", "char": "b", "int8": "b",
                   "short": "h", "ushort": "H", "int": "i", "uint": "I"}
        rowfmt = "<" + "".join(typemap[p[1]] for p in props)
        sz = struct.calcsize(rowfmt)
        rows = struct.iter_unpack(rowfmt, body[: sz * n_vertex])
        arr = np.array([list(r) for r in rows], dtype=float)

    xyz = arr[:, [ix, iy, iz]].astype(np.float64)
    rgb = None
    if has_rgb:
        rgb = arr[:, [names.index("red"), names.index("green"), names.index("blue")]]
    return xyz, rgb


# ----------------------------- 헬퍼 -----------------------------
def smooth(a, k=3):
    if k <= 1:
        return a
    ker = np.ones(k) / k
    return np.convolve(a, ker, mode="same")


def find_peaks_1d(arr, min_height_frac=0.25, min_sep=5):
    """1D 배열에서 두드러진 국소 최대(피크) 인덱스들을 반환."""
    arr = np.asarray(arr, float)
    if arr.size < 3 or arr.max() <= 0:
        return []
    thr = arr.max() * min_height_frac
    cand = [i for i in range(1, len(arr) - 1)
            if arr[i] >= thr and arr[i] >= arr[i - 1] and arr[i] >= arr[i + 1]]
    cand.sort(key=lambda i: -arr[i])  # 높은 피크 우선
    kept = []
    for c in cand:
        if all(abs(c - k) >= min_sep for k in kept):
            kept.append(c)
    return sorted(kept)


def estimate_floor_ceiling(y, bin_size=0.05):
    """Y 히스토그램에서 바닥/천장 높이 추정."""
    lo, hi = np.percentile(y, [0.5, 99.5])
    if hi - lo < 1e-3:
        return float(lo), float(hi)
    bins = max(10, int((hi - lo) / bin_size))
    hist, edges = np.histogram(y, bins=bins, range=(lo, hi))
    centers = (edges[:-1] + edges[1:]) / 2
    strong = np.where(hist >= hist.max() * 0.25)[0]
    if len(strong) == 0:
        return float(lo), float(hi)
    return float(centers[strong[0]]), float(centers[strong[-1]])


def estimate_rotation(P2, res=0.05, step=1.0):
    """벽 점들이 두 축에 가장 잘 정렬되는 회전각(deg, 0~90)을 탐색."""
    c = P2.mean(axis=0)
    Q = P2 - c

    def score(theta):
        r = np.radians(theta)
        ct, st = np.cos(r), np.sin(r)
        u = Q[:, 0] * ct - Q[:, 1] * st
        v = Q[:, 0] * st + Q[:, 1] * ct
        s = 0.0
        for w in (u, v):
            span = w.max() - w.min()
            if span < 1e-6:
                continue
            h, _ = np.histogram(w, bins=max(1, int(span / res) + 1))
            tot = h.sum()
            if tot:
                s += float((h.astype(float) ** 2).sum()) / (tot * tot)  # 집중도
        return s

    # 1° 거친 탐색 → 0.25° 미세 탐색
    coarse = max(np.arange(0, 90, step), key=score)
    fine = max(np.arange(coarse - step, coarse + step, 0.25), key=score)
    return float(fine % 90.0)


def rotate2d(P2, theta_deg):
    r = np.radians(theta_deg)
    ct, st = np.cos(r), np.sin(r)
    R = np.array([[ct, -st], [st, ct]])
    return P2 @ R.T


# ----------------------------- 메인 -----------------------------
def main():
    ap = argparse.ArgumentParser(description="PLY 점구름 → 평면도 추출 (실험용)")
    ap.add_argument("ply", help="입력 PLY 파일")
    ap.add_argument("--out", default=None, help="출력 PNG (기본: <ply>_plan.png)")
    ap.add_argument("--res", type=float, default=0.03, help="격자 해상도 m (기본 0.03)")
    ap.add_argument("--band", type=float, nargs=2, default=[0.3, 0.4],
                    metavar=("ABOVE_FLOOR", "BELOW_CEIL"),
                    help="벽 슬라이스 밴드: 바닥 위 / 천장 아래 여유 m")
    ap.add_argument("--no-align", action="store_true", help="맨해튼 회전 정렬 끄기")
    ap.add_argument("--peak-frac", type=float, default=0.20, help="벽 피크 임계 비율")
    args = ap.parse_args()

    xyz, _ = load_ply(args.ply)
    if len(xyz) == 0:
        sys.exit("점이 없습니다.")

    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    floor_y, ceil_y = estimate_floor_ceiling(y)
    height = ceil_y - floor_y

    # 벽 후보 슬라이스 (천장 추정이 빈약하면 바닥 위쪽만 사용)
    lo = floor_y + args.band[0]
    hi = ceil_y - args.band[1]
    if hi <= lo:
        hi = np.percentile(y, 95)
    wall_mask = (y > lo) & (y < hi)
    P2 = xyz[wall_mask][:, [0, 2]]  # (x, z)
    if len(P2) < 20:
        sys.exit("벽 후보 점이 너무 적습니다. --band 를 조정해 보세요.")

    # 맨해튼 정렬 (estimate_rotation 은 "+theta 회전 시 정렬"을 의미)
    theta = 0.0 if args.no_align else estimate_rotation(P2, res=max(0.05, args.res))
    center = P2.mean(axis=0)
    A = rotate2d(P2 - center, theta)  # 축 정렬된 벽 점
    disp_theta = theta if theta <= 45 else theta - 90  # 보기 쉬운 ±45° 표기

    # 행/열 투영 피크 → 벽 선
    mn, mx = A.min(axis=0), A.max(axis=0)
    nu = max(1, int((mx[0] - mn[0]) / args.res) + 1)
    nv = max(1, int((mx[1] - mn[1]) / args.res) + 1)
    hu, _ = np.histogram(A[:, 0], bins=nu, range=(mn[0], mx[0]))
    hv, _ = np.histogram(A[:, 1], bins=nv, range=(mn[1], mx[1]))
    hu, hv = smooth(hu, 3), smooth(hv, 3)
    min_sep = max(1, int(0.3 / args.res))
    pu = find_peaks_1d(hu, args.peak_frac, min_sep)
    pv = find_peaks_1d(hv, args.peak_frac, min_sep)
    wu = [mn[0] + (p + 0.5) * (mx[0] - mn[0]) / nu for p in pu]
    wv = [mn[1] + (p + 0.5) * (mx[1] - mn[1]) / nv for p in pv]

    width = mx[0] - mn[0]   # x (정렬 좌표)
    depth = mx[1] - mn[1]   # z (정렬 좌표)
    area = width * depth

    # ----------------------------- 리포트 -----------------------------
    print(f"  점 개수        : {len(xyz):,}  (벽 후보 {len(P2):,})")
    print(f"  바닥/천장 높이  : {floor_y:.2f} m  →  {ceil_y:.2f} m   (천장고 {height:.2f} m)")
    print(f"  회전 정렬각     : {disp_theta:.1f}°")
    print(f"  방 크기(외곽)   : {width:.2f} m × {depth:.2f} m   (면적 {area:.1f} m²)")
    print(f"  감지된 벽 선    : 세로 {len(wu)}개 · 가로 {len(wv)}개")

    # ----------------------------- 렌더 -----------------------------
    out = args.out or str(Path(args.ply).with_suffix("")) + "_plan.png"
    fig, ax = plt.subplots(figsize=(8, 8))
    H2, xe, ze = np.histogram2d(A[:, 0], A[:, 1], bins=[max(nu, 2), max(nv, 2)])
    ax.imshow(np.log1p(H2.T), origin="lower", cmap="bone_r",
              extent=[mn[0], mx[0], mn[1], mx[1]], aspect="equal", alpha=0.85)
    for u in wu:
        ax.axvline(u, color="#00b3b3", lw=1.5, alpha=0.9)
    for v in wv:
        ax.axhline(v, color="#00b3b3", lw=1.5, alpha=0.9)
    ax.add_patch(plt.Rectangle((mn[0], mn[1]), width, depth,
                               fill=False, edgecolor="#e23", lw=2.5))
    ax.set_title(f"MoveViz Floor Plan  —  {width:.2f} × {depth:.2f} m "
                 f"({area:.1f} m²),  ceil {height:.2f} m,  rot {disp_theta:.1f}°")
    ax.set_xlabel("X (m)"); ax.set_ylabel("Z (m)")
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    print(f"  ▶ 평면도 PNG    : {out}")

    # JSON (Swift 포팅 시 참고용)
    js = out.rsplit(".", 1)[0] + ".json"
    Path(js).write_text(json.dumps({
        "floor_y": floor_y, "ceiling_y": ceil_y, "height_m": height,
        "rotation_deg": disp_theta, "width_m": width, "depth_m": depth, "area_m2": area,
        "wall_lines_x": wu, "wall_lines_z": wv,
        "bbox_aligned": [list(mn), list(mx)],
    }, indent=2, ensure_ascii=False))
    print(f"  ▶ 결과 JSON     : {js}")


if __name__ == "__main__":
    main()
