#!/usr/bin/env python3
"""[실험 v5] GLB → 평면 + 가구(v4 & v5 둘 다) 비교 서버.

기존 server_furniture.py(:5051), server.py(:5050) 는 일절 건드리지 않음.
별도 포트 :5052. 응답에 furniture(=v5, 기본 표시) + furniture_v4(비교용) 둘 다 포함.
furniture_viewer_v5.html 과 짝.
"""
import os, sys, tempfile
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from glb_to_floorplan_v4 import (
    load_glb, find_floor_ceiling, extract_slices,
    consensus_walls, build_boundary, extract_cad_plan,
    estimate_rotation_angle, detect_openings, decompose_rooms,
)
from glb_furniture import extract_furniture            # v4
from glb_furniture_v5 import extract_furniture_v5      # v5 (개선)

app = Flask(__name__)
CORS(app)


@app.route('/convert', methods=['POST'])
def convert():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    with tempfile.NamedTemporaryFile(suffix='.glb', delete=False) as tmp:
        f.save(tmp.name)
        path = tmp.name
    try:
        mesh = load_glb(path)
        IS_CAD = mesh.faces.shape[0] < 2000
        rotation_angle = 0.0
        fy, cy = 0.0, 2.4
        openings = []
        rooms_data = {'rooms': [], 'interior_openings': [], 'doors': []}
        furniture_v4 = []
        furniture_v5 = []
        slices = []

        if IS_CAD:
            cad = extract_cad_plan(mesh, min_wall_len=0.3)
            if cad is None:
                return jsonify({'error': 'CAD extraction failed'}), 500
            boundary = cad['boundary']; xw, zw = cad['xw'], cad['zw']
            fp = cad['fp']; ap = np.array(fp) if fp else np.array([[0, 0]])
            sp = {}; xh, xe, zh, ze = [], [0.0, 1.0], [], [0.0, 1.0]
            source = 'cad'
        else:
            rotation_angle = estimate_rotation_angle(mesh)
            if abs(rotation_angle) > 1e-4:
                import trimesh
                R = trimesh.transformations.rotation_matrix(rotation_angle, [0, 1, 0])
                mesh = mesh.copy(); mesh.apply_transform(R)
            fy, cy = find_floor_ceiling(mesh)
            slices = extract_slices(mesh, fy, cy, step=0.2)
            xw, zw, xh, xe, zh, ze = consensus_walls(slices, snap=0.06)
            all_w = [p for s in slices for p in s['w']]
            boundary = build_boundary(xw, zw, all_w, min_wall_len=0.4)
            openings = detect_openings(mesh, boundary, fy, cy, min_opening=0.5)
            rooms_data = decompose_rooms(
                mesh, xw, zw, boundary, openings, fy, cy,
                min_opening=0.5, min_room_area=2.0, max_door_width=1.5,
            )
            furniture_v4 = extract_furniture(mesh, fy, cy, boundary, rooms_data['rooms'])
            furniture_v5 = extract_furniture_v5(mesh, fy, cy, boundary, rooms_data['rooms'])
            rng = np.random.RandomState(42)
            fp = ([all_w[i] for i in rng.choice(len(all_w), min(2000, len(all_w)), replace=False)]
                  if all_w else [])
            ap = np.array(fp) if fp else np.array([[0, 0]])
            sp = {s['label']: s['w'] for s in slices}
            source = 'scan'

        out = {
            "m": {"n": len(slices), "h": [s['height'] for s in slices] if slices else []},
            "xw": xw, "zw": zw, "boundary": boundary, "fp": fp, "sp": sp,
            "bounds": {"x": [float(ap[:, 0].min()), float(ap[:, 0].max())],
                       "z": [float(ap[:, 1].min()), float(ap[:, 1].max())]},
            "xh": xh, "zh": zh,
            "xhb": {"s": float(xe[0]), "d": 0.02, "n": len(xh)},
            "zhb": {"s": float(ze[0]), "d": 0.02, "n": len(zh)},
            "source": source,
            "rotation_angle": float(rotation_angle),
            "rotation_deg": round(float(np.degrees(rotation_angle)), 3),
            "floor_y": float(fy),
            "ceil_y": float(cy),
            "openings": openings,
            "rooms": rooms_data['rooms'],
            "interior_openings": rooms_data['interior_openings'],
            "doors": rooms_data['doors'],
            "furniture": furniture_v5,        # 기본 = v5
            "furniture_v4": furniture_v4,      # 비교용
            "furniture_v5": furniture_v5,
            "counts": {"v4": len(furniture_v4), "v5": len(furniture_v5)},
            "version": "v4+v5 furniture compare",
        }
        return jsonify(out)
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500
    finally:
        try: os.unlink(path)
        except OSError: pass


@app.route('/health')
def health():
    return 'ok'


if __name__ == '__main__':
    print("[furniture v5] GLB→plan+furniture(v4&v5) on http://localhost:5052")
    app.run(port=5052, debug=False)
