#!/usr/bin/env python3
"""v4 vs v5 가구 footprint 비교 채점 (dev셋 전용 — test 봉인 유지).
score.py 의 GT/IoU 로직 재사용, 가구 추출만 v5로 교체."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S
import trimesh

def run_v5_furniture(sid):
    from glb_to_floorplan_v4 import (load_glb, find_floor_ceiling, extract_slices,
        consensus_walls, build_boundary, estimate_rotation_angle, detect_openings, decompose_rooms)
    from glb_furniture_v5 import extract_furniture_v5
    mesh = load_glb(os.path.join(S.GLB, f"{sid}.glb"))
    rot = estimate_rotation_angle(mesh)
    if abs(rot)>1e-4:
        mesh=mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
    fy,cy=find_floor_ceiling(mesh)
    slices=extract_slices(mesh,fy,cy,step=0.2)
    xw,zw,xh,xe,zh,ze=consensus_walls(slices,snap=0.06)
    all_w=[p for s in slices for p in s['w']]
    boundary=build_boundary(xw,zw,all_w,min_wall_len=0.4)
    openings=detect_openings(mesh,boundary,fy,cy,min_opening=0.5)
    rd=decompose_rooms(mesh,xw,zw,boundary,openings,fy,cy,min_opening=0.5,min_room_area=2.0,max_door_width=1.5)
    furn=extract_furniture_v5(mesh,fy,cy,boundary,rd['rooms'])
    return rot,furn,boundary

def score_set(ids, which):
    rows=[]
    for sid in ids:
        try:
            if which=="v4":
                rot,furn,bnd=S.run_v4_furniture(sid)
            else:
                rot,furn,bnd=run_v5_furniture(sid)
            gt=S.gt_footprints(sid,rot); pred=S.pred_footprints(furn)
            s25=S.match_and_score(gt,pred,0.25); s50=S.match_and_score(gt,pred,0.50)
            rows.append({"id":sid,"n_gt":len(gt),"n_pred":len(pred),"iou25":s25,"iou50":s50})
        except Exception as e:
            rows.append({"id":sid,"error":str(e)})
    ok=[r for r in rows if 'error' not in r]
    import statistics as st
    def m(key,thr):
        v=[r[thr][key] for r in ok]; return round(st.mean(v),3) if v else 0
    return {"n":len(ok),"P@.25":m("precision","iou25"),"R@.25":m("recall","iou25"),
            "P@.5":m("precision","iou50"),"R@.5":m("recall","iou50"),
            "tot_gt":sum(r['n_gt'] for r in ok),"tot_pred":sum(r['n_pred'] for r in ok)}, rows

if __name__=="__main__":
    BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    splits=json.load(open(f"{BASE}/splits.json"))
    dev=splits['dev']
    print(f"dev {len(dev)}씬에서 v4 vs v5 비교 (test 봉인)\n")
    v4s,_=score_set(dev,"v4"); print("v4:", v4s)
    v5s,v5rows=score_set(dev,"v5"); print("v5:", v5s)
    print(f"\n개선폭 R@.25: {v4s['R@.25']} → {v5s['R@.25']}  ({v5s['R@.25']-v4s['R@.25']:+.3f})")
    print(f"개선폭 P@.25: {v4s['P@.25']} → {v5s['P@.25']}  ({v5s['P@.25']-v4s['P@.25']:+.3f})")
    print(f"검출수: GT={v4s['tot_gt']} v4예측={v4s['tot_pred']} v5예측={v5s['tot_pred']}")
    json.dump({"dev_v4":v4s,"dev_v5":v5s},open(f"{BASE}/results/v4_vs_v5_dev.json","w"),indent=2,ensure_ascii=False)
