#!/usr/bin/env python3
# result.json + 평면도 이미지 → 자체완결 HTML 에디터 생성
# 방 폴리곤 위에 가구를 실측(cm) 크기로 배치·이동·회전, 라벨 편집, JSON 내보내기
import json, os, base64, sys

here=os.path.dirname(os.path.abspath(__file__))
res=json.load(open(os.path.join(here,"result.json")))
if len(sys.argv) < 2:
    raise SystemExit("사용법: python make_editor.py <floorplan-image>")
img_path=sys.argv[1]
b64=base64.b64encode(open(img_path,"rb").read()).decode()
mime="image/jpeg" if img_path.lower().endswith((".jpg",".jpeg")) else "image/png"
W,H=res["size_px"]; sc=res.get("scale",{})
mmpx=sc.get("mm_per_px_x",10.0)  # 가구 크기 환산용(가로 기준)
data=json.dumps(res,ensure_ascii=False)

html=f"""<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>평면도 편집기 · 가구배치</title>
<style>
:root{{--red:#FF3B30;--ink:#1B1B1E;--sub:#8B8D92;--line:#E5E7EA;--card:#F2F3F5;--page:#F6F7F9}}
*{{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,"Apple SD Gothic Neo",sans-serif}}
body{{background:var(--page);color:var(--ink);display:flex;height:100vh;overflow:hidden}}
#side{{width:240px;flex:0 0 auto;background:#fff;border-right:1px solid var(--line);padding:16px;overflow-y:auto}}
#side h1{{font-size:16px;font-weight:800;margin-bottom:4px}}
#side .meta{{font-size:11px;color:var(--sub);margin-bottom:14px;line-height:1.5}}
.sec{{font-size:11px;font-weight:800;color:var(--red);letter-spacing:.5px;margin:14px 0 8px}}
.fbtn{{display:inline-flex;align-items:center;justify-content:center;gap:4px;width:calc(50% - 4px);
  padding:9px 6px;margin:0 4px 8px 0;font-size:12px;font-weight:600;border:1px solid var(--line);
  border-radius:10px;background:var(--card);cursor:pointer}}
.fbtn:hover{{border-color:var(--red);color:var(--red)}}
.fbtn small{{color:var(--sub);font-weight:500;font-size:10px}}
.roomrow{{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0}}
.roomrow .sw{{width:12px;height:12px;border-radius:3px;flex:0 0 auto}}
.roomrow .ar{{margin-left:auto;color:var(--sub);font-size:11px}}
#stage{{flex:1;position:relative;overflow:auto;display:flex;align-items:center;justify-content:center;background:#e9ebee}}
#wrap{{position:relative;box-shadow:0 8px 30px rgba(0,0,0,.15)}}
#wrap img{{display:block;width:{W}px;height:{H}px}}
svg{{position:absolute;top:0;left:0}}
.room{{fill:rgba(255,59,48,.04);stroke:rgba(255,59,48,.5);stroke-width:1.5;cursor:pointer}}
.room.sel{{fill:rgba(255,59,48,.14);stroke:var(--red);stroke-width:2.5}}
.rlabel{{font-size:12px;font-weight:700;fill:#1B1B1E;paint-order:stroke;stroke:#fff;stroke-width:3px}}
.furn{{fill:rgba(34,118,255,.18);stroke:#1769ff;stroke-width:1.5;cursor:move}}
.furn.sel{{stroke:#FF3B30;stroke-width:2.5;fill:rgba(255,59,48,.2)}}
.flabel{{font-size:10px;font-weight:700;fill:#1B1B1E;pointer-events:none;paint-order:stroke;stroke:#fff;stroke-width:2.5px}}
.bar{{position:absolute;left:14px;bottom:14px;background:#fff;border:1px solid var(--line);border-radius:10px;
  padding:8px 12px;font-size:11px;color:var(--sub);box-shadow:0 4px 12px rgba(0,0,0,.08)}}
.toolbar{{position:absolute;right:14px;top:14px;display:flex;gap:8px}}
.tb{{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:12px;
  font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.08)}}
.tb.red{{background:var(--red);color:#fff;border-color:var(--red)}}
.hint{{font-size:10px;color:var(--sub);margin-top:6px;line-height:1.5}}
</style></head><body>
<div id="side">
  <h1>평면도 편집기</h1>
  <div class="meta" id="meta"></div>
  <div class="sec">가구 추가 (실측 cm)</div>
  <div id="palette"></div>
  <div class="sec">방 목록</div>
  <div id="rooms"></div>
  <div class="hint">· 방/가구 클릭 → 선택<br>· 드래그 → 이동<br>· 선택 후 R=회전, ⌫=삭제<br>· 방 더블클릭 → 이름 변경</div>
</div>
<div id="stage"><div id="wrap">
  <img src="data:{mime};base64,{b64}">
  <svg id="svg" width="{W}" height="{H}"></svg>
  <div class="bar" id="scalebar"></div>
  <div class="toolbar">
    <div class="tb" onclick="addFromBtn('맞춤가구',60,60)">+ 가구</div>
    <div class="tb red" onclick="exportJSON()">JSON 내보내기</div>
  </div>
</div></div>
<script>
const RES={data};
const MMPX={mmpx};            // 1px = MMPX mm
const PALETTE=[
 ["침대(퀸)",150,200],["침대(싱글)",100,200],["소파",200,90],["식탁",120,80],
 ["책상",120,60],["옷장",100,60],["냉장고",70,70],["TV장",150,40],
 ["의자",45,45],["수납장",80,40]];
const svg=document.getElementById('svg');
const NS="http://www.w3.org/2000/svg";
let furns=[], sel=null, selType=null;

function cm2px(cm){{return cm*10/MMPX;}}  // cm→mm→px
function el(t,a){{const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);return e;}}

// 방 렌더
RES.rooms.forEach((r,i)=>{{
  const pts=r.polygon_px.map(p=>p.join(',')).join(' ');
  const poly=el('polygon',{{points:pts,class:'room','data-i':i}});
  poly.onclick=e=>{{selectRoom(i);e.stopPropagation();}};
  poly.ondblclick=e=>{{const n=prompt('방 이름',r.name||'');if(n){{r.name=n;draw();}}}};
  svg.appendChild(poly);
}});
function drawRoomLabels(){{
  RES.rooms.forEach(r=>{{
    const t=el('text',{{x:r.centroid_px[0],y:r.centroid_px[1],class:'rlabel','text-anchor':'middle'}});
    t.textContent=`${{r.name||'?'}} ${{r.area_m2||''}}㎡`;
    t.style.pointerEvents='none';svg.appendChild(t);
  }});
}}
// 가구 렌더
function draw(){{
  [...svg.querySelectorAll('.furn,.flabel,.rlabel')].forEach(e=>e.remove());
  drawRoomLabels();
  furns.forEach((f,i)=>{{
    const g=el('g',{{transform:`rotate(${{f.rot}} ${{f.x}} ${{f.y}})`}});
    const rc=el('rect',{{x:f.x-f.w/2,y:f.y-f.h/2,width:f.w,height:f.h,
      class:'furn'+(sel===i&&selType==='f'?' sel':''),'data-i':i}});
    rc.onmousedown=e=>startDrag(e,i);
    g.appendChild(rc);svg.appendChild(g);
    const t=el('text',{{x:f.x,y:f.y+3,class:'flabel','text-anchor':'middle'}});
    t.textContent=f.name;svg.appendChild(t);
  }});
  document.querySelectorAll('.room').forEach((p,i)=>p.classList.toggle('sel',sel===i&&selType==='r'));
}}
function selectRoom(i){{sel=i;selType='r';draw();}}
// 드래그
let drag=null;
function startDrag(e,i){{sel=i;selType='f';drag={{i,sx:e.clientX,sy:e.clientY,ox:furns[i].x,oy:furns[i].y}};draw();e.stopPropagation();}}
window.onmousemove=e=>{{if(!drag)return;const k=zoom();furns[drag.i].x=drag.ox+(e.clientX-drag.sx)/k;furns[drag.i].y=drag.oy+(e.clientY-drag.sy)/k;draw();}};
window.onmouseup=()=>drag=null;
function zoom(){{const r=document.querySelector('#wrap img').getBoundingClientRect();return r.width/{W};}}
svg.onclick=()=>{{sel=null;selType=null;draw();}};
window.onkeydown=e=>{{
  if(sel===null)return;
  if(selType==='f'&&(e.key==='r'||e.key==='R')){{furns[sel].rot=(furns[sel].rot+90)%360;draw();}}
  if((e.key==='Backspace'||e.key==='Delete')&&selType==='f'){{furns.splice(sel,1);sel=null;draw();e.preventDefault();}}
}};
function addFromBtn(name,wcm,hcm){{
  furns.push({{name,w:cm2px(wcm),h:cm2px(hcm),x:{W}/2,y:{H}/2,rot:0,wcm,hcm}});
  sel=furns.length-1;selType='f';draw();
}}
// 팔레트
const pal=document.getElementById('palette');
PALETTE.forEach(([n,w,h])=>{{
  const b=document.createElement('div');b.className='fbtn';
  b.innerHTML=`${{n}}<br><small>${{w}}×${{h}}</small>`;
  b.onclick=()=>addFromBtn(n,w,h);pal.appendChild(b);
}});
// 방 목록 + 메타
document.getElementById('meta').innerHTML=
  `${{RES.image}}<br>전체 ${{(RES.scale.total_w_mm/1000)||'?'}}×${{(RES.scale.total_h_mm/1000)||'?'}}m · ${{RES.n_rooms}}개 방<br>스케일 ${{MMPX.toFixed(1)}}mm/px`;
const rl=document.getElementById('rooms');
const COLORS=['#FF3B30','#1769ff','#16A34A','#F59E0B','#9333EA','#0EA5E9','#EC4899','#65A30D'];
RES.rooms.forEach((r,i)=>{{
  const d=document.createElement('div');d.className='roomrow';
  d.innerHTML=`<span class="sw" style="background:${{COLORS[i%COLORS.length]}}"></span>${{r.name||'?'}}<span class="ar">${{r.area_m2||''}}㎡</span>`;
  d.onclick=()=>selectRoom(i);rl.appendChild(d);
}});
document.getElementById('scalebar').innerHTML=`📏 1m = ${{(1000/MMPX).toFixed(0)}}px · 가구는 실측 cm 비율`;
function exportJSON(){{
  const out={{...RES,furniture:furns.map(f=>({{name:f.name,w_cm:f.wcm,h_cm:f.hcm,
    center_mm:[Math.round(f.x*MMPX),Math.round(f.y*MMPX)],rot:f.rot}}))}};
  const blob=new Blob([JSON.stringify(out,null,2)],{{type:'application/json'}});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='floorplan_edited.json';a.click();
}}
draw();
</script></body></html>"""
open(os.path.join(here,"editor.html"),"w").write(html)
print("editor.html 생성:", os.path.join(here,"editor.html"))
