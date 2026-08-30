#!/usr/bin/env python3
"""SceneCAD 씬 시각화: 메쉬 탑다운 점 + 코너(verts) + 벽선(edges) 오버레이.
JSON verts=3D코너, edges=코너인덱스쌍, quads=면. Y-up이므로 바닥평면은 XZ."""
import os, sys, json, glob
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import trimesh
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

SC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scenecad", "scannet_planes"))
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scenecad_preview"))
os.makedirs(OUT, exist_ok=True)

def preview(sid):
    j = json.load(open(f"{SC}/{sid}.json"))
    verts = np.array(j["verts"], float)        # (N,3) Y-up
    edges = j["edges"]
    # 메쉬 점
    try:
        m = trimesh.load(f"{SC}/{sid}.ply", process=False)
        V = np.asarray(m.vertices, float)
    except Exception:
        V = verts
    fig, ax = plt.subplots(figsize=(6,6), dpi=90)
    # 바닥평면 XZ (Y-up). 메쉬 점밀도
    ax.scatter(V[:,0], V[:,2], s=1, c="#cbd5e1", alpha=0.5, linewidths=0)
    # 벽선(edges) — 파랑
    for a,b in edges:
        ax.plot([verts[a,0],verts[b,0]],[verts[a,2],verts[b,2]], c="#2563eb", lw=1.5, alpha=0.8)
    # 코너(verts) — 빨강 점
    ax.scatter(verts[:,0], verts[:,2], s=30, c="#dc2626", zorder=5, edgecolors="white", linewidths=0.5)
    ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(f"{sid}  ·  코너 {len(verts)}개 · 벽선 {len(edges)}개", fontsize=11)
    fig.tight_layout()
    png=f"{OUT}/{sid}.png"; fig.savefig(png, bbox_inches="tight"); plt.close(fig)
    return png, len(verts), len(edges)

if __name__=="__main__":
    # 코너 수가 다양하도록 6개 샘플 (간단방~복잡방)
    allj = sorted(glob.glob(f"{SC}/*.json"))
    picks=[]
    for jf in allj:
        sid=os.path.basename(jf)[:-5]
        n=len(json.load(open(jf))["verts"])
        picks.append((n,sid))
    picks.sort()
    # 작은거 2, 중간 2, 큰거 2
    sel=[picks[2][1], picks[len(picks)//4][1], picks[len(picks)//2][1],
         picks[len(picks)*3//4][1], picks[-3][1], picks[-1][1]]
    meta=[]
    for sid in sel:
        png,nv,ne=preview(sid); meta.append({"id":sid,"corners":nv,"edges":ne})
        print(f"{sid}: 코너 {nv} 벽선 {ne}")
    json.dump(meta, open(f"{OUT}/index.json","w"), indent=2)
