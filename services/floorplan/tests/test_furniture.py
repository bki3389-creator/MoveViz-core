#!/usr/bin/env python3
"""가구 추출 검증: v4 파이프라인으로 boundary/rooms 구하고 → extract_furniture → 통계 + PNG."""
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Polygon

from glb_to_floorplan_v4 import (
    load_glb, find_floor_ceiling, extract_slices, consensus_walls,
    build_boundary, detect_openings, decompose_rooms, estimate_rotation_angle,
)
from glb_furniture import extract_furniture


def run(path, out_png):
    mesh = load_glb(path)
    ang = estimate_rotation_angle(mesh)
    if abs(ang) > 1e-4:
        import trimesh
        mesh = mesh.copy()
        mesh.apply_transform(trimesh.transformations.rotation_matrix(ang, [0, 1, 0]))
    fy, cy = find_floor_ceiling(mesh)
    slices = extract_slices(mesh, fy, cy, step=0.2)
    xw, zw, *_ = consensus_walls(slices, snap=0.06)
    all_w = [p for s in slices for p in s["w"]]
    boundary = build_boundary(xw, zw, all_w, min_wall_len=0.4)
    openings = detect_openings(mesh, boundary, fy, cy, min_opening=0.5)
    rooms_data = decompose_rooms(mesh, xw, zw, boundary, openings, fy, cy,
                                 min_opening=0.5, min_room_area=2.0, max_door_width=1.5)
    rooms = rooms_data["rooms"]

    furn = extract_furniture(mesh, fy, cy, boundary, rooms)

    nb = sum(1 for f in furn if f["builtin"])
    print(f"\n=== {path.split('/')[-1]} ===")
    print(f"  방 {len(rooms)}개, 가구 {len(furn)}개 (빌트인 {nb} / 자립 {len(furn)-nb})")
    for f in furn[:12]:
        w = f["bbox"][2] - f["bbox"][0]
        d = f["bbox"][3] - f["bbox"][1]
        tag = "빌트인" if f["builtin"] else "가구  "
        print(f"   [{tag}] {w:.2f}x{d:.2f}m  h={f['height_m']:.2f}m  "
              f"면적 {f['footprint_m2']:.2f}m²  room={f['room_id']}")

    # ── 시각화 ──
    fig, ax = plt.subplots(figsize=(9, 9))
    # 방
    pal = ["#dbeafe", "#dcfce7", "#fef9c3", "#fce7f3", "#ede9fe", "#ccfbf1"]
    for ri, r in enumerate(rooms):
        if r.get("polygon") and len(r["polygon"]) >= 3:
            ax.add_patch(Polygon([(p[0], p[1]) for p in r["polygon"]],
                                 closed=True, facecolor=pal[ri % len(pal)],
                                 edgecolor="#94a3b8", lw=1, alpha=0.7, zorder=1))
    # boundary
    if boundary:
        bx = [p[0] for p in boundary]
        bz = [p[1] for p in boundary]
        ax.plot(bx, bz, "-", color="#111", lw=3, zorder=4)
    # 가구
    for f in furn:
        x0, z0, x1, z1 = f["bbox"]
        col = "#f59e0b" if f["builtin"] else "#64748b"
        ax.add_patch(Rectangle((x0, z0), x1 - x0, z1 - z0, facecolor=col,
                               edgecolor="#1e293b", lw=1, alpha=0.55, zorder=5))
        ax.text((x0 + x1) / 2, (z0 + z1) / 2, f"{f['height_m']:.1f}m",
                ha="center", va="center", fontsize=7, color="#0f172a", zorder=6)
    ax.set_aspect("equal")
    ax.set_title(f"{path.split('/')[-1]} — 방 {len(rooms)} · 가구 {len(furn)} (빌트인 {nb})  "
                 f"[주황=빌트인, 회색=자립]")
    ax.grid(True, alpha=0.2)
    fig.tight_layout()
    fig.savefig(out_png, dpi=110)
    print(f"  ▶ PNG: {out_png}")
    return len(furn), nb


if __name__ == "__main__":
    targets = sys.argv[1:]
    if not targets:
        raise SystemExit("사용법: python tests/test_furniture.py <scan.glb> [scan2.glb ...]")
    for t in targets:
        try:
            base = t.split("/")[-1].replace(".glb", "").replace(" ", "").replace(".", "_")
            run(t, f"/tmp/furniture_{base}.png")
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"  실패: {t}: {e}")
