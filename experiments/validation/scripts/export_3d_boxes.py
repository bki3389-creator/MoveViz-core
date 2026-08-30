#!/usr/bin/env python3
"""각 씬의 3D 가구 박스(정답 GT / v4 / v5)를 GLB와 같은 좌표계로 추출 → JSON.
3D 뷰어(Three.js)가 glb/<sid>.glb 와 함께 이 박스들을 오버레이한다.

좌표계 통일:
  - glb/<sid>.glb = 원본 PLY에 Rx(-90°)만 적용된 메쉬 (Y-up). 뷰어는 이걸 그대로 로드.
  - GT OBB = 원본 메쉬 좌표(obbAligned) → Rx(-90°) 적용하면 glb와 정합. (8코너 그대로 = 진짜 3D 박스)
  - v4/v5 검출 = v4 내부에서 추가 Ry(rot) 회전된 좌표 → Ry(-rot) 역회전하면 glb와 정합.
    검출은 2D footprint(+height)뿐이므로, 바닥~높이로 3D 박스 생성.
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S, score_v5 as SV
import trimesh
from glb_to_floorplan_v4 import load_glb, find_floor_ceiling, estimate_rotation_angle

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT=os.path.join(BASE,"boxes3d"); os.makedirs(OUT,exist_ok=True)

def Rx(t): return np.array([[1,0,0],[0,np.cos(t),-np.sin(t)],[0,np.sin(t),np.cos(t)]])
def Ry(t): return np.array([[np.cos(t),0,np.sin(t)],[0,1,0],[-np.sin(t),0,np.cos(t)]])

def gt_boxes_3d(sid):
    """정답 OBB → glb 좌표(Y-up)의 8코너 박스 리스트."""
    ann=os.path.join(S.DATA,sid,f"{sid}_3dod_annotation.json")
    if not os.path.exists(ann): return []
    a=json.load(open(ann))
    M=Rx(-np.pi/2)  # glb는 Rx(-90)만 적용됨
    out=[]
    for obj in a.get("data",[]):
        obb=obj.get("segments",{}).get("obbAligned")
        if not obb: continue
        c=np.array(obb["centroid"],float)
        l,h,w=np.array(obb["axesLengths"],float)/2
        R=np.array(obb["normalizedAxes"],float).reshape(3,3).T
        xs=np.array([l,l,-l,-l,l,l,-l,-l]); ys=np.array([h,-h,-h,h,h,-h,-h,h]); zs=np.array([w,w,w,w,-w,-w,-w,-w])
        corners=(R.T@np.vstack([xs,ys,zs])).T+c   # 원본 좌표 8코너
        corners=(M@corners.T).T                     # → glb 좌표
        out.append({"label":obj.get("label","?"),"corners":corners.round(3).tolist()})
    return out

def detection_boxes_3d(sid, furn, rot, fy, cy):
    """v4/v5 검출 footprint(2D, v4회전좌표) → Ry(-rot) 역회전 → glb 좌표 3D 박스."""
    Rinv=Ry(-rot)
    out=[]
    floor=fy; ceil=cy
    for f in furn:
        poly=f["polygon"]  # [[x,z],...] v4회전좌표
        h=f.get("height_m",1.0)
        top=floor+h
        pts=[]
        for (x,z) in poly:
            pts.append([x,floor,z]); pts.append([x,top,z])
        P=np.array(pts)
        P=(Rinv@P.T).T  # 역회전 → glb 좌표
        out.append({"footprint":[[round(x,3),round(z,3)] for x,z in poly],
                    "verts":P.round(3).tolist(),"height":round(h,2),
                    "builtin":f.get("builtin",False)})
    return out

def process(sid):
    # v4/v5 검출 (+ 좌표 보정용 rot, fy, cy)
    from glb_to_floorplan_v4 import extract_slices, consensus_walls, build_boundary, detect_openings, decompose_rooms
    from glb_furniture import extract_furniture
    from glb_furniture_v5 import extract_furniture_v5
    mesh=load_glb(os.path.join(S.GLB,f"{sid}.glb"))
    rot=estimate_rotation_angle(mesh)
    m2=mesh.copy()
    if abs(rot)>1e-4: m2.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
    fy,cy=find_floor_ceiling(m2)
    sl=extract_slices(m2,fy,cy,step=0.2)
    xw,zw,xh,xe,zh,ze=consensus_walls(sl,snap=0.06)
    all_w=[p for s in sl for p in s['w']]
    bnd=build_boundary(xw,zw,all_w,min_wall_len=0.4)
    op=detect_openings(m2,bnd,fy,cy,min_opening=0.5)
    rd=decompose_rooms(m2,xw,zw,bnd,op,fy,cy,min_opening=0.5,min_room_area=2.0,max_door_width=1.5)
    f4=extract_furniture(m2,fy,cy,bnd,rd['rooms'])
    f5=extract_furniture_v5(m2,fy,cy,bnd,rd['rooms'])
    data={"id":sid,"rotation":float(rot),"floor_y":float(fy),"ceil_y":float(cy),
          "gt":gt_boxes_3d(sid),
          "v4":detection_boxes_3d(sid,f4,rot,fy,cy),
          "v5":detection_boxes_3d(sid,f5,rot,fy,cy)}
    json.dump(data,open(os.path.join(OUT,f"{sid}.json"),"w"))
    return data

if __name__=="__main__":
    sids=sys.argv[1:] or [m['id'] for m in json.load(open(f"{BASE}/results/furniture_compare.json"))]
    idx=[]
    for sid in sids:
        try:
            d=process(sid)
            idx.append({"id":sid,"gt":len(d['gt']),"v4":len(d['v4']),"v5":len(d['v5'])})
            print(f"{sid}: GT={len(d['gt'])} v4={len(d['v4'])} v5={len(d['v5'])}")
        except Exception as e:
            print(f"{sid}: ERR {e}")
    json.dump(idx,open(os.path.join(BASE,"boxes3d_index.json"),"w"),indent=2)
    print(f"완료 {len(idx)}씬 → boxes3d/, boxes3d_index.json")
