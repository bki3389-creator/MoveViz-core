#!/usr/bin/env python3
"""평면 v5 keep_frac 파라미터 스윕 (dev셋).
무거운 v4 파이프라인+GT를 씬당 1회만 계산해 캐시 → keep_frac만 바꿔 빠르게 비교."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S, score_floor as SF
import trimesh, statistics as st
from glb_to_floorplan_v4 import (load_glb, find_floor_ceiling, extract_slices,
    consensus_walls, build_boundary, estimate_rotation_angle)
import glb_floor_v5 as G

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
dev=json.load(open(f"{BASE}/splits.json"))['dev']

# 씬별 1회 계산: mesh(회전적용), fy,cy, b4, GT polygon
cache=[]
for sid in dev:
    try:
        mesh=load_glb(os.path.join(S.GLB,f"{sid}.glb"))
        rot=estimate_rotation_angle(mesh)
        if abs(rot)>1e-4:
            mesh=mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
        fy,cy=find_floor_ceiling(mesh)
        sl=extract_slices(mesh,fy,cy,step=0.2)
        xw,zw,xh,xe,zh,ze=consensus_walls(sl,snap=0.06)
        all_w=[p for s in sl for p in s['w']]
        b4=build_boundary(xw,zw,all_w,min_wall_len=0.4)
        gt=SF.floor_gt_polygon(sid,rot)
        cache.append((sid,mesh,fy,cy,b4,gt))
    except Exception as e:
        print(f"{sid}: cache ERR {e}")
print(f"캐시 {len(cache)}씬\n")

def eval_kf(kf):
    ious=[]; ratios=[]; worse=0
    for sid,mesh,fy,cy,b4,gt in cache:
        if gt is None: continue
        p4=SF.v4_boundary_polygon(b4)
        i4=gt.intersection(p4).area/gt.union(p4).area if p4 else 0
        b5=G.tighten_boundary(mesh,fy,cy,b4,min_keep_frac=kf)
        p5=SF.v4_boundary_polygon(b5)
        i5=gt.intersection(p5).area/gt.union(p5).area if p5 else i4
        r5=p5.area/gt.area if (p5 and gt.area>0) else 0
        ious.append(i5); ratios.append(r5)
        if i5 < i4-0.01: worse+=1
    return round(st.mean(ious),4), round(st.mean(ratios),3), worse

# v4 baseline
b4i=[]
for sid,mesh,fy,cy,b4,gt in cache:
    if gt is None: continue
    p4=SF.v4_boundary_polygon(b4)
    b4i.append(gt.intersection(p4).area/gt.union(p4).area if p4 else 0)
print(f"v4 baseline IoU={st.mean(b4i):.4f}\n")
print("keep_frac | meanIoU | meanRatio | 악화씬수")
best=None
for kf in [0.40,0.45,0.50,0.55,0.60,0.65]:
    iou,ratio,worse=eval_kf(kf)
    print(f"  {kf:.2f}    |  {iou:.4f} |   {ratio:.2f}    |  {worse}")
    score=iou - 0.02*worse  # 악화 페널티
    if best is None or score>best[1]: best=(kf,score,iou,ratio,worse)
print(f"\n최적 keep_frac={best[0]} (IoU={best[2]}, ratio={best[3]}, 악화{best[4]})")
json.dump({"best_keep_frac":best[0],"iou":best[2],"ratio":best[3],"worse":best[4],
           "v4_iou":round(st.mean(b4i),4)},
          open(f"{BASE}/results/floor_sweep.json","w"),indent=2)
