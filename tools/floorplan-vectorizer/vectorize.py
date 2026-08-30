#!/usr/bin/env python3
# 평면도 이미지 → 편집 가능 벡터 데이터 (1차 프로토타입)
# 입력: 평면도 JPG/PNG + (OCR로 얻은) 치수/라벨 힌트
# 출력: rooms/walls JSON + 시각화 오버레이 PNG
#
# 단계: 스케일 복원 → 벽 마스크 → 방(색영역) 분할 → 라벨 매칭 → JSON/오버레이
import cv2, numpy as np, json, os, sys

def load(path):
    img = cv2.imread(path)
    return img

def plan_bbox(img):
    """치수/여백을 제외한 '평면도 본체' 바운딩박스 추정 = 색이 있는(채도) 영역 + 벽."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sat = hsv[:,:,1]
    # 채색 영역(바닥/욕실/발코니) 또는 어두운 벽
    content = ((sat > 35) | (gray < 90)).astype(np.uint8)*255
    # 잡음 제거 후 가장 큰 덩어리의 bbox
    content = cv2.morphologyEx(content, cv2.MORPH_CLOSE, np.ones((15,15),np.uint8))
    n,lab,stats,_ = cv2.connectedComponentsWithStats(content,8)
    if n<=1: return (0,0,img.shape[1],img.shape[0])
    i = 1+np.argmax(stats[1:,cv2.CC_STAT_AREA])
    x,y,w,h,_ = stats[i]
    return (x,y,x+w,y+h)

def wall_mask(img, bbox):
    x0,y0,x1,y1 = bbox
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    dark = (gray < 95).astype(np.uint8)*255
    # bbox 밖(치수선/텍스트) 제거
    m = np.zeros_like(dark); m[y0:y1, x0:x1] = dark[y0:y1, x0:x1]
    # 벽은 굵고 길다 → 작은 점(텍스트 글자)은 opening으로 제거
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3,3),np.uint8))
    return m

def rooms(img, bbox, walls, labels, door_k=39):
    """검은 벽을 경계로 사용. 문(門) 구멍만 morphological closing으로 봉합해
       벽으로 닫힌 셀을 만든 뒤 연결성분=방으로 잡는다(경계가 실제 벽에 붙음).
       벽이 없는 개방형 공간(라벨이 2개 이상 든 셀)만 watershed로 분리."""
    from collections import defaultdict
    x0,y0,x1,y1 = bbox
    H,W = img.shape[:2]
    plan_area=(x1-x0)*(y1-y0)
    # 1) 문틈 봉합: 벽 마스크 closing (커널≈문폭). 벽 두께는 보존, 작은 틈만 메움.
    ker=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(door_k,door_k))
    wc=cv2.morphologyEx(walls,cv2.MORPH_CLOSE,ker)
    # 2) 내부 = bbox 안 & 닫힌벽 아님
    interior=np.zeros((H,W),np.uint8); interior[y0:y1,x0:x1]=255; interior[wc>0]=0
    interior=cv2.erode(interior,np.ones((3,3),np.uint8),iterations=1)
    _=interior  # (참고용; 아래 watershed가 실제 분할)
    # 3) 문봉합된 벽을 배리어로, 전체 라벨 시드 watershed.
    #    → 벽이 있으면 경계가 벽에 붙고(가장 큰 그래디언트), 개구부만 라벨 중간에서 나뉨.
    wb=cv2.dilate(wc,np.ones((3,3),np.uint8),iterations=1)  # 벽 약간 두껍게=확실한 배리어
    clean=np.full((H,W,3),255,np.uint8); clean[wb>0]=(0,0,0)
    mk=np.zeros((H,W),np.int32)
    mk[:y0,:]=1; mk[y1:,:]=1; mk[:,:x0]=1; mk[:,x1:]=1     # 평면 밖=배경
    id2n={}; mid=2
    for L in labels:
        cv2.circle(mk,(int(L["pos"][0]),int(L["pos"][1])),5,mid,-1); id2n[mid]=L["name"]; mid+=1
    cv2.watershed(clean,mk)
    out=[]
    for m_,nm in id2n.items():
        comp=(mk==m_).astype(np.uint8)*255
        a=int(comp.sum()//255)
        if a<plan_area*0.0025: continue
        cnts,_=cv2.findContours(comp,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        if not cnts: continue
        c=max(cnts,key=cv2.contourArea)
        poly=cv2.approxPolyDP(c,0.008*cv2.arcLength(c,True),True).reshape(-1,2)
        M=cv2.moments(comp); m=max(M["m00"],1)
        out.append({"name":nm,"area_px":a,"centroid_px":[M["m10"]/m,M["m01"]/m],
                    "polygon_px":poly.tolist()})
    out.sort(key=lambda r:-r["area_px"])
    return out

def main():
    here=os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) < 2:
        raise SystemExit("사용법: python vectorize.py <floorplan-image> [hint.json]")
    img_path=sys.argv[1]
    hint_path=sys.argv[2] if len(sys.argv)>2 else os.path.join(here,"hint.json")
    hint=json.load(open(hint_path)) if os.path.exists(hint_path) else {}
    img=load(img_path); H,W=img.shape[:2]
    bbox=plan_bbox(img)
    walls=wall_mask(img,bbox)
    rms=rooms(img,bbox,walls,hint.get("labels",[]))
    # 스케일
    x0,y0,x1,y1=bbox
    tw=hint.get("total_w_mm"); th=hint.get("total_h_mm")
    scale={}
    if tw and th:
        scale={"mm_per_px_x": tw/(x1-x0), "mm_per_px_y": th/(y1-y0),
               "total_w_mm":tw,"total_h_mm":th}
        for r in rms:
            r["area_m2"]=round(r["area_px"]*scale["mm_per_px_x"]*scale["mm_per_px_y"]/1e6,2)
    # 출력 JSON
    res={"image":os.path.basename(img_path),"size_px":[W,H],"bbox_px":list(bbox),
         "scale":scale,"n_rooms":len(rms),"rooms":rms}
    json.dump(res,open(os.path.join(here,"result.json"),"w"),ensure_ascii=False,indent=2,
              default=lambda o:o.item() if hasattr(o,"item") else float(o))
    # 오버레이 (벽=빨강, 방 외곽=색선) + 한글 라벨(PIL)
    from PIL import Image as PImage, ImageDraw, ImageFont
    ov=img.copy()
    ov[walls>0]=(0,0,255)
    np.random.seed(7); cols=[]
    for r in rms:
        col=tuple(int(c) for c in np.random.randint(60,255,3)); cols.append(col)
        poly=np.array(r["polygon_px"],np.int32)
        cv2.polylines(ov,[poly],True,col,2)
    cv2.rectangle(ov,(x0,y0),(x1,y1),(255,0,0),2)
    pim=PImage.fromarray(cv2.cvtColor(ov,cv2.COLOR_BGR2RGB)); dr=ImageDraw.Draw(pim)
    fp="/System/Library/Fonts/AppleSDGothicNeo.ttc"
    font=ImageFont.truetype(fp,15) if os.path.exists(fp) else ImageFont.load_default()
    for r,col in zip(rms,cols):
        cx,cy=map(int,r["centroid_px"]); t=f"{r.get('name','?')} {r.get('area_m2','')}㎡"
        dr.text((cx-34,cy-8),t,font=font,fill=(0,0,0),stroke_width=3,stroke_fill=(255,255,255))
        dr.text((cx-34,cy-8),t,font=font,fill=(col[2],col[1],col[0]))
    pim.save(os.path.join(here,"overlay.png"))
    print(f"bbox={bbox} rooms={len(rms)} scale={scale.get('mm_per_px_x',0):.2f}mm/px")
    for r in rms[:15]:
        print(f"  {r.get('name','?'):6} area={r.get('area_m2','?')}m2 cent={[int(v) for v in r['centroid_px']]}")

if __name__=="__main__": main()
