#!/usr/bin/env python3
"""대표모델(템플릿) 엔진 — 대표모델_통합계획.md 구현(P1+P2).

멀티에이전트 리뷰(2026-07-25, 확정 10건 + 사전 발견 3건) 반영 수정판:
- 파츠를 (태그·중심·크기) 데이터로 먼저 계산해 파츠 간 겹침을 테스트로 검증 가능
- 침대: 낮은 실측 H(0.25~0.40)에서도 헤드보드·매트리스 유지, 매트리스-헤드보드 관통 제거
- 수납장/옷장: 몸통·도어가 다리 위에 얹힘(다리 관통·매몰 제거), 손잡이는 도어가
  맞닿는 중앙 이음선 쪽(힌지는 바깥 프레임), 낮은 몸통에서는 손잡이 생략
- 냉장고/서랍 손잡이도 TEMPLATES 데이터를 실제로 소비(죽은 데이터 제거)
- 실측 치수 타당성 게이트: 비정상 치수(깊이 16cm 냉장고 등)는 템플릿 대신
  기존 제네릭 모델로 폴백 — 평면 footprint를 지어내지 않는다
- resolve_front 결과 yaw를 (-180,180]로 정규화, 형식 오류 항목은 배치 전체가 아니라
  해당 항목만 스킵, boundary가 무효(점<2)면 front_resolved=False로 기록
"""

import glob
import json
import math
import os
import sys

import numpy as np
import trimesh

from furniture_models import (
    _COLORS,
    _box,
    _cyl,
    _merge,
    make_furniture_model,
)


# 축 규칙은 데이터로만 정의한다. 빌더는 scale/fixed/clamp 세 종류만 해석한다.
TEMPLATES = {
    "cabinet_closed": {
        "door": {"d": ("fixed", 0.020), "gap": 0.002, "split": 0.5},
        "handle": {"w": ("fixed", 0.025), "h": ("fixed", 0.080),
                   "d": ("fixed", 0.015)},
        "leg": {"r": ("fixed", 0.020), "h": ("clamp", 0.060, 0.100)},
    },
    "wardrobe_box_hinged": {
        "door": {"d": ("fixed", 0.020), "gap": 0.002, "split": 0.6},
        "handle": {"w": ("fixed", 0.025), "h": ("fixed", 0.080),
                   "d": ("fixed", 0.015), "from_top": ("fixed", 0.200)},
    },
    "fridge_box": {
        "door": {"d": ("fixed", 0.020), "gap": 0.002},
        "handle": {"w": ("fixed", 0.025), "h": ("scale", 0.700),
                   "d": ("fixed", 0.015)},
    },
    "bed_headboard": {
        "frame": {"h_frac": 0.6, "h_clamp": (0.250, 0.400)},
        "headboard": {"d": ("fixed", 0.080)},
        "mattress": {"w": ("scale", 0.960), "max_h": 0.250},
    },
}

# 실측 치수 타당성 범위 (w, h, d) — 벗어나면 템플릿 대신 제네릭 폴백.
# footprint(w,d)를 클램프로 '지어내면' 평면 배치 충돌 판단이 깨지므로 게이트만 한다.
_PLAUSIBLE = {
    "fridge_box": ((0.40, 1.60), (0.60, 2.40), (0.35, 1.20)),
    "cabinet_closed": ((0.30, 3.50), (0.15, 1.60), (0.15, 1.00)),
    "wardrobe_box_hinged": ((0.40, 4.00), (1.40, 2.60), (0.30, 1.00)),
    "bed_headboard": ((0.70, 2.50), (0.15, 1.60), (1.20, 2.60)),
}

_WOOD = _COLORS["cabinet"]
_METAL = (205, 208, 212, 255)
_HANDLE = (80, 80, 82, 255)
_MATTRESS = (232, 232, 230, 255)


def _axis(rule, total):
    """축 규칙 하나를 실제 미터 값으로 바꾼다."""
    kind = rule[0]
    if kind == "scale":
        return total * float(rule[1]), False
    if kind == "fixed":
        return float(rule[1]), False
    if kind == "clamp":
        value = min(max(total, float(rule[1])), float(rule[2]))
        return value, not math.isclose(value, total)
    raise ValueError(f"알 수 없는 축 규칙: {rule!r}")


def _safe_dims(w, h, d):
    return tuple(max(float(value), 0.05) for value in (w, h, d))


# ---- 파츠 조립: 메시 생성 전에 (태그, 크기, 중심) 데이터로 먼저 만든다 ----

def _part_box(tag, w, h, d, color, cx=0.0, cy=0.0, cz=0.0):
    return {"tag": tag, "kind": "box", "size": (w, h, d),
            "center": (cx, cy, cz), "color": color}


def _part_cyl(tag, r, h, color, cx, cy, cz):
    return {"tag": tag, "kind": "cyl", "size": (r, h),
            "center": (cx, cy, cz), "color": color}


def part_bounds(part):
    """파츠의 AABB (min_xyz, max_xyz) — 겹침 검증용."""
    cx, cy, cz = part["center"]
    if part["kind"] == "box":
        w, h, d = part["size"]
        half = (w / 2, h / 2, d / 2)
    else:
        r, h = part["size"]
        half = (r, h / 2, r)
    return ((cx - half[0], cy - half[1], cz - half[2]),
            (cx + half[0], cy + half[1], cz + half[2]))


def _materialize(parts):
    meshes = []
    for p in parts:
        cx, cy, cz = p["center"]
        if p["kind"] == "box":
            w, h, d = p["size"]
            meshes.append(_box(w, h, d, p["color"], cx=cx, cy=cy, cz=cz))
        else:
            r, h = p["size"]
            meshes.append(_cyl(r, h, p["color"], cx, cy, cz))
    return _merge(meshes)


# ---- 빌더: 각 form_factor → (parts, meta) ----

def _cabinet(form_factor, w, h, d):
    """수납장(도어/서랍형)과 옷장의 공통 조립기."""
    spec = TEMPLATES[form_factor]
    wardrobe = form_factor == "wardrobe_box_hinged"
    drawer = not wardrobe and h < 0.6
    door_d, _ = _axis(spec["door"]["d"], d)
    handle_d, _ = _axis(spec["handle"]["d"], d)
    handle_w, _ = _axis(spec["handle"]["w"], w)
    handle_h, _ = _axis(spec["handle"]["h"], h)
    gap = spec["door"]["gap"]

    # 다리(수납장 H≥0.4만): 몸통·도어를 다리 '위에' 얹는다 — 관통/매몰 방지.
    has_legs = (not wardrobe) and h >= 0.4
    if has_legs:
        leg_rule = TEMPLATES["cabinet_closed"]["leg"]
        leg_h = min(max(h * 0.1, leg_rule["h"][1]), leg_rule["h"][2])
        leg_r, _ = _axis(leg_rule["r"], min(w, d))
    base = leg_h if has_legs else 0.0
    inner_h = h - base

    body_d = max(d - door_d - handle_d, 0.01)
    body_z = -d / 2 + body_d / 2
    panel_z = d / 2 - handle_d - door_d / 2
    handle_z = d / 2 - handle_d / 2
    parts = [_part_box("body", w, inner_h, body_d, _WOOD,
                       cy=base + inner_h / 2, cz=body_z)]
    # 몸통이 너무 낮으면 손잡이 생략(바닥 이탈·역전 clamp 방지).
    with_handles = inner_h >= handle_h * 1.2
    handles = []

    if drawer:
        count = min(max(round(h / 0.25), 1), 4)
        panel_h = max(inner_h / count - gap, 0.01)
        for index in range(count):
            y = base + (index + 0.5) * inner_h / count
            parts.append(_part_box("door", max(w - gap, 0.01), panel_h, door_d,
                                   _WOOD, cy=y, cz=panel_z))
            if with_handles:
                # 서랍 손잡이는 스펙 값을 가로로 눕힌 바(폭↔높이 스왑).
                parts.append(_part_box("handle", handle_h, handle_w, handle_d,
                                       _HANDLE, cy=y, cz=handle_z))
                handles.append((handle_h, handle_w, handle_d))
        panel_kind = "drawer"
    else:
        split = spec["door"]["split"]
        count = min(max(round(w / split), 1), 4)
        panel_w = max(w / count - gap, 0.01)
        for index in range(count):
            x = -w / 2 + (index + 0.5) * w / count
            parts.append(_part_box("door", panel_w, inner_h, door_d, _WOOD,
                                   cx=x, cy=base + inner_h / 2, cz=panel_z))
            if not with_handles:
                continue
            if wardrobe:
                from_top, _ = _axis(spec["handle"]["from_top"], h)
                lo = base + handle_h / 2
                hi = max(h - handle_h / 2, lo)
                handle_y = min(max(h - from_top, lo), hi)
            else:
                handle_y = base + inner_h / 2
            # 힌지는 바깥 프레임 쪽 → 손잡이는 도어들이 맞닿는 중앙 이음선 쪽.
            side = 1 if x <= 1e-9 else -1
            handle_x = x + side * max(panel_w / 2 - handle_w, 0)
            parts.append(_part_box("handle", handle_w, handle_h, handle_d,
                                   _HANDLE, cx=handle_x, cy=handle_y,
                                   cz=handle_z))
            handles.append((handle_w, handle_h, handle_d))
        panel_kind = "door"

    if has_legs:
        # 다리는 몸통 footprint 안쪽(z는 body 범위 내) — 도어와 안 겹친다.
        inset_x = max(w / 2 - leg_r * 1.5, 0)
        inset_z = max(body_d / 2 - leg_r * 1.5, 0)
        for sx in (-1, 1):
            for sz in (-1, 1):
                parts.append(_part_cyl("leg", leg_r, base, _WOOD,
                                       sx * inset_x, base / 2,
                                       body_z + sz * inset_z))
    return parts, {"clamped": False, "panel_kind": panel_kind,
                   "panel_count": count, "handle_sizes": handles}


def _fridge(w, h, d):
    spec = TEMPLATES["fridge_box"]
    door_d, _ = _axis(spec["door"]["d"], d)
    handle_d, _ = _axis(spec["handle"]["d"], d)
    handle_w, _ = _axis(spec["handle"]["w"], w)
    gap = spec["door"]["gap"]
    body_d = max(d - door_d - handle_d, 0.01)
    panel_z = d / 2 - handle_d - door_d / 2
    handle_z = d / 2 - handle_d / 2
    parts = [_part_box("body", w, h, body_d, _METAL,
                       cy=h / 2, cz=-d / 2 + body_d / 2)]
    handles = []

    if w >= 0.85:  # 양문형: 세로 분할, 손잡이는 중앙 이음선 양옆
        panel_w = max(w / 2 - gap, 0.01)
        handle_h, _ = _axis(spec["handle"]["h"], h)
        for side in (-1, 1):
            parts.append(_part_box("door", panel_w, h, door_d, _METAL,
                                   cx=side * w / 4, cy=h / 2, cz=panel_z))
            parts.append(_part_box("handle", handle_w, handle_h, handle_d,
                                   _HANDLE, cx=side * (gap + handle_w),
                                   cy=h / 2, cz=handle_z))
            handles.append((handle_w, handle_h, handle_d))
        panel_kind = "side_by_side"
    else:  # 상하형: 아래 2/3 + 위 1/3
        for panel_h, start in ((h * 2 / 3, 0.0), (h / 3, h * 2 / 3)):
            visible_h = max(panel_h - gap, 0.01)
            y = start + panel_h / 2
            handle_h, _ = _axis(spec["handle"]["h"], panel_h)
            parts.append(_part_box("door", w, visible_h, door_d, _METAL,
                                   cy=y, cz=panel_z))
            parts.append(_part_box("handle", handle_w, handle_h, handle_d,
                                   _HANDLE, cx=w / 2 - handle_w, cy=y,
                                   cz=handle_z))
            handles.append((handle_w, handle_h, handle_d))
        panel_kind = "top_bottom"
    return parts, {"clamped": False, "panel_kind": panel_kind,
                   "panel_count": 2, "handle_sizes": handles}


def _bed(w, h, d):
    """프레임+매트리스+헤드보드. 낮은 실측 H에서도 파츠가 유지되도록
    프레임을 비율(60%)로 잡고 스펙 범위로 클램프한다(전체 bbox는 입력 H)."""
    spec = TEMPLATES["bed_headboard"]
    lo, hi = spec["frame"]["h_clamp"]
    frame_h = min(max(spec["frame"]["h_frac"] * h, lo), hi)
    frame_h = min(frame_h, 0.8 * h)   # 프레임이 전체 H를 잠식하지 않게
    clamped = not math.isclose(frame_h, spec["frame"]["h_frac"] * h)

    head_d, _ = _axis(spec["headboard"]["d"], d)
    head_d = min(head_d, d * 0.2)
    has_head = (h - frame_h) >= 0.05 - 1e-9
    mattress_h = min(h - frame_h, spec["mattress"]["max_h"])
    has_mattress = mattress_h >= 0.02
    mattress_w, _ = _axis(spec["mattress"]["w"], w)

    parts = [_part_box("frame", w, frame_h, d, _WOOD, cy=frame_h / 2)]
    if has_head:
        parts.append(_part_box("headboard", w, h - frame_h, head_d, _WOOD,
                               cy=(frame_h + h) / 2, cz=-d / 2 + head_d / 2))
    if has_mattress:
        # 매트리스는 헤드보드 '앞면'에서 시작 — 관통 없이 맞닿기만 한다.
        mat_d = d - head_d if has_head else d * 0.96
        mat_cz = head_d / 2 if has_head else 0.0
        parts.append(_part_box("mattress", mattress_w, mattress_h, mat_d,
                               _MATTRESS, cy=frame_h + mattress_h / 2,
                               cz=mat_cz))
    return parts, {"clamped": clamped, "panel_kind": "headboard",
                   "panel_count": 1, "handle_sizes": []}


def _build_parts(form_factor, w, h, d):
    w, h, d = _safe_dims(w, h, d)
    if form_factor in ("cabinet_closed", "wardrobe_box_hinged"):
        return _cabinet(form_factor, w, h, d)
    if form_factor == "fridge_box":
        return _fridge(w, h, d)
    if form_factor == "bed_headboard":
        return _bed(w, h, d)
    raise ValueError(f"지원하지 않는 form_factor: {form_factor}")


def _build_with_meta(form_factor, w, h, d):
    parts, meta = _build_parts(form_factor, w, h, d)
    meta["parts"] = [(p["tag"], part_bounds(p)) for p in parts]
    return _materialize(parts), meta


def build(form_factor: str, w, h, d) -> trimesh.Trimesh:
    """form_factor와 전체 치수로 바닥 y=0인 로컬 대표모델을 만든다."""
    return _build_with_meta(form_factor, w, h, d)[0]


# ---- 매핑 + 방향성 ----

def _candidate_form_factor(category, h):
    category = str(category).lower()
    if category in ("cabinet", "wardrobe"):
        return "wardrobe_box_hinged" if category == "wardrobe" or h >= 1.5 \
            else "cabinet_closed"
    if category in ("refrigerator", "fridge"):
        return "fridge_box"
    if category == "bed":
        return "bed_headboard"
    return None


def _plausible(form_factor, w, h, d):
    ranges = _PLAUSIBLE.get(form_factor)
    if ranges is None:
        return True
    return all(lo <= v <= hi for v, (lo, hi) in zip((w, h, d), ranges))


def resolve_form_factor(category: str, dims_whd):
    """검출 카테고리+치수 → 대표형. 치수가 비정상(오검출/벽 투영)이면 None
    (호출측이 furniture_models 제네릭으로 폴백)."""
    w, h, d = _safe_dims(*dims_whd)
    candidate = _candidate_form_factor(category, h)
    if candidate and not _plausible(candidate, w, h, d):
        return None
    return candidate


def _norm_yaw(yaw):
    return (float(yaw) + 180.0) % 360.0 - 180.0


def _ray_segment_distance(origin, direction, a, b):
    """2D 반직선과 선분의 교차 거리. 교차하지 않으면 inf."""
    edge = b - a
    cross = direction[0] * edge[1] - direction[1] * edge[0]
    if abs(cross) < 1e-10:
        return math.inf
    delta = a - origin
    ray_t = (delta[0] * edge[1] - delta[1] * edge[0]) / cross
    seg_t = (delta[0] * direction[1] - delta[1] * direction[0]) / cross
    if ray_t >= -1e-9 and -1e-9 <= seg_t <= 1 + 1e-9:
        return max(ray_t, 0.0)
    return math.inf


def _valid_boundary(boundary):
    return boundary is not None and len(boundary) >= 2


def resolve_front(center_xyz, dims_whd, yaw_deg, boundary) -> float:
    """두 yaw 후보 중 로컬 등(-Z)이 벽에 더 가까운 방향을 (-180,180]로 반환."""
    del dims_whd  # 현 단계에서는 중심에서 벽까지의 방향 거리만 비교한다.
    if not _valid_boundary(boundary):
        return _norm_yaw(yaw_deg)
    points = np.asarray(boundary, dtype=float)
    origin = np.asarray([center_xyz[0], center_xyz[2]], dtype=float)
    if not np.allclose(points[0], points[-1]):
        points = np.vstack([points, points[0]])

    def wall_distance(candidate):
        angle = math.radians(candidate)
        back = np.asarray([-math.sin(angle), -math.cos(angle)])
        return min(_ray_segment_distance(origin, back, points[i], points[i + 1])
                   for i in range(len(points) - 1))

    yaw = float(yaw_deg)
    best = yaw if wall_distance(yaw) <= wall_distance(yaw + 180.0) else yaw + 180.0
    return _norm_yaw(best)


_WALL_CATEGORIES = {
    "cabinet", "wardrobe", "refrigerator", "fridge",
    "shelf", "bed", "sofa", "tv",
}


def _place(mesh, center, dims, yaw):
    world = mesh.copy()
    floor_y = float(center[1]) - float(dims[1]) / 2
    rotation = trimesh.transformations.rotation_matrix(
        np.radians(yaw), [0, 1, 0])
    translation = trimesh.transformations.translation_matrix(
        [float(center[0]), floor_y, float(center[2])])
    world.apply_transform(translation @ rotation)
    return world


def export_furniture_models_v2(furniture_list, out_dir, boundary=None):
    """기존 manifest 호환 형식으로 개별 GLB와 세계좌표 합본을 내보낸다.
    항목 하나가 형식 오류여도 그 항목만 스킵한다."""
    os.makedirs(out_dir, exist_ok=True)
    boundary_ok = _valid_boundary(boundary)
    manifest, scene_parts = [], []
    for index, furniture in enumerate(furniture_list):
        try:
            category = furniture.get("category", "object")
            dims = furniture.get("dims") or [0.5, 0.5, 0.5]
            center = furniture.get("center") or [0, dims[1] / 2, 0]
            yaw = float(furniture.get("yaw_deg", 0.0))
            candidate = _candidate_form_factor(category, _safe_dims(*dims)[1])
            form_factor = resolve_form_factor(category, dims)
            front_resolved = boundary_ok and category.lower() in _WALL_CATEGORIES
            resolved_yaw = resolve_front(center, dims, yaw, boundary) \
                if front_resolved else yaw
            if form_factor:
                local_mesh, meta = _build_with_meta(form_factor, *dims)
            else:
                local_mesh = make_furniture_model(category, dims)
                meta = {"clamped": False}
            world_mesh = _place(local_mesh, center, dims, resolved_yaw)
        except Exception as exc:
            print(f"[furniture_templates] skip #{index} ({furniture!r:.60}): {exc}")
            continue
        filename = f"{index:02d}_{category}.glb"
        local_mesh.export(os.path.join(out_dir, filename))
        scene_parts.append(world_mesh)
        entry = {
            "category": category,
            "category_ko": furniture.get("category_ko", category),
            "file": filename,
            "dims_m": [round(float(value), 3) for value in dims],
            "yaw_deg": round(float(resolved_yaw), 1),
            "form_factor": form_factor,
            "front_resolved": front_resolved,
        }
        if candidate and not form_factor:
            entry["template_gate"] = "implausible_dims"   # 오검출/벽투영 의심 → 제네릭 폴백
        if meta["clamped"]:
            entry["clamped"] = True
        manifest.append(entry)
    if scene_parts:
        trimesh.util.concatenate(scene_parts).export(
            os.path.join(out_dir, "furniture_layout.glb"))
    return manifest


# ---- 셀프테스트 ----

def _check_bbox(mesh, dims, tolerance=0.05):
    return len(mesh.vertices) > 0 and all(
        abs(float(mesh.extents[index]) - float(dims[index])) <= tolerance
        for index in range(3))


def _bounds_overlap(b1, b2, eps=1e-9):
    return all(b1[0][k] < b2[1][k] - eps and b2[0][k] < b1[1][k] - eps
               for k in range(3))


def _parts_by_tag(meta, tag):
    return [bounds for t, bounds in meta["parts"] if t == tag]


def _assert_no_overlap(meta, tag_a, tag_b, label):
    for ba in _parts_by_tag(meta, tag_a):
        for bb in _parts_by_tag(meta, tag_b):
            assert not _bounds_overlap(ba, bb), \
                f"{label}: {tag_a}-{tag_b} 관통 {ba} vs {bb}"


def _run_test(label, function):
    try:
        detail = function()
        print(f"OK {label}{': ' + detail if detail else ''}")
        return True
    except Exception as exc:
        print(f"FAIL {label}: {exc}")
        return False


def _self_test():
    passed = []

    def cabinet_sweep():
        for w in (0.4, 0.8, 1.2, 2.0):
            dims = (w, 1.0, 0.4)
            mesh, meta = _build_with_meta("cabinet_closed", *dims)
            assert _check_bbox(mesh, dims), mesh.extents
            assert meta["panel_count"] == min(max(round(w / 0.5), 1), 4)
            assert all(np.allclose(size, (0.025, 0.080, 0.015))
                       for size in meta["handle_sizes"])
            _assert_no_overlap(meta, "leg", "door", f"cabinet w={w}")
            _assert_no_overlap(meta, "leg", "handle", f"cabinet w={w}")
            # 다리가 있으면 도어는 다리 위에서 시작, 어떤 파츠도 바닥 아래 금지
            legs = _parts_by_tag(meta, "leg")
            if legs:
                leg_top = max(b[1][1] for b in legs)
                assert all(abs(b[0][1] - leg_top) < 1e-6
                           for b in _parts_by_tag(meta, "door"))
            assert all(b[0][1] >= -1e-9 for _, b in meta["parts"])
        # 2도어: 손잡이는 바깥이 아니라 중앙 이음선 쪽
        _, meta = _build_with_meta("cabinet_closed", 0.8, 1.0, 0.4)
        doors = _parts_by_tag(meta, "door")
        hnds = _parts_by_tag(meta, "handle")
        assert len(doors) == 2 and len(hnds) == 2
        for db, hb in zip(doors, hnds):
            door_cx = (db[0][0] + db[1][0]) / 2
            hnd_cx = (hb[0][0] + hb[1][0]) / 2
            assert abs(hnd_cx) < abs(door_cx), "손잡이가 힌지(바깥)쪽에 있음"
        # 낮은 장은 서랍형 + 손잡이 스왑(80×25mm)
        _, meta = _build_with_meta("cabinet_closed", 0.8, 0.5, 0.4)
        assert meta["panel_kind"] == "drawer" and meta["panel_count"] == 2
        assert all(np.allclose(size, (0.080, 0.025, 0.015))
                   for size in meta["handle_sizes"])
        return "W 4종 + 서랍형 + 관통/손잡이 위치"

    def wardrobe_sweep():
        for w in (0.6, 1.2, 2.4):
            dims = (w, 1.8, 0.6)
            mesh, meta = _build_with_meta("wardrobe_box_hinged", *dims)
            assert _check_bbox(mesh, dims), mesh.extents
            assert meta["panel_count"] == min(max(round(w / 0.6), 1), 4)
            assert all(b[0][1] >= -1e-9 for _, b in meta["parts"])
        # 비정상 저높이: 손잡이 생략, 바닥 이탈 없음 (게이트 이전 직접 호출 대비)
        _, meta = _build_with_meta("wardrobe_box_hinged", 0.6, 0.06, 0.6)
        assert not _parts_by_tag(meta, "handle")
        assert all(b[0][1] >= -1e-9 for _, b in meta["parts"])
        return "W 3종 + 저높이 가드"

    def fridge_sweep():
        for w, kind in ((0.6, "top_bottom"), (0.9, "side_by_side")):
            dims = (w, 1.8, 0.7)
            mesh, meta = _build_with_meta("fridge_box", *dims)
            assert _check_bbox(mesh, dims), mesh.extents
            assert meta["panel_count"] == 2 and meta["panel_kind"] == kind
        # 손잡이 길이가 TEMPLATES 데이터(scale 0.7)에서 실제로 나온다
        _, meta = _build_with_meta("fridge_box", 0.9, 1.8, 0.7)
        assert any(math.isclose(size[1], 1.8 * 0.7) for size in meta["handle_sizes"])
        _, meta = _build_with_meta("fridge_box", 0.6, 1.8, 0.7)
        assert any(math.isclose(size[1], (1.8 * 2 / 3) * 0.7)
                   for size in meta["handle_sizes"])
        return "W 2종 + 데이터 소비 확인"

    def bed_sweep():
        # 정상 높이 + 리뷰에서 터진 저높이(0.25~0.40) 전 구간에서 3파츠 유지
        for h in (0.25, 0.30, 0.40, 0.60):
            dims = (1.5, h, 2.0)
            mesh, meta = _build_with_meta("bed_headboard", *dims)
            assert _check_bbox(mesh, dims), (h, mesh.extents)
            tags = {t for t, _ in meta["parts"]}
            assert tags == {"frame", "headboard", "mattress"}, (h, tags)
            # 헤드보드는 입력 H까지 닿고, 매트리스와 관통하지 않는다
            head = _parts_by_tag(meta, "headboard")[0]
            assert abs(head[1][1] - h) < 1e-6
            _assert_no_overlap(meta, "mattress", "headboard", f"bed h={h}")
        return "H 4종(저높이 포함) + 관통 없음"

    def front_test():
        room = [[0, 0], [4, 0], [4, 4], [0, 4]]
        # 서쪽 벽 근처에서 yaw=90이면 등(-Z)이 -X(벽쪽) → 유지
        result = resolve_front([0.2, 0.5, 2.0], [0.8, 1.0, 0.4], 90, room)
        assert math.isclose(result, 90.0), result
        # 반대(270)는 180° 플립 + (-180,180] 정규화 → 90
        flipped = resolve_front([0.2, 0.5, 2.0], [0.8, 1.0, 0.4], 270, room)
        assert math.isclose(flipped, 90.0), flipped
        assert -180.0 < flipped <= 180.0
        # 무효 boundary는 원본 yaw(정규화만)
        assert math.isclose(resolve_front([0, 0, 0], [1, 1, 1], 270, []), -90.0)
        return "4×4 방 + 정규화"

    def gate_test():
        # 실스캔에서 나온 비정상 치수 → 게이트(제네릭 폴백)
        assert resolve_form_factor("refrigerator", [0.94, 1.32, 0.165]) is None
        assert resolve_form_factor("bed", [0.262, 0.31, 0.218]) is None
        # 정상 치수는 통과
        assert resolve_form_factor("refrigerator", [0.9, 1.8, 0.7]) == "fridge_box"
        assert resolve_form_factor("bed", [1.5, 0.5, 2.0]) == "bed_headboard"
        assert resolve_form_factor("cabinet", [0.8, 1.0, 0.4]) == "cabinet_closed"
        assert resolve_form_factor("cabinet", [1.0, 1.8, 0.6]) == "wardrobe_box_hinged"
        return "오검출 게이트 + 정상 통과"

    def robust_test():
        out_dir = os.path.join(os.path.dirname(__file__) or ".",
                               "furniture_models_v2_test")
        items = [
            {"category": "cabinet", "dims": [0.8, 1.0, 0.4],
             "center": [1, 0.5, 1], "yaw_deg": 0},
            {"category": "bed", "dims": [0.5]},              # 형식 오류 → 이것만 스킵
            {"category": "refrigerator", "dims": [0.9, 1.8, 0.7],
             "center": [2, 0.9, 1], "yaw_deg": 30},
        ]
        manifest = export_furniture_models_v2(items, out_dir, boundary=[])
        assert len(manifest) == 2, manifest
        # 빈 boundary는 front_resolved=False로 기록돼야 한다
        assert all(m["front_resolved"] is False for m in manifest)
        return "항목 단위 스킵 + 무효 boundary 플래그"

    def integration_test():
        paths = glob.glob(os.path.join(os.path.dirname(__file__) or ".",
                                       "..", "scans", "*", "furniture_vision.json"))
        assert paths, "furniture_vision.json 없음"
        latest = max(paths, key=os.path.getmtime)
        with open(latest, encoding="utf-8") as stream:
            data = json.load(stream)
        furniture = data.get("furniture", [])
        out_dir = os.path.join(os.path.dirname(__file__) or ".",
                               "furniture_models_v2_test")
        manifest = export_furniture_models_v2(furniture, out_dir)
        assert len(manifest) == len(furniture), (len(manifest), len(furniture))
        assert all(os.path.isfile(os.path.join(out_dir, item["file"]))
                   for item in manifest)
        if furniture:
            assert os.path.isfile(os.path.join(out_dir, "furniture_layout.glb"))
        return f"{os.path.basename(os.path.dirname(latest))}, {len(manifest)}개"

    for label, function in (
        ("cabinet 치수/분할/손잡이/관통", cabinet_sweep),
        ("wardrobe 치수/분할/가드", wardrobe_sweep),
        ("fridge 치수/분할/데이터", fridge_sweep),
        ("bed 저높이/관통", bed_sweep),
        ("resolve_front 정규화", front_test),
        ("치수 게이트", gate_test),
        ("견고성/boundary 플래그", robust_test),
        ("기존 스캔 통합", integration_test),
    ):
        passed.append(_run_test(label, function))
    return all(passed)


if __name__ == "__main__":
    sys.exit(0 if _self_test() else 1)
