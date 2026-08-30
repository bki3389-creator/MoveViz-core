#!/usr/bin/env python3
"""dev셋에서 v5 가구의 TP vs FP 특징 정밀 분석.
어떤 특징이 노이즈(FP)를 recall 손실 없이 걸러낼지 데이터로 찾는다."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S, score_v5 as SV
from shapely.geometry import Polygon

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
dev=json.load(open(f"{BASE}/splits.json"))['dev']

def feats(f, poly):
    # 종횡비(긴변/짧은변), 면적, 높이, 채움률(면적/bbox면적), builtin
    xs=[p[0] for p in f['polygon']]; zs=[p[1] for p in f['polygon']]
    bw=max(xs)-min(xs); bh=max(zs)-min(zs)
    long_=max(bw,bh,1e-3); short=max(min(bw,bh),1e-3)
    aspect=long_/short
    bbox_area=max(bw*bh,1e-4)
    fill=poly.area/bbox_area
    return {"area":f['footprint_m2'],"height":f['height_m'],"aspect":aspect,
            "fill":fill,"builtin":f.get('builtin',False)}

tp,fp=[],[]
for sid in dev:
    try:
        rot,furn,bnd=SV.run_v5_furniture(sid)
        gt=S.gt_footprints(sid,rot); gpolys=[g['poly'] for g in gt]
        for f in furn:
            p=Polygon(f['polygon'])
            if not p.is_valid or p.area<1e-3: continue
            best=max((p.intersection(g).area/p.union(g).area for g in gpolys), default=0)
            (tp if best>=0.25 else fp).append(feats(f,p))
    except Exception as e:
        print(sid,"ERR",e)

import statistics as st
def stats(name,L):
    print(f"\n{name} (n={len(L)}):")
    for k in ["area","height","aspect","fill"]:
        v=[x[k] for x in L]
        print(f"  {k:8s}: median={st.median(v):.2f} mean={st.mean(v):.2f} p10={np.percentile(v,10):.2f} p90={np.percentile(v,90):.2f}")
    bi=sum(1 for x in L if x['builtin']); print(f"  builtin비율: {bi/len(L)*100:.0f}%")

print("=== v5 가구 TP vs FP 특징 (dev 30씬) ===")
stats("TP(맞음)",tp); stats("FP(노이즈)",fp)

# 필터 시뮬레이션: 각 필터가 TP/FP를 얼마나 거르나
print("\n=== 필터별 효과 (TP유지율 / FP제거율) — 둘 다 높을수록 좋음 ===")
def sim(name, keepfn):
    tk=sum(1 for x in tp if keepfn(x)); fk=sum(1 for x in fp if keepfn(x))
    print(f"  {name}: TP유지 {tk}/{len(tp)}={tk/len(tp)*100:.0f}%  FP유지 {fk}/{len(fp)}={fk/len(fp)*100:.0f}% (제거 {100-fk/len(fp)*100:.0f}%)")
sim("area>=0.10", lambda x:x['area']>=0.10)
sim("area>=0.15", lambda x:x['area']>=0.15)
sim("aspect<=5", lambda x:x['aspect']<=5)
sim("aspect<=4", lambda x:x['aspect']<=4)
sim("fill>=0.5", lambda x:x['fill']>=0.5)
sim("fill>=0.6", lambda x:x['fill']>=0.6)
sim("area>=0.12 & aspect<=5", lambda x:x['area']>=0.12 and x['aspect']<=5)
sim("area>=0.10 & fill>=0.5", lambda x:x['area']>=0.10 and x['fill']>=0.5)
sim("area>=0.12 & aspect<=4.5 & fill>=0.45", lambda x:x['area']>=0.12 and x['aspect']<=4.5 and x['fill']>=0.45)
