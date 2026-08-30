#!/usr/bin/env python3
"""GLB 가구 추출 (빌트인 포함).

바닥/천장/경계벽을 제거한 "잔여 메시"를 top-down occupancy로 클러스터링해
방 안의 가구 footprint 를 대략 추출한다. 벽에 붙어있으면 built-in 으로 표시.

좌표계: glb_to_floorplan_v4 와 동일한 (회전 정렬된) 백엔드 [x, z] 공간.
extract_furniture 에 넘기는 mesh / boundary / rooms 는 모두 같은 공간이어야 한다.
"""
import numpy as np
from scipy import ndimage


def _pt_in_poly(x, z, poly):
    """ray-casting. poly = [[x,z], ...] (열림/닫힘 무관)."""
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, zi = poly[i][0], poly[i][1]
        xj, zj = poly[j][0], poly[j][1]
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _pt_seg_dist(px, pz, ax, az, bx, bz):
    """점-선분 거리."""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    if L2 < 1e-12:
        return np.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return np.hypot(px - (ax + t * dx), pz - (az + t * dz))


def _bbox_to_boundary_dist(bbox, boundary):
    """가구 bbox 4꼭짓점에서 boundary 폴리라인까지의 최소 거리."""
    x0, z0, x1, z1 = bbox
    corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
    best = 1e9
    for (px, pz) in corners:
        for i in range(len(boundary) - 1):
            ax, az = boundary[i][0], boundary[i][1]
            bx, bz = boundary[i + 1][0], boundary[i + 1][1]
            d = _pt_seg_dist(px, pz, ax, az, bx, bz)
            if d < best:
                best = d
    return best


def extract_furniture(mesh, floor_y, ceil_y, boundary, rooms=None,
                      res=0.05, band_lo=0.06, band_hi=1.8,
                      min_area=0.08, min_height=0.10,
                      builtin_dist=0.18, close_iter=1, full_height_frac=0.75):
    """잔여 메시를 클러스터링해 가구 리스트 반환.

    각 항목: {id, bbox:[x0,z0,x1,z1], polygon, height_m, footprint_m2,
              builtin: bool, room_id}
    """
    if mesh is None or len(getattr(mesh, "faces", [])) == 0:
        return []
    fn = mesh.face_normals
    ct = mesh.triangles_center
    y = ct[:, 1]

    # 1) 비구조 면 = 바닥/천장(수평면) 제외 + 가구 높이 밴드
    horizontal = np.abs(fn[:, 1]) > 0.7
    near_floor = horizontal & (np.abs(y - floor_y) < 0.15)
    near_ceil = horizontal & (np.abs(y - ceil_y) < 0.15)
    top = min(ceil_y - 0.1, floor_y + band_hi)
    band = (y > floor_y + band_lo) & (y < top)
    cand = band & ~near_floor & ~near_ceil
    if int(cand.sum()) < 10:
        return []

    pts = ct[cand][:, [0, 2]]
    pys = y[cand]

    # 2) boundary 내부만 유지 (벽 밖 잡음 제거)
    if boundary and len(boundary) >= 4:
        keep = np.array([_pt_in_poly(p[0], p[1], boundary) for p in pts])
        if keep.sum() >= 10:
            pts, pys = pts[keep], pys[keep]

    # 3) top-down occupancy grid
    mn = pts.min(axis=0) - 0.1
    mx = pts.max(axis=0) + 0.1
    nx = max(1, int((mx[0] - mn[0]) / res) + 1)
    nz = max(1, int((mx[1] - mn[1]) / res) + 1)
    gx = np.clip(((pts[:, 0] - mn[0]) / res).astype(int), 0, nx - 1)
    gz = np.clip(((pts[:, 1] - mn[1]) / res).astype(int), 0, nz - 1)
    occ = np.zeros((nx, nz), dtype=np.int32)
    np.add.at(occ, (gx, gz), 1)
    # 셀별 최대 높이(바닥 기준) — 천장까지 닿는 컬럼(=벽/구조)을 제외하는 데 사용
    maxh = np.zeros((nx, nz), dtype=np.float32)
    np.maximum.at(maxh, (gx, gz), (pys - floor_y).astype(np.float32))

    room_h = max(0.5, ceil_y - floor_y)
    full_cut = min(room_h * full_height_frac, room_h - 0.30)  # 이보다 높으면 벽/구조로 간주
    furn_cells = (occ >= 2) & (maxh > min_height) & (maxh < full_cut)
    if close_iter > 0:
        furn_cells = ndimage.binary_closing(furn_cells, iterations=close_iter)

    labels, n = ndimage.label(furn_cells)
    if n == 0:
        return []

    furniture = []
    fid = 0
    for lab in range(1, n + 1):
        cells = np.argwhere(labels == lab)
        area = len(cells) * res * res
        if area < min_area:
            continue
        wx = mn[0] + (cells[:, 0] + 0.5) * res
        wz = mn[1] + (cells[:, 1] + 0.5) * res
        x0, x1 = float(wx.min() - res / 2), float(wx.max() + res / 2)
        z0, z1 = float(wz.min() - res / 2), float(wz.max() + res / 2)
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2

        h = float(maxh[cells[:, 0], cells[:, 1]].max())
        if h < min_height:
            continue

        builtin = _bbox_to_boundary_dist([x0, z0, x1, z1], boundary) <= builtin_dist if boundary else False

        rid = None
        if rooms:
            cand = [r for r in rooms if r.get("bbox")
                    and r["bbox"][0] - 0.1 <= cx <= r["bbox"][2] + 0.1
                    and r["bbox"][1] - 0.1 <= cz <= r["bbox"][3] + 0.1]
            inside = [r for r in cand if r.get("polygon") and _pt_in_poly(cx, cz, r["polygon"])]
            pick = inside or cand
            if pick:
                rid = min(pick, key=lambda r: r.get("area_m2", 1e9)).get("id")

        furniture.append({
            "id": fid,
            "bbox": [round(x0, 3), round(z0, 3), round(x1, 3), round(z1, 3)],
            "polygon": [[round(x0, 3), round(z0, 3)], [round(x1, 3), round(z0, 3)],
                        [round(x1, 3), round(z1, 3)], [round(x0, 3), round(z1, 3)]],
            "height_m": round(h, 2),
            "footprint_m2": round((x1 - x0) * (z1 - z0), 2),
            "builtin": bool(builtin),
            "room_id": rid,
        })
        fid += 1

    # 큰 것 우선 정렬
    furniture.sort(key=lambda f: -f["footprint_m2"])
    for i, f in enumerate(furniture):
        f["id"] = i
    return furniture
