# -*- coding: utf-8 -*-
"""
아파트 유형 자동 모델링 스크립트
Rhino EditPythonScript에서 실행

사용법:
1. 아파트로 변환할 박스(들)를 선택
2. 이 스크립트 실행
3. 박스가 아파트 유형으로 변환됨

설정:
- 층고: 3500mm
- 파라펫: 1200mm
- 코어 크기: 6000 x 4000mm
- 옥상 코어 돌출: 2500mm
"""

import rhinoscriptsyntax as rs
import Rhino.Geometry as rg
import math
import scriptcontext as sc

# ── 설정 ──
FLOOR_HEIGHT = 3500      # 층고 mm
PARAPET_HEIGHT = 1200     # 파라펫 높이
CORE_WIDTH = 6000         # 코어 짧은쪽
CORE_DEPTH = 4000         # 코어 긴쪽
CORE_OVERRUN = 2500       # 옥상 코어 돌출
BAY_WIDTH = 3600          # 베이 간격 (긴변 창문 간격)
WINDOW_HEIGHT = 2200      # 창문 높이
WINDOW_SILL = 900         # 창턱 높이
BALCONY_DEPTH = 1500      # 발코니 깊이
BALCONY_HEIGHT = 1200     # 발코니 난간 높이
SHORT_WINDOW_WIDTH = 1200 # 짧은변 창 폭
SHORT_WINDOW_HEIGHT = 1500 # 짧은변 창 높이

# ── 유틸리티 ──
def get_box_base_corners(brep):
    """박스의 밑면 4개 꼭짓점을 추출"""
    bb = rs.BoundingBox(brep)
    if not bb or len(bb) < 8:
        return None
    # bb: 0-3 하단, 4-7 상단
    base = [bb[0], bb[1], bb[2], bb[3]]
    return base

def get_base_and_height(brep):
    """객체의 밑면 꼭짓점과 높이를 반환"""
    bb = rs.BoundingBox(brep)
    if not bb:
        return None, 0
    z_min = bb[0].Z
    z_max = bb[4].Z
    height = z_max - z_min
    base = [rg.Point3d(bb[0].X, bb[0].Y, z_min),
            rg.Point3d(bb[1].X, bb[1].Y, z_min),
            rg.Point3d(bb[2].X, bb[2].Y, z_min),
            rg.Point3d(bb[3].X, bb[3].Y, z_min)]
    return base, height

def get_actual_base_curve(brep):
    """Brep/Extrusion의 실제 밑면 외곽선 추출"""
    obj = rs.coercebrep(brep)
    if obj is None:
        return None

    bb = rs.BoundingBox(brep)
    z_min = bb[0].Z

    # 가장 낮은 면 찾기
    best_face = None
    best_z_diff = float('inf')

    for i in range(obj.Faces.Count):
        face = obj.Faces[i]
        area_mp = rg.AreaMassProperties.Compute(face)
        if area_mp:
            cen = area_mp.Centroid
            # 밑면에 가장 가까운 수평 면
            normal = face.NormalAt(face.Domain(0).Mid, face.Domain(1).Mid)
            if abs(normal.Z) > 0.9:  # 수평 면
                z_diff = abs(cen.Z - z_min)
                if z_diff < best_z_diff:
                    best_z_diff = z_diff
                    best_face = face

    if best_face is None:
        return None

    # 면의 외곽 루프
    loop = best_face.OuterLoop
    curve3d = loop.To3dCurve()
    return curve3d

def regularize_to_right_angles(pts):
    """꼭짓점들을 직각으로 보정 (OBB 기반)"""
    # Oriented Bounding Box 방향 찾기
    pts_2d = [rg.Point3d(p.X, p.Y, 0) for p in pts]

    # 주축 방향 찾기 (가장 긴 변)
    max_len = 0
    main_dir = rg.Vector3d(1, 0, 0)
    n = len(pts_2d)

    for i in range(n):
        j = (i + 1) % n
        dx = pts_2d[j].X - pts_2d[i].X
        dy = pts_2d[j].Y - pts_2d[i].Y
        length = math.sqrt(dx*dx + dy*dy)
        if length > max_len:
            max_len = length
            main_dir = rg.Vector3d(dx/length, dy/length, 0)

    # 직교 방향
    perp_dir = rg.Vector3d(-main_dir.Y, main_dir.X, 0)

    # 모든 점을 주축/직교축 좌표계로 변환
    center = rg.Point3d(
        sum(p.X for p in pts_2d) / n,
        sum(p.Y for p in pts_2d) / n,
        pts[0].Z
    )

    u_vals = []
    v_vals = []
    for p in pts_2d:
        dx = p.X - center.X
        dy = p.Y - center.Y
        u = dx * main_dir.X + dy * main_dir.Y
        v = dx * perp_dir.X + dy * perp_dir.Y
        u_vals.append(u)
        v_vals.append(v)

    # OBB 범위
    u_min, u_max = min(u_vals), max(u_vals)
    v_min, v_max = min(v_vals), max(v_vals)

    z = pts[0].Z

    # 직각 사각형 꼭짓점 (반시계)
    corners = [
        rg.Point3d(center.X + u_min*main_dir.X + v_min*perp_dir.X,
                    center.Y + u_min*main_dir.Y + v_min*perp_dir.Y, z),
        rg.Point3d(center.X + u_max*main_dir.X + v_min*perp_dir.X,
                    center.Y + u_max*main_dir.Y + v_min*perp_dir.Y, z),
        rg.Point3d(center.X + u_max*main_dir.X + v_max*perp_dir.X,
                    center.Y + u_max*main_dir.Y + v_max*perp_dir.Y, z),
        rg.Point3d(center.X + u_min*main_dir.X + v_max*perp_dir.X,
                    center.Y + u_min*main_dir.Y + v_max*perp_dir.Y, z),
    ]

    # 긴변/짧은변 판별
    side_a = corners[0].DistanceTo(corners[1])  # u 방향
    side_b = corners[1].DistanceTo(corners[2])  # v 방향

    long_dir = main_dir if side_a >= side_b else perp_dir
    short_dir = perp_dir if side_a >= side_b else main_dir
    long_len = max(side_a, side_b)
    short_len = min(side_a, side_b)

    return corners, long_dir, short_dir, long_len, short_len

def make_layer(name, color=None):
    """레이어 생성 (없으면)"""
    if not rs.IsLayer(name):
        rs.AddLayer(name, color)
    return name

def rect_pts(cx, cy, z, w, h, dir_u, dir_v):
    """중심 기준 사각형 4점"""
    hu, hv = w/2.0, h/2.0
    return [
        rg.Point3d(cx - hu*dir_u.X - hv*dir_v.X, cy - hu*dir_u.Y - hv*dir_v.Y, z),
        rg.Point3d(cx + hu*dir_u.X - hv*dir_v.X, cy + hu*dir_u.Y - hv*dir_v.Y, z),
        rg.Point3d(cx + hu*dir_u.X + hv*dir_v.X, cy + hu*dir_u.Y + hv*dir_v.Y, z),
        rg.Point3d(cx - hu*dir_u.X + hv*dir_v.X, cy - hu*dir_u.Y + hv*dir_v.Y, z),
    ]

# ── 메인 생성 함수 ──
def generate_apartment(brep_id):
    """박스 하나를 아파트로 변환"""
    base_pts, total_height = get_base_and_height(brep_id)
    if not base_pts or total_height < FLOOR_HEIGHT:
        print("유효하지 않은 객체: 높이 부족")
        return

    # 직각화
    corners, long_dir, short_dir, long_len, short_len = regularize_to_right_angles(base_pts)
    z_base = corners[0].Z
    num_floors = max(1, int(round(total_height / FLOOR_HEIGHT)))
    actual_height = num_floors * FLOOR_HEIGHT

    print("  긴변: {:.0f}mm, 짧은변: {:.0f}mm, 층수: {}".format(long_len, short_len, num_floors))

    # 중심점
    cx = sum(c.X for c in corners) / 4.0
    cy = sum(c.Y for c in corners) / 4.0

    # 레이어 생성
    lyr_mass = make_layer("APT_Mass", rs.CreateColor(200, 200, 210))
    lyr_window = make_layer("APT_Windows", rs.CreateColor(150, 200, 230))
    lyr_balcony = make_layer("APT_Balcony", rs.CreateColor(180, 180, 180))
    lyr_core = make_layer("APT_Core", rs.CreateColor(120, 120, 130))
    lyr_parapet = make_layer("APT_Parapet", rs.CreateColor(160, 160, 170))
    lyr_roof = make_layer("APT_RoofStructure", rs.CreateColor(140, 140, 150))

    created = []

    # ── 1. 매스 (직각화된 본체) ──
    base_crv_pts = list(corners) + [corners[0]]
    base_crv = rs.AddPolyline([rs.CreatePoint(p.X, p.Y, z_base) for p in base_crv_pts])
    mass = rs.ExtrudeCurveStraight(base_crv, (0,0,0), (0,0,actual_height))
    if mass:
        rs.CapPlanarHoles(mass)
        rs.ObjectLayer(mass, lyr_mass)
        created.append(mass)
    rs.DeleteObject(base_crv)

    # ── 2. 긴변 창문 + 발코니 ──
    # 긴변 4개의 시작/끝 (두 면)
    long_sides = []
    for i in range(4):
        j = (i + 1) % 4
        edge_vec = rg.Vector3d(corners[j].X - corners[i].X, corners[j].Y - corners[i].Y, 0)
        edge_len = edge_vec.Length
        if abs(edge_len - long_len) < 500:  # 긴변
            mid_x = (corners[i].X + corners[j].X) / 2.0
            mid_y = (corners[i].Y + corners[j].Y) / 2.0
            # 외향 법선 (건물 바깥쪽)
            normal = rg.Vector3d(-edge_vec.Y / edge_len, edge_vec.X / edge_len, 0)
            # 중심에서 이 면의 중점 방향이 법선과 같은지 확인
            to_mid = rg.Vector3d(mid_x - cx, mid_y - cy, 0)
            if to_mid * normal < 0:
                normal = -normal
            long_sides.append({
                'start': corners[i], 'end': corners[j],
                'normal': normal, 'length': edge_len
            })

    for side in long_sides:
        edge_dir = rg.Vector3d(side['end'].X - side['start'].X,
                               side['end'].Y - side['start'].Y, 0)
        edge_dir.Unitize()
        normal = side['normal']
        n_bays = max(1, int(side['length'] / BAY_WIDTH))
        actual_bay = side['length'] / n_bays

        for floor in range(num_floors):
            z_floor = z_base + floor * FLOOR_HEIGHT

            for bay in range(n_bays):
                t = (bay + 0.5) / n_bays
                win_cx = side['start'].X + edge_dir.X * side['length'] * t
                win_cy = side['start'].Y + edge_dir.Y * side['length'] * t

                # 창문 (벽면에서 약간 들어간 위치)
                win_w = actual_bay * 0.7
                win_h = WINDOW_HEIGHT
                z_win = z_floor + WINDOW_SILL

                w_pts = [
                    rs.CreatePoint(win_cx - edge_dir.X*win_w/2, win_cy - edge_dir.Y*win_w/2, z_win),
                    rs.CreatePoint(win_cx + edge_dir.X*win_w/2, win_cy + edge_dir.Y*win_w/2, z_win),
                    rs.CreatePoint(win_cx + edge_dir.X*win_w/2, win_cy + edge_dir.Y*win_w/2, z_win + win_h),
                    rs.CreatePoint(win_cx - edge_dir.X*win_w/2, win_cy - edge_dir.Y*win_w/2, z_win + win_h),
                    rs.CreatePoint(win_cx - edge_dir.X*win_w/2, win_cy - edge_dir.Y*win_w/2, z_win),
                ]
                win_crv = rs.AddPolyline(w_pts)
                win_srf = rs.AddPlanarSrf(win_crv)
                if win_srf:
                    for s in win_srf:
                        rs.ObjectLayer(s, lyr_window)
                        created.append(s)
                rs.DeleteObject(win_crv)

                # 발코니 (2층부터)
                if floor >= 1:
                    bal_w = actual_bay * 0.8
                    bal_base_z = z_floor
                    bal_pts = [
                        rs.CreatePoint(win_cx - edge_dir.X*bal_w/2 + normal.X*10,
                                       win_cy - edge_dir.Y*bal_w/2 + normal.Y*10, bal_base_z),
                        rs.CreatePoint(win_cx + edge_dir.X*bal_w/2 + normal.X*10,
                                       win_cy + edge_dir.Y*bal_w/2 + normal.Y*10, bal_base_z),
                        rs.CreatePoint(win_cx + edge_dir.X*bal_w/2 + normal.X*(10+BALCONY_DEPTH),
                                       win_cy + edge_dir.Y*bal_w/2 + normal.Y*(10+BALCONY_DEPTH), bal_base_z),
                        rs.CreatePoint(win_cx - edge_dir.X*bal_w/2 + normal.X*(10+BALCONY_DEPTH),
                                       win_cy - edge_dir.Y*bal_w/2 + normal.Y*(10+BALCONY_DEPTH), bal_base_z),
                        rs.CreatePoint(win_cx - edge_dir.X*bal_w/2 + normal.X*10,
                                       win_cy - edge_dir.Y*bal_w/2 + normal.Y*10, bal_base_z),
                    ]
                    bal_crv = rs.AddPolyline(bal_pts)
                    bal_slab = rs.ExtrudeCurveStraight(bal_crv, (0,0,0), (0,0,150))
                    if bal_slab:
                        rs.CapPlanarHoles(bal_slab)
                        rs.ObjectLayer(bal_slab, lyr_balcony)
                        created.append(bal_slab)
                    # 난간
                    rail = rs.ExtrudeCurveStraight(bal_crv, (0,0,0), (0,0,BALCONY_HEIGHT))
                    if rail:
                        rs.ObjectLayer(rail, lyr_balcony)
                        created.append(rail)
                    rs.DeleteObject(bal_crv)

    # ── 3. 짧은변 창문 ──
    short_sides = []
    for i in range(4):
        j = (i + 1) % 4
        edge_vec = rg.Vector3d(corners[j].X - corners[i].X, corners[j].Y - corners[i].Y, 0)
        edge_len = edge_vec.Length
        if abs(edge_len - short_len) < 500:  # 짧은변
            mid_x = (corners[i].X + corners[j].X) / 2.0
            mid_y = (corners[i].Y + corners[j].Y) / 2.0
            normal = rg.Vector3d(-edge_vec.Y / edge_len, edge_vec.X / edge_len, 0)
            to_mid = rg.Vector3d(mid_x - cx, mid_y - cy, 0)
            if to_mid * normal < 0:
                normal = -normal
            short_sides.append({
                'start': corners[i], 'end': corners[j],
                'normal': normal, 'length': edge_len,
                'edge_dir': rg.Vector3d(edge_vec.X/edge_len, edge_vec.Y/edge_len, 0)
            })

    for side in short_sides:
        edge_dir = side['edge_dir']
        n_wins = max(1, int(side['length'] / (SHORT_WINDOW_WIDTH * 3)))

        for floor in range(num_floors):
            z_floor = z_base + floor * FLOOR_HEIGHT
            z_win = z_floor + WINDOW_SILL + 200

            for w in range(n_wins):
                t = (w + 0.5) / n_wins
                win_cx = side['start'].X + edge_dir.X * side['length'] * t
                win_cy = side['start'].Y + edge_dir.Y * side['length'] * t

                w_pts = [
                    rs.CreatePoint(win_cx - edge_dir.X*SHORT_WINDOW_WIDTH/2,
                                   win_cy - edge_dir.Y*SHORT_WINDOW_WIDTH/2, z_win),
                    rs.CreatePoint(win_cx + edge_dir.X*SHORT_WINDOW_WIDTH/2,
                                   win_cy + edge_dir.Y*SHORT_WINDOW_WIDTH/2, z_win),
                    rs.CreatePoint(win_cx + edge_dir.X*SHORT_WINDOW_WIDTH/2,
                                   win_cy + edge_dir.Y*SHORT_WINDOW_WIDTH/2, z_win + SHORT_WINDOW_HEIGHT),
                    rs.CreatePoint(win_cx - edge_dir.X*SHORT_WINDOW_WIDTH/2,
                                   win_cy - edge_dir.Y*SHORT_WINDOW_WIDTH/2, z_win + SHORT_WINDOW_HEIGHT),
                    rs.CreatePoint(win_cx - edge_dir.X*SHORT_WINDOW_WIDTH/2,
                                   win_cy - edge_dir.Y*SHORT_WINDOW_WIDTH/2, z_win),
                ]
                win_crv = rs.AddPolyline(w_pts)
                win_srf = rs.AddPlanarSrf(win_crv)
                if win_srf:
                    for s in win_srf:
                        rs.ObjectLayer(s, lyr_window)
                        created.append(s)
                rs.DeleteObject(win_crv)

    # ── 4. 코어 ──
    # 건물 길이에 따라 코어 개수/위치
    if long_len < 30000:
        # 짧은 건물: 코어 1개 (중앙)
        core_positions = [(cx, cy)]
    elif long_len < 60000:
        # 중간 건물: 코어 1개 (1/3 지점)
        core_positions = [
            (cx + long_dir.X * long_len * 0.2, cy + long_dir.Y * long_len * 0.2)
        ]
    else:
        # 긴 건물: 코어 2개 (1/4, 3/4)
        core_positions = [
            (cx - long_dir.X * long_len * 0.25, cy - long_dir.Y * long_len * 0.25),
            (cx + long_dir.X * long_len * 0.25, cy + long_dir.Y * long_len * 0.25),
        ]

    for core_cx, core_cy in core_positions:
        # 코어 본체 (건물 높이)
        core_pts = rect_pts(core_cx, core_cy, z_base, CORE_WIDTH, CORE_DEPTH, long_dir, short_dir)
        core_crv_pts = [rs.CreatePoint(p.X, p.Y, p.Z) for p in core_pts]
        core_crv_pts.append(core_crv_pts[0])
        core_crv = rs.AddPolyline(core_crv_pts)
        core_ext = rs.ExtrudeCurveStraight(core_crv, (0,0,0), (0,0,actual_height))
        if core_ext:
            rs.CapPlanarHoles(core_ext)
            rs.ObjectLayer(core_ext, lyr_core)
            created.append(core_ext)
        rs.DeleteObject(core_crv)

        # 옥상 코어 돌출
        roof_core_pts = rect_pts(core_cx, core_cy, z_base + actual_height, CORE_WIDTH, CORE_DEPTH, long_dir, short_dir)
        roof_crv_pts = [rs.CreatePoint(p.X, p.Y, p.Z) for p in roof_core_pts]
        roof_crv_pts.append(roof_crv_pts[0])
        roof_crv = rs.AddPolyline(roof_crv_pts)
        roof_ext = rs.ExtrudeCurveStraight(roof_crv, (0,0,0), (0,0,CORE_OVERRUN))
        if roof_ext:
            rs.CapPlanarHoles(roof_ext)
            rs.ObjectLayer(roof_ext, lyr_roof)
            created.append(roof_ext)
        rs.DeleteObject(roof_crv)

    # ── 5. 파라펫 ──
    parapet_outer_pts = list(corners) + [corners[0]]
    parapet_outer = rs.AddPolyline([rs.CreatePoint(p.X, p.Y, z_base + actual_height) for p in parapet_outer_pts])

    # 안쪽 오프셋 (200mm)
    offset_dist = 200
    inner_corners = []
    for c in corners:
        dx = c.X - cx
        dy = c.Y - cy
        dist = math.sqrt(dx*dx + dy*dy)
        if dist > 0:
            inner_corners.append(rg.Point3d(
                c.X - dx/dist * offset_dist,
                c.Y - dy/dist * offset_dist,
                z_base + actual_height
            ))
        else:
            inner_corners.append(rg.Point3d(c.X, c.Y, z_base + actual_height))

    parapet_inner_pts = inner_corners + [inner_corners[0]]
    parapet_inner = rs.AddPolyline([rs.CreatePoint(p.X, p.Y, p.Z) for p in parapet_inner_pts])

    # 파라펫 = 외곽 - 내곽 사이를 올림
    parapet_srf = rs.ExtrudeCurveStraight(parapet_outer, (0,0,0), (0,0,PARAPET_HEIGHT))
    if parapet_srf:
        rs.CapPlanarHoles(parapet_srf)
        rs.ObjectLayer(parapet_srf, lyr_parapet)
        created.append(parapet_srf)

    rs.DeleteObject(parapet_outer)
    rs.DeleteObject(parapet_inner)

    # 원본 박스 숨기기
    rs.HideObject(brep_id)

    print("  생성 완료: {} 객체".format(len(created)))
    return created


# ── 실행 ──
def main():
    objs = rs.GetObjects("아파트로 변환할 박스를 선택하세요", 16+8)  # polysrf + extrusion
    if not objs:
        print("선택 없음")
        return

    rs.EnableRedraw(False)

    total = 0
    for i, obj in enumerate(objs):
        print("[{}/{}] 처리 중...".format(i+1, len(objs)))
        result = generate_apartment(obj)
        if result:
            total += len(result)

    rs.EnableRedraw(True)
    print("\n완료! 총 {} 객체 생성".format(total))

main()
