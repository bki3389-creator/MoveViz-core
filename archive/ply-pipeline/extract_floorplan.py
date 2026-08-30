"""
MoveViz — Sparse Point Cloud → Floor Plan Extractor
=====================================================
COLMAP sparse reconstruction 결과에서 2D 평면도를 자동 추출하는 스크립트.

파이프라인:
  1. Point cloud 로드 (PLY / COLMAP bin / txt)
  2. Statistical outlier 제거
  3. 바닥면 검출 (RANSAC)
  4. 좌표계 정렬 (바닥 = XY 평면)
  5. 벽 높이 구간 필터링
  6. XY 투영 → 2D occupancy grid
  7. Morphology 처리 → contour 추출
  8. Polygon 단순화
  9. 출력: rooms.json + top-view PNG

사용법:
  python extract_floorplan.py --input sparse_cloud.ply --output ./output
  python extract_floorplan.py --input sparse/0 --output ./output  (COLMAP bin 폴더)
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import cv2
import numpy as np

try:
    import open3d as o3d
except ImportError:
    print("open3d 설치 필요: pip install open3d")
    sys.exit(1)

try:
    from shapely.geometry import Polygon, MultiPolygon
    from shapely.ops import unary_union
except ImportError:
    print("shapely 설치 필요: pip install shapely")
    sys.exit(1)


# ─────────────────────────────────────────────
# 1. COLMAP 데이터 로더
# ─────────────────────────────────────────────

def load_colmap_points3d_bin(filepath):
    """COLMAP points3D.bin 파일에서 3D 포인트 + 색상 읽기"""
    points = []
    colors = []
    with open(filepath, "rb") as f:
        num_points = struct.unpack("<Q", f.read(8))[0]
        for _ in range(num_points):
            point3d_id = struct.unpack("<Q", f.read(8))[0]
            xyz = struct.unpack("<ddd", f.read(24))
            rgb = struct.unpack("<BBB", f.read(3))
            error = struct.unpack("<d", f.read(8))[0]
            track_length = struct.unpack("<Q", f.read(8))[0]
            # skip track data
            f.read(track_length * 8)  # each track entry = image_id(4) + point2d_idx(4)
            points.append(xyz)
            colors.append([c / 255.0 for c in rgb])
    return np.array(points), np.array(colors)


def load_colmap_points3d_txt(filepath):
    """COLMAP points3D.txt 파일에서 3D 포인트 + 색상 읽기"""
    points = []
    colors = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("#") or len(line) == 0:
                continue
            parts = line.split()
            x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
            r, g, b = int(parts[4]), int(parts[5]), int(parts[6])
            points.append([x, y, z])
            colors.append([r / 255.0, g / 255.0, b / 255.0])
    return np.array(points), np.array(colors)


def load_point_cloud(input_path):
    """입력 경로에 따라 적절한 로더 선택"""
    input_path = Path(input_path)

    # Case 1: PLY 파일
    if input_path.suffix.lower() == ".ply":
        print(f"[1/9] PLY 파일 로드: {input_path}")
        pcd = o3d.io.read_point_cloud(str(input_path))
        points = np.asarray(pcd.points)
        colors = np.asarray(pcd.colors) if pcd.has_colors() else np.zeros((len(points), 3))
        print(f"  → {len(points)} points 로드됨")
        return points, colors

    # Case 2: COLMAP sparse 폴더 (points3D.bin 또는 .txt)
    if input_path.is_dir():
        bin_path = input_path / "points3D.bin"
        txt_path = input_path / "points3D.txt"

        if bin_path.exists():
            print(f"[1/9] COLMAP bin 로드: {bin_path}")
            points, colors = load_colmap_points3d_bin(bin_path)
            print(f"  → {len(points)} points 로드됨")
            return points, colors
        elif txt_path.exists():
            print(f"[1/9] COLMAP txt 로드: {txt_path}")
            points, colors = load_colmap_points3d_txt(txt_path)
            print(f"  → {len(points)} points 로드됨")
            return points, colors
        else:
            # sparse/0 안에 있을 수도 있음
            sub = input_path / "0"
            if sub.is_dir():
                return load_point_cloud(sub)
            raise FileNotFoundError(f"points3D.bin/txt를 찾을 수 없습니다: {input_path}")

    raise FileNotFoundError(f"지원하지 않는 입력 형식: {input_path}")


# ─────────────────────────────────────────────
# 2. 전처리
# ─────────────────────────────────────────────

def remove_outliers(points, colors, nb_neighbors=20, std_ratio=2.0):
    """Statistical outlier removal"""
    print("[2/9] Outlier 제거 중...")
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)
    pcd.colors = o3d.utility.Vector3dVector(colors)

    cleaned, idx = pcd.remove_statistical_outlier(
        nb_neighbors=nb_neighbors, std_ratio=std_ratio
    )
    pts = np.asarray(cleaned.points)
    cols = np.asarray(cleaned.colors)
    print(f"  → {len(points)} → {len(pts)} points (제거: {len(points) - len(pts)})")
    return pts, cols


# ─────────────────────────────────────────────
# 3. 바닥면 검출 + 좌표 정렬
# ─────────────────────────────────────────────

def detect_floor_and_align(points, colors, distance_threshold=0.15, ransac_n=3, num_iterations=2000):
    """
    RANSAC으로 가장 큰 수평 평면(바닥)을 찾고,
    바닥이 z=0이 되도록 좌표계를 회전/이동시킨다.
    """
    print("[3/9] 바닥면 검출 (RANSAC)...")
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)

    # RANSAC plane segmentation
    plane_model, inliers = pcd.segment_plane(
        distance_threshold=distance_threshold,
        ransac_n=ransac_n,
        num_iterations=num_iterations,
    )
    a, b, c, d = plane_model
    normal = np.array([a, b, c])
    normal = normal / np.linalg.norm(normal)

    print(f"  → 평면 법선: [{a:.3f}, {b:.3f}, {c:.3f}], d={d:.3f}")
    print(f"  → 바닥 inlier: {len(inliers)} points")

    # 법선이 아래를 가리키면 뒤집기
    if normal[2] < 0:
        normal = -normal
        d = -d

    # 좌표 정렬: 법선 → z축이 되도록 회전
    print("[4/9] 좌표계 정렬 (바닥 → XY 평면)...")
    z_axis = np.array([0, 0, 1.0])
    v = np.cross(normal, z_axis)
    s = np.linalg.norm(v)
    c_val = np.dot(normal, z_axis)

    if s < 1e-6:
        # 이미 정렬됨
        R = np.eye(3)
    else:
        vx = np.array([
            [0, -v[2], v[1]],
            [v[2], 0, -v[0]],
            [-v[1], v[0], 0]
        ])
        R = np.eye(3) + vx + vx @ vx * ((1 - c_val) / (s ** 2))

    # 회전 적용
    aligned = (R @ points.T).T

    # 바닥 높이를 z=0으로 이동
    floor_z = np.median(aligned[inliers, 2])
    aligned[:, 2] -= floor_z

    print(f"  → 바닥 z 오프셋: {floor_z:.3f}")
    return aligned, colors, R, floor_z


# ─────────────────────────────────────────────
# 4. 벽 구간 필터링
# ─────────────────────────────────────────────

def filter_wall_height(points, colors, z_min=0.3, z_max=2.2):
    """
    바닥 바로 위(0~z_min)와 천장 위(z_max~)를 제거하고,
    벽 높이 구간의 점만 남긴다.
    """
    print(f"[5/9] 벽 높이 필터링 (z: {z_min}m ~ {z_max}m)...")
    mask = (points[:, 2] >= z_min) & (points[:, 2] <= z_max)
    filtered = points[mask]
    cols = colors[mask]
    print(f"  → {len(points)} → {len(filtered)} points")
    return filtered, cols


# ─────────────────────────────────────────────
# 5. XY 투영 → Occupancy Grid
# ─────────────────────────────────────────────

def create_occupancy_grid(points, resolution=0.05):
    """
    XY 평면 투영 후 2D occupancy grid(이미지) 생성.
    resolution: 그리드 한 칸의 실제 크기 (미터)
    """
    print(f"[6/9] XY 투영 → Occupancy Grid (해상도: {resolution}m)...")
    xy = points[:, :2]

    x_min, y_min = xy.min(axis=0)
    x_max, y_max = xy.max(axis=0)

    # 여유 마진
    margin = 0.5  # 50cm
    x_min -= margin
    y_min -= margin
    x_max += margin
    y_max += margin

    width = int(np.ceil((x_max - x_min) / resolution))
    height = int(np.ceil((y_max - y_min) / resolution))

    print(f"  → 그리드 크기: {width} x {height} px")
    print(f"  → 실제 범위: {x_max - x_min:.1f}m x {y_max - y_min:.1f}m")

    # occupancy 채우기
    grid = np.zeros((height, width), dtype=np.uint8)
    for x, y in xy:
        col = int((x - x_min) / resolution)
        row = int((y - y_min) / resolution)
        col = min(col, width - 1)
        row = min(row, height - 1)
        grid[row, col] = 255

    return grid, x_min, y_min, resolution


# ─────────────────────────────────────────────
# 6. Morphology → Contour 추출
# ─────────────────────────────────────────────

def extract_contours(grid, kernel_size=5, iterations=3):
    """
    Morphology 연산으로 점들을 연결하고,
    가장 큰 외곽 contour를 추출한다.
    """
    print("[7/9] Morphology + Contour 추출...")

    # Dilation: 점들을 연결
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    dilated = cv2.dilate(grid, kernel, iterations=iterations)

    # Closing: 빈틈 채우기
    closed = cv2.morphologyEx(dilated, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Contour 검출
    contours, hierarchy = cv2.findContours(
        closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    if not contours:
        print("  → 경고: contour를 찾지 못했습니다!")
        return [], closed

    # 면적 기준 정렬
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    print(f"  → {len(contours)} contour(s) 발견, 최대 면적: {cv2.contourArea(contours[0]):.0f} px²")
    return contours, closed


# ─────────────────────────────────────────────
# 7. Polygon 단순화 + 직교 보정
# ─────────────────────────────────────────────

def simplify_polygon(contour, x_min, y_min, resolution, epsilon_ratio=0.02):
    """
    contour를 단순화하고, 실제 미터 좌표로 변환한다.
    """
    print("[8/9] Polygon 단순화...")

    perimeter = cv2.arcLength(contour, True)
    epsilon = epsilon_ratio * perimeter
    approx = cv2.approxPolyDP(contour, epsilon, True)

    # 픽셀 → 미터 좌표 변환
    polygon_m = []
    for pt in approx:
        px_col, px_row = pt[0]
        x_m = px_col * resolution + x_min
        y_m = px_row * resolution + y_min
        polygon_m.append([round(x_m, 3), round(y_m, 3)])

    print(f"  → {len(contour)} → {len(approx)} vertices")
    return polygon_m, approx


def compute_room_bounds(polygon_m):
    """polygon에서 bounding box 크기 계산"""
    arr = np.array(polygon_m)
    x_min, y_min = arr.min(axis=0)
    x_max, y_max = arr.max(axis=0)
    w = round(x_max - x_min, 2)
    h = round(y_max - y_min, 2)
    return w, h


# ─────────────────────────────────────────────
# 8. 시각화 + 저장
# ─────────────────────────────────────────────

def draw_floorplan_image(grid, contours_approx, closed_img, output_dir):
    """Top-view 평면도 이미지 생성 및 저장"""
    print("[9/9] 평면도 이미지 생성...")

    # 1) Raw occupancy grid
    cv2.imwrite(str(output_dir / "01_occupancy_raw.png"), grid)

    # 2) Morphology 결과
    cv2.imwrite(str(output_dir / "02_morphology.png"), closed_img)

    # 3) 최종 평면도
    h, w = closed_img.shape[:2]
    canvas = np.ones((h, w, 3), dtype=np.uint8) * 255  # 흰 배경

    # morphology 결과를 연한 회색으로
    mask = closed_img > 0
    canvas[mask] = [220, 220, 220]

    # contour 그리기
    for i, approx in enumerate(contours_approx):
        color = (40, 40, 40) if i == 0 else (150, 150, 150)
        thickness = 3 if i == 0 else 1
        cv2.drawContours(canvas, [approx], -1, color, thickness)

    # 4) 축척 바 (1m)
    scale_px = int(1.0 / 0.05)  # 1m를 resolution(0.05)으로 나눈 값 → 20px
    bar_y = h - 30
    bar_x = 30
    cv2.line(canvas, (bar_x, bar_y), (bar_x + scale_px, bar_y), (0, 0, 0), 2)
    cv2.putText(canvas, "1m", (bar_x + scale_px // 3, bar_y - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

    floorplan_path = output_dir / "03_floorplan.png"
    cv2.imwrite(str(floorplan_path), canvas)
    print(f"  → 저장: {floorplan_path}")

    return floorplan_path


def save_rooms_json(polygon_m, bounds_w, bounds_h, output_dir):
    """가구 배치 알고리즘용 rooms.json 저장"""
    rooms_data = {
        "meta": {
            "version": "1.0",
            "unitSystem": "metric",
            "source": "MoveViz - COLMAP sparse → floorplan",
            "note": "COLMAP sparse reconstruction 기반 추정치. 실제 치수와 차이가 있을 수 있음."
        },
        "rooms": [
            {
                "id": "room_01",
                "label": "스캔된 공간",
                "bounds": {
                    "w": bounds_w,
                    "h": bounds_h
                },
                "polygon": polygon_m,
                "openings": []
            }
        ]
    }

    json_path = output_dir / "rooms.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(rooms_data, f, ensure_ascii=False, indent=2)

    print(f"  → 저장: {json_path}")
    return rooms_data


# ─────────────────────────────────────────────
# Main Pipeline
# ─────────────────────────────────────────────

def run_pipeline(input_path, output_dir, resolution=0.05,
                 z_min=0.3, z_max=2.2,
                 kernel_size=5, morph_iterations=3,
                 epsilon_ratio=0.02):
    """전체 파이프라인 실행"""

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("MoveViz — Sparse Point Cloud → Floor Plan Extractor")
    print("=" * 60)

    # Step 1: 포인트 클라우드 로드
    points, colors = load_point_cloud(input_path)

    if len(points) < 100:
        print("에러: 포인트가 너무 적습니다 (최소 100개 필요)")
        return None

    # Step 2: Outlier 제거
    points, colors = remove_outliers(points, colors)

    # Step 3-4: 바닥 검출 + 좌표 정렬
    points, colors, rotation, floor_offset = detect_floor_and_align(points, colors)

    # Step 5: 벽 높이 필터링
    wall_points, wall_colors = filter_wall_height(points, colors, z_min=z_min, z_max=z_max)

    if len(wall_points) < 50:
        print("경고: 벽 구간 포인트가 너무 적습니다. z 범위를 넓힙니다...")
        wall_points, wall_colors = filter_wall_height(points, colors, z_min=0.1, z_max=3.0)

    # Step 6: Occupancy Grid
    grid, x_min, y_min, res = create_occupancy_grid(wall_points, resolution=resolution)

    # Step 7: Contour 추출
    contours, closed_img = extract_contours(grid, kernel_size=kernel_size, iterations=morph_iterations)

    if not contours:
        print("실패: 외곽선을 추출하지 못했습니다.")
        # 그래도 raw grid는 저장
        cv2.imwrite(str(output_dir / "01_occupancy_raw.png"), grid)
        return None

    # Step 8: Polygon 단순화 (상위 3개까지)
    polygons = []
    approxes = []
    for i, cnt in enumerate(contours[:3]):
        poly_m, approx = simplify_polygon(cnt, x_min, y_min, resolution, epsilon_ratio)
        polygons.append(poly_m)
        approxes.append(approx)

    # 가장 큰 polygon의 bounds
    main_polygon = polygons[0]
    bounds_w, bounds_h = compute_room_bounds(main_polygon)
    print(f"\n  ★ 추정 방 크기: {bounds_w}m × {bounds_h}m")

    # Step 9: 시각화 + 저장
    draw_floorplan_image(grid, approxes, closed_img, output_dir)
    rooms_data = save_rooms_json(main_polygon, bounds_w, bounds_h, output_dir)

    # 전체 포인트 통계도 저장
    stats = {
        "total_points_loaded": int(len(points)),
        "wall_points_used": int(len(wall_points)),
        "grid_resolution_m": resolution,
        "estimated_width_m": bounds_w,
        "estimated_height_m": bounds_h,
        "polygon_vertices": len(main_polygon),
        "z_filter": {"min": z_min, "max": z_max},
    }
    with open(output_dir / "stats.json", "w") as f:
        json.dump(stats, f, indent=2)

    print("\n" + "=" * 60)
    print("완료!")
    print(f"  출력 폴더: {output_dir}")
    print(f"  - 01_occupancy_raw.png  (원본 XY 투영)")
    print(f"  - 02_morphology.png     (morphology 처리)")
    print(f"  - 03_floorplan.png      (최종 평면도)")
    print(f"  - rooms.json            (가구 배치용 JSON)")
    print(f"  - stats.json            (처리 통계)")
    print(f"  ★ 추정 크기: {bounds_w}m × {bounds_h}m")
    print("=" * 60)

    return rooms_data


# ─────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MoveViz: Sparse Point Cloud → Floor Plan")
    parser.add_argument("--input", "-i", required=True,
                        help="입력 경로: .ply 파일 또는 COLMAP sparse 폴더")
    parser.add_argument("--output", "-o", default="./output",
                        help="출력 폴더 (기본: ./output)")
    parser.add_argument("--resolution", "-r", type=float, default=0.05,
                        help="Grid 해상도 (미터, 기본: 0.05)")
    parser.add_argument("--z-min", type=float, default=0.3,
                        help="벽 시작 높이 (기본: 0.3m)")
    parser.add_argument("--z-max", type=float, default=2.2,
                        help="벽 끝 높이 (기본: 2.2m)")
    parser.add_argument("--kernel", type=int, default=5,
                        help="Morphology 커널 크기 (기본: 5)")
    parser.add_argument("--morph-iter", type=int, default=3,
                        help="Dilation 반복 횟수 (기본: 3)")
    parser.add_argument("--epsilon", type=float, default=0.02,
                        help="Polygon 단순화 비율 (기본: 0.02)")

    args = parser.parse_args()

    run_pipeline(
        input_path=args.input,
        output_dir=args.output,
        resolution=args.resolution,
        z_min=args.z_min,
        z_max=args.z_max,
        kernel_size=args.kernel,
        morph_iterations=args.morph_iter,
        epsilon_ratio=args.epsilon,
    )
