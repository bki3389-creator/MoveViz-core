#!/usr/bin/env python3
"""평면 외곽 v4 vs v5 비교 (dev셋 전용). score_floor.py 의 GT/IoU 재사용."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S
import score_floor as SF
import trimesh

def get_boundaries(sid):
    """한 씬에서 v4 boundary와 v5(tightened) boundary 둘 다 반환 + rotation."""
    from glb_to_floorplan_v4 import (load_glb, find_floor_ceiling, extract_slices,
        consensus_walls, build_boundary, estimate_rotation_angle)
    from glb_floor_v5 import tighten_boundary
    mesh = load_glb(os.path.join(S.GLB, f"{sid}.glb"))
    rot = estimate_rotation_angle(mesh)
    if abs(rot)>1e-4:
        mesh=mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
    fy,cy=find_floor_ceiling(mesh)
    slices=extract_slices(mesh,fy,cy,step=0.2)
    xw,zw,xh,xe,zh,ze=consensus_walls(slices,snap=0.06)
    all_w=[p for s in slices for p in s['w']]
    b4=build_boundary(xw,zw,all_w,min_wall_len=0.4)
    b5=tighten_boundary(mesh,fy,cy,b4)
    return rot, fy, cy, b4, b5, mesh

def score_one(sid):
    from shapely.geometry import Polygon
    rot,fy,cy,b4,b5,mesh = get_boundaries(sid)
    gt = SF.floor_gt_polygon(sid, rot)
    def iou_ratio(bnd):
        p = SF.v4_boundary_polygon(bnd)
        if gt is None or p is None: return None,None
        return gt.intersection(p).area/gt.union(p).area, p.area/gt.area
    i4,r4 = iou_ratio(b4); i5,r5 = iou_ratio(b5)
    return {"id":sid,"iou_v4":i4,"ratio_v4":r4,"iou_v5":i5,"ratio_v5":r5}

if __name__=="__main__":
    BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    dev=json.load(open(f"{BASE}/splits.json"))['dev']
    rows=[]
    for sid in dev:
        try:
            r=score_one(sid); rows.append(r)
            print(f"{sid}: IoU {r['iou_v4']:.3f}→{r['iou_v5']:.3f}  ratio {r['ratio_v4']:.2f}→{r['ratio_v5']:.2f}")
        except Exception as e:
            print(f"{sid}: ERR {e}"); rows.append({"id":sid,"error":str(e)})
    ok=[r for r in rows if 'error' not in r and r.get('iou_v4') is not None and r.get('iou_v5') is not None]
    import statistics as st
    s={"n":len(ok),
       "iou_v4":round(st.mean([r['iou_v4'] for r in ok]),3),
       "iou_v5":round(st.mean([r['iou_v5'] for r in ok]),3),
       "ratio_v4":round(st.mean([r['ratio_v4'] for r in ok]),3),
       "ratio_v5":round(st.mean([r['ratio_v5'] for r in ok]),3)}
    print(f"\n=== 평면 v4 vs v5 (dev {s['n']}씬) ===")
    print(f"  IoU:   {s['iou_v4']} → {s['iou_v5']}  ({s['iou_v5']-s['iou_v4']:+.3f})")
    print(f"  면적비: {s['ratio_v4']} → {s['ratio_v5']}  (1.0이 이상적)")
    json.dump({"summary":s,"per_scene":rows},open(f"{BASE}/results/floor_v4_vs_v5_dev.json","w"),indent=2,ensure_ascii=False)
