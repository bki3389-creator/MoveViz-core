#!/usr/bin/env python3
"""GT OBB footprint vs v4 예측 footprint 좌표 정합 디버그 오버레이.
4가지 GT 변환 가설을 한 장에 그려 어느 게 메쉬 바닥점밀도와 맞는지 눈으로 확인.
"""
import os, sys, json, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly
import score, trimesh

def Rx(t): return np.array([[1,0,0],[0,np.cos(t),-np.sin(t)],[0,np.sin(t),np.cos(t)]])
def Ry(t): return np.array([[np.cos(t),0,np.sin(t)],[0,1,0],[-np.sin(t),0,np.cos(t)]])

sid = sys.argv[1] if len(sys.argv)>1 else "41126700"
rot, furn, bnd = score.run_v4_furniture(sid)
bnd = np.array(bnd)

# 변환된 메쉬(=v4가 본 좌표계)의 바닥점
from glb_to_floorplan_v4 import load_glb, estimate_rotation_angle, find_floor_ceiling
mesh = load_glb(os.path.join(score.GLB, f"{sid}.glb"))
if abs(rot)>1e-4:
    mesh = mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
V = np.asarray(mesh.vertices)
fy,cy = find_floor_ceiling(mesh)
band = (V[:,1]>=fy+0.05)&(V[:,1]<=fy+0.5)  # 바닥 근처 슬랩
floorpts = V[band][:,[0,2]]

a = json.load(open(f"{score.DATA}/{sid}/{sid}_3dod_annotation.json"))
signs = np.array([[sx,sy,sz] for sx in(-1,1) for sy in(-1,1) for sz in(-1,1)])

def gt_xz(transform):
    polys=[]
    for o in a['data']:
        obb=o['segments'].get('obbAligned')
        if not obb: continue
        cor=score.obb_corners(obb)       # 공식 방식, RAW 좌표계
        cor2=(transform@cor.T).T
        polys.append((o['label'], cor2[:,[0,2]]))
    return polys

hyps = {
    "A: Ry(rot)·Rx(-90)": Ry(rot)@Rx(-np.pi/2),
    "B: Ry(rot) only": Ry(rot),
    "C: Ry(rot)·Rx(+90)": Ry(rot)@Rx(np.pi/2),
    "D: Ry(-rot) only": Ry(-rot),
}
fig,axes=plt.subplots(1,4,figsize=(20,5))
for ax,(name,T) in zip(axes,hyps.items()):
    if len(floorpts): ax.scatter(floorpts[:,0],floorpts[:,1],s=0.3,c='#bbb',alpha=0.3)
    # 예측(빨강)
    for f in furn:
        x0,z0,x1,z1=f['bbox']
        ax.add_patch(MplPoly([(x0,z0),(x1,z0),(x1,z1),(x0,z1)],closed=True,fill=False,edgecolor='red',lw=1.5))
    # GT(파랑)
    for lab,xz in gt_xz(T):
        try:
            from scipy.spatial import ConvexHull
            h=ConvexHull(xz); poly=xz[h.vertices]
        except: poly=xz
        ax.add_patch(MplPoly(poly,closed=True,fill=True,facecolor='blue',alpha=0.25,edgecolor='blue',lw=1))
    ax.set_title(name,fontsize=10); ax.set_aspect('equal')
    ax.set_xlim(floorpts[:,0].min()-1 if len(floorpts) else -5, floorpts[:,0].max()+1 if len(floorpts) else 5)
    ax.set_ylim(floorpts[:,1].min()-1 if len(floorpts) else -5, floorpts[:,1].max()+1 if len(floorpts) else 5)
fig.suptitle(f"{sid}  회색=메쉬바닥점  빨강=v4예측  파랑=GT(OBB)  | rot={np.degrees(rot):.1f}°",fontsize=12)
fig.tight_layout()
out=os.path.join(score.RES,f"align_debug_{sid}.png")
fig.savefig(out,dpi=85,bbox_inches='tight'); plt.close(fig)
print("저장:",out)
