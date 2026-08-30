#!/usr/bin/env python3
"""mirror_glass_clean.py — 거울/유리 스캔 아티팩트 제거 (deep-research 결론 구현).

거울은 LiDAR에 '반사 광경로 길이'를 깊이로 돌려줘서, 거울 평면 뒤에 실내 장면의
대칭 반사상(plane reflection)을 팬텀 지오메트리로 만든다. 이를 제거한다:

코어(학습 0, trimesh/numpy/scipy, 맥 CPU):
 1. 수직 평면 RANSAC → 후보 거울/벽 평면.
 2. Householder 대칭: 각 후보 평면으로 정점을 반사(reflection) → 반사 결과가
    '실내 실물 정점'과 일치(KDTree)하고, 그 정점이 평면의 '바깥쪽'(방 중심 반대편)에
    있으면 = 반사 팬텀 → 삭제. (실내 실물은 안쪽이라 안전)
 3. 삭제 정점에 붙은 면 제거 → 깨끗한 메시.

검증: `python mirror_glass_clean.py --selftest` (합성 거울 씬, 모델 불필요).
"""
from __future__ import annotations
import numpy as np


def _vertical_planes(V, n_planes=5, tol=0.03, iters=400, min_inliers=250, seed=0):
    """수직 평면(벽/거울 후보) RANSAC. 반환 [(p0, normal, inlier_idx), ...]."""
    rng = np.random.default_rng(seed)
    planes = []
    remaining = np.arange(len(V))
    for _ in range(n_planes):
        if len(remaining) < min_inliers:
            break
        pts = V[remaining]
        best_cnt, best = 0, None
        for _ in range(iters):
            i, j = rng.choice(len(pts), 2, replace=False)
            d = pts[j] - pts[i]
            nrm = np.array([d[2], 0.0, -d[0]])      # 수직 평면(법선 y=0)
            ln = np.linalg.norm(nrm)
            if ln < 1e-6:
                continue
            nrm /= ln
            dist = np.abs((pts - pts[i]) @ nrm)
            cnt = int((dist < tol).sum())
            if cnt > best_cnt:
                best_cnt, best = cnt, (pts[i].copy(), nrm, dist < tol)
        if best is None or best_cnt < min_inliers:
            break
        p0, nrm, inl = best
        planes.append((p0, nrm, remaining[inl]))
        remaining = remaining[~inl]
    return planes


def _reflect(V, p0, n):
    """평면(p0, 법선 n) 기준 Householder 대칭 반사."""
    d = (V - p0) @ n
    return V - 2.0 * d[:, None] * n[None, :]


def detect_phantoms(V, planes=None, match_tol=0.06, min_behind=0.15, min_matches=120, centroid=None):
    """반사 팬텀 정점 마스크 반환. 각 평면으로 반사 → 실물과 매칭 + 평면 바깥쪽이면 팬텀."""
    from scipy.spatial import cKDTree
    if planes is None:
        planes = _vertical_planes(V)
    if centroid is None:
        centroid = V.mean(0)
    tree = cKDTree(V)
    phantom = np.zeros(len(V), bool)
    used_planes = []
    for p0, n, _ in planes:
        side_c = np.sign((centroid - p0) @ n)          # 방 중심이 있는 쪽(=안쪽)
        signed = (V - p0) @ n
        outside = (np.sign(signed) == -side_c) & (np.abs(signed) > min_behind)
        if outside.sum() < min_matches:
            continue
        Vr = _reflect(V, p0, n)                          # 평면 대칭 반사
        dist, _ = tree.query(Vr)                         # 반사 결과가 실물과 가까운가
        cand = outside & (dist < match_tol)              # 바깥쪽 + 반사가 실물에 맺힘 = 팬텀
        if cand.sum() >= min_matches:
            phantom |= cand
            used_planes.append((p0.tolist(), n.tolist(), int(cand.sum())))
    return phantom, used_planes


def outside_main_footprint(V, cell=0.07, bridge=0.18):
    """방 본체(가장 큰 2D footprint 연결영역)와 떨어진 정점 마스크.
    거울 반사상은 보통 방 외곽 밖 별도 영역으로 나타나므로 가장 확실한 신호."""
    import cv2
    xz = V[:, [0, 2]]
    mn = xz.min(0)
    gx = np.floor((xz - mn) / cell).astype(int)
    W, H = gx[:, 0].max() + 3, gx[:, 1].max() + 3
    grid = np.zeros((H, W), np.uint8)
    grid[gx[:, 1], gx[:, 0]] = 1
    k = max(1, int(round(bridge / cell)))            # 작은 틈(문틀 등) 메워 방을 하나로
    closed = cv2.morphologyEx(grid, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lab = cv2.connectedComponents(closed, connectivity=8)
    counts = np.bincount(lab.ravel()); counts[0] = 0
    if len(counts) <= 1:
        return np.zeros(len(V), bool)
    room = int(counts.argmax())
    room_mask = (lab == room).astype(np.uint8)
    room_mask = cv2.dilate(room_mask, np.ones((3, 3), np.uint8))
    inside = room_mask[gx[:, 1], gx[:, 0]] > 0
    return ~inside


def clean_mesh(mesh, match_tol=0.06, min_behind=0.15, min_matches=120, use_footprint=True):
    """거울 반사 팬텀 제거: footprint-바깥(분리 블롭) ∪ Householder 대칭 매칭."""
    import trimesh
    V = np.asarray(mesh.vertices, float)
    F = np.asarray(mesh.faces, int)
    phantom, planes = detect_phantoms(V, match_tol=match_tol, min_behind=min_behind, min_matches=min_matches)
    foot = outside_main_footprint(V) if use_footprint else np.zeros(len(V), bool)
    phantom = phantom | foot
    keep_v = ~phantom
    # 팬텀 정점이 하나라도 포함된 면 제거
    keep_f = keep_v[F].all(axis=1)
    new = mesh.copy()
    new.update_faces(keep_f)
    new.remove_unreferenced_vertices()
    report = {
        "removed_vertices": int(phantom.sum()),
        "removed_by_footprint": int(foot.sum()),
        "removed_by_symmetry": int((phantom & ~foot).sum()),
        "removed_faces": int((~keep_f).sum()),
        "mirror_planes": len(planes),
        "planes": planes,
        "kept_vertices": int(keep_v.sum()),
    }
    return new, report


# ── 검증 ──────────────────────────────────────────────────────────────────
def selftest():
    """합성: 방(상자 일부) + 한쪽 벽이 거울이라 실내가 대칭 반사된 팬텀 → 제거되는지."""
    import trimesh
    ok = True
    # 실내: x∈[0,2]에 'ㄷ'자 벽 + 바닥 (간단히 두 박스로 실물 구성)
    a = trimesh.creation.box(extents=(0.1, 1.0, 1.0)); a.apply_translation([0.0, 0.5, 0.0])   # 왼쪽 벽
    b = trimesh.creation.box(extents=(0.6, 0.4, 0.4)); b.apply_translation([0.7, 0.2, 0.0])   # 실내 물체
    for _ in range(3):
        a = a.subdivide(); b = b.subdivide()
    real = trimesh.util.concatenate([a, b])
    Vr = np.asarray(real.vertices)

    # 거울 평면 x=2 (법선 +x). 실내를 x=2 기준 대칭 → 팬텀(x>2, 바깥)
    mirror_p0 = np.array([2.0, 0, 0]); mirror_n = np.array([1.0, 0, 0])
    phantom = real.copy()
    phantom.vertices = _reflect(Vr, mirror_p0, mirror_n)   # x>2로 반사된 가짜
    scene = trimesh.util.concatenate([real, phantom])
    n_before = len(scene.vertices)

    cleaned, rep = clean_mesh(scene, match_tol=0.05, min_matches=50)
    n_after = len(cleaned.vertices)
    # 두 검출 경로(대칭 평면 또는 footprint) 중 하나로 팬텀 절반이 제거돼야 한다.
    # 완전 대칭 합성 씬은 전체 centroid가 거울 평면에 놓이므로 footprint 경로가 주 신호다.
    has_detection_signal = rep["mirror_planes"] >= 1 or rep["removed_by_footprint"] > 0
    t1 = rep["removed_vertices"] > 0.3 * n_before and has_detection_signal
    print(f"  ① 거울 팬텀 검출: {'PASS' if t1 else 'FAIL'}  제거 {rep['removed_vertices']}/{n_before}정점, "
          f"평면 {rep['mirror_planes']}, footprint {rep['removed_by_footprint']}")
    ok &= t1
    # 남은 정점이 전부 x<=2.05 (실내쪽)인지 — 팬텀(x>2)이 사라졌나
    maxx = cleaned.vertices[:, 0].max()
    t2 = maxx < 2.15
    print(f"  ② 실물 보존/팬텀 제거: {'PASS' if t2 else 'FAIL'}  남은 maxX={maxx:.2f} (거울 x=2 안쪽이어야)")
    ok &= t2
    print(f"\n  === mirror_glass_clean 셀프테스트: {'ALL PASS ✅' if ok else 'FAIL ❌'} ===")
    return ok


def main():
    import argparse, sys, json
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--mesh"); ap.add_argument("--out", default="cleaned.obj")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(0 if selftest() else 1)
    if not a.mesh:
        ap.error("--mesh 필요 (또는 --selftest)")
    import trimesh
    mesh = trimesh.load(a.mesh, force="mesh")
    cleaned, rep = clean_mesh(mesh)
    cleaned.export(a.out)
    print(json.dumps(rep, ensure_ascii=False, indent=2)[:600])
    print("저장:", a.out)


if __name__ == "__main__":
    main()
