#!/usr/bin/env python3
"""ARKitScenes 30씬 시각 확인용 프리뷰 생성기.

각 씬에 대해:
  - PLY 메쉬를 탑다운(XZ 평면)으로 렌더 → 바닥 점밀도 히트맵
  - 가구 OBB(정답)를 그 위에 색 박스로 오버레이 (라벨별 색)
  - 대표 RGB 프레임 1장 썸네일 복사
  - 메타: 가구 개수/종류, 정점 수, 바닥면적(대략), 메쉬 파일크기
결과를 results/preview/ 에 PNG로, scenes.json 에 메타로 저장.
기존 코드는 건드리지 않음 — 전부 새 파일.
"""
import os, sys, json, glob, math
import numpy as np

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(BASE, "data", "3dod", "Training")
OUT  = os.path.join(BASE, "results", "preview")
os.makedirs(OUT, exist_ok=True)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly
import trimesh

# 라벨별 고정 색 (자주 나오는 가구)
PALETTE = {
    "cabinet": "#d97706", "refrigerator": "#0891b2", "shelf": "#7c3aed",
    "table": "#16a34a", "bed": "#dc2626", "sofa": "#2563eb", "sink": "#0d9488",
    "washer": "#9333ea", "toilet": "#65a30d", "bathtub": "#c026d3",
    "oven": "#ea580c", "dishwasher": "#0284c7", "fireplace": "#b45309",
    "stove": "#e11d48", "stool": "#4f46e5", "chair": "#059669",
    "tv_monitor": "#7c2d12", "build_in_cabinet": "#a16207",
}
def color_for(label):
    return PALETTE.get(label, "#64748b")


def obb_corners_xz(centroid, axes_lengths, normalized_axes):
    """OBB의 바닥 footprint 4각형(XZ평면) 반환. 단위: mm→m 변환."""
    c = np.array(centroid, float) / 1000.0
    L = np.array(axes_lengths, float) / 1000.0
    # normalizedAxes: 9개 (3x3), 열 우선 or 행 우선? ARKitScenes는 3x3 행벡터(각 축)
    R = np.array(normalized_axes, float).reshape(3, 3)
    # 8코너 생성 후 XZ만 사용
    signs = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
    corners = c + (signs * (L / 2.0)) @ R
    xz = corners[:, [0, 2]]
    # XZ 평면 convex hull 대신 min-area 박스 근사: 그냥 8점의 XZ투영 후 외곽
    return xz


def render_scene(scene_id):
    sdir = os.path.join(DATA, scene_id)
    ply = os.path.join(sdir, f"{scene_id}_3dod_mesh.ply")
    ann = os.path.join(sdir, f"{scene_id}_3dod_annotation.json")
    if not os.path.exists(ply):
        return None
    meta = {"id": scene_id}

    # --- 메쉬 로드 ---
    try:
        mesh = trimesh.load(ply, process=False)
        if isinstance(mesh, trimesh.Scene):
            mesh = trimesh.util.concatenate(list(mesh.geometry.values()))
        V = np.asarray(mesh.vertices, float)
    except Exception as e:
        meta["error"] = f"mesh load fail: {e}"
        return meta
    meta["vertices"] = int(len(V))
    meta["mesh_mb"] = round(os.path.getsize(ply) / 1e6, 1)

    # ARKitScenes 좌표: Y=up. XZ가 바닥평면.
    X, Y, Z = V[:, 0], V[:, 1], V[:, 2]
    xmin, xmax = np.percentile(X, [1, 99])
    zmin, zmax = np.percentile(Z, [1, 99])
    meta["floor_area_m2"] = round(abs((xmax - xmin) * (zmax - zmin)), 1)
    meta["height_m"] = round(float(np.percentile(Y, 99) - np.percentile(Y, 1)), 2)

    # --- annotation ---
    furn = []
    if os.path.exists(ann):
        try:
            a = json.load(open(ann))
            for obj in a.get("data", []):
                lab = obj.get("label", "?")
                obb = obj.get("segments", {}).get("obb")
                if not obb:
                    continue
                xz = obb_corners_xz(obb["centroid"], obb["axesLengths"], obb["normalizedAxes"])
                furn.append({"label": lab, "xz": xz})
        except Exception as e:
            meta["ann_error"] = str(e)
    meta["furniture_count"] = len(furn)
    from collections import Counter
    meta["labels"] = dict(Counter(f["label"] for f in furn))

    # --- 탑다운 렌더 ---
    fig, ax = plt.subplots(figsize=(5, 5), dpi=90)
    # 바닥 점밀도(2D 히스토그램)로 방 윤곽 표현
    ax.hist2d(X, Z, bins=180, range=[[xmin, xmax], [zmin, zmax]],
              cmap="Greys", cmin=1)
    # 가구 OBB footprint 오버레이
    for f in furn:
        pts = f["xz"]
        # convex hull로 박스 외곽
        try:
            from scipy.spatial import ConvexHull
            h = ConvexHull(pts)
            poly = pts[h.vertices]
        except Exception:
            poly = pts
        ax.add_patch(MplPoly(poly, closed=True, fill=True,
                             facecolor=color_for(f["label"]), alpha=0.35,
                             edgecolor=color_for(f["label"]), linewidth=1.5))
        cx, cz = pts[:, 0].mean(), pts[:, 1].mean()
        ax.text(cx, cz, f["label"], fontsize=6, ha="center", va="center",
                color="#111", weight="bold")
    ax.set_aspect("equal")
    ax.set_xlim(xmin, xmax); ax.set_ylim(zmin, zmax)
    ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(f"{scene_id}  |  furniture {len(furn)}  |  {meta['floor_area_m2']} m2",
                 fontsize=9)
    fig.tight_layout()
    png = os.path.join(OUT, f"{scene_id}_topdown.png")
    fig.savefig(png, bbox_inches="tight")
    plt.close(fig)
    meta["topdown"] = os.path.relpath(png, BASE)

    # --- 대표 RGB 1장 ---
    frames = sorted(glob.glob(os.path.join(sdir, f"{scene_id}_frames", "lowres_wide", "*.png")))
    if frames:
        mid = frames[len(frames) // 2]
        meta["rgb"] = os.path.relpath(mid, BASE)
        meta["frame_count"] = len(frames)
    return meta


def main():
    scenes = sorted(d for d in os.listdir(DATA) if os.path.isdir(os.path.join(DATA, d)))
    print(f"{len(scenes)}개 씬 처리 시작...")
    results = []
    for i, s in enumerate(scenes, 1):
        m = render_scene(s)
        if m:
            results.append(m)
            print(f"  [{i}/{len(scenes)}] {s}: 가구 {m.get('furniture_count','?')}개, "
                  f"{m.get('floor_area_m2','?')}㎡, {m.get('vertices','?')} verts")
    json.dump(results, open(os.path.join(BASE, "results", "scenes.json"), "w"),
              ensure_ascii=False, indent=2)
    print(f"\n완료. {len(results)}개 씬 → results/scenes.json")


if __name__ == "__main__":
    main()
