#!/usr/bin/env python3
"""GLB 가구 추출 v5 (실험 — 기존 glb_furniture.py 보존).

v4(glb_furniture.py) 대비 개선 목표 (ARKitScenes 채점 진단 기반):
  - 과소검출 해소: 작은 가구(의자/TV/협탁)도 검출 (occ 임계·min_area 완화)
  - 붙은 가구 분리: distance-transform + watershed 로 한 덩어리를 개별 가구로 분할
  - footprint 정밀화: axis-aligned bbox → min-area rotated rect (회전 가구 대응)
v4 와 동일한 인터페이스: extract_furniture_v5(mesh, floor_y, ceil_y, boundary, rooms)
반환 항목 스키마는 v4와 동일(+ "obb" 회전사각형 추가).
"""
import numpy as np
from scipy import ndimage

# v4의 헬퍼 재사용 (기존 코드 import — 수정 안 함)
from glb_furniture import _pt_in_poly, _pt_seg_dist, _bbox_to_boundary_dist


def _wall_contact_sides(bbox, boundary, tol=0.18):
    """bbox의 4변 중 boundary(벽)에 tol 이내로 닿는 변의 개수.
    빌트인(코너장 등)은 보통 2면 이상 벽에 닿음. 소파(벽에 한 면만)는 1면."""
    if not boundary or len(boundary) < 2:
        return 0
    x0, z0, x1, z1 = bbox
    # 4변의 중점
    mids = [((x0+x1)/2, z0), ((x0+x1)/2, z1), (x0, (z0+z1)/2), (x1, (z0+z1)/2)]
    cnt = 0
    for (px, pz) in mids:
        best = 1e9
        for i in range(len(boundary)-1):
            ax, az = boundary[i][0], boundary[i][1]
            bx, bz = boundary[i+1][0], boundary[i+1][1]
            d = _pt_seg_dist(px, pz, ax, az, bx, bz)
            if d < best: best = d
        if best <= tol:
            cnt += 1
    return cnt


def _min_area_rect(points_xz):
    """2D 점들의 최소면적 회전사각형 4꼭짓점 반환 (rotating calipers 간이판: convex hull edge별 탐색)."""
    pts = np.asarray(points_xz, float)
    if len(pts) < 3:
        x0, z0 = pts.min(0); x1, z1 = pts.max(0)
        return np.array([[x0,z0],[x1,z0],[x1,z1],[x0,z1]]), (x1-x0)*(z1-z0)
    try:
        from scipy.spatial import ConvexHull
        hull = pts[ConvexHull(pts).vertices]
    except Exception:
        x0, z0 = pts.min(0); x1, z1 = pts.max(0)
        return np.array([[x0,z0],[x1,z0],[x1,z1],[x0,z1]]), (x1-x0)*(z1-z0)
    best_area = 1e18; best_rect = None
    n = len(hull)
    for i in range(n):
        edge = hull[(i+1) % n] - hull[i]
        L = np.hypot(*edge)
        if L < 1e-9: continue
        u = edge / L
        v = np.array([-u[1], u[0]])
        proj_u = hull @ u; proj_v = hull @ v
        du = proj_u.max() - proj_u.min(); dv = proj_v.max() - proj_v.min()
        area = du * dv
        if area < best_area:
            best_area = area
            umin, umax = proj_u.min(), proj_u.max()
            vmin, vmax = proj_v.min(), proj_v.max()
            corners = [umin*u+vmin*v, umax*u+vmin*v, umax*u+vmax*v, umin*u+vmax*v]
            best_rect = np.array(corners)
    return best_rect, best_area


def extract_furniture_v5(mesh, floor_y, ceil_y, boundary, rooms=None,
                         res=0.04, band_lo=0.05, band_hi=2.6,
                         min_area=0.04, min_height=0.08,
                         builtin_dist=0.18, full_height_frac=0.80,
                         split_min_dist=0.14, split_area=1.5,
                         noise_filter=True, nf_min_area=0.20, nf_max_aspect=5.0):
                         # ↑ dev 튜닝 최적값(sp0.14_nf0.2): P0.295/R0.451/F1 0.357 (r2)
    """v5: 완화된 임계 + watershed 분리 + 회전사각형 footprint.

    noise_filter(2라운드): ARKitScenes dev 분석 기반. 최종 가구 중
      footprint면적 < nf_min_area 또는 종횡비 > nf_max_aspect 인 것을 노이즈로 제거.
      (dev 검증: 진짜가구 98% 유지, 노이즈 22% 제거 → precision↑ recall 거의 유지)
      noise_filter=False 면 1라운드 동작 그대로(보존)."""
    if mesh is None or len(getattr(mesh, "faces", [])) == 0:
        return []
    fn = mesh.face_normals
    ct = mesh.triangles_center
    y = ct[:, 1]

    horizontal = np.abs(fn[:, 1]) > 0.7
    near_floor = horizontal & (np.abs(y - floor_y) < 0.12)
    near_ceil = horizontal & (np.abs(y - ceil_y) < 0.12)
    top = min(ceil_y - 0.08, floor_y + band_hi)
    band = (y > floor_y + band_lo) & (y < top)
    cand = band & ~near_floor & ~near_ceil
    if int(cand.sum()) < 10:
        return []

    pts = ct[cand][:, [0, 2]]
    pys = y[cand]

    if boundary and len(boundary) >= 4:
        keep = np.array([_pt_in_poly(p[0], p[1], boundary) for p in pts])
        if keep.sum() >= 10:
            pts, pys = pts[keep], pys[keep]

    mn = pts.min(axis=0) - 0.1
    mx = pts.max(axis=0) + 0.1
    nx = max(1, int((mx[0]-mn[0])/res)+1)
    nz = max(1, int((mx[1]-mn[1])/res)+1)
    gx = np.clip(((pts[:,0]-mn[0])/res).astype(int),0,nx-1)
    gz = np.clip(((pts[:,1]-mn[1])/res).astype(int),0,nz-1)
    occ = np.zeros((nx,nz),np.int32); np.add.at(occ,(gx,gz),1)

    # 셀별 '연속 컬럼 높이' 계산: 바닥부터 0.2m 빈으로 점유를 쌓고, 빈 구간(gap)이
    # VGAP 이상 비면 거기서 끊음 → 천장에 떠 있는 점(가구 위 허공+천장)을 높이에서 제외.
    HBIN = 0.2; VGAP = 1  # 0.2m*1 = 빈 칸 1개 이상 비면 단절
    h_rel = (pys - floor_y)
    nbin = max(2, int(np.ceil((ceil_y - floor_y) / HBIN)) + 1)
    bi = np.clip((h_rel / HBIN).astype(int), 0, nbin - 1)
    # (gx,gz,bin) 점유 여부
    colocc = np.zeros((nx, nz, nbin), bool)
    colocc[gx, gz, bi] = True
    # 각 셀: 바닥(bin0~)부터 연속 점유의 끝 bin → 높이
    maxh = np.zeros((nx, nz), np.float32)
    occ_any = colocc.any(axis=2)
    for ix, iz in np.argwhere(occ_any):
        col = colocc[ix, iz]
        top_bin = 0; gap = 0
        for b in range(nbin):
            if col[b]:
                top_bin = b; gap = 0
            else:
                gap += 1
                if gap >= VGAP and b > 0:
                    break
        maxh[ix, iz] = (top_bin + 1) * HBIN

    room_h = max(0.5, ceil_y - floor_y)
    full_cut = min(room_h*full_height_frac, room_h-0.25)
    # v5: occ>=1 (작은가구 살림) + 높이밴드
    furn_cells = (occ >= 1) & (maxh > min_height) & (maxh < full_cut)
    furn_cells = ndimage.binary_closing(furn_cells, iterations=1)
    # 작은 구멍만 메우고 과도한 팽창 방지
    furn_cells = ndimage.binary_opening(furn_cells, iterations=1)

    labels, n = ndimage.label(furn_cells)
    if n == 0:
        return []

    furniture = []
    for lab in range(1, n+1):
        comp = (labels == lab)
        area = int(comp.sum()) * res * res
        if area < min_area:
            continue
        # v5: 큰 덩어리만 watershed 분리 (split_area↑=과분할↓, split_min_dist↑=덜쪼갬)
        sub_masks = [comp]
        if area > split_area:
            dist = ndimage.distance_transform_edt(comp)
            # 로컬 최대 = 가구 중심 후보
            from scipy.ndimage import maximum_filter
            peaks = (dist == maximum_filter(dist, size=int(split_min_dist/res)*2+1)) & (dist > split_min_dist/res)
            mk, nm = ndimage.label(peaks)
            if nm >= 2:
                ws = _watershed(dist, mk, comp)
                sub_masks = [(ws == k) for k in range(1, nm+1) if (ws==k).sum()*res*res >= min_area]
                if not sub_masks:
                    sub_masks = [comp]

        for sm in sub_masks:
            cells = np.argwhere(sm)
            if len(cells)*res*res < min_area:
                continue
            wx = mn[0] + (cells[:,0]+0.5)*res
            wz = mn[1] + (cells[:,1]+0.5)*res
            pts_xz = np.column_stack([wx, wz])
            rect, rect_area = _min_area_rect(pts_xz)
            x0,x1 = float(wx.min()-res/2), float(wx.max()+res/2)
            z0,z1 = float(wz.min()-res/2), float(wz.max()+res/2)
            cx,cz = (x0+x1)/2,(z0+z1)/2
            # 높이: 셀별 최고점들의 95퍼센타일 (노이즈 1~2점에 안 휘둘림, 밴드상한 포화 방지)
            cell_h = maxh[cells[:,0], cells[:,1]]
            cell_h = cell_h[cell_h > 0]
            if len(cell_h) == 0:
                continue
            h = float(np.percentile(cell_h, 95))
            if h < min_height:
                continue
            # 빌트인 판정 개선: '벽 근처'만으로는 부족(소파도 벽에 붙임).
            # 진짜 빌트인 = 천장까지 닿거나(붙박이장) OR 키 크고 2면 이상 벽 접촉(코너장).
            # 낮거나 한 면만 벽에 붙은 가구(소파·침대·책상)는 자립.
            near_wall = (_bbox_to_boundary_dist([x0,z0,x1,z1], boundary) <= builtin_dist) if boundary else False
            sides = _wall_contact_sides([x0,z0,x1,z1], boundary) if boundary else 0
            tall = h >= room_h * 0.70           # 방 높이의 70% 이상 = 키 큰 수납장류
            builtin = bool(near_wall and (tall or sides >= 2))
            rid = None
            if rooms:
                cc=[r for r in rooms if r.get("bbox") and r["bbox"][0]-0.1<=cx<=r["bbox"][2]+0.1 and r["bbox"][1]-0.1<=cz<=r["bbox"][3]+0.1]
                ins=[r for r in cc if r.get("polygon") and _pt_in_poly(cx,cz,r["polygon"])]
                pk=ins or cc
                if pk: rid=min(pk,key=lambda r:r.get("area_m2",1e9)).get("id")
            furniture.append({
                "id":0, "bbox":[round(x0,3),round(z0,3),round(x1,3),round(z1,3)],
                "polygon":[[round(float(p[0]),3),round(float(p[1]),3)] for p in rect],  # 회전사각형
                "obb": [[round(float(p[0]),3),round(float(p[1]),3)] for p in rect],
                "height_m":round(h,2),
                "footprint_m2":round(float(rect_area),2),
                "builtin":bool(builtin), "room_id":rid,
            })

    # 2라운드 노이즈 필터: 작거나(면적) 가늘고긴(종횡비) 클러스터 = 노이즈로 간주해 제거
    if noise_filter:
        filtered = []
        for f in furniture:
            xs=[p[0] for p in f['polygon']]; zs=[p[1] for p in f['polygon']]
            bw=max(xs)-min(xs); bh=max(zs)-min(zs)
            long_=max(bw,bh,1e-3); short=max(min(bw,bh),1e-3)
            aspect=long_/short
            if f["footprint_m2"] < nf_min_area:
                continue
            if aspect > nf_max_aspect:
                continue
            filtered.append(f)
        furniture = filtered

    furniture.sort(key=lambda f:-f["footprint_m2"])
    for i,f in enumerate(furniture): f["id"]=i
    return furniture


def _watershed(dist, markers, mask):
    """간이 watershed: skimage 있으면 사용, 없으면 marker 최근접 할당."""
    try:
        from skimage.segmentation import watershed
        return watershed(-dist, markers, mask=mask)
    except Exception:
        # fallback: 각 셀을 가장 가까운 marker로
        from scipy.ndimage import distance_transform_edt
        idx = np.argwhere(markers > 0)
        if len(idx) == 0:
            return mask.astype(int)
        out = np.zeros_like(markers)
        cells = np.argwhere(mask)
        for (cx,cz) in cells:
            d = ((idx[:,0]-cx)**2 + (idx[:,1]-cz)**2)
            out[cx,cz] = markers[tuple(idx[np.argmin(d)])]
        return out
