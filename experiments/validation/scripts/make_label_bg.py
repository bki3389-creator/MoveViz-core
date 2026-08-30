#!/usr/bin/env python3
"""라벨링용 탑다운 배경 생성.
각 씬을 v4 좌표계(GLB + v4 rotation 적용)로 맞춘 뒤, 벽 점밀도 탑다운 PNG 생성.
벽(수직면)은 진하게, 바닥/가구는 옅게 → 사람이 벽선을 따라 그리기 쉽게.
라벨 좌표↔실좌표 변환을 위한 메타(extent, 이미지크기)도 저장.
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S
import trimesh
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from glb_to_floorplan_v4 import load_glb, find_floor_ceiling, estimate_rotation_angle

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT=os.path.join(BASE,"label_bg"); os.makedirs(OUT, exist_ok=True)
IMG=900  # px

def make_bg(sid):
    mesh=load_glb(os.path.join(S.GLB,f"{sid}.glb"))
    rot=estimate_rotation_angle(mesh)
    if abs(rot)>1e-4:
        mesh=mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
    fn=mesh.face_normals; ct=mesh.triangles_center
    fy,cy=find_floor_ceiling(mesh)
    y=ct[:,1]
    # 벽 = 수직면(법선 수평), 허리높이 위주
    wall = (np.abs(fn[:,1])<0.3) & (y>fy+0.1) & (y<min(cy-0.1, fy+2.2))
    other= (~wall) & (y>fy+0.05) & (y<cy-0.05)
    W=ct[wall][:,[0,2]]; O=ct[other][:,[0,2]]
    allp=ct[(y>fy+0.05)&(y<cy-0.05)][:,[0,2]]
    if len(allp)<10: return None
    xmin,zmin=allp.min(0)-0.2; xmax,zmax=allp.max(0)+0.2
    fig,ax=plt.subplots(figsize=(IMG/100,IMG/100),dpi=100)
    ax.set_facecolor("#0c111c")
    if len(O): ax.scatter(O[:,0],O[:,1],s=0.4,c="#2a3550",alpha=0.4,linewidths=0)  # 가구/기타 옅게
    if len(W): ax.scatter(W[:,0],W[:,1],s=0.7,c="#ffd65a",alpha=0.55,linewidths=0)  # 벽 진하게
    ax.set_xlim(xmin,xmax); ax.set_ylim(zmin,zmax)
    ax.set_aspect("equal"); ax.axis("off")
    fig.subplots_adjust(left=0,right=1,top=1,bottom=0)
    png=os.path.join(OUT,f"{sid}.png")
    fig.savefig(png,dpi=100,facecolor="#0c111c"); plt.close(fig)
    # 픽셀↔실좌표 매핑 메타 (이미지는 좌상단원점, z축 뒤집힘 주의)
    return {"id":sid,"rotation":float(rot),
            "xmin":float(xmin),"xmax":float(xmax),"zmin":float(zmin),"zmax":float(zmax),
            "img":IMG, "png":f"label_bg/{sid}.png"}

def main():
    splits=json.load(open(f"{BASE}/splits.json"))
    ids=sorted(set(splits['dev']+splits['test']))
    meta={}
    for i,sid in enumerate(ids,1):
        try:
            m=make_bg(sid)
            if m: meta[sid]=m; print(f"[{i}/{len(ids)}] {sid}")
        except Exception as e:
            print(f"[{i}/{len(ids)}] {sid} ERR {e}")
    json.dump(meta,open(os.path.join(BASE,"label_meta.json"),"w"),indent=2)
    print(f"완료 {len(meta)}씬 → label_bg/, label_meta.json")

if __name__=="__main__":
    main()
