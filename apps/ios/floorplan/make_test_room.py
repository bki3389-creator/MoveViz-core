#!/usr/bin/env python3
"""
make_test_room.py — extract_floorplan.py 검증용 합성 방 점구름(PLY) 생성.

실제 LiDAR 스캔과 비슷하게:
  - 4.0m × 3.0m × 2.5m 직사각형 방 (X 폭 × Z 깊이 × Y 높이)
  - 바닥 / 천장 / 벽 4면
  - 한쪽 벽에 문 틈 (door gap)
  - 구석에 가구(작은 박스) 잡음
  - 1cm 가우시안 노이즈
  - 전체를 Y축 기준 20° 회전 + 임의 평행이동 (정렬 알고리즘 시험)

ARKit 규약대로 Y가 위(up).

사용법:  python make_test_room.py [out.ply]
"""
import sys
import numpy as np

rng = np.random.default_rng(7)

W, D, H = 4.0, 3.0, 2.5          # x폭, z깊이, y높이
ROT_DEG = 20.0                    # 전체 회전 (정렬 알고리즘이 복구해야 함)
NOISE = 0.01                      # 1cm


def grid_points(per_m2, *ranges):
    """주어진 (lo,hi) 범위 곱공간을 per_m2 밀도로 균일 샘플."""
    area = 1.0
    for lo, hi in ranges:
        area *= max(hi - lo, 1e-3)
    n = max(int(area * per_m2), 1)
    cols = [rng.uniform(lo, hi, n) for lo, hi in ranges]
    return np.stack(cols, axis=1), n


pts = []

# 바닥 (y=0) 과 천장 (y=H)
floor, _ = grid_points(500, (0, W), (0, D))
pts.append(np.column_stack([floor[:, 0], np.zeros(len(floor)), floor[:, 1]]))
ceil, _ = grid_points(300, (0, W), (0, D))
pts.append(np.column_stack([ceil[:, 0], np.full(len(ceil), H), ceil[:, 1]]))

# 벽 x=0, x=W
for xw in (0.0, W):
    wall, _ = grid_points(500, (0, D), (0, H))
    pts.append(np.column_stack([np.full(len(wall), xw), wall[:, 1], wall[:, 0]]))

# 벽 z=0  (막힌 벽)
wall, _ = grid_points(500, (0, W), (0, H))
pts.append(np.column_stack([wall[:, 0], wall[:, 1], np.zeros(len(wall))]))

# 벽 z=D  (문 틈: x∈[1.0,1.9], y<2.0 구간 제거)
wall, _ = grid_points(500, (0, W), (0, H))
keep = ~((wall[:, 0] > 1.0) & (wall[:, 0] < 1.9) & (wall[:, 1] < 2.0))
wall = wall[keep]
pts.append(np.column_stack([wall[:, 0], wall[:, 1], np.full(len(wall), D)]))

# 가구 잡음: 구석의 작은 박스(테이블) 윗면 + 옆면
fx0, fz0 = 2.8, 0.3
box_top, _ = grid_points(600, (fx0, fx0 + 0.9), (fz0, fz0 + 0.6))
pts.append(np.column_stack([box_top[:, 0], np.full(len(box_top), 0.75), box_top[:, 1]]))

cloud = np.concatenate(pts, axis=0)
cloud += rng.normal(0, NOISE, cloud.shape)  # 센서 노이즈

# 전체 회전(Y축) + 평행이동
r = np.radians(ROT_DEG)
ct, st = np.cos(r), np.sin(r)
Ry = np.array([[ct, 0, -st], [0, 1, 0], [st, 0, ct]])
cloud = cloud @ Ry.T
cloud += np.array([12.3, 0.0, -5.7])  # 원점에서 떨어뜨림

# ASCII PLY 쓰기 (MoveViz PLYExporter 와 동일 포맷)
out = sys.argv[1] if len(sys.argv) > 1 else "test_room.ply"
with open(out, "w") as f:
    f.write("ply\nformat ascii 1.0\n")
    f.write("comment synthetic test room (4x3x2.5, rot20, door gap, furniture)\n")
    f.write(f"element vertex {len(cloud)}\n")
    f.write("property float x\nproperty float y\nproperty float z\n")
    f.write("property uchar red\nproperty uchar green\nproperty uchar blue\n")
    f.write("end_header\n")
    for p in cloud:
        f.write(f"{p[0]:.4f} {p[1]:.4f} {p[2]:.4f} 160 160 160\n")

print(f"✅ 합성 방 생성: {out}  ({len(cloud):,} 점)")
print(f"   정답값 → 크기 {W}×{D} m, 천장 {H} m, 회전 {ROT_DEG}°")
