#!/usr/bin/env python3
"""colorize_vertices.py — 메시 위 이미지 매핑(텍스처링)의 코어: projective vertex coloring.

폴리캠/OpenMVS의 "Let There Be Color!"(Waechter 2014) 계열을 정점 단위로 단순화한 구현.
입력: 메시 + 포즈가 있는 RGB 프레임들(image, intrinsics K, camera→world transform).
각 정점을 각 카메라에 투영 → 가시성 판정 → 정면도 가중 평균으로 정점 색을 채운다.
우리 PLY/GLB 파이프라인이 정점색을 이미 지원하므로(PLYExporter RGB) 가장 적은 변경으로 색이 붙는다.

좌표 규약(내부): OpenCV 카메라 — +X 오른쪽, +Y 아래, +Z 앞(forward).
  K = [[fx,0,cx],[0,fy,cy],[0,0,1]],  cam_to_world = 카메라 축의 월드 표현(4x4).
  ARKit(-Z forward, +Y up)에서 올 때는 to_cv_pose()로 변환(아래 제공).

검증: `python colorize_vertices.py --selftest` (합성 데이터, iOS/실기기 불필요).
"""
from __future__ import annotations
import numpy as np

DEFAULT_COLOR = np.array([180, 180, 180], np.uint8)


# ── 투영 ────────────────────────────────────────────────────────────────
def project_points(points_w, K, cam_to_world, w, h):
    """월드 점 → 픽셀 좌표(u,v) + 카메라 깊이 z + 유효 마스크.
    OpenCV 규약(+Z forward). 반환 uv는 float 픽셀."""
    points_w = np.asarray(points_w, float)
    world_to_cam = np.linalg.inv(np.asarray(cam_to_world, float))
    n = len(points_w)
    homo = np.c_[points_w, np.ones(n)]
    pc = (world_to_cam @ homo.T).T[:, :3]          # 카메라 공간
    z = pc[:, 2]
    safe = z > 1e-6
    zc = np.where(safe, z, 1.0)
    u = K[0, 0] * pc[:, 0] / zc + K[0, 2]
    v = K[1, 1] * pc[:, 1] / zc + K[1, 2]
    in_img = (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1)
    valid = safe & in_img
    return np.stack([u, v], 1), z, valid


def bilinear_sample(img, uv):
    """img(HxWx3) 에서 uv(float 픽셀) 양선형 샘플 → (N,3) float."""
    h, w = img.shape[:2]
    u = np.clip(uv[:, 0], 0, w - 1)
    v = np.clip(uv[:, 1], 0, h - 1)
    x0 = np.floor(u).astype(int); y0 = np.floor(v).astype(int)
    x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    fx = (u - x0)[:, None]; fy = (v - y0)[:, None]
    img = img.astype(float)
    c = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
         + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)
    return c


# ── 가시성 ──────────────────────────────────────────────────────────────
def frontal_weight(vertex_normals, vertices, cam_pos):
    """정점 법선과 '정점→카메라' 방향의 정렬도(>0=정면). 가중치 + back-face 컬링용."""
    view = cam_pos[None, :] - vertices
    view /= (np.linalg.norm(view, axis=1, keepdims=True) + 1e-9)
    return np.einsum("ij,ij->i", vertex_normals, view)   # cos각, [-1,1]


def raycast_visible(mesh, vertices, vertex_normals, cam_pos):
    """trimesh 레이캐스트로 오클루전 판정(오목 메시용, 느림). 가려지면 False."""
    origins = cam_pos[None, :].repeat(len(vertices), 0)
    dirs = vertices - origins
    dist = np.linalg.norm(dirs, axis=1)
    dirs /= (dist[:, None] + 1e-9)
    # 자기 면과의 자가교차 방지: 표면에서 살짝 띄움
    locs, idx_ray, _ = mesh.ray.intersects_location(
        ray_origins=origins, ray_directions=dirs, multiple_hits=False)
    first = np.full(len(vertices), np.inf)
    for loc, ir in zip(locs, idx_ray):
        d = np.linalg.norm(loc - origins[ir])
        if d < first[ir]:
            first[ir] = d
    # 첫 충돌이 정점보다 충분히 앞이면 가림
    return first >= (dist - 1e-2)


# ── 코어: 정점 색칠 ──────────────────────────────────────────────────────
def colorize(mesh, views, occlusion="normal", min_frontal=0.10):
    """mesh + views([{image,K,cam_to_world}]) → (N,4) uint8 RGBA 정점색.
    occlusion: 'normal'(back-face 컬링, convex에 정확/빠름) | 'raycast'(오목, 느림) | 'none'.
    정면도(frontal)로 가중 평균. 가시 프레임이 없으면 DEFAULT_COLOR."""
    V = np.asarray(mesh.vertices, float)
    N = mesh.vertex_normals
    acc = np.zeros((len(V), 3), float)
    wsum = np.zeros(len(V), float)

    for vw in views:
        img = vw["image"]; K = np.asarray(vw["K"], float); c2w = np.asarray(vw["cam_to_world"], float)
        h, w = img.shape[:2]
        uv, z, valid = project_points(V, K, c2w, w, h)
        cam_pos = c2w[:3, 3]
        fw = frontal_weight(N, V, cam_pos)
        vis = valid & (fw > min_frontal)
        if occlusion == "raycast" and vis.any():
            ok = np.zeros(len(V), bool)
            sub = np.where(vis)[0]
            rc = raycast_visible(mesh, V[sub], N[sub], cam_pos)
            ok[sub] = rc
            vis &= ok
        if not vis.any():
            continue
        cols = bilinear_sample(img, uv[vis])           # (M,3)
        weight = fw[vis]                                 # 정면일수록 큰 가중
        acc[vis] += cols * weight[:, None]
        wsum[vis] += weight

    out = np.tile(DEFAULT_COLOR, (len(V), 1)).astype(float)
    colored = wsum > 1e-6
    out[colored] = acc[colored] / wsum[colored, None]
    rgba = np.c_[np.clip(out, 0, 255).astype(np.uint8), np.full(len(V), 255, np.uint8)]
    coverage = float(colored.mean())
    return rgba, coverage


# ── ARKit → OpenCV 포즈 변환 (iOS 캡처 연동용) ────────────────────────────
def arkit_to_cv_pose(ark_cam_to_world):
    """ARKit 카메라(-Z forward,+Y up) → OpenCV(+Z forward,+Y down) cam_to_world.
    카메라 로컬 축에 diag(1,-1,-1) 적용(Y,Z 뒤집기)."""
    M = np.asarray(ark_cam_to_world, float).copy()
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    return M @ flip


# ── I/O: 폴더에서 views 로드 (image_*.jpg + poses.json) ───────────────────
def load_views(folder):
    """folder/poses.json = [{"image":"f0.jpg","K":[[..]],"cam_to_world":[[..]],"convention":"arkit"|"opencv"}, ...]
    iOS KeyframeRecorder가 쓰는 포맷. convention=="arkit"이면 OpenCV 포즈로 변환."""
    import os, json, cv2
    meta = json.load(open(os.path.join(folder, "poses.json")))
    views = []
    for m in meta:
        bgr = cv2.imread(os.path.join(folder, m["image"]))
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        c2w = m["cam_to_world"]
        if m.get("convention", "opencv").lower() == "arkit":
            c2w = arkit_to_cv_pose(c2w).tolist()
        views.append({"image": rgb, "K": m["K"], "cam_to_world": c2w})
    return views


# ─────────────────────────────────────────────────────────────────────────
def _cube(size=1.0, subdiv=True):
    import trimesh
    m = trimesh.creation.box(extents=(size, size, size))
    if subdiv:
        m = m.subdivide().subdivide()
    return m


def _look_at(eye, target, up=(0, -1, 0)):
    """OpenCV cam_to_world: +Z가 target을 향하도록(+Y 아래)."""
    eye = np.asarray(eye, float); target = np.asarray(target, float); up = np.asarray(up, float)
    z = target - eye; z /= np.linalg.norm(z)          # forward(+Z)
    x = np.cross(up, z); x /= np.linalg.norm(x)        # right(+X)
    y = np.cross(z, x)                                  # down(+Y)
    M = np.eye(4); M[:3, 0] = x; M[:3, 1] = y; M[:3, 2] = z; M[:3, 3] = eye
    return M


def _render_face_colors(mesh, face_colors, K, c2w, w, h):
    """painter's algorithm로 면을 깊이순 채워 합성 이미지 생성(검증용 미니 래스터라이저)."""
    import cv2
    img = np.zeros((h, w, 3), np.uint8)
    tris = mesh.vertices[mesh.faces]                    # (F,3,3)
    world_to_cam = np.linalg.inv(c2w)
    # 면 중심 깊이로 정렬(먼 것 먼저)
    centers = tris.mean(1)
    cc = (world_to_cam @ np.c_[centers, np.ones(len(centers))].T).T[:, 2]
    order = np.argsort(-cc)
    fn = mesh.face_normals
    for f in order:
        if cc[f] <= 0:
            continue
        # back-face 컬링(카메라가 보는 면만)
        cam_pos = c2w[:3, 3]
        if np.dot(fn[f], cam_pos - centers[f]) <= 0:
            continue
        uv, z, valid = project_points(tris[f], K, c2w, w, h)
        if not valid.all():
            continue
        pts = uv.astype(np.int32)
        col = tuple(int(x) for x in face_colors[f])
        cv2.fillConvexPoly(img, pts, col)
    return img


def selftest():
    """합성 데이터로 정확성 증명: ① 투영 수식 ② 단일 이미지 샘플 정확도 ③ 멀티뷰 큐브 복원."""
    import cv2
    ok_all = True

    # ── 테스트 ①: 투영 수식 (손계산과 일치) ──
    K = np.array([[500, 0, 320], [0, 500, 240], [0, 0, 1]], float)
    c2w = np.eye(4); c2w[2, 3] = -2.0   # 카메라가 z=-2, +Z 바라봄
    p = np.array([[0, 0, 0]])           # 원점 점 → 카메라 정면 z=2
    uv, z, valid = project_points(p, K, c2w, 640, 480)
    exp = np.array([320.0, 240.0])      # 광축 중심
    t1 = valid[0] and np.allclose(uv[0], exp, atol=1e-6) and abs(z[0] - 2.0) < 1e-6
    print(f"  ① 투영 수식: {'PASS' if t1 else 'FAIL'}  uv={uv[0]}, z={z[0]:.3f}")
    ok_all &= t1

    # ── 테스트 ②: 알려진 픽셀 색 round-trip ──
    img = np.zeros((480, 640, 3), np.uint8)
    img[240, 320] = [200, 50, 30]       # 정확히 투영될 픽셀에 색
    sampled = bilinear_sample(img, uv)
    t2 = np.allclose(sampled[0], [200, 50, 30], atol=1.0)
    print(f"  ② 픽셀 샘플 round-trip: {'PASS' if t2 else 'FAIL'}  sampled={sampled[0]}")
    ok_all &= t2

    # ── 테스트 ③: 멀티뷰 큐브 색 복원 ──
    mesh = _cube(1.0, subdiv=True)
    F = len(mesh.faces)
    rng = np.random.default_rng(0)
    # 6면을 6색으로(같은 방향 면 = 같은 색)
    palette = np.array([[230, 40, 40], [40, 200, 40], [40, 60, 230],
                        [230, 200, 40], [200, 40, 230], [40, 220, 220]], float)
    fn = mesh.face_normals
    axis = np.argmax(np.abs(fn), 1) * 2 + (fn[np.arange(F), np.argmax(np.abs(fn), 1)] > 0)
    face_colors = palette[axis.astype(int)]
    # 6면을 정면으로 보는 카메라 6개
    cams = []
    for d in [(0, 0, 1), (0, 0, -1), (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)]:
        d = np.array(d, float)
        up = (0, -1, 0) if abs(d[1]) < 0.9 else (0, 0, 1)
        cams.append(_look_at(d * 3, (0, 0, 0), up))
    views = []
    for c2w in cams:
        im = _render_face_colors(mesh, face_colors, K, c2w, 640, 480)
        views.append({"image": im, "K": K, "cam_to_world": c2w})
    rgba, cov = colorize(mesh, views, occlusion="normal", min_frontal=0.2)

    # 각 면 중심에 해당하는 정점들의 복원색을 그 면 색과 비교
    # (면 중심 정점: 한 면 안쪽 정점은 그 면 색과 일치해야 함)
    rgb = rgba[:, :3].astype(float)
    # 정점별 '지배 축'으로 기대색 매핑
    vn = mesh.vertex_normals
    dom = np.argmax(np.abs(vn), 1)
    strong = np.abs(vn[np.arange(len(vn)), dom]) > 0.9   # 면 중앙부 정점(법선이 축에 정렬)
    vaxis = dom * 2 + (vn[np.arange(len(vn)), dom] > 0)
    expected = palette[vaxis.astype(int)]
    err = np.linalg.norm(rgb[strong] - expected[strong], axis=1)
    t3 = (cov > 0.95) and (np.median(err) < 25)
    print(f"  ③ 멀티뷰 큐브 복원: {'PASS' if t3 else 'FAIL'}  "
          f"coverage={cov*100:.0f}%, 면중앙정점 색오차(median)={np.median(err):.1f}")
    ok_all &= t3

    print(f"\n  === colorize_vertices 셀프테스트: {'ALL PASS ✅' if ok_all else 'FAIL ❌'} ===")
    return ok_all


def main():
    import argparse, sys
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--mesh", help="입력 메시(.glb/.ply/.obj)")
    ap.add_argument("--views", help="views 폴더(poses.json + 이미지)")
    ap.add_argument("--out", default="colored.ply")
    ap.add_argument("--occlusion", default="normal", choices=["normal", "raycast", "none"])
    a = ap.parse_args()
    if a.selftest:
        sys.exit(0 if selftest() else 1)
    if not (a.mesh and a.views):
        ap.error("--mesh 와 --views 가 필요합니다 (또는 --selftest)")
    import trimesh
    mesh = trimesh.load(a.mesh, force="mesh")
    views = load_views(a.views)
    rgba, cov = colorize(mesh, views, occlusion=a.occlusion)
    attach_vertex_colors(mesh, rgba)
    mesh.export(a.out)
    print(f"저장: {a.out}  (coverage {cov*100:.0f}%, {len(views)}뷰)")


def attach_vertex_colors(mesh, rgba):
    """입력 메시의 visual 종류(Texture/Color)와 무관하게 정점색을 강제 부여.
    GLB는 보통 TextureVisuals라 vertex_colors 세터가 안 먹으므로 ColorVisuals로 교체."""
    import trimesh
    mesh.visual = trimesh.visual.color.ColorVisuals(mesh=mesh, vertex_colors=rgba)
    return mesh


if __name__ == "__main__":
    main()
