#!/usr/bin/env python3
"""최종 검증: 봉인했던 TEST 30씬에서 v4 vs v5 측정 (가구 + 평면).
이 스크립트는 모든 튜닝이 끝난 뒤 단 1회만 실행한다 (data leakage 방지)."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "services", "floorplan")))
import score as S, score_floor as SF, score_v5 as SV, score_floor_v5 as SFV
import statistics as st

BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
test=json.load(open(f"{BASE}/splits.json"))['test']
print(f"=== 봉인 TEST {len(test)}씬 최종 측정 ===\n")

# --- 가구 ---
print("[가구 footprint]")
fr={}
for which,fn in [("v4",S.run_v4_furniture),("v5",SV.run_v5_furniture)]:
    rows=[]
    for sid in test:
        try:
            rot,furn,bnd=fn(sid)
            gt=S.gt_footprints(sid,rot); pred=S.pred_footprints(furn)
            rows.append({"id":sid,"n_gt":len(gt),"n_pred":len(pred),
                         "iou25":S.match_and_score(gt,pred,0.25),
                         "iou50":S.match_and_score(gt,pred,0.50)})
        except Exception as e:
            rows.append({"id":sid,"error":str(e)})
    ok=[r for r in rows if 'error' not in r]
    def m(k,t): v=[r[t][k] for r in ok]; return round(st.mean(v),3) if v else 0
    fr[which]={"R@.25":m("recall","iou25"),"P@.25":m("precision","iou25"),
               "R@.5":m("recall","iou50"),"P@.5":m("precision","iou50"),
               "tot_pred":sum(r['n_pred'] for r in ok),"tot_gt":sum(r['n_gt'] for r in ok)}
    print(f"  {which}: {fr[which]}")

# --- 평면 ---
print("\n[평면 외곽 IoU]")
flr=[]
for sid in test:
    try:
        r=SFV.score_one(sid); flr.append(r)
    except Exception as e:
        flr.append({"id":sid,"error":str(e)})
ok=[r for r in flr if 'error' not in r and r.get('iou_v4') is not None and r.get('iou_v5') is not None]
fl={"iou_v4":round(st.mean([r['iou_v4'] for r in ok]),3),
    "iou_v5":round(st.mean([r['iou_v5'] for r in ok]),3),
    "ratio_v4":round(st.mean([r['ratio_v4'] for r in ok]),3),
    "ratio_v5":round(st.mean([r['ratio_v5'] for r in ok]),3),"n":len(ok)}
print(f"  v4 IoU={fl['iou_v4']} ratio={fl['ratio_v4']}")
print(f"  v5 IoU={fl['iou_v5']} ratio={fl['ratio_v5']}")

result={"furniture":fr,"floor":fl,"n_test":len(test)}
json.dump(result,open(f"{BASE}/results/FINAL_test.json","w"),indent=2,ensure_ascii=False)
print("\n=== 최종 요약 (TEST, 봉인해제) ===")
print(f"가구 R@.25: {fr['v4']['R@.25']} → {fr['v5']['R@.25']}  ({fr['v5']['R@.25']-fr['v4']['R@.25']:+.3f})")
print(f"가구 P@.25: {fr['v4']['P@.25']} → {fr['v5']['P@.25']}  ({fr['v5']['P@.25']-fr['v4']['P@.25']:+.3f})")
print(f"평면 IoU:   {fl['iou_v4']} → {fl['iou_v5']}  ({fl['iou_v5']-fl['iou_v4']:+.3f})")
print(f"평면 면적비: {fl['ratio_v4']} → {fl['ratio_v5']}")
print("저장: results/FINAL_test.json")
