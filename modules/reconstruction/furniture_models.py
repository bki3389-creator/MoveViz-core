#!/usr/bin/env python3
"""탐지된 가구(카테고리+치수+yaw) → 카테고리별 정제된 3D 모델 파일.

리서치 확인 결과(2026-07-05): Polycam의 Room/Space Mode도 스캔 지오메트리에서
가구를 "추출·정제"하는 게 아니라, 감지된 카테고리에 맞춰 **자체 라이브러리의
일반 대체 모델(제네릭 프록시)**을 그 자리에 꽂아 넣는다 — 3dwithus 리뷰:
"The furniture pieces... are generic and are uploaded from the library."
실제 스캔 표면에서 뽑아낸 지오메트리(포토그래메트리형 진짜 추출)는 오브젝트를
따로 스캔하는 별도 모드(Polycam Object Mode)에서만 나온다. 즉 "방 스캔 속
가구가 사실적으로 보인다"는 인상은 대부분 이 카테고리별 프록시 모델의
품질에서 온다 — 노이즈 낀 원본 클러스터를 다듬는 게 아니라 아예 깨끗한
모델로 교체하는 것.

이 모듈은 그 메커니즘을 구현한다: 카테고리별로 사람이 알아볼 수 있는 형태
(다리+상판 테이블, 등받이+팔걸이 소파, 시트+등받이+다리 의자 등)를
trimesh 프리미티브로 조립해두고, 감지된 실측 치수(dims)·중심·yaw로
맞춰 배치한다. 라이선스/네트워크 위험이 있는 외부 3D 에셋 다운로드 없이
전부 자체 생성.
"""

import numpy as np
import trimesh

# 카테고리별 색상(단순 재질 근사) — RGBA
_COLORS = {
    "bed": (235, 220, 200, 255), "sofa": (150, 130, 190, 255),
    "chair": (170, 120, 90, 255), "table": (150, 110, 70, 255),
    "desk": (150, 110, 70, 255), "toilet": (245, 245, 245, 255),
    "sink": (235, 235, 240, 255), "bathtub": (240, 240, 245, 255),
    "refrigerator": (210, 210, 215, 255), "cabinet": (180, 150, 110, 255),
    "tv": (30, 30, 30, 255), "appliance": (200, 200, 205, 255),
    "counter": (190, 170, 140, 255), "shelf": (170, 140, 100, 255),
    "rack": (170, 140, 100, 255),
}
_DEFAULT_COLOR = (190, 175, 160, 255)


def _box(w, h, d, color, cx=0.0, cy=0.0, cz=0.0):
    m = trimesh.creation.box(extents=(max(w, 0.01), max(h, 0.01), max(d, 0.01)))
    m.apply_translation([cx, cy, cz])
    m.visual.vertex_colors = color
    return m


_UPRIGHT = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])


def _cyl(r, h, color, cx, cy, cz):
    # trimesh.creation.cylinder는 기본적으로 Z축 방향(길이)으로 생성됨 —
    # 다리/기둥처럼 세우려면(Y축 방향) 먼저 -90° X회전 후 위치 이동.
    m = trimesh.creation.cylinder(radius=max(r, 0.005), height=max(h, 0.01), sections=10)
    m.apply_transform(_UPRIGHT)
    m.apply_translation([cx, cy, cz])
    m.visual.vertex_colors = color
    return m


def _merge(parts):
    m = trimesh.util.concatenate([p for p in parts if p is not None and len(p.vertices)])
    return m


# 각 생성 함수: (w, h, d) 실측 전체 치수(미터) → 로컬 좌표 메시.
# 로컬 좌표계: 바닥 중심이 원점(0,floor,0), 가구는 바닥(y=0)에서 위로(+y) 서 있음.
# X=폭(가로), Z=깊이(앞뒤), Y=높이 — 최종 배치 시 yaw(Y축 회전)+center로 옮김.

def _make_table_like(w, h, d, color, leg_r_frac=0.035):
    top_h = max(0.04, h * 0.06)
    leg_h = h - top_h
    parts = [_box(w, top_h, d, color, cy=leg_h + top_h / 2)]
    r = min(w, d) * leg_r_frac
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(_cyl(r, leg_h, color,
                              sx * (w / 2 - r * 1.6), leg_h / 2, sz * (d / 2 - r * 1.6)))
    return _merge(parts)


def _make_chair(w, h, d, color):
    seat_y = h * 0.5
    parts = [_box(w, h * 0.08, d, color, cy=seat_y)]                       # 좌판
    parts.append(_box(w, h - seat_y, h * 0.06,                            # 등받이
                      color, cy=(seat_y + h) / 2, cz=-d / 2 + h * 0.03))
    r = min(w, d) * 0.05
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(_cyl(r, seat_y, color, sx * (w / 2 - r * 1.5),
                              seat_y / 2, sz * (d / 2 - r * 1.5)))
    return _merge(parts)


def _make_sofa(w, h, d, color):
    seat_y = h * 0.42
    arm_w = min(0.18, w * 0.12)
    parts = [_box(w, seat_y, d, color, cy=seat_y / 2)]                     # 시트
    parts.append(_box(w, h - seat_y, d * 0.28, color,                     # 등받이
                      cy=(seat_y + h) / 2, cz=-d / 2 + d * 0.14))
    for sx in (-1, 1):                                                    # 팔걸이
        parts.append(_box(arm_w, h * 0.75, d, color,
                          cx=sx * (w / 2 - arm_w / 2), cy=h * 0.75 / 2))
    return _merge(parts)


def _make_bed(w, h, d, color):
    frame_h = h * 0.35
    parts = [_box(w, frame_h, d, color, cy=frame_h / 2)]                  # 프레임
    parts.append(_box(w * 0.96, h - frame_h, d * 0.96,                    # 매트리스
                      (235, 225, 215, 255), cy=frame_h + (h - frame_h) / 2))
    parts.append(_box(w * 0.98, h * 0.12, d * 0.06,                       # 베개(머리쪽)
                      (250, 250, 250, 255), cy=h - h * 0.06,
                      cz=-d / 2 + d * 0.08))
    return _merge(parts)


def _make_toilet(w, h, d, color):
    parts = [_box(w * 0.85, h * 0.45, d * 0.62, color,                    # 볼(하부)
                  cy=h * 0.225, cz=d * 0.06)]
    parts.append(_box(w * 0.7, h * 0.5, d * 0.32, color,                  # 탱크(상부/후면)
                      cy=h * 0.5 + h * 0.25, cz=-d / 2 + d * 0.16))
    return _merge(parts)


def _make_sink(w, h, d, color):
    parts = [_box(w, h * 0.18, d, color, cy=h - h * 0.09)]                 # 볼(상단)
    parts.append(_cyl(min(w, d) * 0.15, h * 0.82, color, 0, (h * 0.82) / 2, 0))  # 받침
    return _merge(parts)


def _make_bathtub(w, h, d, color):
    outer = _box(w, h, d, color)
    inner = _box(w * 0.85, h * 0.8, d * 0.8, (225, 235, 245, 255), cy=h * 0.12)
    return _merge([outer, inner])


def _make_flat_screen(w, h, d, color):
    parts = [_box(w, h * 0.85, max(d * 0.15, 0.03), color, cy=h * 0.55)]  # 패널
    parts.append(_box(w * 0.25, h * 0.15, d, (40, 40, 40, 255), cy=h * 0.075))  # 스탠드
    return _merge(parts)


_GENERATORS = {
    "table": _make_table_like, "desk": _make_table_like, "counter": _make_table_like,
    "chair": _make_chair, "sofa": _make_sofa, "bed": _make_bed,
    "toilet": _make_toilet, "sink": _make_sink, "bathtub": _make_bathtub,
    "tv": _make_flat_screen,
}


def make_furniture_model(category: str, dims_whd) -> trimesh.Trimesh:
    """카테고리 + 실측 치수(w,h,d 미터) → 로컬좌표 정제 모델(바닥=y0, 중심=원점 XZ)."""
    w, h, d = (max(float(x), 0.05) for x in dims_whd)
    color = _COLORS.get(category, _DEFAULT_COLOR)
    gen = _GENERATORS.get(category, None)
    mesh = gen(w, h, d, color) if gen else _box(w, h, d, color, cy=h / 2)
    if mesh is None or len(mesh.vertices) == 0:
        mesh = _box(w, h, d, color, cy=h / 2)
    return mesh


def place_instance(category, center_xyz, dims_whd, yaw_deg) -> trimesh.Trimesh:
    """로컬 모델을 실제 검출된 center(바닥 위 y포함)·yaw로 세계좌표에 배치.
    center_xyz[1]은 박스 '중심' 높이(기존 fit_obb 관례) → 바닥 y로 변환."""
    mesh = make_furniture_model(category, dims_whd).copy()
    cx, cy_mid, cz = center_xyz
    floor_y = cy_mid - dims_whd[1] / 2
    R = trimesh.transformations.rotation_matrix(np.radians(yaw_deg), [0, 1, 0])
    T = trimesh.transformations.translation_matrix([cx, floor_y, cz])
    mesh.apply_transform(T @ R)
    return mesh


def export_furniture_models(furniture_list, out_dir):
    """furniture_vision.json의 furniture 리스트 → 개별 GLB + 합본 씬.
    반환: [{"category", "category_ko", "file", "dims_m"}], 실패 항목은 스킵."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    manifest, scene_parts = [], []
    for i, f in enumerate(furniture_list):
        cat = f.get("category", "object")
        dims = f.get("dims") or [0.5, 0.5, 0.5]
        center = f.get("center") or [0, dims[1] / 2, 0]
        yaw = f.get("yaw_deg", 0.0)
        try:
            world_mesh = place_instance(cat, center, dims, yaw)
            local_mesh = make_furniture_model(cat, dims)  # 개별 파일은 원점 기준(재사용 쉽게)
        except Exception as e:
            print(f"[furniture_models] skip #{i} ({cat}): {e}")
            continue
        fn = f"{i:02d}_{cat}.glb"
        local_mesh.export(os.path.join(out_dir, fn))
        scene_parts.append(world_mesh)
        manifest.append({
            "category": cat, "category_ko": f.get("category_ko", cat),
            "file": fn, "dims_m": [round(float(x), 3) for x in dims],
            "yaw_deg": round(float(yaw), 1),
        })
    if scene_parts:
        trimesh.util.concatenate(scene_parts).export(
            os.path.join(out_dir, "furniture_layout.glb"))
    return manifest


if __name__ == "__main__":
    # 셀프테스트: 카테고리별 모델이 유효 메시(정점>0, 실측 치수와 bbox 대략 일치)인지 확인.
    tests = [
        ("chair", [0.5, 0.85, 0.5]), ("sofa", [1.9, 0.8, 0.9]),
        ("bed", [1.5, 0.6, 2.0]), ("table", [1.2, 0.75, 0.7]),
        ("toilet", [0.4, 0.75, 0.65]), ("sink", [0.5, 0.85, 0.45]),
        ("bathtub", [1.6, 0.55, 0.75]), ("tv", [1.1, 0.65, 0.08]),
        ("cabinet", [0.8, 1.2, 0.4]),
    ]
    for cat, dims in tests:
        m = make_furniture_model(cat, dims)
        ext = m.extents
        # 토일렛/싱크류는 부품이 전체 bbox를 다 채우지 않는 게 자연스러워 여유 있게 허용.
        tol = 0.12 if cat in ("toilet", "sink") else 0.05
        ok = len(m.vertices) > 0 and all(abs(ext[k] - dims[k]) < tol for k in range(3))
        print(f"{'OK ' if ok else 'FAIL'} {cat:12s} dims={dims} -> extents={ext.round(3)}, "
              f"verts={len(m.vertices)}")
