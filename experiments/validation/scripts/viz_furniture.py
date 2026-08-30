#!/usr/bin/env python3
"""가구 추출 v4 vs v5 vs 정답(GT) 3패널 비교 이미지.
각 씬: [GT 정답박스] [v4 검출] [v5 검출] 을 메쉬 바닥점 위에 나란히.
눈으로 'v5가 더 많이/정확히 잡는다'를 확인."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S, score_v5 as SV
import trimesh
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly
from glb_to_floorplan_v4 import load_glb, find_floor_ceiling, estimate_rotation_angle

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT=os.path.join(BASE,"furniture_compare"); os.makedirs(OUT,exist_ok=True)

def floor_pts(sid,rot):
    mesh=load_glb(os.path.join(S.GLB,f"{sid}.glb"))
    if abs(rot)>1e-4:
        mesh=mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
    V=np.asarray(mesh.vertices); fy,cy=find_floor_ceiling(mesh)
    band=(V[:,1]>fy+0.05)&(V[:,1]<cy-0.05)
    return V[band][:,[0,2]]

def draw(ax, pts, polys, title, col, gt_polys=None):
    if len(pts): ax.scatter(pts[:,0],pts[:,1],s=0.3,c="#ccc",alpha=0.25,linewidths=0)
    # GT를 옅게 깔아 비교(검출 패널에서)
    if gt_polys:
        for g in gt_polys:
            xy=np.array(g.exterior.coords)
            ax.add_patch(MplPoly(xy,closed=True,fill=False,edgecolor="#16a34a",lw=1.2,linestyle="--",alpha=0.7))
    for p in polys:
        ax.add_patch(MplPoly(p,closed=True,fill=True,facecolor=col,alpha=0.35,edgecolor=col,lw=1.5))
    ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(title,fontsize=11)

def viz(sid):
    rot4,furn4,_=S.run_v4_furniture(sid)
    rot5,furn5,_=SV.run_v5_furniture(sid)
    gt=S.gt_footprints(sid,rot5)
    pts=floor_pts(sid,rot5)
    gt_polys=[g['poly'] for g in gt]
    p4=[f['polygon'] for f in furn4]
    p5=[f['polygon'] for f in furn5]
    fig,ax=plt.subplots(1,3,figsize=(16,5.4))
    draw(ax[0],pts,[list(np.array(g.exterior.coords)) for g in gt_polys],
         f"GT 정답: 가구 {len(gt_polys)}개","#16a34a")
    draw(ax[1],pts,p4,f"v4(기존): {len(p4)}개 검출","#dc2626",gt_polys)
    draw(ax[2],pts,p5,f"v5(개선): {len(p5)}개 검출","#2563eb",gt_polys)
    fig.suptitle(f"{sid}  |  초록점선=정답 윤곽  (가구 검출 비교)",fontsize=12)
    fig.tight_layout()
    png=os.path.join(OUT,f"{sid}.png"); fig.savefig(png,dpi=85,bbox_inches="tight"); plt.close(fig)
    return png, len(gt_polys), len(p4), len(p5)

if __name__=="__main__":
    # dev에서 가구 많은 대표 씬 몇 개 (시각 효과 큰 것)
    sids=sys.argv[1:] if len(sys.argv)>1 else None
    if not sids:
        # 가구 수 기준 상위 몇 개
        fr=json.load(open(f"{BASE}/results/score_furniture.json"))['per_scene']
        fr=[r for r in fr if 'error' not in r]
        fr.sort(key=lambda r:-r['n_gt'])
        sids=[r['id'] for r in fr[:6]]
    metas=[]
    for sid in sids:
        try:
            png,ng,n4,n5=viz(sid); metas.append({"id":sid,"gt":ng,"v4":n4,"v5":n5})
            print(f"{sid}: GT={ng} v4={n4} v5={n5} → {png}")
        except Exception as e:
            print(f"{sid}: ERR {e}")
    json.dump(metas,open(f"{BASE}/results/furniture_compare.json","w"),indent=2)
