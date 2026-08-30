#!/usr/bin/env python3
"""MoveViz scan ingest and processing server.

폰(iOS 앱)이 같은 WiFi로 메시(OBJ/GLB/PLY) + 키프레임을 POST → 맥 디스크에 저장 →
자동으로 평면도 파이프라인(v4 + 가구 후처리 + CAD SVG) 실행 → 앱이 결과를 GET.
저장 위치: ``MOVEVIZ_SCANS_DIR/<id>`` (기본값: ``data/scans/<id>``).

엔드포인트:
  POST /upload      multipart: file=<mesh>, [keyframes=<zip>], [mode=lidar|camera]  → {id}
  GET  /result/<id> → {status, summary, plan_svg, plan_png, raw}
  GET  /scans/<id>/<name>  정적 파일(plan.svg/png/json, mesh)
  GET  /health

실행: python ingest_server.py   (포트 8080)
폰에서 접속 주소: http://<맥 LAN IP>:8080
"""
import os, sys, json, threading, subprocess, traceback, datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

BASE = os.path.dirname(os.path.abspath(__file__))
SCANS = os.path.abspath(os.environ.get(
    "MOVEVIZ_SCANS_DIR", os.path.join(BASE, "data", "scans")
))
PIPE = os.path.join(BASE, "services", "floorplan")
TEX = os.path.join(BASE, "modules", "reconstruction")
os.makedirs(SCANS, exist_ok=True)
sys.path.insert(0, PIPE)
sys.path.insert(0, TEX)

app = Flask(__name__)
CORS(app)
_status = {}   # id -> {"status":..., "summary":..., "error":...}


def _process(scan_id, mesh_path, mode):
    """백그라운드: 메시 → v4 평면 → 가구 후처리 → CAD SVG. 결과를 폴더에 저장.
    이미지 zip(카메라 모드)이면 평면도 대신 이미지 콘택트시트 + 카메라 궤적 시각화."""
    d = os.path.join(SCANS, scan_id)
    try:
        _status[scan_id] = {"status": "processing", "mode": mode}
        # RoomPlan(온디바이스): 폰이 보낸 roomplan.json(벽/가구) + USDZ → 평면도 + 3D 렌더
        if mode == "roomplan":
            rp = json.load(open(os.path.join(d, "roomplan.json")))
            _process_roomplan(scan_id, d, mesh_path, rp)
            return
        # 카메라(이미지 기반): zip 압축 풀고 이미지+궤적 시각화
        if mesh_path.lower().endswith(".zip"):
            _process_camera_images(scan_id, mesh_path, d, mode)
            return
        # USDZ(카메라/Object Capture)면 GLB로 변환 후 처리
        if mesh_path.lower().endswith(".usdz"):
            import usdz_to_glb
            glb = os.path.join(d, "scan_from_usdz.glb")
            usdz_to_glb.convert(mesh_path, glb)
            mesh_path = glb
        # 거울/유리 반사 팬텀 제거 → 가짜 개구부(문/창)·가구 차단 (반사상=실내 대칭 복제)
        mirror_rep = None
        try:
            import trimesh as _tm, mirror_glass_clean as _MGC
            _cl, mirror_rep = _MGC.clean_mesh(_tm.load(mesh_path, force="mesh"))
            if mirror_rep.get("removed_vertices", 0) > 0:
                cp = os.path.join(d, "scan_cleaned.obj")
                _cl.export(cp)
                mesh_path = cp   # 이후 평면도/가구/텍스처 전부 정제 메시 사용
                print(f"[ingest] {scan_id} 거울 팬텀 제거: {mirror_rep['removed_vertices']}정점 "
                      f"(footprint {mirror_rep.get('removed_by_footprint')} + 대칭 {mirror_rep.get('removed_by_symmetry')})")
        except Exception as e:
            print(f"[ingest] 거울 제거 스킵: {e}")
        # v4 파이프라인 (run_v4.run = load→walls→openings→rooms→furniture+후처리)
        import run_v4
        import render_cad_plan
        data = run_v4.run(mesh_path)

        # 가구 리스트 이원 기록(진단#4·#5): 지오메트리/비전 둘 다 plan.json에 남겨 실패를 가시화.
        # 비전이 놓쳐도 지오메트리 결과가 사라지지 않도록 '통째 대체' 대신 별도 키로 보존.
        data["furniture_geometry"] = list(data.get("furniture", []))
        data["furniture_vision"] = []
        vision_error = None

        # 가구 비전(OWLv2) — 키프레임 있으면 '먼저' 실행해 정확한(표준치수) 가구를 평면도에 주입
        fur = None
        kfzip = os.path.join(d, "keyframes.zip")
        if os.path.exists(kfzip):
            try:
                import zipfile, detect_furniture_vision as DFV
                kfdir = os.path.join(d, "keyframes")
                if not os.path.isdir(kfdir):
                    os.makedirs(kfdir, exist_ok=True)
                    with zipfile.ZipFile(kfzip) as z:
                        z.extractall(kfdir)
                posedir = kfdir
                for root, _, files in os.walk(kfdir):
                    if "poses.json" in files:
                        posedir = root; break
                fur = DFV.detect_furniture(mesh_path, posedir, max_views=36,
                                           log=lambda m: print("[ingest]", m))
                with open(os.path.join(d, "furniture_vision.json"), "w") as f:
                    json.dump(fur, f, ensure_ascii=False, indent=2)
                _render_furniture_topview(d, mesh_path, fur)
                vf = _vision_to_plan_furniture(fur, data.get("boundary"))   # ★ 비전 가구 평면도 표기(yaw+경계 클램프)
                data["furniture_vision"] = vf
                data["furniture"] = vf                                       # 활성(표시)은 비전 결과
                print(f"[ingest] {scan_id} 가구비전: {len(fur['furniture'])}개 → 평면도 주입")
                # 카테고리별 정제 3D 모델(폴리캠 Room Mode와 동일 메커니즘 — 노이즈
                # 낀 원본 클러스터 대신 감지된 치수·yaw에 맞춘 깨끗한 대체 모델).
                try:
                    if os.environ.get("FURN_TEMPLATES") == "1":
                        # 대표모델 템플릿 엔진(옵트인) — 벽 기준 정면 해소 포함,
                        # 비정상 실측 치수는 내부 게이트가 제네릭으로 폴백.
                        import furniture_templates as FTPL
                        data["furniture_models"] = FTPL.export_furniture_models_v2(
                            fur["furniture"], os.path.join(d, "furniture_models"),
                            boundary=data.get("boundary"))
                    else:
                        import furniture_models as FMOD
                        data["furniture_models"] = FMOD.export_furniture_models(
                            fur["furniture"], os.path.join(d, "furniture_models"))
                except Exception as e:
                    print(f"[ingest] 가구 3D 모델 생성 실패: {e}")
                    data["furniture_models"] = []
            except Exception as e:
                # 광역 except가 예외를 삼켜 '가구 0개 평면도'가 무음으로 나가던 문제(진단#4) →
                # 서버는 죽이지 않되 오류를 summary.json에 표면화. 비전 실패 시 지오메트리 가구 유지.
                traceback.print_exc()
                vision_error = f"{type(e).__name__}: {e}"
                data["furniture"] = data["furniture_geometry"]
                print(f"[ingest] 가구 비전 검출 실패(표면화됨): {vision_error}")

        with open(os.path.join(d, "plan.json"), "w") as f:
            json.dump(data, f)
        render_cad_plan.render(data, os.path.join(d, "plan.svg"))    # 비전 가구 심볼 포함
        op = data.get("openings", [])
        summary = {
            "area_m2": _area(data.get("boundary", [])),
            "walls": len(data.get("xw", [])) + len(data.get("zw", [])),
            "doors": sum(1 for o in op if o.get("type") == "door"),
            "windows": sum(1 for o in op if o.get("type") != "door"),
            "rooms": len(data.get("rooms", [])),
            "furniture": len(data.get("furniture", [])),
            "furniture_geometry": len(data.get("furniture_geometry", [])),
        }
        if mirror_rep and mirror_rep.get("removed_vertices", 0) > 0:
            summary["mirror_removed"] = mirror_rep["removed_vertices"]
        if vision_error:                          # 비전 실패를 summary.json에 표면화(무음 금지)
            summary["error"] = vision_error
        if fur:
            summary["space_type"] = fur["space_type"]["type"]
            summary["space_detail"] = fur["space_type"].get("detail")
            summary["furniture_vision"] = len(fur["furniture"])
            summary["furniture_models"] = len(data.get("furniture_models", []))
        _svg_to_png(os.path.join(d, "plan.svg"), os.path.join(d, "plan.png"))
        # 텍스처드 3D (RGB 키프레임 있으면)
        if os.path.exists(kfzip):
            try:
                tex = _texture_mesh(d, mesh_path, kfzip)
                summary["textured"] = tex.get("coverage")
                print(f"[ingest] {scan_id} 텍스처 매핑: 커버리지 {tex.get('coverage')} ({tex.get('views')}뷰)")
            except Exception as e:
                print(f"[ingest] 텍스처 매핑 실패: {e}")
        _status[scan_id] = {"status": "done", "mode": mode, "summary": summary}
        with open(os.path.join(d, "summary.json"), "w") as f:
            json.dump(_status[scan_id], f, ensure_ascii=False)
        print(f"[ingest] {scan_id} 처리완료: {summary}")
    except Exception as e:
        traceback.print_exc()
        _status[scan_id] = {"status": "error", "error": str(e)}


def _texture_mesh(d, mesh_path, kfzip):
    """RGB 키프레임을 메시에 투영해 정점색 부여(이미지 매핑) + 텍스처드 3D 프리뷰 렌더."""
    import zipfile, trimesh
    import colorize_vertices as CV
    kfdir = os.path.join(d, "keyframes")
    os.makedirs(kfdir, exist_ok=True)
    with zipfile.ZipFile(kfzip) as z:
        z.extractall(kfdir)
    posedir = kfdir
    for root, _, files in os.walk(kfdir):
        if "poses.json" in files:
            posedir = root; break
    mesh = trimesh.load(mesh_path, force="mesh")
    views = CV.load_views(posedir)
    rgba, cov = CV.colorize(mesh, views, occlusion="normal")
    CV.attach_vertex_colors(mesh, rgba)
    mesh.export(os.path.join(d, "colored.glb"))
    _render_colored(mesh, rgba, os.path.join(d, "textured3d.png"))
    # 폰에서 텍스처드 3D 보기용 — GLB는 iOS QuickLook이 못 여니 정점색 USDZ로도 export.
    try:
        _export_colored_usdz(mesh, rgba, os.path.join(d, "colored.usdz"))
    except Exception as e:
        print(f"[ingest] colored.usdz export 실패: {e}")
    return {"coverage": float(cov), "views": len(views)}


def _export_colored_usdz(mesh, rgba, out):
    """정점색 메시 → USDZ(displayColor primvar). iOS QuickLook이 색까지 렌더."""
    from pxr import Usd, UsdGeom, Gf, Sdf, UsdUtils
    import numpy as np
    V = np.asarray(mesh.vertices, float); F = np.asarray(mesh.faces, int)
    usdc = out[:-5] + ".usdc"
    stage = Usd.Stage.CreateNew(usdc)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    m = UsdGeom.Mesh.Define(stage, "/scan")
    m.CreatePointsAttr([Gf.Vec3f(float(p[0]), float(p[1]), float(p[2])) for p in V])
    m.CreateFaceVertexCountsAttr([3] * len(F))
    m.CreateFaceVertexIndicesAttr(F.reshape(-1).tolist())
    cols = [Gf.Vec3f(float(c[0]) / 255.0, float(c[1]) / 255.0, float(c[2]) / 255.0) for c in rgba]
    pv = UsdGeom.PrimvarsAPI(m).CreatePrimvar("displayColor", Sdf.ValueTypeNames.Color3fArray, UsdGeom.Tokens.vertex)
    pv.Set(cols)
    stage.SetDefaultPrim(m.GetPrim())
    stage.GetRootLayer().Save()
    UsdUtils.CreateNewUsdzPackage(usdc, out)
    try:
        os.remove(usdc)
    except OSError:
        pass


_FUR_PALETTE = {
    "bed": (60, 60, 220), "sofa": (200, 90, 60), "chair": (60, 160, 60), "desk": (200, 60, 200),
    "table": (60, 170, 200), "monitor": (140, 60, 200), "tv": (100, 40, 160), "cabinet": (120, 110, 40),
    "shelf": (40, 130, 130), "rack": (30, 90, 180), "refrigerator": (180, 130, 40), "appliance": (150, 150, 40),
    "toilet": (120, 120, 120), "sink": (130, 130, 90), "bathtub": (110, 110, 140), "counter": (90, 140, 90),
    "whiteboard": (160, 90, 90), "plant": (40, 150, 90),
}

_FURN_KO = {
    "toilet": "변기", "sink": "세면대", "bathtub": "욕조", "bed": "침대", "sofa": "소파",
    "chair": "의자", "desk": "책상", "table": "테이블", "refrigerator": "냉장고", "monitor": "모니터",
    "tv": "TV", "cabinet": "수납장", "shelf": "선반", "rack": "랙", "counter": "카운터",
    "appliance": "가전", "whiteboard": "화이트보드", "plant": "화분",
}

def _clamp_box_to_polygon(corners, boundary, wall_inset=0.10, iters=80):
    """회전 OBB 코너(4×[x,z])를 경계 폴리곤(벽두께/2 inset) 안으로 최소 평행이동해 가둔다.
    AABB가 아니라 폴리곤 기준(진단#4) — 비직사각형 방에서 가구가 엉뚱한 벽으로 밀리는 것 방지.
    shapely 없거나 경계 부적합이면 코너를 그대로 반환."""
    import numpy as np
    try:
        from shapely.geometry import Polygon
        from shapely.ops import nearest_points
    except Exception:
        return corners
    poly = Polygon(boundary)
    if not poly.is_valid:
        poly = poly.buffer(0)
    inset = poly.buffer(-wall_inset)
    if inset.is_empty or inset.area <= 1e-6:
        inset = poly
    corners = np.asarray(corners, float)
    for _ in range(iters):
        box = Polygon(corners)
        if not box.is_valid:
            box = box.buffer(0)
        if inset.contains(box):
            break
        c = box.centroid
        if inset.contains(c):                      # 중심은 안 → 안쪽으로 살짝 밀어 코너까지 수용
            tgt = inset.centroid; step = 0.03
        else:                                      # 중심이 밖 → 경계 최근접 내부점으로 점프
            tgt = nearest_points(inset, c)[0]; step = 1.0
        dx, dy = tgt.x - c.x, tgt.y - c.y
        n = (dx * dx + dy * dy) ** 0.5
        if n < 1e-9:
            ic = inset.centroid; dx, dy = ic.x - c.x, ic.y - c.y
            n = (dx * dx + dy * dy) ** 0.5 or 1.0
        corners = corners + (np.array([dx, dy]) * (step if step < 1.0 else 1.0))
    return [[float(x), float(y)] for x, y in corners]


def _vision_to_plan_furniture(fur, boundary=None, wall_inset=0.10):
    """비전 가구(center/dims/yaw, 표준치수 스냅됨) → render_cad_plan 형식(obb 코너 + 카테고리).
    ★yaw를 살린 회전 OBB 코너를 emit(진단#5) — _draw_furniture_symbol과 동일한 cv2.boxPoints 수식.
    ★경계 폴리곤(벽 안쪽 면) 기준으로 박스를 클램프해 벽 관통 방지(AABB 아님, 진단#4)."""
    import cv2, numpy as np
    have_boundary = bool(boundary) and len(boundary) >= 3
    b2 = [[float(p[0]), float(p[1])] for p in boundary] if have_boundary else None
    out = []
    for o in fur.get("furniture", []):
        cx, _, cz = o["center"]; w, _, dd = o["dims"]; yaw = o.get("yaw_deg", 0.0)
        corners = cv2.boxPoints(((float(cx), float(cz)),
                                 (max(float(w), 0.01), max(float(dd), 0.01)),
                                 float(yaw)))                       # 회전 사각형 4코너(yaw 반영)
        corners = [[float(p[0]), float(p[1])] for p in corners]
        if b2 is not None:
            corners = _clamp_box_to_polygon(corners, b2, wall_inset)
        out.append({
            "obb": corners,
            "category": o["category"],
            "category_ko": _FURN_KO.get(o["category"], o["category"]),
            "yaw_deg": float(yaw),
        })
    return out


def _process_roomplan(scan_id, d, usdz_path, rp):
    """RoomPlan(온디바이스) 결과: walls/furniture JSON → 평면도 PNG + 가구목록, USDZ→GLB(갤러리 3D)."""
    # 3D: USDZ → GLB (갤러리 model-viewer가 GLB만 렌더)
    if usdz_path and usdz_path.lower().endswith(".usdz") and os.path.exists(usdz_path):
        try:
            import usdz_to_glb
            usdz_to_glb.convert(usdz_path, os.path.join(d, "colored.glb"))
        except Exception as e:
            print(f"[ingest] roomplan USDZ→GLB 실패: {e}")
    _render_roomplan_plan(d, rp)
    furn = [{"category": f.get("category", "?"), "center": [f.get("cx", 0), 0, f.get("cz", 0)],
             "dims": [f.get("w", 0.3), 0, f.get("d", 0.3)], "yaw_deg": f.get("yaw", 0), "score": 1.0}
            for f in rp.get("furniture", [])]
    with open(os.path.join(d, "furniture_vision.json"), "w") as f:
        json.dump({"furniture": furn, "space_type": {"type": "roomplan", "detail": None}, "n_views": 0},
                  f, ensure_ascii=False)
    summary = {
        "area_m2": rp.get("area_m2"), "walls": len(rp.get("walls", [])),
        "doors": len(rp.get("doors", [])), "windows": len(rp.get("windows", [])),
        "rooms": 1, "furniture": len(furn), "furniture_vision": len(furn),
    }
    _status[scan_id] = {"status": "done", "mode": "roomplan", "summary": summary}
    with open(os.path.join(d, "summary.json"), "w") as f:
        json.dump(_status[scan_id], f, ensure_ascii=False)
    print(f"[ingest] {scan_id} RoomPlan 처리완료: {summary}")


def _render_roomplan_plan(d, rp, S=900):
    """RoomPlan 벽/문/창/가구를 건축 평면도 PNG로 렌더(cv2). 가구는 심볼로."""
    import numpy as np, cv2
    walls = rp.get("walls", [])
    pts = [p for seg in walls for p in seg]
    img = np.full((S, S, 3), 255, np.uint8)
    if not pts:
        cv2.imwrite(os.path.join(d, "plan.png"), img)
        return
    pts = np.asarray(pts, float); mn = pts.min(0); mx = pts.max(0); pad = 80
    sc = min((S - 2 * pad) / (mx[0] - mn[0] + 1e-6), (S - 2 * pad) / (mx[1] - mn[1] + 1e-6))

    def to_px(p):
        return np.array([(p[0] - mn[0]) * sc + pad, S - ((p[1] - mn[1]) * sc + pad)])

    def seg_line(segs, color, t):
        for s in segs:
            a = to_px(s[0]).astype(int); b = to_px(s[1]).astype(int)
            cv2.line(img, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), color, t, cv2.LINE_AA)

    seg_line(walls, (40, 40, 48), 8)
    seg_line(rp.get("doors", []), (60, 160, 60), 4)
    seg_line(rp.get("windows", []), (200, 120, 40), 4)
    for f in rp.get("furniture", []):
        o = {"center": [f.get("cx", 0), 0, f.get("cz", 0)], "dims": [f.get("w", 0.3), 0, f.get("d", 0.3)],
             "yaw_deg": f.get("yaw", 0), "category": f.get("category", "?")}
        _draw_furniture_symbol(img, o, to_px, (120, 110, 90))
    cv2.putText(img, f"RoomPlan floor plan  {rp.get('area_m2','?')} m2", (14, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (40, 40, 48), 1, cv2.LINE_AA)
    cv2.imwrite(os.path.join(d, "plan.png"), img)


def _draw_furniture_symbol(img, o, to_px, color):
    """가구를 '박스'가 아니라 탑뷰 심볼(가구처럼)로 그린다 — 카테고리별 형태 + 외곽 + 라벨.
    회전(yaw)·치수에 맞춰 로컬 정규좌표[-0.5,0.5]를 메시 XZ→픽셀로 변환해 작도."""
    import cv2, numpy as np
    cx, _, cz = o["center"]; w, _, d = o["dims"]; ang = o["yaw_deg"]; cat = o["category"]
    bp = cv2.boxPoints(((cx, cz), (max(w, 0.06), max(d, 0.06)), ang))
    u1 = bp[1] - bp[0]; l1 = float(np.linalg.norm(u1)) + 1e-9; u1 = u1 / l1
    u2 = bp[2] - bp[1]; l2 = float(np.linalg.norm(u2)) + 1e-9; u2 = u2 / l2
    cen = np.array([cx, cz], float)

    def L(lx, ly):
        wpt = cen + lx * l1 * u1 + ly * l2 * u2
        return to_px((float(wpt[0]), float(wpt[1])))

    def poly(pts, closed=True, t=2):
        p = np.array([L(x, y) for x, y in pts]).astype(np.int32)
        cv2.polylines(img, [p], closed, color, t, cv2.LINE_AA)

    def ell(cxl, cyl, rxl, ryl, t=2):
        c = L(cxl, cyl); ax = L(cxl + rxl, cyl); ay = L(cxl, cyl + ryl)
        rx = max(1, int(np.linalg.norm(ax - c))); ry = max(1, int(np.linalg.norm(ay - c)))
        a = float(np.degrees(np.arctan2((ax - c)[1], (ax - c)[0])))
        cv2.ellipse(img, (int(c[0]), int(c[1])), (rx, ry), a, 0, 360, color, t, cv2.LINE_AA)

    poly([(-.5, -.5), (.5, -.5), (.5, .5), (-.5, .5)])           # 외곽(모든 가구)
    if cat == "toilet":
        poly([(-.30, -.5), (.30, -.5), (.30, -.26), (-.30, -.26)])   # 물탱크
        ell(0, 0.12, 0.30, 0.34)                                      # 변기 보울
    elif cat == "sink":
        ell(0, 0.02, 0.34, 0.28); ell(0, -0.34, 0.05, 0.05)          # 세면대 + 수전
    elif cat == "bathtub":
        poly([(-.40, -.38), (.40, -.38), (.40, .40), (-.40, .40)]); ell(0, 0.30, 0.06, 0.06)
    elif cat == "bed":
        poly([(-.46, -.5), (.46, -.5), (.46, -.16), (-.46, -.16)])   # 베개열
        poly([(0, -.16), (0, .5)], closed=False, t=1)                # 중앙선
    elif cat == "sofa":
        poly([(-.5, -.5), (.5, -.5), (.5, -.28), (-.5, -.28)])       # 등받이
        poly([(-.5, -.28), (-.30, -.28), (-.30, .5)], closed=False)  # 팔걸이L
        poly([(.5, -.28), (.30, -.28), (.30, .5)], closed=False)     # 팔걸이R
    elif cat == "chair":
        poly([(-.5, -.5), (.5, -.5), (.5, -.26), (-.5, -.26)])       # 등받이
    elif cat == "refrigerator":
        poly([(-.5, 0), (.5, 0)], closed=False, t=1)                 # 도어 분할
        poly([(.34, -.34), (.34, -.10)], closed=False, t=3)          # 손잡이
    elif cat in ("cabinet", "shelf", "rack"):
        for yy in (-.16, .16):                                       # 선반 칸
            poly([(-.5, yy), (.5, yy)], closed=False, t=1)
    elif cat in ("tv", "monitor"):
        poly([(-.5, -.18), (.5, -.18), (.5, .18), (-.5, .18)], t=3)  # 화면(두껍게)
    # table/desk/counter/plant/etc → 외곽 박스만
    cpx = L(0, 0).astype(int)
    cv2.putText(img, cat, (int(cpx[0]) - 16, int(cpx[1]) + 3),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)


def _render_furniture_topview(d, mesh_path, fur, S=900):
    """탑뷰에 메시 footprint + 가구 회전박스(OBB) + 카테고리 라벨 + 공간유형 배너."""
    import numpy as np, cv2, trimesh
    mesh = trimesh.load(mesh_path, force="mesh")
    xz = np.asarray(mesh.vertices, float)[:, [0, 2]]
    mn = xz.min(0); mx = xz.max(0); pad = 60
    sc = min((S - 2 * pad) / (mx[0] - mn[0] + 1e-6), (S - 2 * pad) / (mx[1] - mn[1] + 1e-6))

    def to_px(p):
        return np.array([(p[0] - mn[0]) * sc + pad, S - ((p[1] - mn[1]) * sc + pad)])

    img = np.full((S, S, 3), 250, np.uint8)
    px = ((xz - mn) * sc + pad); px[:, 1] = S - px[:, 1]
    for p in px.astype(np.int32)[::6]:
        cv2.circle(img, (int(p[0]), int(p[1])), 1, (212, 212, 212), -1)
    for o in fur.get("furniture", []):
        col = _FUR_PALETTE.get(o["category"], (80, 120, 200))
        _draw_furniture_symbol(img, o, to_px, col)
    sp = fur.get("space_type", {})
    cv2.rectangle(img, (0, 0), (S, 42), (40, 40, 40), -1)
    cv2.putText(img, f"space: {sp.get('type','?')} ({sp.get('detail','')})  |  furniture: {len(fur.get('furniture',[]))}  (vision/OWLv2)",
                (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(os.path.join(d, "furniture_topview.png"), img)


def _render_colored(mesh, rgba, out, S=900):
    """정점색 메시를 아이소 뷰로 셰이딩 렌더(텍스처드 3D 프리뷰)."""
    import numpy as np, cv2
    V = np.asarray(mesh.vertices, float).copy(); F = np.asarray(mesh.faces)
    V -= V.mean(0)
    ay, ax = np.radians(35), np.radians(28)
    Ry = np.array([[np.cos(ay),0,np.sin(ay)],[0,1,0],[-np.sin(ay),0,np.cos(ay)]])
    Rx = np.array([[1,0,0],[0,np.cos(ax),-np.sin(ax)],[0,np.sin(ax),np.cos(ax)]])
    Vr = V @ Ry.T @ Rx.T
    pad = 50; mn = Vr[:,:2].min(0); mx = Vr[:,:2].max(0)
    sc = min((S-2*pad)/(mx[0]-mn[0]+1e-6), (S-2*pad)/(mx[1]-mn[1]+1e-6))
    xy = ((Vr[:,:2]-mn)*sc+pad).astype(np.int32); xy[:,1] = S - xy[:,1]
    tri = Vr[F]; depth = tri[:,:,2].mean(1)
    n = np.cross(tri[:,1]-tri[:,0], tri[:,2]-tri[:,0])
    nl = np.linalg.norm(n,axis=1,keepdims=True); n = n/np.where(nl<1e-9,1,nl)
    light = np.array([0.4,0.7,0.6]); light /= np.linalg.norm(light)
    sh = (0.45 + 0.55*np.clip(n@light,0,1))[:,None]
    fcol = rgba[F][:,:,:3].astype(float).mean(1)        # 면색 = 정점색 평균(RGB)
    col = np.clip(fcol*sh, 0, 255).astype(np.uint8)
    poly = xy[F]
    img = np.full((S,S,3),245,np.uint8)
    for i in np.argsort(depth):
        c = col[i]
        cv2.fillConvexPoly(img, poly[i], (int(c[2]),int(c[1]),int(c[0])), lineType=cv2.LINE_AA)  # RGB→BGR
    cv2.putText(img, "textured 3D (images mapped to mesh)", (12,26), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (60,60,70), 1, cv2.LINE_AA)
    cv2.imwrite(out, img)


def _process_camera_images(scan_id, zip_path, d, mode):
    """카메라(이미지 기반, 비-라이다) 스캔: zip 해제 → keyframes.zip으로 보존
    (furniture_vision 등 하류 단계가 찾는 파일명) → ARKit 실측 포즈 앵커 기반
    메트릭 메시 재구성(reconstruct_from_keyframes.py, VIO 포즈라 추정 불필요) →
    성공하면 이후 LiDAR와 동일한 파이프라인(run_v4 평면도+가구비전+텍스처)으로 진행.
    실패(포즈 부족 등)해도 기존처럼 콘택트시트+궤적 시각화는 항상 남긴다."""
    import zipfile, cv2, numpy as np
    kfdir = os.path.join(d, "keyframes")
    os.makedirs(kfdir, exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(kfdir)
    except Exception as e:
        _status[scan_id] = {"status": "error", "error": f"zip 해제 실패: {e}"}
        return
    # 하류(_process의 가구비전/텍스처)가 이 파일명을 찾으므로 zip을 그대로 보존.
    kfzip = os.path.join(d, "keyframes.zip")
    if not os.path.exists(kfzip):
        import shutil; shutil.copy(zip_path, kfzip)

    imgs, poses = [], None
    for root, _, files in os.walk(kfdir):
        for fn in sorted(files):
            if fn.lower().endswith((".jpg", ".jpeg", ".png")):
                imgs.append(os.path.join(root, fn))
        if poses is None and "poses.json" in files:
            try: poses = json.load(open(os.path.join(root, "poses.json")))
            except Exception: poses = None

    sheet = _contact_sheet(imgs)
    traj = _trajectory_img(poses)
    cap_img = _stack_v(sheet, traj)
    cv2.imwrite(os.path.join(d, "camera_capture.png"), cap_img)
    # 재구성 실패/미실행 폴백에서도 /result가 광고하는 plan.png가 존재해야
    # 앱이 "이미지 로드 실패"를 띄우지 않는다. (재구성 성공 시 _process가 진짜
    # 평면도 plan.png로 덮어씀 — camera_capture.png는 그때도 원본 시각화로 남음.)
    cv2.imwrite(os.path.join(d, "plan.png"), cap_img)

    n_poses = len(poses) if poses else 0
    if n_poses >= 10:
        recon_glb = os.path.join(d, "scan_recon.glb")
        recon_python = os.environ.get("MOVEVIZ_RECON_PYTHON", sys.executable)
        script = os.path.join(TEX, "reconstruct_from_keyframes.py")
        try:
            print(f"[ingest] {scan_id} 비-라이다 재구성 시작 ({n_poses} 포즈)")
            r = subprocess.run([recon_python, script, kfdir, recon_glb],
                               capture_output=True, text=True, timeout=1800)
            print(r.stdout[-2000:])
            if r.returncode != 0 or not os.path.exists(recon_glb):
                raise RuntimeError(f"reconstruct 실패(rc={r.returncode}): {r.stderr[-800:]}")
            # 재구성 성공 → LiDAR와 동일한 다운스트림(평면도/가구/텍스처) 처리.
            # keyframes.zip은 위에서 이미 d/에 복사해둬서 _process의 자체 탐색(kfzip)이 찾는다.
            _process(scan_id, recon_glb, mode)
            return
        except Exception as e:
            print(f"[ingest] {scan_id} 비-라이다 재구성 실패, 시각화만 제공: {e}")

    summary = {"mode": "camera", "images": len(imgs), "poses": n_poses}
    _status[scan_id] = {"status": "done", "mode": mode, "summary": summary}
    json.dump(_status[scan_id], open(os.path.join(d, "summary.json"), "w"), ensure_ascii=False)
    print(f"[ingest] {scan_id} 카메라 이미지 {len(imgs)}장 / 포즈 {n_poses} 처리 (재구성 미실행)")


def _contact_sheet(imgs, cols=4, thumb=220):
    import cv2, numpy as np
    if not imgs:
        c = np.full((120, 700, 3), 30, np.uint8)
        cv2.putText(c, "no images captured", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
        return c
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.full((rows * thumb, cols * thumb, 3), 20, np.uint8)
    for i, p in enumerate(imgs):
        im = cv2.imread(p)
        if im is None: continue
        h, w = im.shape[:2]; s = thumb / max(h, w)
        im = cv2.resize(im, (int(w * s), int(h * s)))
        r, c = divmod(i, cols)
        sheet[r*thumb:r*thumb+im.shape[0], c*thumb:c*thumb+im.shape[1]] = im
    cv2.putText(sheet, f"captured images: {len(imgs)}", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240, 240, 240), 1, cv2.LINE_AA)
    return sheet


def _trajectory_img(poses, S=500):
    """카메라 위치(궤적)를 top-down(XZ)으로 — 이미지 기반 3D 데이터의 카메라 경로."""
    import cv2, numpy as np
    img = np.full((S, S, 3), 16, np.uint8)
    if not poses:
        cv2.putText(img, "no camera poses", (20, S//2), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)
        return img
    pts = []
    for m in poses:
        T = m.get("cam_to_world")
        if T and len(T) == 4:
            pts.append((T[0][3], T[2][3]))   # x, z (월드)
    if len(pts) < 2:
        cv2.putText(img, f"poses: {len(poses)}", (20, S//2), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)
        return img
    xs = [p[0] for p in pts]; zs = [p[1] for p in pts]
    minx, maxx, minz, maxz = min(xs), max(xs), min(zs), max(zs)
    pad = 40; sc = min((S-2*pad)/max(maxx-minx, 0.3), (S-2*pad)/max(maxz-minz, 0.3))
    P = lambda x, z: (int(pad+(x-minx)*sc), int(pad+(z-minz)*sc))
    for i in range(len(pts)-1):
        cv2.line(img, P(*pts[i]), P(*pts[i+1]), (120, 200, 255), 2, cv2.LINE_AA)
    for p in pts: cv2.circle(img, P(*p), 3, (90, 160, 255), -1)
    cv2.circle(img, P(*pts[0]), 6, (90, 255, 120), -1)   # start
    cv2.putText(img, f"camera trajectory ({len(pts)} poses) - top view", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (240, 240, 240), 1, cv2.LINE_AA)
    return img


def _stack_v(a, b):
    import cv2, numpy as np
    w = max(a.shape[1], b.shape[1])
    def pad(im):
        if im.shape[1] == w: return im
        out = np.full((im.shape[0], w, 3), 16, np.uint8); out[:, :im.shape[1]] = im; return out
    return np.vstack([pad(a), pad(b)])


def _area(b):
    if len(b) < 3:
        return 0.0
    xs = [p[0] for p in b]; zs = [p[1] for p in b]
    n = len(b) - (1 if b[0] == b[-1] else 0)
    a = abs(sum(xs[i]*zs[(i+1) % n] - xs[(i+1) % n]*zs[i] for i in range(n))) / 2
    return round(a, 1)


def _svg_to_png(svg, png):
    chrome = os.environ.get(
        "CHROME_BIN", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
    if not os.path.exists(chrome):
        return
    try:
        subprocess.run([chrome, "--headless=new", "--disable-gpu",
                        "--virtual-time-budget=3000", "--window-size=1100,1100",
                        f"--screenshot={png}", f"file://{svg}"],
                       timeout=30, capture_output=True)
    except Exception:
        pass


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    mode = request.form.get("mode", "lidar")
    scan_id = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    d = os.path.join(SCANS, scan_id)
    os.makedirs(d, exist_ok=True)
    fmesh = request.files["file"]
    ext = os.path.splitext(fmesh.filename or "scan.obj")[1] or ".obj"
    mesh_path = os.path.join(d, "scan" + ext)
    fmesh.save(mesh_path)
    # 키프레임(선택) 저장 — 텍스처/비전 입력
    if "keyframes" in request.files:
        request.files["keyframes"].save(os.path.join(d, "keyframes.zip"))
    if "roomdata" in request.files:    # RoomPlan 벽/가구 JSON
        request.files["roomdata"].save(os.path.join(d, "roomplan.json"))
    print(f"[ingest] 업로드 수신: {scan_id} ({mode}) → {mesh_path}")
    threading.Thread(target=_process, args=(scan_id, mesh_path, mode), daemon=True).start()
    return jsonify({"id": scan_id, "status": "received"})


@app.route("/result/<scan_id>")
def result(scan_id):
    st = _status.get(scan_id)
    if st is None:
        # 디스크에서 복구
        sp = os.path.join(SCANS, scan_id, "summary.json")
        if os.path.exists(sp):
            st = json.load(open(sp))
        else:
            return jsonify({"status": "unknown"}), 404
    out = dict(st)
    base = f"/scans/{scan_id}"
    if st.get("status") == "done":
        out["plan_svg"] = f"{base}/plan.svg"
        out["plan_png"] = f"{base}/plan.png"
        out["raw"] = f"{base}/plan.json"
        if os.path.exists(os.path.join(SCANS, scan_id, "textured3d.png")):
            out["textured_png"] = f"{base}/textured3d.png"
        if os.path.exists(os.path.join(SCANS, scan_id, "colored.glb")):
            out["colored_glb"] = f"{base}/colored.glb"
        if os.path.exists(os.path.join(SCANS, scan_id, "colored.usdz")):
            out["colored_usdz"] = f"{base}/colored.usdz"
        if os.path.exists(os.path.join(SCANS, scan_id, "furniture_topview.png")):
            out["furniture_png"] = f"{base}/furniture_topview.png"
        if os.path.exists(os.path.join(SCANS, scan_id, "furniture_vision.json")):
            out["furniture_json"] = f"{base}/furniture_vision.json"
        fmdir = os.path.join(SCANS, scan_id, "furniture_models")
        if os.path.isdir(fmdir):
            manifest_path = os.path.join(SCANS, scan_id, "plan.json")
            models = []
            try:
                fmlist = json.load(open(manifest_path)).get("furniture_models", [])
                models = [{**m, "url": f"{base}/furniture_models/{m['file']}"} for m in fmlist]
            except Exception:
                pass
            out["furniture_models"] = models
            if os.path.exists(os.path.join(fmdir, "furniture_layout.glb")):
                out["furniture_layout_glb"] = f"{base}/furniture_models/furniture_layout.glb"
    return jsonify(out)


@app.route("/scans/<scan_id>/<path:name>")
def serve(scan_id, name):
    return send_from_directory(os.path.join(SCANS, scan_id), name)


@app.route("/health")
def health():
    return jsonify({"ok": True, "scans": len(os.listdir(SCANS))})


MODE_LABEL = {"roomplan": "RoomPlan", "lidar": "LiDAR→맥", "camera": "카메라"}

def _scan_mode(sid):
    sp = os.path.join(SCANS, sid, "summary.json")
    if os.path.exists(sp):
        try:
            return json.load(open(sp)).get("mode", "lidar")
        except Exception:
            pass
    return "lidar"

def _scan_card(sid):
    d = os.path.join(SCANS, sid)
    if not os.path.isdir(d):
        return ""
    base = f"/scans/{sid}"
    # 요약
    summ = {}; mode = "lidar"
    sp = os.path.join(d, "summary.json")
    if os.path.exists(sp):
        try:
            jj = json.load(open(sp)); summ = jj.get("summary", {}); mode = jj.get("mode", "lidar")
        except Exception:
            summ = {}
    # 가구 비전
    furn = []
    space = "?"
    fp = os.path.join(d, "furniture_vision.json")
    if os.path.exists(fp):
        try:
            fj = json.load(open(fp))
            furn = fj.get("furniture", [])
            space = fj.get("space_type", {}).get("type", "?")
        except Exception:
            pass
    has = lambda n: os.path.exists(os.path.join(d, n))

    # 인터랙티브 3D: colored.glb 우선(정점색), 없으면 scan.obj
    model = f"{base}/colored.glb" if has("colored.glb") else (f"{base}/scan.obj" if has("scan.obj") else "")
    viewer = (f'<model-viewer src="{model}" camera-controls auto-rotate shadow-intensity="1" '
              f'exposure="1.1" style="width:100%;height:340px;background:#1a1a1f;border-radius:10px"></model-viewer>'
              if model.endswith(".glb") else
              (f'<img src="{base}/textured3d.png" class="ph">' if has("textured3d.png") else '<div class="ph">3D 없음</div>'))

    stat = lambda k, lbl: f'<span class="stat"><b>{summ.get(k,"-")}</b>{lbl}</span>'
    area = summ.get("area_m2")
    area_s = f"{area:.1f}㎡" if isinstance(area, (int, float)) else "-"
    flist = "".join(f'<span class="chip">{o.get("category","?")} '
                    f'<i>{o.get("dims",[0,0,0])[0]:.1f}×{o.get("dims",[0,0,0])[2]:.1f}m</i></span>'
                    for o in furn[:14])

    plan = f'<img src="{base}/plan.png" class="ph">' if has("plan.png") else '<div class="ph">평면도 처리중…</div>'
    furnimg = f'<img src="{base}/furniture_topview.png" class="ph">' if has("furniture_topview.png") else ''

    badge = f'<span class="badge b-{mode}">{MODE_LABEL.get(mode, mode)}</span>'
    return f'''
    <div class="card">
      <div class="hd"><b>{sid}</b>{badge}<span class="sp">{space} · {area_s}</span></div>
      <div class="stats">{stat("walls","벽")}{stat("doors","문")}{stat("windows","창")}{stat("rooms","방")}<span class="stat"><b>{len(furn)}</b>가구</span></div>
      <div class="grid">
        <div><div class="lbl">평면도</div>{plan}</div>
        <div><div class="lbl">텍스처드 3D (드래그로 회전)</div>{viewer}</div>
        <div><div class="lbl">가구 인식</div>{furnimg}</div>
      </div>
      <div class="chips">{flist}</div>
    </div>'''


def _weekly_summary():
    """갤러리 첫 장 — 이번 주 작업 요약(회의용)."""
    items = [
        ("🪞 거울·유리 아티팩트 자동 제거",
         "욕실 등 고반사 공간에서 LiDAR가 만든 '유령 지오메트리'와 '가짜 문/창'을 자동 제거. "
         "딥리서치로 원인 규명 → footprint+대칭(Householder) 기하 제거. 욕실: 팬텀 2,550점 제거, 가짜 문/창 4→0."),
        ("🛋️ 가구 인식 정교화",
         "OWLv2(오픈보캡 비전)로 카테고리 결정 → 공간유형 조건화(욕실에선 침대/TV 오검출 제거) → "
         "메시 타이트 OBB(bleed 제거)로 박스 정밀화 + 표준치수. 욕실 가구 30→3개로 정확."),
        ("🏷️ 공간유형 분류",
         "집·사무실·카페·매장·창고 자동 판별(폴리캠은 집만). 가구 조합 기반 + 비전. 욕실을 욕실로 정확 인식."),
        ("📐 3가지 스캔 모드 비교",
         "RoomPlan(온디바이스·Apple) / LiDAR→맥(비전 파이프라인) / 카메라(비-LiDAR)를 한 화면에서 비교(아래)."),
        ("🎨 텍스처드 3D",
         "스캔 이미지를 메시에 입혀(커버리지 94%) 폰에서 색 입은 3D를 회전·확대(QuickLook/USDZ)."),
        ("📱 iOS 앱",
         "스캔 자동 저장/불러오기, 맥 자동연결(.local), 평면도에 가구 심볼 표기, 업로드 경량화."),
    ]
    cards = "".join(
        f'<div class="scard"><div class="st">{t}</div><div class="sd">{d}</div></div>' for t, d in items)
    research = ("딥리서치 3건: ①가구검출 방법(OWLv2 채택) ②거울/유리 처리 ③메시 레퍼런스 박스 정확도. "
                "결론: 학습 0·상업 라이선스·맥에서 동작하는 기하+비전 하이브리드.")
    nxt = "다음: 메시 타이트 OBB 추가 정밀화 · RoomPlan 박스 융합 · 거울면 벽 봉합."
    return f'''
    <div class="summary">
      <div class="sh">📋 이번 주 작업 요약 <span>회의용 · {_today()}</span></div>
      <div class="scards">{cards}</div>
      <div class="snote"><b>리서치:</b> {research}</div>
      <div class="snote"><b>{nxt}</b></div>
      {_app_section()}
    </div>'''


def _app_section():
    """앱 UI 목업 + 3가지 모드 작동 흐름(회의용)."""
    return '''
    <div class="appsec">
      <div class="sh2">📱 앱 UI · 작동 방식</div>
      <div class="appwrap">
        <div class="phone">
          <div class="screen">
            <div class="scanview">📷 LiDAR 스캔 중<div class="sub">방을 천천히 한 바퀴</div></div>
            <div class="stat3">메시 84k · 커버리지 92% · 4.2㎡</div>
            <div class="cta">● 스캔 시작</div>
          </div>
          <div class="tabbar">
            <span class="on">🟢<br>즉석</span><span>🔵<br>LiDAR</span><span>🟠<br>카메라</span><span>📁<br>내스캔</span><span>⚙️<br>설정</span>
          </div>
        </div>
        <div class="flows">
          <div class="flow fr"><b>🟢 즉석 (RoomPlan · 온디바이스)</b>
            <div>스캔 → <b>폰에서 바로</b> 2D 평면도 + 가구(Apple 16종) + 텍스처 3D <i>· 맥 불필요 · 즉시</i></div></div>
          <div class="flow fl"><b>🔵 LiDAR → 맥 (비전 파이프라인)</b>
            <div>스캔 → 메시+이미지 맥 전송 → <b>거울 제거 · OWLv2 가구 · 공간유형</b> → CAD 평면도 + 텍스처 3D <i>· 가장 정밀</i></div></div>
          <div class="flow fc"><b>🟠 카메라 (비-LiDAR)</b>
            <div>사진 촬영 → 맥 전송 → 이미지 기반 재구성 <i>· LiDAR 없는 기기용</i></div></div>
          <div class="flow fa"><b>📁 내 스캔 / ⚙️ 설정</b>
            <div>모든 스캔 자동 저장·재전송·3D보기 · 맥 자동연결(.local) · 결과는 이 갤러리로</div></div>
        </div>
      </div>
    </div>'''


def _today():
    try:
        return datetime.date.today().strftime("%Y-%m-%d")
    except Exception:
        return ""


@app.route("/")
@app.route("/gallery")
def index():
    ids = [i for i in sorted(os.listdir(SCANS), reverse=True) if os.path.isdir(os.path.join(SCANS, i))][:30]
    # 모드별 그룹화(비교)
    groups = {}
    for i in ids:
        groups.setdefault(_scan_mode(i), []).append(i)
    order = [("roomplan", "🟢 RoomPlan (온디바이스 · Apple)"),
             ("lidar", "🔵 LiDAR → 맥 (비전 파이프라인 · 거울제거+OWLv2)"),
             ("camera", "🟠 카메라 (비-LiDAR · 사진)")]
    seen = set(); cards = ""
    for m, label in order:
        if groups.get(m):
            seen.add(m)
            inner = "".join(_scan_card(i) for i in groups[m])
            cards += f'<h2 class="sec">{label} <span class="cnt">{len(groups[m])}</span></h2>{inner}'
    for m, lst in groups.items():     # 기타 모드
        if m not in seen:
            cards += f'<h2 class="sec">{m} <span class="cnt">{len(lst)}</span></h2>' + "".join(_scan_card(i) for i in lst)
    return f'''<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoveViz 스캔 결과</title>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>
  body{{margin:0;background:#0e0e12;color:#e8e8ea;font:15px/1.5 -apple-system,system-ui,sans-serif}}
  header{{position:sticky;top:0;background:#16161c;padding:14px 20px;border-bottom:1px solid #26262e;display:flex;justify-content:space-between;align-items:center;z-index:10}}
  header h1{{font-size:17px;margin:0}} header .r{{color:#9a9aa2;font-size:13px}}
  .wrap{{max-width:1100px;margin:0 auto;padding:18px}}
  .card{{background:#16161c;border:1px solid #26262e;border-radius:14px;padding:16px;margin-bottom:18px}}
  .hd{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}}
  .hd b{{font-size:16px}} .sp{{color:#7db3ff;font-weight:600}}
  .stats{{display:flex;gap:16px;margin-bottom:12px;color:#b8b8c0;font-size:13px}}
  .stat b{{color:#fff;font-size:16px;margin-right:3px}}
  .grid{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}}
  @media(max-width:820px){{.grid{{grid-template-columns:1fr}}}}
  .lbl{{font-size:12px;color:#8a8a92;margin-bottom:5px}}
  .ph{{width:100%;height:340px;object-fit:contain;background:#fff;border-radius:10px}}
  div.ph{{display:flex;align-items:center;justify-content:center;background:#1a1a1f;color:#666}}
  .chips{{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}}
  .chip{{background:#22222a;padding:4px 9px;border-radius:20px;font-size:12px}} .chip i{{color:#888;font-style:normal}}
  .sec{{font-size:15px;margin:26px 2px 12px;padding-bottom:6px;border-bottom:1px solid #26262e}} .sec .cnt{{color:#7a7a82;font-weight:400}}
  .badge{{font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;margin-left:8px}}
  .b-roomplan{{background:#143d1f;color:#5fd27f}} .b-lidar{{background:#10314f;color:#6fb6ff}} .b-camera{{background:#4a2f10;color:#f0a85f}}
  .summary{{background:linear-gradient(160deg,#171b26,#14161c);border:1px solid #2a3142;border-radius:16px;padding:22px;margin-bottom:24px}}
  .sh{{font-size:19px;font-weight:800;margin-bottom:16px}} .sh span{{font-size:13px;color:#8a8a92;font-weight:500;margin-left:8px}}
  .scards{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
  @media(max-width:760px){{.scards{{grid-template-columns:1fr}}}}
  .scard{{background:#1b1f29;border:1px solid #2a3142;border-radius:11px;padding:13px 15px}}
  .st{{font-weight:700;font-size:14.5px;margin-bottom:5px}} .sd{{font-size:12.5px;color:#aab0bf;line-height:1.5}}
  .snote{{margin-top:13px;font-size:12.5px;color:#9aa0af}} .snote b{{color:#cfd4df}}
  .appsec{{margin-top:20px;padding-top:18px;border-top:1px solid #2a3142}}
  .sh2{{font-size:16px;font-weight:800;margin-bottom:14px}}
  .appwrap{{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}}
  .phone{{width:188px;flex:0 0 auto;background:#000;border:6px solid #2a2f3c;border-radius:30px;overflow:hidden}}
  .screen{{height:300px;background:linear-gradient(150deg,#2b3340,#1a2029);position:relative;display:flex;flex-direction:column;justify-content:space-between;padding:16px 12px}}
  .scanview{{color:#cdd6e3;font-size:13px;font-weight:700;text-align:center;margin-top:30px}} .scanview .sub{{font-size:11px;color:#8a93a3;font-weight:400;margin-top:5px}}
  .stat3{{font-size:10px;color:#9fb0c4;text-align:center;background:#0008;border-radius:20px;padding:5px}}
  .cta{{background:#2f6bff;color:#fff;text-align:center;font-size:13px;font-weight:700;padding:10px;border-radius:11px}}
  .tabbar{{display:flex;background:#15181f;padding:7px 0}} .tabbar span{{flex:1;text-align:center;font-size:9px;color:#6a7282;line-height:1.5}} .tabbar .on{{color:#5fd27f}}
  .flows{{flex:1;min-width:280px;display:flex;flex-direction:column;gap:9px}}
  .flow{{background:#1b1f29;border-left:3px solid #444;border-radius:9px;padding:11px 13px}}
  .flow b{{font-size:13px}} .flow div{{font-size:12px;color:#aab0bf;margin-top:4px;line-height:1.5}} .flow i{{color:#7f8696;font-style:normal}}
  .flow.fr{{border-left-color:#5fd27f}} .flow.fl{{border-left-color:#6fb6ff}} .flow.fc{{border-left-color:#f0a85f}} .flow.fa{{border-left-color:#9aa0af}}
</style></head><body>
<header><h1>📐 MoveViz 스캔 결과</h1><div class="r">{len(ids)}개 · 자동 새로고침</div></header>
<div class="wrap">{_weekly_summary()}{cards if cards else "<p>아직 스캔이 없습니다. 폰에서 스캔→전송하세요.</p>"}</div>
<script>setTimeout(()=>location.reload(), 20000);</script>
</body></html>'''


if __name__ == "__main__":
    print("=" * 56)
    print(" MoveViz ingest server  →  http://0.0.0.0:8080")
    print(" 폰에서 접속: http://<맥 LAN IP>:8080")
    print(" 저장 위치:", SCANS)
    print("=" * 56)
    app.run(host="0.0.0.0", port=8080, debug=False, threaded=True)
