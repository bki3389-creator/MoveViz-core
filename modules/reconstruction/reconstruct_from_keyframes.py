#!/usr/bin/env python3
"""비-라이다 카메라 스캔(키프레임+ARKit 포즈) → 메트릭 스케일 방 메시.

핵심 원리 (폴리캠/Scaniverse류가 비-라이다 폰에서도 정확한 실측 치수를 내는 이유):
ARKit의 ARWorldTrackingConfiguration은 카메라 영상만으로 포즈를 "추정"하는 게
아니라, IMU(가속도계)를 함께 융합하는 **VIO(Visual-Inertial Odometry)** 다.
중력 가속도 크기가 알려져 있어 IMU가 스케일을 관측 가능하게 만들어주므로,
LiDAR/스테레오 없이도 카메라 이동거리가 실제 미터 단위로 나온다 — 순수 단안
SfM(예: COLMAP, VGGT)이 스케일을 원천적으로 못 정하는 것과 근본적으로 다르다.
(iOS KeyframeRecorder가 저장하는 poses.json의 cam_to_world가 바로 이 값.)

즉 이 카메라 모드는 "포즈를 추정해야 하는 어려운 문제"가 이미 캡처 시점에
공짜로 풀려있다 — video2mesh.py/vggt2mesh.py가 실패했던 지점(포즈 추정)이
아예 없다. 남은 일은 프레임별 단안 메트릭 깊이(Depth Anything V2)를 그
알려진 포즈에 얹어 TSDF로 융합하는 것뿐이다.

사용 (.venv312 — open3d 필요, py3.13 메인 venv엔 없음):
  .venv312/bin/python reconstruct_from_keyframes.py <keyframes_dir> <out.glb>
"""

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np


def arkit_to_cv_pose(ark_cam_to_world):
    """ARKit 카메라(-Z forward,+Y up) → OpenCV(+Z forward,+Y down) cam_to_world.
    (colorize_vertices.arkit_to_cv_pose와 동일 로직 — venv 경계로 인해 자체 포함.)"""
    M = np.asarray(ark_cam_to_world, float).copy()
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    return M @ flip


def gravity_rotation_k(cam_to_world_cv):
    """월드 상방(+Y)이 이미지 위쪽을 향하게 하는 np.rot90 회전수 k∈{0,1,2,3}.
    detect_furniture_vision.gravity_rotation_k와 동일 로직(육안 A/B + roundtrip 검증됨).
    깊이 모델은 정립 이미지(바닥 아래) 장면 사전확률로 학습되어, ARKit가 가로
    센서 방향으로 저장한 세로 스캔 프레임을 그대로 넣으면 메트릭 정확도가 떨어진다
    → 세워서 추론하고 깊이맵만 원래 방향으로 되돌린다(포즈/K는 원본 좌표 유지)."""
    R = np.asarray(cam_to_world_cv, float)[:3, :3]
    up_cam = R.T @ np.array([0.0, 1.0, 0.0])
    gx, gy = float(up_cam[0]), float(up_cam[1])
    if abs(gy) >= abs(gx):
        return 0 if gy < 0 else 2
    return 1 if gx > 0 else 3


def find_poses_json(root):
    for r, _, files in os.walk(root):
        if "poses.json" in files:
            return os.path.join(r, "poses.json"), r
    return None, None


def load_posed_frames(keyframes_dir, size):
    """poses.json + 이미지 → [(rgb, K_scaled, cam_to_world_cv)], 리사이즈 반영."""
    posefile, imgdir = find_poses_json(keyframes_dir)
    if posefile is None:
        sys.exit(f"[error] poses.json not found under {keyframes_dir}")
    meta = json.load(open(posefile))
    frames = []
    for m in meta:
        path = os.path.join(imgdir, m["image"])
        bgr = cv2.imread(path)
        if bgr is None:
            continue
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h0, w0 = rgb.shape[:2]
        scale = size / max(h0, w0)
        if scale < 1.0:
            rgb = cv2.resize(rgb, (round(w0 * scale), round(h0 * scale)),
                             interpolation=cv2.INTER_AREA)
        K = np.array(m["K"], float) * scale
        K[2, 2] = 1.0
        c2w = m["cam_to_world"]
        if m.get("convention", "opencv").lower() == "arkit":
            c2w = arkit_to_cv_pose(c2w)
        frames.append((rgb, K, np.asarray(c2w, float)))
    return frames


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("keyframes_dir")
    ap.add_argument("out_glb")
    ap.add_argument("--model", default="indoor-small",
                    choices=["indoor-small", "indoor-base", "outdoor-small", "outdoor-base"])
    ap.add_argument("--size", type=int, default=640, help="깊이 추론 해상도(긴 변)")
    ap.add_argument("--depth-min", type=float, default=0.15)
    ap.add_argument("--depth-max", type=float, default=8.0,
                    help="실내 스캔 기준 최대 깊이(m)")
    ap.add_argument("--voxel", type=float, default=0.02, help="TSDF 복셀 크기(m)")
    ap.add_argument("--stride", type=int, default=1, help="N프레임마다 1장만 사용")
    args = ap.parse_args()

    t0 = time.time()
    print(f"[recon] loading posed frames from {args.keyframes_dir}", flush=True)
    frames = load_posed_frames(args.keyframes_dir, args.size)
    frames = frames[::args.stride]
    if len(frames) < 5:
        sys.exit(f"[error] too few posed frames ({len(frames)}) — need real capture")
    h, w = frames[0][0].shape[:2]
    print(f"[recon] {len(frames)} frames, {w}x{h}", flush=True)

    import open3d as o3d
    import torch
    import trimesh
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    device = torch.device("mps" if torch.backends.mps.is_available()
                          else "cuda" if torch.cuda.is_available() else "cpu")
    repo = {
        "indoor-small": "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",
        "indoor-base": "depth-anything/Depth-Anything-V2-Metric-Indoor-Base-hf",
        "outdoor-small": "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf",
        "outdoor-base": "depth-anything/Depth-Anything-V2-Metric-Outdoor-Base-hf",
    }[args.model]
    print(f"[recon] loading {repo} on {device}", flush=True)
    processor = AutoImageProcessor.from_pretrained(repo)
    model = AutoModelForDepthEstimation.from_pretrained(repo).to(device).eval()

    @torch.inference_mode()
    def infer_depth(rgb):
        inputs = processor(images=rgb, return_tensors="pt").to(device)
        out = model(**inputs)
        d = torch.nn.functional.interpolate(
            out.predicted_depth.unsqueeze(1), size=rgb.shape[:2],
            mode="bilinear", align_corners=False)
        return d.squeeze().float().cpu().numpy()

    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=args.voxel, sdf_trunc=args.voxel * 5,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)

    depth_stats = []
    for i, (rgb, K, c2w) in enumerate(frames):
        # 중력 기준으로 세워서 깊이 추론 → 깊이맵을 원본 방향으로 복원.
        k = gravity_rotation_k(c2w)
        depth = infer_depth(np.ascontiguousarray(np.rot90(rgb, k)))
        depth = np.ascontiguousarray(np.rot90(depth, -k)).astype(np.float32)
        depth[(depth < args.depth_min) | (depth > args.depth_max)] = 0.0
        depth[~np.isfinite(depth)] = 0.0
        depth_stats.append(float(np.median(depth[depth > 0])) if (depth > 0).any() else 0.0)

        intr = o3d.camera.PinholeCameraIntrinsic(
            w, h, K[0, 0], K[1, 1], K[0, 2], K[1, 2])
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.ascontiguousarray(rgb)),
            o3d.geometry.Image(np.ascontiguousarray(depth)),
            depth_scale=1.0, depth_trunc=args.depth_max, convert_rgb_to_intensity=False)
        extrinsic = np.linalg.inv(c2w)   # world-to-camera (알려진 ARKit 포즈, 추정 아님)
        volume.integrate(rgbd, intr, extrinsic)
        if i % 20 == 0:
            print(f"  integrate {i}/{len(frames)}", flush=True)

    mesh = volume.extract_triangle_mesh()
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()

    clusters, n_tris, _ = mesh.cluster_connected_triangles()
    clusters, n_tris = np.asarray(clusters), np.asarray(n_tris)
    min_tris = max(100, int(0.001 * len(mesh.triangles)))
    mesh.remove_triangles_by_mask(~(n_tris[clusters] >= min_tris))
    mesh.remove_unreferenced_vertices()

    if len(mesh.triangles) == 0:
        sys.exit("[error] empty mesh — depth/pose data may be invalid")

    vertices = np.asarray(mesh.vertices)          # ARKit Y-up world 그대로(변환 없음)
    faces = np.asarray(mesh.triangles)
    colors = (np.clip(np.asarray(mesh.vertex_colors), 0, 1) * 255).astype(np.uint8)
    tm = trimesh.Trimesh(vertices=vertices, faces=faces, vertex_colors=colors, process=False)
    tm.update_faces(tm.area_faces > 1e-9)
    tm.export(args.out_glb)

    bbox = vertices.max(0) - vertices.min(0)
    metrics = {
        "n_frames": len(frames), "n_vertices": int(len(tm.vertices)),
        "n_faces": int(len(tm.faces)), "bbox_size_m": [float(x) for x in bbox],
        "median_depth_m": round(float(np.median(depth_stats)), 2),
        "runtime_s": round(time.time() - t0, 1),
        "notes": ("ARKit VIO 실측 포즈(추정 아님) 앵커 + DepthAnythingV2 메트릭 깊이 → "
                 f"TSDF({args.voxel}m 복셀) 융합. World frame = ARKit 원본(Y-up, 미변환)."),
    }
    with open(os.path.splitext(args.out_glb)[0] + "_metrics.json", "w") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)
    print(json.dumps(metrics, indent=2, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
