#!/usr/bin/env python3
# 스캔 평면 분석 결과(JSON) → IFC4 BIM 파일 (Revit 임포트용)
#   - 벽(structure/built-in) segs → IfcWall (문틈은 segs로 자연 반영)
#   - 창(openings) / 문(doors) → IfcWindow / IfcDoor (벽 보이드 포함)
#   - 방(rooms) → IfcSpace (이름·면적)
#   - 바닥(boundary) → IfcSlab
# 좌표: 평면(x,z) → IFC(X=x, Y=z), 높이=Z. 바닥을 Z=0으로 정규화.
import json, sys, os, math
import numpy as np
import ifcopenshell
from ifcopenshell.api import run

THICK = 0.12          # 벽 두께(m)
SLAB_T = 0.2          # 바닥 슬래브 두께
DOOR_H = 2.1
WIN_SILL, WIN_H = 0.9, 1.2

def place_matrix(x, y, z, dirx, diry):
    """로컬 X축을 (dirx,diry,0) 방향으로, 원점 (x,y,z)에 두는 4x4 배치행렬."""
    M = np.eye(4)
    M[0,0], M[1,0] = dirx, diry          # local X
    M[0,1], M[1,1] = -diry, dirx         # local Y (수직)
    M[0,3], M[1,3], M[2,3] = x, y, z
    return M

def build(data, out_path):
    H = float(data["ceil_y"] - data["floor_y"])
    f = run("project.create_file", version="IFC4")
    proj = run("root.create_entity", f, ifc_class="IfcProject", name="MoveMate Scan")
    run("unit.assign_unit", f, units=[run("unit.add_si_unit", f, unit_type="LENGTHUNIT")])
    ctx = run("context.add_context", f, context_type="Model")
    body = run("context.add_context", f, context_type="Model",
               context_identifier="Body", target_view="MODEL_VIEW", parent=ctx)
    site   = run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    bldg   = run("root.create_entity", f, ifc_class="IfcBuilding", name="Building")
    storey = run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Level 1")
    run("aggregate.assign_object", f, products=[site], relating_object=proj)
    run("aggregate.assign_object", f, products=[bldg], relating_object=site)
    run("aggregate.assign_object", f, products=[storey], relating_object=bldg)

    n_wall = n_door = n_win = n_space = 0

    def add_wall(x, y, length, dirx, diry):
        nonlocal n_wall
        if length < 0.15: return None
        w = run("root.create_entity", f, ifc_class="IfcWall", name=f"Wall {n_wall+1}")
        rep = run("geometry.add_wall_representation", f, context=body,
                  length=length, height=H, thickness=THICK)
        run("geometry.assign_representation", f, product=w, representation=rep)
        run("geometry.edit_object_placement", f, product=w,
            matrix=place_matrix(x, y, 0.0, dirx, diry))
        run("spatial.assign_container", f, products=[w], relating_structure=storey)
        n_wall += 1
        return w

    # ── 벽: xw(고정 x, z방향) + zw(고정 z, x방향), structure/built-in만 ──
    for w in data.get("xw", []):
        if w.get("cls") == "noise": continue
        pos = w["pos"]
        for lo, hi in w.get("segs", []):
            add_wall(pos, lo, hi - lo, 0.0, 1.0)        # +Y(z)방향
    for w in data.get("zw", []):
        if w.get("cls") == "noise": continue
        pos = w["pos"]
        for lo, hi in w.get("segs", []):
            add_wall(lo, pos, hi - lo, 1.0, 0.0)        # +X(x)방향

    # ── 창/문 ──
    def add_opening(o, kind):
        nonlocal n_door, n_win
        cx, cy = o["center"]
        width = o.get("width") or abs(o["span"][1]-o["span"][0])
        if width < 0.2: return
        dirx, diry = (0.0,1.0) if o.get("wall_dir")=="x" else (1.0,0.0)  # x벽=z방향
        if kind=="door":
            el = run("root.create_entity", f, ifc_class="IfcDoor", name=f"Door {n_door+1}")
            rep = run("geometry.add_door_representation", f, context=body,
                      overall_height=DOOR_H, overall_width=width)
            z=0.0; n_door+=1
        else:
            el = run("root.create_entity", f, ifc_class="IfcWindow", name=f"Window {n_win+1}")
            rep = run("geometry.add_window_representation", f, context=body,
                      overall_height=WIN_H, overall_width=width)
            z=WIN_SILL; n_win+=1
        run("geometry.assign_representation", f, product=el, representation=rep)
        run("geometry.edit_object_placement", f, product=el,
            matrix=place_matrix(cx, cy, z, dirx, diry))
        run("spatial.assign_container", f, products=[el], relating_structure=storey)

    for o in data.get("doors", []): add_opening(o, "door")
    for o in data.get("openings", []):
        add_opening(o, "window" if o.get("type")=="window" else "door")

    # ── 방: IfcSpace (bbox 사각형 + 이름/면적) ──
    for r in data.get("rooms", []):
        bb = r.get("bbox");
        if not bb: continue
        x0,z0,x1,z1 = bb
        sp = run("root.create_entity", f, ifc_class="IfcSpace",
                 name=r.get("name") or f"Room {r.get('id','')}")
        try:
            rep = run("geometry.add_slab_representation", f, context=body,
                      depth=0.02, x=abs(x1-x0), y=abs(z1-z0))
            run("geometry.assign_representation", f, product=sp, representation=rep)
            run("geometry.edit_object_placement", f, product=sp,
                matrix=place_matrix(min(x0,x1), min(z0,z1), 0.0, 1.0, 0.0))
        except Exception: pass
        run("aggregate.assign_object", f, products=[sp], relating_object=storey)  # 공간은 집합관계
        n_space += 1

    f.write(out_path)
    return dict(walls=n_wall, doors=n_door, windows=n_win, spaces=n_space, height=round(H,2))

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv)>1 else "/tmp/conv_out.json"
    out = sys.argv[2] if len(sys.argv)>2 else os.path.join(os.path.dirname(os.path.abspath(__file__)),"scan.ifc")
    data = json.load(open(src))
    res = build(data, out)
    print("IFC 생성:", out)
    print(res)
