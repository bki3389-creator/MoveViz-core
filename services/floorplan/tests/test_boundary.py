#!/usr/bin/env python3
"""GLB 경계 추출 수동 검증 도구.

실제 스캔은 저장소에 포함하지 않는다. 검증할 GLB 경로를 명령행 인자로 전달한다.
"""

from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from glb_to_floorplan_v4 import (  # noqa: E402
    build_boundary,
    consensus_walls,
    extract_slices,
    find_floor_ceiling,
    load_glb,
)


def inspect_boundary(path_string):
    path = Path(path_string).expanduser().resolve()
    mesh = load_glb(str(path))
    if not hasattr(mesh, "faces"):
        raise TypeError("경계 검증에는 면이 있는 mesh 파일이 필요합니다")
    is_cad = mesh.faces.shape[0] < 2000
    if is_cad:
        print(f"=== {path.name} === IS_CAD")
        return

    floor_y, ceiling_y = find_floor_ceiling(mesh)
    slices = extract_slices(mesh, floor_y, ceiling_y, step=0.2)
    x_walls, z_walls, *_ = consensus_walls(slices, snap=0.06)
    all_wall_points = [point for section in slices for point in section["w"]]
    boundary = build_boundary(x_walls, z_walls, all_wall_points, min_wall_len=0.4)

    print(f"=== {path.name} === corners={len(boundary) - 1}")
    for x, z in boundary:
        print(f"  [{x:.2f}, {z:.2f}]")


if __name__ == "__main__":
    targets = sys.argv[1:]
    if not targets:
        raise SystemExit("사용법: python tests/test_boundary.py <scan.glb> [scan2.glb ...]")

    failed = False
    for target in targets:
        try:
            inspect_boundary(target)
        except Exception as exc:
            failed = True
            import traceback

            traceback.print_exc()
            print(f"=== {target} === ERROR: {exc}")
    raise SystemExit(1 if failed else 0)
