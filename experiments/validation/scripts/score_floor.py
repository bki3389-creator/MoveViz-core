#!/usr/bin/env python3
"""평면(외곽) 추출 정확도 채점기.

ARKitScenes엔 벽/문/창 벡터 GT가 없으므로, 메쉬 바닥점에서 '방 외곽(floor footprint)'을
자동으로 GT로 생성해 v4 boundary와 IoU로 비교한다.

GT 생성:
  - v4가 본 좌표계(GLB Y-up + v4 rotation)와 동일하게 메쉬를 맞춤
  - 바닥 슬랩(floor_y ~ +0.5m) 정점의 XZ 투영 → alpha-shape 대신 robust하게
    2D occupancy grid(5cm) → 최대 연결성분 → morphology close → 외곽 폴리곤
  - 이게 '실제 방이 차지하는 바닥 면적'의 근사 정답

지표:
  - Boundary IoU: v4 boundary 폴리곤 ∩ GT floor 폴리곤 / 합집합
  - Area ratio: v4면적 / GT면적 (1.0이 이상적; <1 과소, >1 과대)
주의: 자동 GT라 '벽 두께/스캔 구멍'에 영향받음 → 절대점수보다 v4↔v5 상대비교에 쓸 것.
기존 코드 불변. v4는 import만.
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
sys.path.insert(0, os.path.dirname(__file__))

import trimesh
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from scipy import ndimage
import score as S  # run_v4_furniture 재사용

GRID = 0.05  # 5cm

def floor_gt_polygon(sid, rotation_angle):
    """v4 좌표계에서 메쉬 바닥점 → 방 외곽 GT 폴리곤."""
    from glb_to_floorplan_v4 import load_glb, find_floor_ceiling
    mesh = load_glb(os.path.join(S.GLB, f"{sid}.glb"))
    if abs(rotation_angle) > 1e-4:
        mesh = mesh.copy()
        mesh.apply_transform(trimesh.transformations.rotation_matrix(rotation_angle, [0,1,0]))
    V = np.asarray(mesh.vertices)
    fy, cy = find_floor_ceiling(mesh)
    # 바닥 근처 + 전체 점 모두 사용(벽 포함 점유영역) — 방이 차지하는 평면영역
    band = (V[:,1] >= fy - 0.1) & (V[:,1] <= fy + 1.2)
    pts = V[band][:, [0,2]]
    if len(pts) < 50:
        pts = V[:, [0,2]]
    xmin, zmin = pts.min(0); xmax, zmax = pts.max(0)
    nx = max(2, int((xmax-xmin)/GRID)+1); nz = max(2, int((zmax-zmin)/GRID)+1)
    ix = np.clip(((pts[:,0]-xmin)/GRID).astype(int), 0, nx-1)
    iz = np.clip(((pts[:,1]-zmin)/GRID).astype(int), 0, nz-1)
    grid = np.zeros((nx, nz), bool)
    grid[ix, iz] = True
    # morphology: close(구멍 메움) → 최대 연결성분
    grid = ndimage.binary_closing(grid, iterations=3)
    grid = ndimage.binary_fill_holes(grid)
    lab, n = ndimage.label(grid)
    if n == 0:
        return None
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n+1))
    big = (np.argmax(sizes)+1)
    grid = (lab == big)
    # 외곽 폴리곤: marching-squares 컨투어 (셀 단위 union보다 빠르고 안정적)
    from skimage import measure
    # grid 외곽에 패딩 1칸(컨투어 닫힘 보장)
    padded = np.pad(grid.astype(float), 1)
    contours = measure.find_contours(padded, 0.5)
    if not contours:
        return None
    # 가장 긴 컨투어 = 외곽
    c = max(contours, key=len)
    # (row=x_idx, col=z_idx) → 실좌표. 패딩 1 보정.
    xs = xmin + (c[:,0]-1) * GRID
    zs = zmin + (c[:,1]-1) * GRID
    poly = Polygon(np.column_stack([xs, zs]))
    if not poly.is_valid:
        poly = poly.buffer(0)
        if isinstance(poly, MultiPolygon):
            poly = max(poly.geoms, key=lambda p:p.area)
    return poly.simplify(0.05)

def v4_boundary_polygon(boundary):
    if not boundary or len(boundary) < 3:
        return None
    p = Polygon(boundary)
    if not p.is_valid:
        p = p.buffer(0)
    return p if p.area > 0.5 else None

def main():
    scenes = sorted(d for d in os.listdir(S.DATA)
                    if os.path.isdir(os.path.join(S.DATA,d))
                    and os.path.exists(os.path.join(S.GLB, f"{d}.glb")))
    rows = []
    for i, sid in enumerate(scenes, 1):
        try:
            rot, furn, boundary = S.run_v4_furniture(sid)
            gt = floor_gt_polygon(sid, rot)
            pred = v4_boundary_polygon(boundary)
            if gt is None or pred is None:
                rows.append({"id":sid, "error":"no polygon"});
                print(f"[{i}/{len(scenes)}] {sid}: no polygon"); continue
            inter = gt.intersection(pred).area
            uni = gt.union(pred).area
            iou = inter/uni if uni>0 else 0
            aratio = pred.area/gt.area if gt.area>0 else 0
            rows.append({"id":sid, "iou":round(iou,3),
                         "area_ratio":round(aratio,3),
                         "gt_area":round(gt.area,1), "pred_area":round(pred.area,1)})
            print(f"[{i}/{len(scenes)}] {sid}: IoU={iou:.3f} area_ratio={aratio:.2f} "
                  f"(GT={gt.area:.1f} pred={pred.area:.1f}㎡)")
        except Exception as e:
            rows.append({"id":sid, "error":str(e)})
            print(f"[{i}/{len(scenes)}] {sid}: ERROR {e}")
    ok=[r for r in rows if 'error' not in r]
    import statistics as st
    summary={"scenes":len(ok),"errors":len(rows)-len(ok),
             "mean_boundary_iou": round(st.mean([r['iou'] for r in ok]),3) if ok else 0,
             "median_boundary_iou": round(st.median([r['iou'] for r in ok]),3) if ok else 0,
             "mean_area_ratio": round(st.mean([r['area_ratio'] for r in ok]),3) if ok else 0}
    json.dump({"summary":summary,"per_scene":rows},
              open(os.path.join(S.RES,"score_floor.json"),"w"),ensure_ascii=False,indent=2)
    print("\n=== v4 평면(외곽) 베이스라인 ===")
    for k,v in summary.items(): print(f"  {k}: {v}")
    print("저장: results/score_floor.json")

if __name__=="__main__":
    main()
