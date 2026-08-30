#!/usr/bin/env python3
"""벽선·코너 정확도 채점 (수동 라벨 wall_labels.json 기준).

정답: 사람이 라벨한 방 폴리곤(벽선·코너), v4 출력 좌표계(=라벨 도구가 px2world로 저장한 그 좌표계).
예측: v4 boundary / v5 tighten_boundary 의 외곽 폴리곤.

지표 (RoomFormer 관례 차용, 단위는 meter):
  - Corner F1: 예측 코너 ↔ GT 코너 매칭(임계 0.2m). precision/recall/F1
  - Edge(벽선) IoU: 방 폴리곤 면적 IoU (외곽 일치도)
라벨 없는 씬은 건너뜀 → 라벨한 만큼만 채점.
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S, score_floor as SF
import trimesh
from shapely.geometry import Polygon
from shapely.ops import unary_union

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CORNER_THRESH=0.20  # m

def get_pred_boundaries(sid):
    """v4 boundary, v5 tightened boundary 반환."""
    from glb_to_floorplan_v4 import (load_glb, find_floor_ceiling, extract_slices,
        consensus_walls, build_boundary, estimate_rotation_angle)
    from glb_floor_v5 import tighten_boundary
    mesh=load_glb(os.path.join(S.GLB,f"{sid}.glb"))
    rot=estimate_rotation_angle(mesh)
    if abs(rot)>1e-4:
        mesh=mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
    fy,cy=find_floor_ceiling(mesh)
    sl=extract_slices(mesh,fy,cy,step=0.2)
    xw,zw,xh,xe,zh,ze=consensus_walls(sl,snap=0.06)
    all_w=[p for s in sl for p in s['w']]
    b4=build_boundary(xw,zw,all_w,min_wall_len=0.4)
    b5=tighten_boundary(mesh,fy,cy,b4)
    return b4,b5

def gt_union_polygon(rooms):
    """라벨한 방 폴리곤들의 합집합 + 코너 점 집합."""
    polys=[]; corners=[]
    for r in rooms:
        if len(r)<3: continue
        p=Polygon(r)
        if not p.is_valid: p=p.buffer(0)
        if p.area>0.1: polys.append(p)
        corners.extend(r)
    if not polys: return None, []
    return unary_union(polys), corners

def poly_corners(poly):
    if poly is None: return []
    geoms=[poly] if poly.geom_type=='Polygon' else list(poly.geoms)
    cs=[]
    for g in geoms:
        cs.extend(list(g.exterior.coords)[:-1])
    return cs

def corner_f1(gt_corners, pred_corners, thr=CORNER_THRESH):
    if not gt_corners or not pred_corners: return 0,0,0
    G=np.array(gt_corners); P=np.array(pred_corners)
    matched_g=set(); tp=0
    for pi,p in enumerate(P):
        d=np.hypot(G[:,0]-p[0],G[:,1]-p[1])
        j=int(np.argmin(d))
        if d[j]<=thr and j not in matched_g:
            matched_g.add(j); tp+=1
    prec=tp/len(P); rec=tp/len(G)
    f1=2*prec*rec/(prec+rec) if (prec+rec)>0 else 0
    return round(prec,3),round(rec,3),round(f1,3)

def iou(a,b):
    if a is None or b is None: return 0
    if not a.intersects(b): return 0
    return a.intersection(b).area/a.union(b).area

def main():
    lab_path=os.path.join(BASE,"wall_labels.json")
    if not os.path.exists(lab_path):
        print("⚠️ wall_labels.json 없음. 라벨링 도구로 몇 씬 저장 후 다시 실행."); return
    labels=json.load(open(lab_path))
    splits=json.load(open(f"{BASE}/splits.json"))
    rows=[]
    for sid,rooms in labels.items():
        try:
            gtpoly,gtc=gt_union_polygon(rooms)
            if gtpoly is None: continue
            b4,b5=get_pred_boundaries(sid)
            p4=SF.v4_boundary_polygon(b4); p5=SF.v4_boundary_polygon(b5)
            split='dev' if sid in splits['dev'] else 'test'
            r={"id":sid,"split":split,
               "iou_v4":round(iou(gtpoly,p4),3),"iou_v5":round(iou(gtpoly,p5),3),
               "corner_v4":corner_f1(gtc, poly_corners(p4)),
               "corner_v5":corner_f1(gtc, poly_corners(p5))}
            rows.append(r)
            print(f"{sid}({split}): IoU {r['iou_v4']}→{r['iou_v5']} | cornerF1 {r['corner_v4'][2]}→{r['corner_v5'][2]}")
        except Exception as e:
            print(f"{sid}: ERR {e}")
    if not rows: print("채점할 라벨 없음"); return
    import statistics as st
    def avg(k): return round(st.mean([r[k] for r in rows]),3)
    def avgc(k): return round(st.mean([r[k][2] for r in rows]),3)
    print(f"\n=== 벽선·코너 정확도 ({len(rows)}씬 라벨) ===")
    print(f"  외곽 IoU:   v4={avg('iou_v4')}  v5={avg('iou_v5')}")
    print(f"  Corner F1:  v4={avgc('corner_v4')}  v5={avgc('corner_v5')}")
    json.dump({"n":len(rows),"rows":rows},open(f"{BASE}/results/score_walls.json","w"),indent=2,ensure_ascii=False)
    print("저장: results/score_walls.json")

if __name__=="__main__":
    main()
