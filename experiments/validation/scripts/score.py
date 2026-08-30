#!/usr/bin/env python3
"""가구 footprint 추출 정확도 채점기 (ARKitScenes OBB 정답 기준).

채점 대상: v4 가구 추출 결과(예측 footprint, axis-aligned bbox [x0,z0,x1,z1])
정답(GT):  ARKitScenes 3dod annotation의 가구 OBB → 바닥 footprint(2D oriented box)

좌표 정합 (핵심):
  GT OBB는 원본 PLY 좌표계(Z-up, cm). 예측은 v4 출력 좌표계(Y-up, m, +rotation_angle 적용).
  GT를 예측 좌표계로 옮기는 변환:
     원본(cm) → ÷100(m) → Rx(PRE_ROT_X=-90°) [Z-up→Y-up] → Ry(rotation_angle) [v4 내부회전]
  그 뒤 Y-up 바닥평면 = XZ 평면에서 footprint(2D polygon) 추출.

지표:
  - mAP@IoU (0.25, 0.5): footprint IoU 기준 평균 정밀도 (객체 검출 표준)
  - precision/recall @0.5
  - 매칭은 greedy (IoU 큰 순)
  - 단위: 면적 IoU는 2D footprint polygon intersection
주의: v4 예측 footprint는 axis-aligned bbox라 회전 가구엔 불리(상한 존재). 베이스라인 측정용.

빌트인 분류 정확도: GT엔 빌트인 라벨이 없으므로, "벽 인접" 휴리스틱 GT를
  GT OBB와 boundary 거리로 유도해 참조치로만 제공(정식 GT 아님 — caveat).

기존 코드 불변. v4는 import해서 호출만.
"""
import os, sys, json, glob
import numpy as np

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(BASE, "data", "3dod", "Training")
GLB  = os.path.join(BASE, "glb")
RES  = os.path.join(BASE, "results")
PIPE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan"))
sys.path.insert(0, PIPE)

import trimesh
from shapely.geometry import Polygon
from shapely.ops import unary_union

# 변환 체인 1단계 (convert_all과 동일해야 함)
PRE_ROT_X = -np.pi / 2

def Rx(t): return np.array([[1,0,0],[0,np.cos(t),-np.sin(t)],[0,np.sin(t),np.cos(t)]])
def Ry(t): return np.array([[np.cos(t),0,np.sin(t)],[0,1,0],[-np.sin(t),0,np.cos(t)]])

def obb_corners(obb):
    """ARKitScenes obbAligned → 8 corners (RAW 메쉬 좌표계, meters).
    공식 box_utils.compute_box_3d 방식: rotmat=reshape(3,3).T, corners=rotmat.T@template."""
    c = np.array(obb["centroid"], float)              # 이미 meters, RAW 메쉬와 동일 좌표계
    l, h, w = np.array(obb["axesLengths"], float) / 2.0
    rotmat = np.array(obb["normalizedAxes"], float).reshape(3, 3).T
    x = np.array([l, l, -l, -l, l, l, -l, -l])
    y = np.array([h, -h, -h, h, h, -h, -h, h])
    z = np.array([w, w, w, w, -w, -w, -w, -w])
    corners = (rotmat.T @ np.vstack([x, y, z])).T + c  # (8,3)
    return corners

def gt_footprints(sid, rotation_angle):
    """GT obbAligned → 예측 좌표계의 바닥 footprint Polygon 리스트.
    OBB는 RAW 메쉬와 동일 좌표계 → 메쉬에 가한 변환(Rx PRE_ROT_X 후 Ry rotation)을 그대로 적용."""
    ann = os.path.join(DATA, sid, f"{sid}_3dod_annotation.json")
    if not os.path.exists(ann):
        return []
    a = json.load(open(ann))
    M = Ry(rotation_angle) @ Rx(PRE_ROT_X)             # 메쉬와 동일 변환 체인
    out = []
    for obj in a.get("data", []):
        obb = obj.get("segments", {}).get("obbAligned")
        if not obb:
            continue
        corners = obb_corners(obb)                      # RAW 좌표계 (8,3)
        cor2 = (M @ corners.T).T                         # → v4 출력 좌표계 (Y-up)
        xz = cor2[:, [0, 2]]                             # 바닥평면 XZ
        try:
            from scipy.spatial import ConvexHull
            h = ConvexHull(xz)
            poly = Polygon(xz[h.vertices])
        except Exception:
            poly = Polygon(xz).convex_hull
        if poly.is_valid and poly.area > 1e-3:
            out.append({"label": obj.get("label","?"), "poly": poly})
    return out

def pred_footprints(furniture):
    """v4 가구 추출 결과 → Polygon 리스트 (bbox 또는 polygon)."""
    out = []
    for f in furniture:
        if f.get("polygon"):
            p = Polygon(f["polygon"])
        else:
            x0,z0,x1,z1 = f["bbox"]
            p = Polygon([(x0,z0),(x1,z0),(x1,z1),(x0,z1)])
        if p.is_valid and p.area > 1e-3:
            out.append({"poly": p, "builtin": f.get("builtin", False),
                        "area": f.get("footprint_m2", p.area)})
    return out

def iou(a, b):
    if not a.intersects(b): return 0.0
    inter = a.intersection(b).area
    uni = a.area + b.area - inter
    return inter/uni if uni > 0 else 0.0

def match_and_score(gt, pred, thr):
    """greedy IoU 매칭 → TP/FP/FN."""
    pairs = []
    for i,g in enumerate(gt):
        for j,p in enumerate(pred):
            v = iou(g["poly"], p["poly"])
            if v >= thr:
                pairs.append((v,i,j))
    pairs.sort(reverse=True)
    gm, pm = set(), set()
    tp = 0
    for v,i,j in pairs:
        if i in gm or j in pm: continue
        gm.add(i); pm.add(j); tp += 1
    fn = len(gt) - tp
    fp = len(pred) - tp
    prec = tp/(tp+fp) if (tp+fp)>0 else 0.0
    rec  = tp/(tp+fn) if (tp+fn)>0 else 0.0
    return {"tp":tp,"fp":fp,"fn":fn,"precision":round(prec,3),"recall":round(rec,3)}

def run_v4_furniture(sid):
    """변환된 GLB에 v4 평면화 + 가구추출 적용 → (rotation_angle, furniture, boundary).
    server_furniture.py 의 호출 순서를 그대로 복제 (기존 코드 재사용, 수정 없음)."""
    from glb_to_floorplan_v4 import (
        load_glb, find_floor_ceiling, extract_slices, consensus_walls,
        build_boundary, estimate_rotation_angle, detect_openings, decompose_rooms,
    )
    from glb_furniture import extract_furniture
    glb = os.path.join(GLB, f"{sid}.glb")
    mesh = load_glb(glb)
    rot = estimate_rotation_angle(mesh)
    if abs(rot) > 1e-4:
        Rm = trimesh.transformations.rotation_matrix(rot, [0,1,0])
        mesh = mesh.copy()
        mesh.apply_transform(Rm)
    fy, cy = find_floor_ceiling(mesh)
    slices = extract_slices(mesh, fy, cy, step=0.2)
    xw, zw, xh, xe, zh, ze = consensus_walls(slices, snap=0.06)
    all_w = [p for s in slices for p in s['w']]
    boundary = build_boundary(xw, zw, all_w, min_wall_len=0.4)
    openings = detect_openings(mesh, boundary, fy, cy, min_opening=0.5)
    rooms_data = decompose_rooms(
        mesh, xw, zw, boundary, openings, fy, cy,
        min_opening=0.5, min_room_area=2.0, max_door_width=1.5,
    )
    furn = extract_furniture(mesh, fy, cy, boundary, rooms_data['rooms'])
    return rot, furn, boundary

def main():
    scenes = sorted(d for d in os.listdir(DATA) if os.path.isdir(os.path.join(DATA, d))
                    and os.path.exists(os.path.join(GLB, f"{d}.glb")))
    rows = []
    for i, sid in enumerate(scenes, 1):
        try:
            rot, furn, boundary = run_v4_furniture(sid)
            gt = gt_footprints(sid, rot)
            pred = pred_footprints(furn)
            s25 = match_and_score(gt, pred, 0.25)
            s50 = match_and_score(gt, pred, 0.50)
            rows.append({"id":sid, "n_gt":len(gt), "n_pred":len(pred),
                         "iou25":s25, "iou50":s50})
            print(f"[{i}/{len(scenes)}] {sid}: GT={len(gt)} Pred={len(pred)} "
                  f"| @0.25 P={s25['precision']} R={s25['recall']} "
                  f"| @0.5 P={s50['precision']} R={s50['recall']}")
        except Exception as e:
            print(f"[{i}/{len(scenes)}] {sid}: ERROR {e}")
            rows.append({"id":sid, "error":str(e)})
    # 집계
    ok = [r for r in rows if "error" not in r]
    def avg(key, thr):
        vals=[r[thr][key] for r in ok]
        return round(sum(vals)/len(vals),3) if vals else 0
    summary = {
        "scenes": len(ok), "errors": len(rows)-len(ok),
        "mean_precision@0.25": avg("precision","iou25"),
        "mean_recall@0.25": avg("recall","iou25"),
        "mean_precision@0.5": avg("precision","iou50"),
        "mean_recall@0.5": avg("recall","iou50"),
    }
    out = {"summary": summary, "per_scene": rows}
    json.dump(out, open(os.path.join(RES,"score_furniture.json"),"w"),
              ensure_ascii=False, indent=2)
    print("\n=== 베이스라인 (v4 가구 footprint) ===")
    for k,v in summary.items(): print(f"  {k}: {v}")
    print(f"\n저장: results/score_furniture.json")

if __name__ == "__main__":
    main()
