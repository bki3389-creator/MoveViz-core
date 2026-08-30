#!/usr/bin/env python3
"""usdz_to_glb.py — Apple Object Capture(PhotogrammetrySession) USDZ → GLB 변환.

비-LiDAR 경로의 글루: iOS PhotogrammetryManager가 만든 USDZ를 GLB로 바꿔
기존 평면도 파이프라인(glb_to_floorplan.py)에 그대로 투입한다.

USD(pxr)로 모든 UsdGeom.Mesh를 순회 → 월드변환 적용 → 삼각화 → trimesh로 GLB export.
displayColor(정점색)가 있으면 보존.

deps: usd-core, trimesh, numpy  (.venv)
검증: `python usdz_to_glb.py --selftest` (합성 USDZ 큐브 생성 → 변환 → 정점/면 수 검증).
"""
from __future__ import annotations
import numpy as np


def _triangulate(counts, indices):
    """faceVertexCounts/Indices(폴리곤) → 삼각형 인덱스 (fan triangulation)."""
    tris = []
    i = 0
    for c in counts:
        if c < 3:
            i += c; continue
        f = indices[i:i + c]
        for k in range(1, c - 1):
            tris.append((f[0], f[k], f[k + 1]))
        i += c
    return np.asarray(tris, np.int64) if tris else np.zeros((0, 3), np.int64)


def usd_to_meshes(stage):
    """USD stage의 모든 Mesh → [trimesh.Trimesh] (월드좌표, 정점색 보존)."""
    from pxr import UsdGeom, Usd
    import trimesh
    out = []
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh):
            continue
        m = UsdGeom.Mesh(prim)
        pts = m.GetPointsAttr().Get()
        if not pts:
            continue
        V = np.array([[p[0], p[1], p[2]] for p in pts], float)
        counts = np.array(m.GetFaceVertexCountsAttr().Get() or [], int)
        idx = np.array(m.GetFaceVertexIndicesAttr().Get() or [], int)
        F = _triangulate(counts, idx)
        if len(F) == 0:
            continue
        # 로컬 → 월드 변환
        xf = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
        M = np.array([[xf[r][c] for c in range(4)] for r in range(4)], float)  # row-major
        Vh = np.c_[V, np.ones(len(V))] @ M                  # USD는 row-vector * matrix
        V = Vh[:, :3]
        mesh = trimesh.Trimesh(vertices=V, faces=F, process=False)
        # displayColor(정점색) 보존
        try:
            dc = m.GetDisplayColorAttr().Get()
            if dc and len(dc) == len(V):
                cols = (np.clip(np.array([[c[0], c[1], c[2]] for c in dc]), 0, 1) * 255).astype(np.uint8)
                mesh.visual = trimesh.visual.color.ColorVisuals(
                    mesh=mesh, vertex_colors=np.c_[cols, np.full(len(V), 255, np.uint8)])
        except Exception:
            pass
        out.append(mesh)
    return out


def convert(usdz_path, glb_path):
    from pxr import Usd
    import trimesh
    stage = Usd.Stage.Open(usdz_path)
    if stage is None:
        raise RuntimeError(f"USD 스테이지 열기 실패: {usdz_path}")
    meshes = usd_to_meshes(stage)
    if not meshes:
        raise RuntimeError("USDZ에서 Mesh를 못 찾음")
    combined = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    combined.export(glb_path)
    return combined


# ── 검증: 합성 USDZ 큐브 생성 → 변환 → 검증 ─────────────────────────────
def _make_cube_usda(path):
    from pxr import Usd, UsdGeom, Gf
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    mesh = UsdGeom.Mesh.Define(stage, "/Cube")
    pts = [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),
           (-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]
    mesh.GetPointsAttr().Set([Gf.Vec3f(*p) for p in pts])
    # 6 quads
    quads = [(0,1,2,3),(4,5,6,7),(0,1,5,4),(2,3,7,6),(1,2,6,5),(0,3,7,4)]
    counts = [4]*6
    idx = [i for q in quads for i in q]
    mesh.GetFaceVertexCountsAttr().Set(counts)
    mesh.GetFaceVertexIndicesAttr().Set(idx)
    # 정점색(displayColor, vertex interpolation) — 선택사항
    try:
        from pxr import Sdf
        cpv = UsdGeom.PrimvarsAPI(mesh.GetPrim()).CreatePrimvar(
            "displayColor", Sdf.ValueTypeNames.Color3fArray, UsdGeom.Tokens.vertex)
        cpv.Set([Gf.Vec3f(0.9, 0.2, 0.2)] * 8)
    except Exception:
        pass
    stage.GetRootLayer().Save()


def selftest():
    import os, tempfile, trimesh
    from pxr import UsdUtils
    d = tempfile.mkdtemp()
    usda = os.path.join(d, "cube.usda")
    usdz = os.path.join(d, "cube.usdz")
    try:
        _make_cube_usda(usda)
        UsdUtils.CreateNewUsdzPackage(usda, usdz)   # .usda → 실제 .usdz 패키지(Object Capture와 동일 경로)
    except Exception as e:
        print(f"  USDZ 생성 실패(환경): {e}"); return False
    glb = os.path.join(d, "cube.glb")
    mesh = convert(usdz, glb)                         # 실제 .usdz 를 연다
    ok_verts = len(mesh.vertices) == 8
    ok_faces = len(mesh.faces) == 12          # 6 quads → 12 tris
    ok_file = os.path.exists(glb) and os.path.getsize(glb) > 0
    reload = trimesh.load(glb, force="mesh")
    ok_reload = len(reload.faces) == 12
    has_color = hasattr(reload.visual, "vertex_colors")
    print(f"  USDZ→GLB: 정점 {len(mesh.vertices)}(=8?{ok_verts}) · 면 {len(mesh.faces)}(=12?{ok_faces}) · "
          f"GLB저장 {ok_file} · 재로드면수 {ok_reload} · 정점색 {has_color}")
    allok = ok_verts and ok_faces and ok_file and ok_reload
    print(f"  === usdz_to_glb 셀프테스트: {'PASS ✅' if allok else 'FAIL ❌'} ===")
    return allok


def main():
    import argparse, sys
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("usdz", nargs="?")
    ap.add_argument("-o", "--out", default="model.glb")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(0 if selftest() else 1)
    if not a.usdz:
        ap.error("usdz 경로가 필요합니다 (또는 --selftest)")
    m = convert(a.usdz, a.out)
    print(f"저장: {a.out}  (정점 {len(m.vertices)}, 면 {len(m.faces)})")


if __name__ == "__main__":
    main()
