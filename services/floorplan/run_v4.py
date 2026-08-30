#!/usr/bin/env python3
"""run_v4.py — production v4 파이프라인을 CLI로 실행해 전체 평면 JSON 출력.
server_furniture_v5.py 의 non-CAD 경로와 동일. CAD 렌더러 입력 생성용.
사용: python run_v4.py scan.glb -o out.json
"""
import sys, json, argparse
import numpy as np
from glb_to_floorplan_v4 import (
    load_glb, find_floor_ceiling, extract_slices,
    consensus_walls, build_boundary, extract_cad_plan,
    estimate_rotation_angle, detect_openings, decompose_rooms,
)
try:
    from glb_furniture_v5 import extract_furniture_v5
except Exception:
    extract_furniture_v5 = None
try:
    from furniture_postprocess import refine_furniture   # 폴리캠식 후처리 스냅
except Exception:
    refine_furniture = None


def run(path):
    mesh = load_glb(path)
    IS_CAD = mesh.faces.shape[0] < 2000
    if IS_CAD:
        cad = extract_cad_plan(mesh, min_wall_len=0.3)
        boundary, xw, zw = cad['boundary'], cad['xw'], cad['zw']
        fy, cy = 0.0, 2.4
        openings = detect_openings(mesh, boundary, fy, cy, min_opening=0.5)
        rooms = decompose_rooms(mesh, xw, zw, boundary, openings, fy, cy,
                                min_opening=0.5, min_room_area=2.0, max_door_width=1.5)
        furn = []
        source = 'cad'
    else:
        ang = estimate_rotation_angle(mesh)
        if abs(ang) > 1e-4:
            import trimesh
            R = trimesh.transformations.rotation_matrix(ang, [0, 1, 0])
            mesh = mesh.copy(); mesh.apply_transform(R)
        fy, cy = find_floor_ceiling(mesh)
        slices = extract_slices(mesh, fy, cy, step=0.2)
        xw, zw, xh, xe, zh, ze = consensus_walls(slices, snap=0.06)
        all_w = [p for s in slices for p in s['w']]
        boundary = build_boundary(xw, zw, all_w, min_wall_len=0.4)
        openings = detect_openings(mesh, boundary, fy, cy, min_opening=0.5)
        rooms = decompose_rooms(mesh, xw, zw, boundary, openings, fy, cy,
                                min_opening=0.5, min_room_area=2.0, max_door_width=1.5)
        # 과검출 억제: min_area↑·split_area↑(덜 쪼갬)·noise filter 강화
        furn = (extract_furniture_v5(mesh, fy, cy, boundary, rooms['rooms'],
                                     min_area=0.16, split_area=4.0,
                                     nf_min_area=0.30, nf_max_aspect=4.5)
                if extract_furniture_v5 else [])
        if refine_furniture:
            furn = refine_furniture(furn, rooms['rooms'])   # 후처리: 카테고리·표준치수·축정렬·근접병합
        source = 'scan'

    return {
        "source": source, "floor_y": float(fy), "ceil_y": float(cy),
        "boundary": boundary, "xw": xw, "zw": zw,
        "openings": openings,
        "rooms": rooms['rooms'], "interior_openings": rooms['interior_openings'],
        "doors": rooms['doors'], "furniture": furn,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("-o", "--out", default="v4_out.json")
    a = ap.parse_args()
    d = run(a.glb)
    json.dump(d, open(a.out, "w"))
    op = d["openings"]
    from collections import Counter
    print(f"source={d['source']}  boundary={len(d['boundary'])}pts  "
          f"xw={len(d['xw'])} zw={len(d['zw'])}  openings={len(op)} {dict(Counter(o['type'] for o in op))}  "
          f"rooms={len(d['rooms'])} doors={len(d['doors'])} furniture={len(d['furniture'])}")
    print("saved:", a.out)
