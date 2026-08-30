#!/usr/bin/env python3
# ocr.json(Vision 토큰) → hint_auto.json (치수→스케일, 한글→방라벨 위치) 자동 생성
# 사람이 손으로 넣던 hint.json을 100% 코드로 대체.
import json, re, os, sys
from collections import Counter

here=os.path.dirname(os.path.abspath(__file__))
d=json.load(open(os.path.join(here, sys.argv[1] if len(sys.argv)>1 else "ocr.json")))
W,H,toks=d["w"],d["h"],d["tokens"]
hangul=lambda s: re.sub(r"[^가-힣]","",s)

nums=[]; labels=[]
for t in toks:
    s=t["t"].strip()
    if not hangul(s):                       # 숫자(치수) — "1500 500" 같은 다중도 분리
        for p in re.findall(r"\d{3,5}", s): nums.append((int(p),t["x"],t["y"]))
    elif len(hangul(s))>=2:                  # 한글 2자+ = 방 라벨
        labels.append({"name":hangul(s),"pos":[t["x"],t["y"]]})

# 스케일: 상/하단 밴드의 최대 숫자=가로 총치수, 좌/우 밴드 최대=세로 총치수
topbot=[n[0] for n in nums if n[2]<H*0.12 or n[2]>H*0.88]
leftright=[n[0] for n in nums if n[1]<W*0.12 or n[1]>W*0.88]
total_w=max(topbot,default=0); total_h=max(leftright,default=0)

# 멀티라인 라벨 병합 (드레+스룸 → 드레스룸)
labels.sort(key=lambda l:(l["pos"][0],l["pos"][1])); merged=[]
for l in labels:
    hit=None
    for m in merged:
        if abs(m["pos"][0]-l["pos"][0])<45 and abs(m["pos"][1]-l["pos"][1])<34: hit=m; break
    if hit:
        if l["pos"][1]<hit["pos"][1]: hit["name"]=l["name"]+hit["name"]
        else: hit["name"]=hit["name"]+l["name"]
        hit["pos"]=[(hit["pos"][0]+l["pos"][0])//2,(hit["pos"][1]+l["pos"][1])//2]
    else: merged.append({"name":l["name"],"pos":list(l["pos"])})

# 방이름 화이트리스트(오인식 노이즈 제거). 알려진 키워드 포함 시만 유지.
KNOWN=["침실","거실","주방","식당","서재","드레스룸","파우더룸","욕실","발코니","테라스",
       "현관","복도","다용도","팬트리","안방","알파","창고","화장실","부엌","다이닝","드레스"]
merged=[m for m in merged if any(k in m["name"] or m["name"] in k for k in KNOWN)]

# 중복 이름 접미사 (침실→침실1/2/3)
cnt=Counter(m["name"] for m in merged); seen=Counter()
for m in merged:
    if cnt[m["name"]]>1: seen[m["name"]]+=1; m["name"]=f"{m['name']}{seen[m['name']]}"

out={"total_w_mm":total_w,"total_h_mm":total_h,"labels":merged}
json.dump(out,open(os.path.join(here,"hint_auto.json"),"w"),ensure_ascii=False,indent=2)
print(f"auto scale: {total_w} x {total_h} mm, labels: {len(merged)}")
for m in merged: print(f"  {m['name']:8} {m['pos']}")
