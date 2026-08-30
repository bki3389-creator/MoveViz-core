#!/usr/bin/env python3
"""detect_furniture_vision.py — 키프레임 오픈보캡 2D검출(OWLv2)을 메시에 투표해
회전 가구박스 + 공간유형을 만든다. (deep-research 결론의 구현)

파이프라인(전부 Apple Silicon 맥 / NVIDIA 불필요 / 상업 라이선스 클린):
  1. OWLv2(google/owlv2-base-patch16-ensemble, Apache-2.0)로 키프레임마다 오픈보캡 2D박스.
  2. 메시 정점을 각 키프레임에 투영(colorize_vertices 재사용) + z-buffer 오클루전 → 박스 라벨을
     '정점'에 투표(score×정면도 가중). ★카테고리는 RGB가 결정 → 기하점유의 책상→침대 오인 차단.
  3. 정점 라벨 → 카테고리별 DBSCAN 인스턴스 분리.
  4. 인스턴스마다 바닥(XZ)에 cv2.minAreaRect로 회전 OBB(yaw) + Y범위로 높이.
  5. 가구 히스토그램 기반 공간유형(집/사무실/카페/매장/창고) 1차 분류.

좌표: ARKit world = Y-up(중력 +Y), 바닥평면 = XZ. 회전박스는 Y축 yaw만.
검증: `python detect_furniture_vision.py --selftest` (모델 없이 기하 경로 검증, 합성 박스 주입).
      `python detect_furniture_vision.py --owlv2-image <img.jpg>` (OWLv2 단독 동작 확인).
"""
from __future__ import annotations
import os, json
import numpy as np
from colorize_vertices import project_points, frontal_weight, load_views

# ── 오픈보캡 프롬프트 → 캐논 카테고리 ─────────────────────────────────────
# 집/사무실/카페/매장/창고를 두루 덮는 어휘. 세부 라벨을 캐논으로 합쳐 출력.
CANON = {
    "bed": "bed",
    "sofa": "sofa", "couch": "sofa",
    "armchair": "chair", "chair": "chair", "office chair": "chair", "stool": "chair",
    "desk": "desk", "office desk": "desk",
    "dining table": "table", "coffee table": "table", "table": "table", "conference table": "table",
    "computer monitor": "monitor", "monitor": "monitor", "laptop": "monitor",
    "television": "tv", "tv": "tv",
    "refrigerator": "refrigerator",
    "washing machine": "appliance", "stove": "appliance", "oven": "appliance", "microwave": "appliance",
    "toilet": "toilet", "sink": "sink", "bathtub": "bathtub",
    "bookshelf": "shelf", "shelf": "shelf",
    "cabinet": "cabinet", "wardrobe": "cabinet", "filing cabinet": "cabinet", "drawer": "cabinet",
    "storage rack": "rack", "shelving unit": "rack", "display shelf": "rack", "clothing rack": "rack",
    "whiteboard": "whiteboard",
    "counter": "counter", "kitchen counter": "counter",
    "potted plant": "plant",
}
PROMPTS = list(CANON.keys())

# 공간유형별 그럴듯한 가구(allowlist) — 분류된 공간 밖 카테고리는 제거.
# 예: bathroom이면 bed/tv/냉장고 오검출을 끊는다.
SPACE_FURNITURE = {
    "bathroom": {"toilet", "sink", "bathtub", "cabinet", "shelf", "counter", "appliance"},
    "home":     {"bed", "sofa", "chair", "table", "tv", "monitor", "cabinet", "shelf",
                 "refrigerator", "appliance", "counter", "plant", "sink"},
    "office":   {"desk", "monitor", "chair", "table", "cabinet", "shelf", "whiteboard", "sofa", "tv", "plant"},
    "cafe":     {"table", "chair", "counter", "sofa", "shelf", "plant", "refrigerator", "appliance"},
    "retail":   {"rack", "shelf", "counter", "table", "chair", "cabinet", "plant"},
    "warehouse": {"rack", "shelf", "cabinet", "counter"},
}
# 큰 가구는 바닥 긴변이 이 값 미만이면 오클러스터로 보고 제거(m).
# 반감: 실측 욕조 장변 0.97~0.99m가 bathtub=1.1에 걸려 전멸했었음(진단#2). 실측 우선으로 완화.
SIZE_MIN_LONG = {"bed": 0.75, "sofa": 0.65, "bathtub": 0.55, "desk": 0.4, "refrigerator": 0.225, "table": 0.25}

# 표준 가구 치수(긴변, 짧은변, 높이) m — 검출 박스를 여기에 스냅해 '스케일이 맞는' 평면도.
# 투표 클러스터 OBB는 bleed로 과대해지므로, 실제 가구 표준치수로 교정한다(폴리캠식).
CANON_DIMS = {
    "toilet": (0.68, 0.38, 0.75), "sink": (0.55, 0.42, 0.85), "bathtub": (1.50, 0.72, 0.55),
    "bed": (2.00, 1.50, 0.50), "sofa": (1.80, 0.85, 0.80), "chair": (0.50, 0.50, 0.90),
    "desk": (1.20, 0.60, 0.75), "table": (1.10, 0.75, 0.74), "refrigerator": (0.70, 0.70, 1.80),
    "monitor": (0.55, 0.20, 0.40), "tv": (1.10, 0.08, 0.65), "cabinet": (0.80, 0.45, 1.00),
    "shelf": (0.80, 0.30, 1.80), "counter": (1.20, 0.60, 0.90), "rack": (1.00, 0.50, 1.80),
    "appliance": (0.60, 0.60, 0.85), "whiteboard": (1.20, 0.05, 0.90), "plant": (0.40, 0.40, 0.80),
}


# 표준 치수가 거의 고정인 기물 — 측정 bleed보다 표준이 정확 → canonical 스냅.
FIXED_FIXTURES = {"toilet", "sink", "bathtub", "refrigerator", "tv", "monitor", "chair", "appliance"}

def snap_canonical(o, lo=0.6, hi=1.6):
    """기물(고정치수)은 canonical 스냅, 가변가구(테이블/책상/침대 등)는 측정값을 [lo,hi]배로만 클램프(실측 우선)."""
    c = CANON_DIMS.get(o["category"])
    if not c:
        return o
    lng, sht, h = c
    w, hh, d = o["dims"]
    if o["category"] in FIXED_FIXTURES:
        o["dims"] = [lng, h, sht] if w >= d else [sht, h, lng]
        return o
    longm, shortm = max(w, d), min(w, d)
    longc = min(max(longm, lng * lo), lng * hi)
    shortc = min(max(shortm, sht * lo), sht * hi)
    hc = min(max(hh, h * lo), h * hi)
    o["dims"] = [longc, hc, shortc] if w >= d else [shortc, hc, longc]
    return o


def merge_same_category(objs, iou_thresh=0.3):
    """같은 카테고리가 바닥 footprint(회전 사각형) IoU>iou_thresh로 겹칠 때만 점수 높은 것 유지.
    (기존 중심거리<0.6m 기준은 인접한 실제 의자들·쌍 세면대를 오삭제했음 → 진단#3c) IoU로 교체."""
    from shapely.geometry import Polygon
    import cv2

    def poly(o):
        cx, _, cz = o["center"]; w, _, d = o["dims"]
        p = Polygon(cv2.boxPoints(((cx, cz), (max(w, 0.01), max(d, 0.01)), o.get("yaw_deg", 0.0))))
        return p if p.is_valid else p.buffer(0)

    out, polys = [], []
    for o in sorted(objs, key=lambda x: -x.get("score", 0)):
        p = poly(o); dup = False
        for q, qc in polys:
            if qc != o["category"]:
                continue
            inter = p.intersection(q).area
            if inter > 0:
                union = p.area + q.area - inter
                if union > 0 and inter / union > iou_thresh:
                    dup = True; break
        if not dup:
            out.append(o); polys.append((p, o["category"]))
    return out

# 공간유형 추론 가중치: 카테고리 → {유형: 점수}
SPACE_WEIGHTS = {
    "bed": {"home": 3}, "sofa": {"home": 2}, "tv": {"home": 1.5},
    "toilet": {"home": 1, "bathroom": 3}, "bathtub": {"bathroom": 3}, "sink": {"bathroom": 1, "home": 0.5},
    "refrigerator": {"home": 1.5}, "appliance": {"home": 1},
    "desk": {"office": 3}, "monitor": {"office": 2.5}, "whiteboard": {"office": 2.5},
    "cabinet": {"office": 0.5, "home": 0.5},
    "counter": {"cafe": 2, "retail": 1.5}, "rack": {"retail": 2, "warehouse": 2.5},
    "chair": {"office": 0.3, "cafe": 0.6, "home": 0.3}, "table": {"home": 0.5, "cafe": 0.8, "office": 0.5},
    "shelf": {"home": 0.4, "retail": 0.8}, "plant": {"home": 0.3, "cafe": 0.3},
}


# ── OWLv2 (지연 로드, 1회 캐시) ───────────────────────────────────────────
_OWL = {}

def _load_owlv2(model_id="google/owlv2-base-patch16-ensemble", device=None):
    """device: 'cpu'|'mps'|None. None이면 FURNITURE_DEVICE 환경변수 → mps(가능시) → cpu 순.
    무거운 GPU 작업이 있을 때 CPU로 강제할 수 있게 파라미터화(하드코딩 제거)."""
    if "model" in _OWL and (device is None or _OWL.get("dev") == device):
        return _OWL
    import torch
    from transformers import Owlv2Processor, Owlv2ForObjectDetection
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    # 모델 캐시됨 → HF 오프라인 고정(매 추론마다 HF API 접속/rate-limit '에러' 방지)
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    if device is None:
        device = os.environ.get("FURNITURE_DEVICE") or (
            "mps" if torch.backends.mps.is_available() else "cpu")
    proc = Owlv2Processor.from_pretrained(model_id)
    model = Owlv2ForObjectDetection.from_pretrained(model_id).to(device).eval()
    _OWL.clear()
    _OWL.update(model=model, proc=proc, dev=device, torch=torch)
    return _OWL


def detect_image(rgb, prompts=PROMPTS, thresh=0.10, device=None):
    """RGB(HxWx3 uint8) → [(label, score, (x0,y0,x1,y1)), ...] (픽셀 좌표)."""
    from PIL import Image
    o = _load_owlv2(device=device); torch = o["torch"]
    pil = Image.fromarray(rgb)
    inp = o["proc"](text=[prompts], images=pil, return_tensors="pt").to(o["dev"])
    with torch.no_grad():
        out = o["model"](**inp)
    th = torch.tensor([[pil.height, pil.width]]).to(o["dev"])
    # transformers 5.x: OWLv2는 post_process_grounded_object_detection 사용
    pp = (o["proc"].post_process_grounded_object_detection
          if hasattr(o["proc"], "post_process_grounded_object_detection")
          else o["proc"].post_process_object_detection)
    try:
        res = pp(out, threshold=thresh, target_sizes=th, text_labels=[prompts])[0]
    except TypeError:
        res = pp(out, threshold=thresh, target_sizes=th)[0]
    boxes = res["boxes"].detach().cpu().numpy()
    scores = res["scores"].detach().cpu().numpy()
    tl = res.get("text_labels")
    if tl is not None:
        return [(str(tl[i]), float(scores[i]), tuple(map(float, boxes[i]))) for i in range(len(scores))]
    labels = res["labels"].detach().cpu().numpy()
    return [(prompts[int(l)], float(s), tuple(map(float, b)))
            for b, s, l in zip(boxes, scores, labels)]


# ── 키프레임 정립(중력 기반) — 검출 전 바로 세우고 박스는 원본좌표로 역매핑 ──
# ARKit는 세로 스캔이어도 키프레임을 가로 센서 방향으로 저장 → OWLv2가 옆으로 누운
# 변기/욕조/소파를 봄. 카메라 포즈의 중력(월드 +Y)을 이미지에 투영해 회전수 k를 정한다.
# (실측: 이 스캔들의 108/109 프레임이 k=3=시계90°. 근거는 육안 A/B로 검증됨.)
def gravity_rotation_k(cam_to_world):
    """OpenCV 규약 cam_to_world(+X right,+Y down,+Z fwd)에서 월드 상방(+Y)이 이미지
    위쪽을 향하게 하는 np.rot90(반시계) 회전수 k∈{0,1,2,3}."""
    R = np.asarray(cam_to_world, float)[:3, :3]
    up_cam = R.T @ np.array([0.0, 1.0, 0.0])          # 카메라 프레임에서의 월드 상방
    gx, gy = float(up_cam[0]), float(up_cam[1])
    if abs(gy) >= abs(gx):
        return 0 if gy < 0 else 2                      # 위 / 아래(180°)
    return 1 if gx > 0 else 3                          # 오른쪽(반시계90°) / 왼쪽(시계90°)


def _unrotate_box(box, k, w, h):
    """np.rot90(img,k) 프레임의 박스(x0,y0,x1,y1) → 원본(w×h) 이미지 좌표 박스.
    (roundtrip 단위검증 완료: 4방향 모두 ≤1px 오차)"""
    x0, y0, x1, y1 = box
    out = []
    for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
        if k == 0:
            ox, oy = x, y
        elif k == 1:
            ox, oy = w - 1 - y, x
        elif k == 2:
            ox, oy = w - 1 - x, h - 1 - y
        else:
            ox, oy = y, h - 1 - x
        out.append((ox, oy))
    xs = [p[0] for p in out]; ys = [p[1] for p in out]
    return (min(xs), min(ys), max(xs), max(ys))


def detect_image_upright(rgb, cam_to_world, prompts=PROMPTS, thresh=0.10, device=None):
    """중력으로 이미지를 바로 세워 OWLv2 검출 후, 박스를 '원본 이미지 좌표'로 역매핑.
    ★투표/투영은 원본 좌표·원본 K를 그대로 쓰므로 기하가 어긋나지 않는다."""
    h, w = rgb.shape[:2]
    k = gravity_rotation_k(cam_to_world)
    img = np.ascontiguousarray(np.rot90(rgb, k)) if k else rgb
    dets = detect_image(img, prompts, thresh, device=device)
    if not k:
        return dets
    return [(lbl, sc, _unrotate_box(b, k, w, h)) for lbl, sc, b in dets]


# ── 정점 라벨 투표 ────────────────────────────────────────────────────────
def _occlusion_front(uv, z, cand, w, h, cell=6.0, eps=0.08):
    """정점 z-buffer(저해상 셀) 오클루전: 셀 최소깊이 근처(앞면)만 True.
    레이캐스트 없이 O(정점)으로 가림을 근사. (정점이 충분히 조밀할 때 유효)"""
    nx = int(w / cell) + 2
    ny = int(h / cell) + 2
    gx = np.clip((uv[:, 0] / cell).astype(int), 0, nx - 1)
    gy = np.clip((uv[:, 1] / cell).astype(int), 0, ny - 1)
    key = gy * nx + gx
    zbuf = np.full(nx * ny, np.inf)
    np.minimum.at(zbuf, key[cand], z[cand])
    return cand & (z <= zbuf[key] + eps)


def vote_labels(mesh, views, dets_per_view, min_frontal=0.10, occlusion=True):
    """각 정점에 (카테고리별) 투표 점수 누적 → (votes[N,C], cats, cat_views).
    cat_views[c] = 그 카테고리를 검출한 '서로 다른 뷰' 수(멀티뷰 일관성용)."""
    V = np.asarray(mesh.vertices, float)
    N = mesh.vertex_normals
    cats = sorted(set(CANON.values()))
    ci = {c: i for i, c in enumerate(cats)}
    votes = np.zeros((len(V), len(cats)), float)
    cat_views = {c: 0 for c in cats}

    for vw, dets in zip(views, dets_per_view):
        if not dets:
            continue
        present = set(CANON.get(l) for l, _, _ in dets if CANON.get(l))
        for c in present:
            cat_views[c] += 1
        img = vw["image"]; K = np.asarray(vw["K"], float); c2w = np.asarray(vw["cam_to_world"], float)
        h, w = img.shape[:2]
        uv, z, valid = project_points(V, K, c2w, w, h)
        fw = frontal_weight(N, V, c2w[:3, 3])
        cand = valid & (fw > min_frontal)
        front = _occlusion_front(uv, z, cand, w, h) if occlusion else cand
        if not front.any():
            continue
        u, v = uv[:, 0], uv[:, 1]
        for label, score, (x0, y0, x1, y1) in dets:
            c = CANON.get(label)
            if c is None:
                continue
            inb = front & (u >= x0) & (u <= x1) & (v >= y0) & (v <= y1)
            if inb.any():
                votes[inb, ci[c]] += score * fw[inb]
    return votes, cats, cat_views


# ── 인스턴스 분리 + 회전 OBB ──────────────────────────────────────────────
def _knn_inlier(P, k=12, zthr=2.0):
    """kNN 평균거리 z-score로 정상점 마스크(True). 메시 bleed(투표가 인접 벽에 샌 점) 제거."""
    from scipy.spatial import cKDTree
    if len(P) < k + 2:
        return np.ones(len(P), bool)
    d, _ = cKDTree(P).query(P, k=k + 1)
    md = d[:, 1:].mean(1)
    return (md - md.mean()) / (md.std() + 1e-9) < zthr


def fit_obb(pts):
    """메시 점군 → 타이트 gravity OBB(연구 quick_win). ARKit world는 +Y중력이라 XZ가 바닥.
    bleed 제거(kNN) → XZ minAreaRect(회전캘리퍼) → 높이는 Y 2~98퍼센타일(바닥/천장 점 제외)."""
    import cv2
    P = np.asarray(pts, float)
    keep = _knn_inlier(P)
    if keep.sum() >= 8:            # 너무 적게 남으면 원본 유지
        P = P[keep]
    xz = P[:, [0, 2]].astype(np.float32)
    _, _, ang = cv2.minAreaRect(xz)        # 방향(yaw)만 사용
    a = np.radians(ang)
    u = np.array([np.cos(a), np.sin(a)]); v = np.array([-np.sin(a), np.cos(a)])
    c = xz.mean(0).astype(float)
    pu = (xz - c) @ u; pv = (xz - c) @ v
    # 박스 축 방향 1~99퍼센타일 extent → 벽으로 샌 가장자리 bleed 트림
    u0, u1 = np.percentile(pu, 1), np.percentile(pu, 99)
    v0, v1 = np.percentile(pv, 1), np.percentile(pv, 99)
    bw, bd = float(u1 - u0), float(v1 - v0)
    cen = c + ((u0 + u1) / 2) * u + ((v0 + v1) / 2) * v
    y0, y1 = float(np.percentile(P[:, 1], 2)), float(np.percentile(P[:, 1], 98))
    return {
        "center": [float(cen[0]), (y0 + y1) / 2, float(cen[1])],
        "dims": [bw, y1 - y0, bd],          # 가로(X'), 높이(Y), 세로(Z')
        "yaw_deg": float(ang),
    }


def _degenerate(box):
    """퇴화/노이즈 박스 판정: dims에 0 또는 너무 작은 면적/두께."""
    w, h, d = box["dims"]
    if min(w, d, h) < 0.05:        # 한 축이 사실상 0(나쁜 클러스터)
        return True
    if w * d < 0.02:               # 바닥 면적 < 0.02㎡(14×14cm) → 가구로 보기 어려움
        return True
    return False


def _nms_3d(objs, iou_thresh=0.3):
    """바닥 footprint(회전 사각형) IoU로 중복 박스 병합 — score 높은 것 유지."""
    from shapely.geometry import Polygon
    import cv2
    def poly(o):
        cx, _, cz = o["center"]; w, _, d = o["dims"]
        pts = cv2.boxPoints(((cx, cz), (max(w, 0.01), max(d, 0.01)), o["yaw_deg"]))
        p = Polygon(pts)
        return p if p.is_valid else p.buffer(0)
    keep, polys = [], []
    for o in sorted(objs, key=lambda x: -x["score"]):
        p = poly(o); dup = False
        for q in polys:
            inter = p.intersection(q).area
            if inter > 0:
                union = p.area + q.area - inter
                if union > 0 and inter / union > iou_thresh:
                    dup = True; break
        if not dup:
            keep.append(o); polys.append(p)
    return keep


def _instance_view_support(centroid, category, views, dets_per_view):
    """이 3D 중심을 각 뷰에 투영해, 해당 카테고리 검출박스가 그 점을 포함하는 '서로 다른 뷰' 수.
    카테고리 전체가 아니라 이 인스턴스 위치를 실제로 본 뷰만 세는 인스턴스 레벨 게이트(진단#3b)."""
    c = np.asarray(centroid, float).reshape(1, 3)
    n = 0
    for vw, dets in zip(views, dets_per_view):
        if not dets:
            continue
        img = vw["image"]; h, w = img.shape[:2]
        uv, z, valid = project_points(c, np.asarray(vw["K"], float),
                                      np.asarray(vw["cam_to_world"], float), w, h)
        if not valid[0]:
            continue
        u, v = float(uv[0, 0]), float(uv[0, 1])
        for label, score, (x0, y0, x1, y1) in dets:
            if CANON.get(label) == category and x0 <= u <= x1 and y0 <= v <= y1:
                n += 1
                break
    return n


def instances(V, votes, cats, cat_views=None, min_views=2, min_votes=0.4, min_pts=30, eps_db=0.12,
              views=None, dets_per_view=None):
    """정점 라벨(argmax) → 카테고리별 DBSCAN → 인스턴스별 OBB → 퇴화/크기/멀티뷰 필터 + 3D NMS.
    views/dets_per_view가 주어지면 멀티뷰 게이트를 '인스턴스 레벨'(중심을 담은 뷰 수)로 적용."""
    from sklearn.cluster import DBSCAN
    lab = votes.argmax(1); conf = votes.max(1)
    inst_gate = views is not None and dets_per_view is not None
    out = []
    for cidx, c in enumerate(cats):
        # 폴백(뷰/검출 미제공, 예: 셀프테스트): 카테고리 레벨 멀티뷰 게이트
        if not inst_gate and cat_views is not None and cat_views.get(c, 0) < min_views:
            continue
        idx = np.where((lab == cidx) & (conf >= min_votes))[0]
        if len(idx) < min_pts:
            continue
        db = DBSCAN(eps=eps_db, min_samples=max(8, min_pts // 3)).fit(V[idx])
        for cl in set(db.labels_):
            if cl == -1:
                continue
            sub = idx[db.labels_ == cl]
            if len(sub) < min_pts:
                continue
            box = fit_obb(V[sub])
            if _degenerate(box):
                continue
            long = max(box["dims"][0], box["dims"][2])    # 바닥 긴변
            if c in SIZE_MIN_LONG and long < SIZE_MIN_LONG[c]:   # 큰 가구인데 너무 작음 → 오클러스터
                continue
            if inst_gate:
                nv = _instance_view_support(box["center"], c, views, dets_per_view)
                if nv < min_views:                       # 이 위치를 담은 뷰가 적으면 신뢰 불가
                    continue
                box["views"] = int(nv)
            else:
                box["views"] = int(cat_views.get(c, 0)) if cat_views else 0
            box["category"] = c
            box["n_points"] = int(len(sub))
            box["score"] = float(conf[sub].mean())
            out.append(box)
    out = _nms_3d(out, iou_thresh=0.25)     # 중복(여러 뷰에서 겹친 박스) 병합
    out.sort(key=lambda b: -b["n_points"])
    return out


def classify_space(items):
    """공간유형 점수. items = 가구리스트(인스턴스당 1표) 또는 {카테고리: 가중치(검출수)} dict.
    원시 검출 히스토그램(필터 전)을 dict로 넘기면 toilet/bathtub 빈도가 반영돼 더 강건."""
    if isinstance(items, dict):
        hist = items
    else:
        hist = {}
        for f in items:
            hist[f["category"]] = hist.get(f["category"], 0) + 1
    score = {}
    for c, n in hist.items():
        for sp, w in SPACE_WEIGHTS.get(c, {}).items():
            score[sp] = score.get(sp, 0.0) + w * n
    if not score:
        return {"type": "unknown", "scores": {}}
    best = max(score, key=score.get)
    # bathroom은 보조 라벨 → home으로 흡수하되 주석 유지
    label = "home" if best == "bathroom" else best
    return {"type": label, "detail": best, "scores": {k: round(v, 2) for k, v in sorted(score.items(), key=lambda x: -x[1])}}


# ── 키프레임 샘플링(공간+시선 커버리지 FPS) + 블러 게이트 ─────────────────
def _view_features(views, dir_weight=1.5):
    """FPS 거리용 특징: [카메라위치(m), 시선방향단위벡터×dir_weight]. 위치만이 아니라
    바라보는 방향 다양성까지 반영(같은 지점에서 여러 방향/다른 지점에서 같은 방향 구분)."""
    pos = np.array([np.asarray(v["cam_to_world"], float)[:3, 3] for v in views])
    fwd = np.array([np.asarray(v["cam_to_world"], float)[:3, 2] for v in views])  # OpenCV +Z=forward
    fwd = fwd / (np.linalg.norm(fwd, axis=1, keepdims=True) + 1e-9)
    return np.c_[pos, fwd * dir_weight]


def fps_sample(views, k, dir_weight=1.5):
    """위치+시선방향 결합거리 Farthest Point Sampling으로 k장 선별(추론비용 제한·뷰다양성)."""
    if len(views) <= k:
        return views
    F = _view_features(views, dir_weight)
    chosen = [0]
    d = np.linalg.norm(F - F[0], axis=1)
    for _ in range(1, k):
        i = int(np.argmax(d))
        chosen.append(i)
        d = np.minimum(d, np.linalg.norm(F - F[i], axis=1))
    return [views[i] for i in sorted(set(chosen))]


def blur_gate(views, thresh=60.0, min_keep=12):
    """모션블러 뷰 제거: Laplacian variance < thresh 프레임 드롭(FPS 이전에 수행).
    대부분 흔들린 스캔이면(선명 프레임<min_keep) 선명한 순으로 min_keep장만 확보."""
    import cv2
    scored = []
    for v in views:
        g = cv2.cvtColor(v["image"], cv2.COLOR_RGB2GRAY)
        lv = float(cv2.Laplacian(g, cv2.CV_64F).var())
        scored.append((lv, v))
    sharp = [v for lv, v in scored if lv >= thresh]
    if len(sharp) >= min_keep:
        return sharp, len(views) - len(sharp)
    scored.sort(key=lambda x: -x[0])
    keep = [v for _, v in scored[:max(min_keep, len(sharp))]]
    return keep, len(views) - len(keep)


# ── 엔드투엔드 ────────────────────────────────────────────────────────────
def detect_furniture(mesh_path, views_folder, max_views=40, score_thresh=0.10,
                     min_votes=0.5, eps_db=0.12, min_pts=40, device=None, log=print):
    import trimesh
    mesh = trimesh.load(mesh_path, force="mesh")
    views = load_views(views_folder)
    views, n_blur = blur_gate(views, thresh=60.0, min_keep=max_views)   # 블러 프레임 제거(FPS 이전)
    views = fps_sample(views, max_views)
    log(f"[furniture] {len(views)}뷰 OWLv2 검출 시작 (블러제거 {n_blur}, 정점 {len(mesh.vertices)}, "
        f"device={device or os.environ.get('FURNITURE_DEVICE') or 'auto'})")
    dets = []
    for i, v in enumerate(views):
        # ★중력으로 바로 세워 검출 후 박스는 원본좌표로 역매핑(투표 기하는 원본 유지)
        d = detect_image_upright(v["image"], v["cam_to_world"], PROMPTS, score_thresh, device=device)
        dets.append(d)
        if (i + 1) % 10 == 0:
            log(f"[furniture]   {i+1}/{len(views)}뷰")
    votes, cats, cat_views = vote_labels(mesh, views, dets)
    objs = instances(np.asarray(mesh.vertices, float), votes, cats, cat_views=cat_views,
                     min_views=2, min_votes=min_votes, min_pts=min_pts, eps_db=eps_db,
                     views=views, dets_per_view=dets)
    # 공간유형: '원시 검출 히스토그램(필터 전, 모든 뷰)'에서 판정 — toilet/bathtub 빈도 반영해 강건.
    raw_hist = {}
    for dv in dets:
        for label, score, _ in dv:
            c = CANON.get(label)
            if c:
                raw_hist[c] = raw_hist.get(c, 0) + 1
    space = classify_space(raw_hist)
    # 공간유형 allowlist는 '로그 전용'으로 강등(진단#2) — 삭제하지 않고 무엇이 걸렸을지만 기록.
    # (욕실 1개로 튜닝된 allowlist가 정상 가구를 오삭제하던 문제. 실제 삭제는 Phase2 평가셋 확보 후.)
    key = space.get("detail") if space.get("detail") in SPACE_FURNITURE else space.get("type")
    allow = SPACE_FURNITURE.get(key)
    if allow:
        would_drop = [o["category"] for o in objs if o["category"] not in allow]
        if would_drop:
            log(f"[furniture] 공간({key}) allowlist 로그전용(삭제안함): 부적합후보={would_drop}")
    # 표준 가구치수로 스냅(과대 클러스터 교정) + 같은 카테고리 중복 병합 → 스케일 맞는 평면도
    objs = [snap_canonical(o) for o in objs]
    objs = merge_same_category(objs)
    log(f"[furniture] 가구 {len(objs)}개, 공간유형={space['type']} ({space.get('detail')})")
    return {"furniture": objs, "space_type": space, "n_views": len(views),
            "n_detections": int(sum(len(d) for d in dets))}


# ── 검증 ──────────────────────────────────────────────────────────────────
def selftest():
    """모델 없이 기하 경로(투표→오클루전→클러스터→OBB)를 합성 데이터로 검증."""
    import trimesh
    ok = True
    # 장면: 바닥 위에 '침대'(큰 박스)와 '책상'(작은 박스) 두 개를 떨어뜨려 놓음
    bed = trimesh.creation.box(extents=(2.0, 0.5, 1.4)); bed.apply_translation([-1.5, 0.25, 0])
    desk = trimesh.creation.box(extents=(1.2, 0.75, 0.6)); desk.apply_translation([1.5, 0.375, 0])
    # 실제 LiDAR 메시처럼 조밀하게(정점 간격 ~수 cm) — DBSCAN이 표면을 연결할 수 있게
    for _ in range(4):
        bed = bed.subdivide(); desk = desk.subdivide()
    mesh = trimesh.util.concatenate([bed, desk])

    # 카메라 4개에서 본다고 가정. 각 뷰의 '검출 박스'를 정점 투영으로부터 합성 생성
    from colorize_vertices import _look_at
    K = np.array([[500, 0, 320], [0, 500, 240], [0, 0, 1]], float)
    cams = [_look_at(np.array(e, float), [0, 0.4, 0], (0, -1, 0))
            for e in [(0, 1.5, 4), (4, 1.5, 0), (0, 1.5, -4), (-4, 1.5, 0)]]
    Vb = np.asarray(bed.vertices, float); Vd = np.asarray(desk.vertices, float)
    views, dets = [], []
    for c2w in cams:
        views.append({"image": np.zeros((480, 640, 3), np.uint8), "K": K, "cam_to_world": c2w})
        dv = []
        for V, name in [(Vb, "bed"), (Vd, "desk")]:
            uv, z, valid = project_points(V, K, c2w, 640, 480)
            if valid.sum() < 4:
                continue
            uvv = uv[valid]
            dv.append((name, 0.9, (uvv[:, 0].min(), uvv[:, 1].min(), uvv[:, 0].max(), uvv[:, 1].max())))
        dets.append(dv)

    votes, cats, cat_views = vote_labels(mesh, views, dets, occlusion=True)
    objs = instances(np.asarray(mesh.vertices, float), votes, cats, cat_views=cat_views,
                     min_views=1, min_votes=0.3, min_pts=20, eps_db=0.2)
    # (조밀 메시 간격 ~0.06m < eps 0.2 → 클러스터 연결됨)
    got = sorted(o["category"] for o in objs)
    t1 = got == ["bed", "desk"]
    print(f"  ① 투표→클러스터 2개 분리: {'PASS' if t1 else 'FAIL'}  검출={got}")
    ok &= t1

    # OBB 치수: 침대 ~2.0×1.4, 책상 ~1.2×0.6 (바닥 footprint, 순서 무관)
    def foot(o):
        return tuple(sorted([round(o["dims"][0], 1), round(o["dims"][2], 1)]))
    by = {o["category"]: o for o in objs}
    t2 = t1 and abs(by["bed"]["dims"][1] - 0.5) < 0.2 and abs(by["desk"]["dims"][1] - 0.75) < 0.2
    print(f"  ② OBB 높이 복원: {'PASS' if t2 else 'FAIL'}  "
          f"bed_h={by.get('bed',{}).get('dims',[0,0,0])[1]:.2f}, desk_h={by.get('desk',{}).get('dims',[0,0,0])[1]:.2f}")
    ok &= t2

    # 공간유형: bed+desk → office/home 점수 존재
    sp = classify_space(objs)
    t3 = sp["type"] in ("home", "office") and len(sp["scores"]) >= 1
    print(f"  ③ 공간유형 분류 동작: {'PASS' if t3 else 'FAIL'}  {sp}")
    ok &= t3

    print(f"\n  === detect_furniture_vision 기하경로 셀프테스트: {'ALL PASS ✅' if ok else 'FAIL ❌'} ===")
    return ok


def main():
    import argparse, sys
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--owlv2-image", help="이미지 1장에 OWLv2 검출만 실행(모델 동작 확인)")
    ap.add_argument("--mesh"); ap.add_argument("--views"); ap.add_argument("--out", default="furniture.json")
    ap.add_argument("--max-views", type=int, default=40)
    a = ap.parse_args()
    if a.selftest:
        sys.exit(0 if selftest() else 1)
    if a.owlv2_image:
        import cv2
        rgb = cv2.cvtColor(cv2.imread(a.owlv2_image), cv2.COLOR_BGR2RGB)
        for label, score, box in sorted(detect_image(rgb), key=lambda x: -x[1])[:20]:
            print(f"  {score:.3f}  {label:16s}  {tuple(round(x) for x in box)}")
        return
    if not (a.mesh and a.views):
        ap.error("--mesh 와 --views 필요 (또는 --selftest / --owlv2-image)")
    res = detect_furniture(a.mesh, a.views, max_views=a.max_views)
    json.dump(res, open(a.out, "w"), ensure_ascii=False, indent=2)
    print(f"저장: {a.out}")


if __name__ == "__main__":
    main()
