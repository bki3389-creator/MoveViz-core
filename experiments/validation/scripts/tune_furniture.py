#!/usr/bin/env python3
"""가구 추출 파라미터 자동 튜닝 (dev셋).
메쉬+GT를 씬당 1회 캐싱 → 파라미터 조합만 바꿔 빠르게 채점.
extract_furniture_v5의 인자만 조정(코드 무수정). 결과 JSON 저장.

사용: python tune_furniture.py '<json파라미터>'  → 한 조합 평가
     python tune_furniture.py baseline           → 현재 기본값 평가
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S
import trimesh
from shapely.geometry import Polygon

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_CACHE = {}

def build_cache():
    """dev 각 씬: 회전된 mesh, floor/ceil, boundary, rooms, GT footprints 캐싱."""
    from glb_to_floorplan_v4 import (load_glb, find_floor_ceiling, extract_slices,
        consensus_walls, build_boundary, estimate_rotation_angle, detect_openings, decompose_rooms)
    dev = json.load(open(f"{BASE}/splits.json"))["dev"]
    for sid in dev:
        try:
            mesh = load_glb(os.path.join(S.GLB, f"{sid}.glb"))
            rot = estimate_rotation_angle(mesh)
            if abs(rot) > 1e-4:
                mesh = mesh.copy(); mesh.apply_transform(trimesh.transformations.rotation_matrix(rot,[0,1,0]))
            fy, cy = find_floor_ceiling(mesh)
            sl = extract_slices(mesh, fy, cy, step=0.2)
            xw, zw, xh, xe, zh, ze = consensus_walls(sl, snap=0.06)
            all_w = [p for s in sl for p in s['w']]
            bnd = build_boundary(xw, zw, all_w, min_wall_len=0.4)
            op = detect_openings(mesh, bnd, fy, cy, min_opening=0.5)
            rd = decompose_rooms(mesh, xw, zw, bnd, op, fy, cy, min_opening=0.5, min_room_area=2.0, max_door_width=1.5)
            gt = S.gt_footprints(sid, rot)
            _CACHE[sid] = (mesh, fy, cy, bnd, rd['rooms'], [g['poly'] for g in gt], len(gt))
        except Exception as e:
            print(f"cache {sid} ERR {e}", file=sys.stderr)

def evaluate(params):
    """파라미터로 dev 전체 채점 → 평균 P/R."""
    from glb_furniture_v5 import extract_furniture_v5
    import statistics as st
    P25=[]; R25=[]; P50=[]; R50=[]; tot_pred=0; tot_gt=0
    for sid,(mesh,fy,cy,bnd,rooms,gpolys,ngt) in _CACHE.items():
        furn = extract_furniture_v5(mesh, fy, cy, bnd, rooms, **params)
        preds=[]
        for f in furn:
            poly = Polygon(f["polygon"]) if f.get("polygon") else None
            if poly and poly.is_valid and poly.area>1e-3: preds.append(poly)
        # IoU 매칭 (greedy)
        def score(thr):
            pairs=[]
            for i,g in enumerate(gpolys):
                for j,p in enumerate(preds):
                    if g.intersects(p):
                        v=g.intersection(p).area/g.union(p).area
                        if v>=thr: pairs.append((v,i,j))
            pairs.sort(reverse=True); gm=set(); pm=set(); tp=0
            for v,i,j in pairs:
                if i in gm or j in pm: continue
                gm.add(i); pm.add(j); tp+=1
            prec=tp/len(preds) if preds else 0
            rec=tp/ngt if ngt else 0
            return prec,rec
        p25,r25=score(0.25); p50,r50=score(0.5)
        P25.append(p25); R25.append(r25); P50.append(p50); R50.append(r50)
        tot_pred+=len(preds); tot_gt+=ngt
    return {"P@.25":round(st.mean(P25),3),"R@.25":round(st.mean(R25),3),
            "P@.5":round(st.mean(P50),3),"R@.5":round(st.mean(R50),3),
            "tot_pred":tot_pred,"tot_gt":tot_gt,
            "F1@.25":round(2*st.mean(P25)*st.mean(R25)/(st.mean(P25)+st.mean(R25)+1e-9),3)}

if __name__=="__main__":
    # 입력: 파라미터 조합들의 JSON 배열 파일 경로. 캐시 1회 빌드 후 전부 평가.
    arg = sys.argv[1] if len(sys.argv)>1 else None
    if arg and os.path.exists(arg):
        combos = json.load(open(arg))          # [{"label":..,"params":{..}}, ...]
    elif arg == "baseline":
        combos = [{"label":"baseline","params":{}}]
    else:
        combos = [{"label":"custom","params":json.loads(arg) if arg else {}}]
    build_cache()
    print(f"[cache] {len(_CACHE)}씬 빌드 완료", file=sys.stderr)
    out=[]
    for c in combos:
        res = evaluate(c["params"])
        out.append({"label":c["label"],"params":c["params"],"result":res})
        print(f"  {c['label']}: P@.25={res['P@.25']} R@.25={res['R@.25']} F1={res['F1@.25']} pred={res['tot_pred']}", file=sys.stderr)
    outpath = os.path.join(BASE,"results","tune_results.json")
    json.dump(out, open(outpath,"w"), indent=2, ensure_ascii=False)
    print(json.dumps({"n":len(out),"best":max(out,key=lambda r:r["result"]["F1@.25"])}))
