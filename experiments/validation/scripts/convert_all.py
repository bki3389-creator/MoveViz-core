#!/usr/bin/env python3
"""ARKitScenes PLY(Z-up) → v4 입력용 GLB(Y-up) 일괄 변환.

ARKitScenes 메쉬는 Z-up이고 v4는 Y-up을 가정하므로,
X축 -90° 회전(Z-up→Y-up)을 적용해 변환한다.
이 회전각은 score.py에서 가구 OBB 정답을 같은 좌표계로 옮길 때 그대로 재사용.
기존 코드/데이터 불변 — glb/ 폴더에 새로 생성만.
"""
import os, sys, json, glob
import numpy as np
import trimesh

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(BASE, "data", "3dod", "Training")
GLB  = os.path.join(BASE, "glb")
os.makedirs(GLB, exist_ok=True)

# Z-up → Y-up 회전 (X축 -90°). 이 값이 좌표 변환 체인의 1단계.
PRE_ROT_X = -np.pi / 2

def convert(sid, force=False):
    ply = os.path.join(DATA, sid, f"{sid}_3dod_mesh.ply")
    out = os.path.join(GLB, f"{sid}.glb")
    if not os.path.exists(ply):
        return None
    if os.path.exists(out) and not force:
        return out
    m = trimesh.load(ply, process=False)
    if isinstance(m, trimesh.Scene):
        m = trimesh.util.concatenate(list(m.geometry.values()))
    R = trimesh.transformations.rotation_matrix(PRE_ROT_X, [1, 0, 0])
    m.apply_transform(R)
    m.export(out)
    return out

def main():
    scenes = sorted(d for d in os.listdir(DATA) if os.path.isdir(os.path.join(DATA, d)))
    done = []
    for i, sid in enumerate(scenes, 1):
        r = convert(sid)
        if r:
            done.append(sid)
            print(f"  [{i}/{len(scenes)}] {sid}.glb")
    json.dump({"pre_rot_x_rad": PRE_ROT_X, "scenes": done},
              open(os.path.join(BASE, "results", "convert_meta.json"), "w"), indent=2)
    print(f"완료: {len(done)}개 GLB → glb/")

if __name__ == "__main__":
    main()
