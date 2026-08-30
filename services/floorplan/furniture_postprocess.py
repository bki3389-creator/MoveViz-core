#!/usr/bin/env python3
"""furniture_postprocess.py — 폴리캠식 가구 "후처리 스냅".

리서치 결론: 폴리캠/RoomPlan 가구가 깔끔한 건 검출이 아니라 후처리(① 카테고리 표준치수
스냅 ② 축정렬 회전 ③ 중복병합)에서 나온다. 검출(glb_furniture_v5) 무수정, 출력 리스트만 받아 정돈.

입력/출력: v5 furniture dict 리스트(+ angle_deg/category/snapped 필드 추가).
순수 함수 — 메시 불필요(데스크톱만으로 동작). over-snap 방지: 잔차 임계 안에서만 스냅.
"""
import numpy as np

# (cat, 한글, [(w,l)...] 표준치수, (h_min,h_max))  — KS/IEC 근사
CANON = [
    ("bed",      "침대",   [(1.10, 2.00), (1.50, 2.00), (1.80, 2.00)], (0.30, 0.80)),
    ("sofa",     "소파",   [(1.60, 0.85), (2.10, 0.90), (2.40, 0.95)], (0.50, 0.95)),
    ("table",    "식탁",   [(1.20, 0.80), (1.40, 0.85), (1.60, 0.90)], (0.62, 0.82)),
    ("desk",     "책상",   [(1.20, 0.60), (1.40, 0.70)],               (0.68, 0.82)),
    ("chair",    "의자",   [(0.50, 0.50), (0.55, 0.55)],               (0.40, 1.05)),
    ("wardrobe", "옷장",   [(1.00, 0.60), (1.20, 0.60), (1.50, 0.60)], (1.50, 2.40)),
    ("fridge",   "냉장고", [(0.70, 0.70), (0.90, 0.75)],               (1.50, 2.10)),
    ("washer",   "세탁기", [(0.60, 0.60), (0.65, 0.65)],               (0.78, 1.00)),
    ("shelf",    "수납장", [(0.80, 0.30), (1.20, 0.40), (1.80, 0.40)], (1.20, 2.40)),
    ("tv",       "TV장",  [(1.20, 0.40), (1.50, 0.40)],                (0.40, 0.66)),
]


def _obb_wla(obb):
    """obb 4점 → (긴변 w, 짧은변 l, 각도deg[0~180], 중심)."""
    p = np.asarray(obb, float)
    e0 = p[1] - p[0]; e1 = p[2] - p[1]
    l0, l1 = np.hypot(*e0), np.hypot(*e1)
    if l0 >= l1:
        w, l, edge = l0, l1, e0
    else:
        w, l, edge = l1, l0, e1
    ang = np.degrees(np.arctan2(edge[1], edge[0])) % 180.0
    c = p.mean(0)
    return float(w), float(l), float(ang), c


def _make_obb(center, w, l, ang_deg):
    """중심·긴변(w)·짧은변(l)·각도 → obb 4점."""
    a = np.radians(ang_deg)
    u = np.array([np.cos(a), np.sin(a)])      # 긴변 방향
    v = np.array([-np.sin(a), np.cos(a)])     # 짧은변 방향
    c = np.asarray(center, float)
    hw, hl = w/2, l/2
    return [(c + u*sx*hw + v*sy*hl).tolist()
            for sx, sy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]]


def _classify_and_snap(w, l, h, snap_tol):
    """(w,l,h) → (cat, 한글, snapped(w,l), conf, snapped?). 잔차>임계면 원본 유지."""
    best = None
    for cat, ko, sizes, (hmin, hmax) in CANON:
        if not (hmin - 0.15 <= h <= hmax + 0.15):
            continue
        for (W, L) in sizes:
            res = abs(w - W) + abs(l - L)
            if best is None or res < best[0]:
                best = (res, cat, ko, W, L)
    if best is None:
        return ("unknown", "가구", w, l, "low", False)
    res, cat, ko, W, L = best
    if res <= snap_tol:
        return (cat, ko, W, L, "high", True)
    # 카테고리는 추정하되 치수는 원본 유지(over-snap 방지)
    conf = "med" if res <= snap_tol * 2.2 else "low"
    return (cat, ko, w, l, conf, False)


def _aabb(obb):
    p = np.asarray(obb, float)
    return p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()


def _iou(a, b):
    ax0, az0, ax1, az1 = _aabb(a); bx0, bz0, bx1, bz1 = _aabb(b)
    ix0, iz0 = max(ax0, bx0), max(az0, bz0)
    ix1, iz1 = min(ax1, bx1), min(az1, bz1)
    iw, ih = max(0, ix1-ix0), max(0, iz1-iz0)
    inter = iw*ih
    ua = (ax1-ax0)*(az1-az0) + (bx1-bx0)*(bz1-bz0) - inter
    return inter/ua if ua > 1e-9 else 0.0


def refine_furniture(furniture, rooms=None, snap_tol=0.22, nms_iou=0.45,
                     min_footprint=0.12, max_aspect=6.0):
    """Manhattan 방 가정 → **축정렬(axis-aligned) 박스**로 정돈 + 카테고리·표준치수 스냅 + 병합.
    핵심 변경: min-area-rect의 엉뚱한 회전 대신 bbox(축정렬)를 기준으로 삼아 떨림 제거."""
    out = []
    for f in furniture:
        bb = f.get("bbox")
        if not bb or len(bb) < 4:
            continue
        x0, z0, x1, z1 = bb
        wx, wz = abs(x1 - x0), abs(z1 - z0)       # x·z축 길이(축정렬)
        if wx * wz < 1e-4:
            continue
        w, l = max(wx, wz), min(wx, wz)            # 긴변/짧은변
        if w / max(l, 1e-3) > max_aspect:
            continue                                # 가늘고 긴 노이즈 제거
        long_x = wx >= wz
        h = f.get("height_m", 0.5)
        cat, ko, W, L, conf, did = _classify_and_snap(w, l, h, snap_tol)
        if W * L < min_footprint and cat == "unknown":
            continue                                # 작은 미상 = 노이즈

        # 축정렬 박스: 긴변을 원래 긴축(x or z)에 배치, 중심 유지
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        ax = (W if long_x else L); az = (L if long_x else W)
        obb = [[cx-ax/2, cz-az/2], [cx+ax/2, cz-az/2],
               [cx+ax/2, cz+az/2], [cx-ax/2, cz+az/2]]
        nf = dict(f)
        nf["obb"] = [[round(p[0], 3), round(p[1], 3)] for p in obb]
        nf["polygon"] = nf["obb"]
        nf["bbox"] = [round(cx-ax/2, 3), round(cz-az/2, 3), round(cx+ax/2, 3), round(cz+az/2, 3)]
        nf["angle_deg"] = 0.0 if long_x else 90.0
        nf["dims"] = [round(W, 2), round(L, 2)]
        nf["footprint_m2"] = round(W * L, 2)
        nf["category"], nf["category_ko"], nf["category_conf"] = cat, ko, conf
        nf["snapped"] = bool(did)
        out.append(nf)

    # 중복 병합: ① IoU NMS ② 근접 중심(타일형 과검출 무더기) 병합 — 큰 박스 유지
    out.sort(key=lambda f: -f.get("footprint_m2", 0))
    kept = []
    for f in out:
        fc = ((f["bbox"][0]+f["bbox"][2])/2, (f["bbox"][1]+f["bbox"][3])/2)
        merged = False
        for k in kept:
            kc = ((k["bbox"][0]+k["bbox"][2])/2, (k["bbox"][1]+k["bbox"][3])/2)
            near = ((fc[0]-kc[0])**2 + (fc[1]-kc[1])**2) ** 0.5 < 0.45
            if _iou(f["obb"], k["obb"]) > nms_iou or near:
                merged = True; break
        if not merged:
            kept.append(f)
    for i, f in enumerate(kept):
        f["id"] = i
    return kept


if __name__ == "__main__":
    import sys, json
    d = json.load(open(sys.argv[1]))
    fn = d.get("furniture", [])
    refined = refine_furniture(fn, d.get("rooms"))
    from collections import Counter
    print(f"입력 {len(fn)} → 정제 {len(refined)}")
    print("카테고리:", dict(Counter(f["category_ko"] for f in refined)))
    print("표준치수 스냅:", sum(1 for f in refined if f["snapped"]), "개")
    d["furniture"] = refined
    out = sys.argv[2] if len(sys.argv) > 2 else "refined.json"
    json.dump(d, open(out, "w"))
    print("saved:", out)
