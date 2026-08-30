#!/usr/bin/env python3
"""가구 v4 vs v5 비교 이미지들을 단일 HTML로 묶기 (base64 인라인)."""
import os, json, base64
BASE=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
metas=json.load(open(f"{BASE}/results/furniture_compare.json"))
# 전체 test 요약도 표시
final=json.load(open(f"{BASE}/results/FINAL_test.json"))
fv4,fv5=final['furniture']['v4'],final['furniture']['v5']

def b64(sid):
    p=f"{BASE}/furniture_compare/{sid}.png"
    if not os.path.exists(p): return None
    return "data:image/png;base64,"+base64.b64encode(open(p,'rb').read()).decode()

cards=[]
for m in metas:
    img=b64(m['id'])
    if not img: continue
    cards.append(f"""<div class="card">
      <div class="cap">{m['id']} · 정답 {m['gt']}개 → <span style="color:#dc2626">v4 {m['v4']}개</span> / <span style="color:#2563eb">v5 {m['v5']}개</span></div>
      <img src="{img}"/></div>""")

html=f"""<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>가구 검출 v4 vs v5 비교</title><style>
body{{margin:0;background:#f6f8fb;font-family:-apple-system,sans-serif;color:#0f172a}}
.wrap{{max-width:1200px;margin:0 auto;padding:32px 20px 60px}}
h1{{font-size:24px}}.sub{{color:#64748b;font-size:14px;margin-bottom:20px}}
.summary{{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:24px}}
table{{width:100%;border-collapse:collapse;font-size:14px}}
th,td{{padding:8px 12px;border-bottom:1px solid #eee;text-align:left}}
th{{color:#64748b;font-size:12px}} .up{{color:#16a34a;font-weight:700}}
.card{{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:18px}}
.cap{{font-size:14px;font-weight:600;margin-bottom:8px}} img{{width:100%;display:block;border-radius:8px}}
.legend{{font-size:13px;color:#475569;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin-bottom:20px}}
</style></head><body><div class="wrap">
<h1>가구 검출 정확도 — v4(기존) vs v5(개선)</h1>
<div class="sub">ARKitScenes 실제 iPad LiDAR 스캔 · 초록 점선=정답 가구 윤곽</div>

<div class="summary">
<b>봉인 test 30씬 종합</b>
<table>
<tr><th>지표</th><th>v4 (기존)</th><th>v5 (개선)</th><th>변화</th></tr>
<tr><td>Recall@0.25 (정답 중 찾은 비율)</td><td>{fv4['R@.25']}</td><td>{fv5['R@.25']}</td><td class="up">+{round(fv5['R@.25']-fv4['R@.25'],3)} ({round(fv5['R@.25']/fv4['R@.25'],1)}배)</td></tr>
<tr><td>Precision@0.25 (찾은 것 중 진짜 비율)</td><td>{fv4['P@.25']}</td><td>{fv5['P@.25']}</td><td class="up">+{round(fv5['P@.25']-fv4['P@.25'],3)}</td></tr>
<tr><td>Recall@0.5 (더 엄격한 위치 일치)</td><td>{fv4['R@.5']}</td><td>{fv5['R@.5']}</td><td class="up">+{round(fv5['R@.5']-fv4['R@.5'],3)}</td></tr>
</table></div>

<div class="legend">
<b>보는 법:</b> 각 행 = 한 방. 3패널 = [정답 가구] [v4 검출(빨강)] [v5 검출(파랑)].<br>
v4 패널과 v5 패널의 <b>초록 점선(정답)</b>을 얼마나 채우는지 비교하세요. v5가 정답 윤곽을 더 많이 덮으면 개선된 것.
</div>

{''.join(cards)}
</div></body></html>"""
out=f"{BASE}/가구개선_확인.html"
open(out,"w").write(html)
print("생성:",out, f"({len(html)//1024}KB)")
