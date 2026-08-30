#!/usr/bin/env python3
"""면적 구간(기본 41~100㎡)에 맞는 ARKitScenes 씬을 N개 모을 때까지
후보를 하나씩 받아 면적을 재고, 범위 밖이면 버리는 선별 다운로더.

전략:
  - candidates CSV의 video_id를 순서대로 1씬씩 download_data.py로 받음
  - 받은 PLY의 바닥(XЗ 평면) 면적을 percentile bounds로 측정
  - target 범위면 keep, 아니면 그 씬 폴더 삭제(디스크 절약)
  - N개 채우면 종료. 채택/탈락 내역을 area_selection.log 로 기록
기존 코드/데이터는 안 건드림. 전부 새 파일/폴더.
"""
import os, sys, json, subprocess, shutil
import numpy as np
import trimesh
import pandas as pd

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO = os.path.join(BASE, "ARKitScenes_repo")
DATA = os.path.join(BASE, "data", "3dod", "Training")
PYBIN = sys.executable

AREA_MIN = float(os.environ.get("AREA_MIN", 41))
AREA_MAX = float(os.environ.get("AREA_MAX", 100))
N_TARGET = int(os.environ.get("N_TARGET", 30))
CAND_CSV = os.path.join(BASE, "candidates_80.csv")
LOG = open(os.path.join(BASE, "results", "area_selection.log"), "w")

def log(*a):
    s = " ".join(str(x) for x in a)
    print(s); LOG.write(s + "\n"); LOG.flush()

def measure_area(sid):
    ply = os.path.join(DATA, sid, f"{sid}_3dod_mesh.ply")
    if not os.path.exists(ply):
        return None
    m = trimesh.load(ply, process=False)
    if isinstance(m, trimesh.Scene):
        m = trimesh.util.concatenate(list(m.geometry.values()))
    V = np.asarray(m.vertices, float)
    # ARKitScenes는 Z-up → 바닥평면은 XY. percentile로 외곽 robust 측정.
    xmin, xmax = np.percentile(V[:, 0], [1, 99])
    ymin, ymax = np.percentile(V[:, 1], [1, 99])
    return abs((xmax - xmin) * (ymax - ymin))

def download_one(sid, fold):
    # 1씬짜리 임시 CSV
    tmp = os.path.join(BASE, "_one.csv")
    pd.DataFrame([{"video_id": sid, "visit_id": "NA", "fold": fold}]).to_csv(tmp, index=False)
    r = subprocess.run(
        [PYBIN, "download_data.py", "3dod", "--video_id_csv", tmp,
         "--download_dir", os.path.join(BASE, "data")],
        cwd=REPO, capture_output=True, text=True)
    return r.returncode == 0

def main():
    cand = pd.read_csv(CAND_CSV)
    kept = []
    existing = set(os.listdir(DATA)) if os.path.isdir(DATA) else set()
    log(f"목표: {AREA_MIN}~{AREA_MAX}㎡ {N_TARGET}개. 후보 {len(cand)}개. 기존 씬 {len(existing)}개는 건너뜀.")
    for i, row in cand.iterrows():
        if len(kept) >= N_TARGET:
            break
        sid = str(row["video_id"])
        fold = row["fold"]
        if sid in existing:
            log(f"[{i+1}] {sid} 이미 있음, skip")
            continue
        log(f"[{i+1}] {sid} 다운로드중...")
        if not download_one(sid, fold):
            log(f"    다운로드 실패, skip")
            continue
        area = measure_area(sid)
        if area is None:
            log(f"    메쉬 없음, skip")
            continue
        if AREA_MIN <= area <= AREA_MAX:
            kept.append({"id": sid, "area": round(area, 1), "fold": fold})
            log(f"    ✓ KEEP  {area:.1f}㎡  ({len(kept)}/{N_TARGET})")
        else:
            # 범위 밖 → 폴더 삭제로 디스크 절약
            shutil.rmtree(os.path.join(DATA, sid), ignore_errors=True)
            log(f"    ✗ drop  {area:.1f}㎡ (범위밖, 삭제)")
    json.dump(kept, open(os.path.join(BASE, "results", "added_scenes.json"), "w"),
              ensure_ascii=False, indent=2)
    log(f"\n완료: {len(kept)}개 채택. → results/added_scenes.json")
    if len(kept) < N_TARGET:
        log(f"⚠️ 후보 소진으로 {N_TARGET}개 못 채움. candidates를 더 늘려야 함.")

if __name__ == "__main__":
    main()
