#!/usr/bin/env python3
"""scenes.json + 프리뷰 PNG → 시각 확인용 단일 HTML 갤러리.
이미지를 base64로 인라인 → 파일 하나만 더블클릭하면 됨(서버 불필요).
"""
import os, json, base64, mimetypes
from collections import Counter

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
scenes = json.load(open(os.path.join(BASE, "results", "scenes.json")))

def b64(relpath):
    p = os.path.join(BASE, relpath)
    if not os.path.exists(p):
        return None
    mt = mimetypes.guess_type(p)[0] or "image/png"
    with open(p, "rb") as f:
        return f"data:{mt};base64," + base64.b64encode(f.read()).decode()

# 전체 통계
total_furn = sum(s.get("furniture_count", 0) for s in scenes)
all_labels = Counter()
for s in scenes:
    for lab, n in s.get("labels", {}).items():
        all_labels[lab] += n
areas = [s.get("floor_area_m2", 0) for s in scenes]

PALETTE = {
    "cabinet": "#d97706", "refrigerator": "#0891b2", "shelf": "#7c3aed",
    "table": "#16a34a", "bed": "#dc2626", "sofa": "#2563eb", "sink": "#0d9488",
    "washer": "#9333ea", "toilet": "#65a30d", "bathtub": "#c026d3",
    "oven": "#ea580c", "dishwasher": "#0284c7", "fireplace": "#b45309",
    "stove": "#e11d48", "stool": "#4f46e5", "chair": "#059669",
    "tv_monitor": "#7c2d12", "build_in_cabinet": "#a16207",
}
def col(l): return PALETTE.get(l, "#64748b")

cards = []
for s in sorted(scenes, key=lambda x: -x.get("furniture_count", 0)):
    td = b64(s.get("topdown", "")) if s.get("topdown") else None
    rgb = b64(s.get("rgb", "")) if s.get("rgb") else None
    labels_html = "".join(
        f'<span class="chip" style="background:{col(l)}1a;color:{col(l)};border-color:{col(l)}55">{l} ×{n}</span>'
        for l, n in sorted(s.get("labels", {}).items(), key=lambda x: -x[1])
    )
    td_img = f'<img src="{td}" class="td"/>' if td else '<div class="noimg">no mesh</div>'
    rgb_img = f'<img src="{rgb}" class="rgb"/>' if rgb else '<div class="noimg">no rgb</div>'
    cards.append(f"""
    <div class="card">
      <div class="imgs">
        <figure>{td_img}<figcaption>탑다운 (메쉬 + 가구 OBB 정답)</figcaption></figure>
        <figure>{rgb_img}<figcaption>실제 촬영 (iPad LiDAR)</figcaption></figure>
      </div>
      <div class="meta">
        <div class="sid">{s['id']}</div>
        <div class="stats">
          <span><b>{s.get('furniture_count',0)}</b> 가구</span>
          <span><b>{s.get('floor_area_m2','?')}</b> ㎡</span>
          <span><b>{s.get('height_m','?')}</b> m 높이</span>
          <span><b>{s.get('vertices',0):,}</b> verts</span>
          <span><b>{s.get('mesh_mb','?')}</b> MB</span>
        </div>
        <div class="chips">{labels_html or '<span class="chip">가구 OBB 없음</span>'}</div>
      </div>
    </div>""")

label_legend = "".join(
    f'<span class="chip" style="background:{col(l)}1a;color:{col(l)};border-color:{col(l)}55">{l} ×{n}</span>'
    for l, n in all_labels.most_common()
)

html = f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARKitScenes 검증 데이터 — 시각 확인</title>
<style>
 :root{{--ink:#0f172a;--dim:#64748b;--line:#e2e8f0;--bg:#f6f8fb;--card:#fff;--accent:#2563eb}}
 *{{box-sizing:border-box}}
 body{{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,'Pretendard',Segoe UI,sans-serif;line-height:1.5}}
 .wrap{{max-width:1280px;margin:0 auto;padding:32px 24px 80px}}
 header{{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:24px}}
 .eyebrow{{letter-spacing:.25em;font-size:12px;color:var(--dim);font-weight:700}}
 h1{{font-size:26px;margin:6px 0}}
 .sub{{color:var(--dim);font-size:14px}}
 .overview{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}}
 .ov{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}}
 .ov .n{{font-size:26px;font-weight:700;color:var(--accent)}}
 .ov .l{{font-size:12px;color:var(--dim);margin-top:2px}}
 .legend{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:24px}}
 .legend h3{{margin:0 0 10px;font-size:14px}}
 .chips{{display:flex;flex-wrap:wrap;gap:6px}}
 .chip{{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid;white-space:nowrap}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:18px}}
 .card{{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}}
 .imgs{{display:grid;grid-template-columns:1fr 1fr;gap:0}}
 figure{{margin:0;background:#0c111c}}
 figure img{{width:100%;display:block;aspect-ratio:1;object-fit:cover}}
 figure img.td{{background:#fff;object-fit:contain}}
 figcaption{{font-size:10px;color:#94a3b8;padding:5px 8px;background:#0c111c;text-align:center}}
 .noimg{{aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:#475569;font-size:12px}}
 .meta{{padding:14px 16px}}
 .sid{{font-family:monospace;font-size:13px;color:var(--dim)}}
 .stats{{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 10px;font-size:13px}}
 .stats b{{color:var(--ink);font-size:15px}}
 footer{{margin-top:36px;color:#94a3b8;font-size:12px;text-align:center}}
</style></head>
<body><div class="wrap">
 <header>
   <div class="eyebrow">MOVEVIZ · 정확도 검증 데이터</div>
   <h1>ARKitScenes 검증 씬 — 시각 확인</h1>
   <div class="sub">iPad Pro LiDAR로 스캔한 실제 방 · 메쉬(PLY) + 가구 3D 바운딩박스 정답(OBB) · 우리 iOS 스캔과 같은 센서군</div>
 </header>

 <div class="overview">
   <div class="ov"><div class="n">{len(scenes)}</div><div class="l">씬 (다운로드된)</div></div>
   <div class="ov"><div class="n">{total_furn}</div><div class="l">가구 OBB 총개수</div></div>
   <div class="ov"><div class="n">{len(all_labels)}</div><div class="l">가구 종류</div></div>
   <div class="ov"><div class="n">{min(areas):.0f}~{max(areas):.0f}</div><div class="l">방 면적 범위 (㎡)</div></div>
 </div>

 <div class="legend">
   <h3>가구 라벨 (정답 OBB로 제공되는 종류)</h3>
   <div class="chips">{label_legend}</div>
 </div>

 <div class="grid">{''.join(cards)}</div>

 <footer>
   각 카드 = 1개 씬. 왼쪽=탑다운 점밀도(방 윤곽)+가구 OBB 정답 오버레이, 오른쪽=실제 촬영 RGB.<br>
   이 데이터로 ① 메쉬→평면도 ③ 가구 footprint 추출 정확도를 채점합니다. 가구 많은 순 정렬.
 </footer>
</div></body></html>"""

out = os.path.join(BASE, "검증데이터_확인.html")
open(out, "w").write(html)
print("생성됨:", out, f"({len(html)//1024} KB)")
