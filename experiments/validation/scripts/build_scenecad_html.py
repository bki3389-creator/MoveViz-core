#!/usr/bin/env python3
"""SceneCAD 씬 12개 프리뷰 생성 + base64 인라인 HTML 갤러리."""
import os, sys, json, glob, base64
import numpy as np
import trimesh
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

SC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scenecad", "scannet_planes"))
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scenecad_preview"))
BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.makedirs(OUT, exist_ok=True)

def render(sid):
    j = json.load(open(f"{SC}/{sid}.json"))
    verts = np.array(j["verts"], float); edges = j["edges"]
    try:
        m = trimesh.load(f"{SC}/{sid}.ply", process=False)
        V = np.asarray(m.vertices, float)
    except Exception:
        V = verts
    fig, ax = plt.subplots(figsize=(4.2,4.2), dpi=90)
    ax.scatter(V[:,0], V[:,2], s=1.2, c="#cbd5e1", alpha=0.55, linewidths=0)
    for a,b in edges:
        ax.plot([verts[a,0],verts[b,0]],[verts[a,2],verts[b,2]], c="#2563eb", lw=1.6, alpha=0.85)
    ax.scatter(verts[:,0], verts[:,2], s=26, c="#dc2626", zorder=5, edgecolors="white", linewidths=0.5)
    ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([])
    fig.tight_layout()
    png=f"{OUT}/{sid}.png"; fig.savefig(png, bbox_inches="tight"); plt.close(fig)
    return len(verts), len(edges)

def b64(sid):
    p=f"{OUT}/{sid}.png"
    return "data:image/png;base64,"+base64.b64encode(open(p,'rb').read()).decode() if os.path.exists(p) else None

# 난이도(코너수)별 12개 균등 샘플
allj=sorted(glob.glob(f"{SC}/*.json"))
picks=sorted((len(json.load(open(jf))["verts"]), os.path.basename(jf)[:-5]) for jf in allj)
idxs=[int(i*(len(picks)-1)/11) for i in range(12)]
sel=[picks[i][1] for i in idxs]

cards=[]
for sid in sel:
    nv,ne=render(sid)
    img=b64(sid)
    cards.append(f'<div class="card"><img src="{img}"/><div class="cap">{sid}<br>코너 <b>{nv}</b> · 벽선 <b>{ne}</b></div></div>')
    print(f"{sid}: 코너{nv} 벽선{ne}")

html=f"""<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>SceneCAD 검증 데이터 (평면 벽선·코너 정답)</title><style>
body{{margin:0;background:#f6f8fb;font-family:-apple-system,sans-serif;color:#0f172a}}
.wrap{{max-width:1200px;margin:0 auto;padding:32px 20px 60px}}
h1{{font-size:24px;margin:0}} .sub{{color:#64748b;font-size:14px;margin:6px 0 18px}}
.legend{{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#475569}}
.sw{{display:inline-block;width:11px;height:11px;border-radius:3px;vertical-align:-1px;margin:0 4px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}}
.card{{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;text-align:center}}
.card img{{width:100%;border-radius:8px;background:#fff}}
.cap{{font-size:13px;color:#334155;margin-top:6px;font-family:monospace}}
</style></head><body><div class="wrap">
<h1>SceneCAD — 평면 벽선·코너 정답 데이터</h1>
<div class="sub">실제 RGB-D 스캔(ScanNet) 1,149씬 · 우리 평면추출(v4/v5) 정확도 채점용 GT · 코너수 적은순→많은순 12개 샘플</div>
<div class="legend">
<span class="sw" style="background:#dc2626"></span><b>빨강</b> = 코너(corner) 정답 ·
<span class="sw" style="background:#2563eb"></span><b>파랑</b> = 벽선(edge) 정답 ·
<span class="sw" style="background:#cbd5e1"></span><b>회색</b> = 실제 스캔 메쉬 점(탑다운)<br>
이 코너·벽선을 우리 알고리즘이 메쉬에서 얼마나 정확히 뽑는지 corner F1로 채점합니다.
</div>
<div class="grid">{''.join(cards)}</div>
</div></body></html>"""
out=f"{BASE}/SceneCAD_데이터_확인.html"
open(out,"w").write(html)
print("생성:",out, f"({len(html)//1024}KB)")
