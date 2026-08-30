#!/usr/bin/env python3
"""난이도 기반 dev/test 분할 + 테스트셋 봉인.

난이도 = 방 면적 × 가구 수 (큰 방·가구 많을수록 어려움)으로 stratify해
dev(튜닝용)와 test(봉인)에 난이도가 골고루 들어가게 분배.

data leakage 방지:
  - test 씬 ID는 splits.json의 'test'에 박제. v5 튜닝은 dev로만.
  - 최종 점수만 test로 1회 측정.
재현성: 정렬 후 결정적 분배(홀짝 인터리브) — 랜덤시드 불필요.
"""
import os, json
import numpy as np

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
scenes = json.load(open(os.path.join(BASE, "results", "scenes.json")))
floor = {r['id']: r for r in json.load(open(os.path.join(BASE,"results","score_floor.json")))['per_scene'] if 'error' not in r}
furn  = {r['id']: r for r in json.load(open(os.path.join(BASE,"results","score_furniture.json")))['per_scene'] if 'error' not in r}

# added_scenes(41~100㎡)도 포함 — scenes.json은 소형30만일 수 있어 data 폴더 기준 재수집
DATA = os.path.join(BASE, "data", "3dod", "Training")
all_ids = sorted(d for d in os.listdir(DATA) if os.path.isdir(os.path.join(DATA,d))
                 and os.path.exists(os.path.join(BASE,"glb",f"{d}.glb")))

# 난이도 점수: 가구수(GT) × 면적. floor/furn 결과에서 끌어옴.
rows = []
for sid in all_ids:
    n_gt = furn.get(sid,{}).get('n_gt', 0)
    area = floor.get(sid,{}).get('gt_area', 0)
    difficulty = n_gt * max(area, 1)
    rows.append({"id": sid, "n_gt": n_gt, "area": area, "difficulty": difficulty})

# 난이도 순 정렬 후 인터리브: 짝수 인덱스→test, 홀수→dev (난이도 균등 분포, test 50%)
rows.sort(key=lambda r: r['difficulty'])
test, dev = [], []
for i, r in enumerate(rows):
    (test if i % 2 == 0 else dev).append(r['id'])

splits = {
    "dev": sorted(dev), "test": sorted(test),
    "note": "test는 봉인. v5 튜닝은 dev로만. 최종 1회만 test 측정.",
    "n_dev": len(dev), "n_test": len(test),
}
json.dump(splits, open(os.path.join(BASE,"splits.json"),"w"), ensure_ascii=False, indent=2)
print(f"dev {len(dev)}씬 / test {len(test)}씬 (봉인)")
print("난이도 범위:", round(rows[0]['difficulty'],1), "~", round(rows[-1]['difficulty'],1))
print("저장: splits.json")
