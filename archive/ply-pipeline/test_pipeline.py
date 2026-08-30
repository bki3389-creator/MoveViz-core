"""
테스트 스크립트: 가상 방 포인트클라우드 생성 → 파이프라인 테스트
실제 COLMAP 데이터 없이도 파이프라인을 검증할 수 있다.
"""

import numpy as np
import open3d as o3d
from pathlib import Path

def generate_room_pointcloud(output_path, n_wall_points=3000, n_noise=500):
    """가상 방(4m x 3.5m x 2.5m) 포인트클라우드 생성"""

    points = []

    # 방 크기
    W, D, H = 4.0, 3.5, 2.5

    # 벽 4면 (sparse하게)
    # 남쪽 벽 (y=0)
    for _ in range(n_wall_points // 4):
        x = np.random.uniform(0, W)
        z = np.random.uniform(0, H)
        y = np.random.normal(0, 0.02)
        points.append([x, y, z])

    # 북쪽 벽 (y=D)
    for _ in range(n_wall_points // 4):
        x = np.random.uniform(0, W)
        z = np.random.uniform(0, H)
        y = np.random.normal(D, 0.02)
        points.append([x, y, z])

    # 서쪽 벽 (x=0)
    for _ in range(n_wall_points // 4):
        y = np.random.uniform(0, D)
        z = np.random.uniform(0, H)
        x = np.random.normal(0, 0.02)
        points.append([x, y, z])

    # 동쪽 벽 (x=W)
    for _ in range(n_wall_points // 4):
        y = np.random.uniform(0, D)
        z = np.random.uniform(0, H)
        x = np.random.normal(W, 0.02)
        points.append([x, y, z])

    # 바닥
    for _ in range(800):
        x = np.random.uniform(0, W)
        y = np.random.uniform(0, D)
        z = np.random.normal(0, 0.02)
        points.append([x, y, z])

    # 천장
    for _ in range(400):
        x = np.random.uniform(0, W)
        y = np.random.uniform(0, D)
        z = np.random.normal(H, 0.02)
        points.append([x, y, z])

    # 가구 (침대 모양)
    for _ in range(300):
        x = np.random.uniform(0.2, 1.8)
        y = np.random.uniform(2.0, 4.0)
        z = np.random.uniform(0, 0.5)
        points.append([x, y, z])

    # 랜덤 노이즈
    for _ in range(n_noise):
        points.append(np.random.uniform(-1, W + 1, 3).tolist())

    points = np.array(points)

    # 약간 기울기 (실제 COLMAP처럼)
    angle = np.radians(8)
    Rx = np.array([
        [1, 0, 0],
        [0, np.cos(angle), -np.sin(angle)],
        [0, np.sin(angle), np.cos(angle)]
    ])
    points = (Rx @ points.T).T

    # 오프셋
    points += np.array([2.5, -1.0, 3.0])

    # 색상 (실내 느낌)
    colors = np.random.uniform(0.3, 0.8, (len(points), 3))

    # PLY 저장
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)
    pcd.colors = o3d.utility.Vector3dVector(colors)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    o3d.io.write_point_cloud(str(output_path), pcd)

    print(f"테스트 포인트클라우드 생성: {output_path}")
    print(f"  → {len(points)} points")
    print(f"  → 실제 방 크기: {W}m × {D}m × {H}m")
    return str(output_path)


if __name__ == "__main__":
    from extract_floorplan import run_pipeline

    # 1. 가상 데이터 생성
    ply_path = generate_room_pointcloud("test_data/test_room.ply")

    # 2. 파이프라인 실행
    result = run_pipeline(
        input_path=ply_path,
        output_dir="test_output",
        resolution=0.05,
        z_min=0.3,
        z_max=2.2,
    )

    if result:
        print("\n✅ 테스트 성공!")
        print(f"rooms.json: {result}")
    else:
        print("\n❌ 테스트 실패")
