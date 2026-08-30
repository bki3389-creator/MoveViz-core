#!/usr/bin/env python3
# 평형 타입 라이브러리: "타입당 1회 벡터화 → 모든 세대에 재사용" 구조.
#   add   : 벡터화 결과(result.json)를 타입으로 저장 + 인덱스 갱신
#   match : 전용면적(+단지)으로 가장 잘 맞는 타입 검색 → 그 평면도 반환
# 실제 서비스: 주소+호 → (건축물대장 전유부 API) 전용면적 → match → 세대에 즉시 제공(사용자 편집 0)
import json, os, sys, shutil, hashlib

HERE=os.path.dirname(os.path.abspath(__file__))
LIB=os.path.join(HERE,"library")
IDX=os.path.join(LIB,"index.json")

def _load_idx():
    return json.load(open(IDX)) if os.path.exists(IDX) else []
def _save_idx(x):
    os.makedirs(LIB,exist_ok=True); json.dump(x,open(IDX,"w"),ensure_ascii=False,indent=2)

def interior_area(res):
    # 발코니/테라스(서비스면적) 제외한 전용 추정
    svc=("발코니","테라스")
    return round(sum(r.get("area_m2",0) for r in res["rooms"]
                     if not any(s in r.get("name","") for s in svc)),2)

def add(result_path, danji, typ, exclusive_m2=None, image=None):
    res=json.load(open(result_path))
    area=exclusive_m2 if exclusive_m2 else interior_area(res)
    tid=hashlib.md5(f"{danji}_{typ}".encode()).hexdigest()[:8]
    d=os.path.join(LIB,tid); os.makedirs(d,exist_ok=True)
    shutil.copy(result_path, os.path.join(d,"result.json"))
    if image and os.path.exists(image): shutil.copy(image, os.path.join(d,"source"+os.path.splitext(image)[1]))
    idx=_load_idx(); idx=[e for e in idx if e["type_id"]!=tid]
    idx.append({"type_id":tid,"단지":danji,"타입":typ,"전용면적_m2":area,
                "n_rooms":res.get("n_rooms",len(res["rooms"])),
                "방":[r.get("name") for r in res["rooms"]],
                "result":os.path.relpath(os.path.join(d,"result.json"),HERE)})
    _save_idx(idx)
    print(f"[add] {danji} {typ}  전용 {area}㎡  type_id={tid}  방 {len(res['rooms'])}개")
    return tid

def match(exclusive_m2, danji=None, tol=3.0):
    idx=_load_idx(); cand=[e for e in idx if (danji is None or e["단지"]==danji)]
    if not cand: print("[match] 라이브러리에 후보 없음"); return None
    best=min(cand,key=lambda e:abs(e["전용면적_m2"]-exclusive_m2))
    diff=abs(best["전용면적_m2"]-exclusive_m2)
    ok = diff<=tol
    print(f"[match] 질의 전용 {exclusive_m2}㎡{' / '+danji if danji else ''} → "
          f"{'✅' if ok else '⚠️'} {best['단지']} {best['타입']} "
          f"(전용 {best['전용면적_m2']}㎡, 오차 {diff:.1f}㎡)")
    print(f"        방: {', '.join(b for b in best['방'] if b)}")
    print(f"        평면도: {best['result']}  → 이 세대에 즉시 제공(편집 0)")
    return best if ok else None

if __name__=="__main__":
    cmd=sys.argv[1] if len(sys.argv)>1 else "list"
    if cmd=="add":
        add(sys.argv[2], sys.argv[3], sys.argv[4],
            float(sys.argv[5]) if len(sys.argv)>5 and sys.argv[5] else None,
            sys.argv[6] if len(sys.argv)>6 and sys.argv[6] else None)
    elif cmd=="match":
        match(float(sys.argv[2]), sys.argv[3] if len(sys.argv)>3 else None)
    else:
        idx=_load_idx(); print(f"라이브러리 타입 {len(idx)}개")
        for e in idx: print(f"  {e['type_id']}  {e['단지']} {e['타입']}  전용 {e['전용면적_m2']}㎡  방{e['n_rooms']}")
