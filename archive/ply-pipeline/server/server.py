"""
MoveViz Processing Server
=========================
iPhone 앱에서 PLY 스캔 데이터를 받아 extract_floorplan.py로 처리하고
결과(평면도)를 반환하는 Flask 서버.

사용법:
    pip install flask flask-cors
    python server/server.py

엔드포인트:
    POST /upload   - PLY 파일 업로드 + 처리
    GET  /result/<id>/rooms.json      - 결과 JSON
    GET  /result/<id>/03_floorplan.png - 결과 이미지
    GET  /status   - 서버 상태 확인
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent  # project root
UPLOAD_DIR = BASE_DIR / "server" / "uploads"
EXTRACT_SCRIPT = BASE_DIR / "extract_floorplan.py"
PYTHON_EXE = sys.executable

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.route("/status", methods=["GET"])
def status():
    """서버 상태 확인"""
    return jsonify({
        "status": "ok",
        "server": "MoveViz Processing Server",
        "extract_script": str(EXTRACT_SCRIPT),
        "script_exists": EXTRACT_SCRIPT.exists(),
    })


@app.route("/upload", methods=["POST"])
def upload_scan():
    """PLY 파일 업로드 및 평면도 추출"""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Save uploaded file
    scan_id = f"scan_{int(time.time())}"
    scan_dir = UPLOAD_DIR / scan_id
    scan_dir.mkdir(parents=True, exist_ok=True)

    input_path = scan_dir / "scan.ply"
    file.save(str(input_path))
    file_size = input_path.stat().st_size

    print(f"[Upload] {scan_id}: {file_size:,} bytes")

    # Run extract_floorplan.py
    output_dir = scan_dir / "output"
    cmd = [
        PYTHON_EXE,
        str(EXTRACT_SCRIPT),
        "--input", str(input_path),
        "--output", str(output_dir),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        print(f"[Process] stdout:\n{result.stdout}")
        if result.returncode != 0:
            print(f"[Process] stderr:\n{result.stderr}")
            return jsonify({
                "status": "error",
                "scan_id": scan_id,
                "error": result.stderr[-500:] if result.stderr else "Unknown error",
            }), 500
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "error": "Processing timeout (120s)"}), 504

    # Read results
    rooms_path = output_dir / "rooms.json"
    stats_path = output_dir / "stats.json"

    response = {
        "status": "success",
        "scan_id": scan_id,
        "input_size_bytes": file_size,
    }

    if rooms_path.exists():
        with open(rooms_path, encoding="utf-8") as f:
            response["rooms"] = json.load(f)

    if stats_path.exists():
        with open(stats_path) as f:
            response["stats"] = json.load(f)

    response["files"] = {
        "floorplan": f"/result/{scan_id}/03_floorplan.png",
        "occupancy": f"/result/{scan_id}/01_occupancy_raw.png",
        "morphology": f"/result/{scan_id}/02_morphology.png",
        "rooms_json": f"/result/{scan_id}/rooms.json",
    }

    print(f"[Done] {scan_id}: {response.get('stats', {}).get('estimated_width_m', '?')}m x "
          f"{response.get('stats', {}).get('estimated_height_m', '?')}m")

    return jsonify(response)


@app.route("/result/<scan_id>/<filename>", methods=["GET"])
def get_result(scan_id, filename):
    """처리 결과 파일 다운로드"""
    filepath = UPLOAD_DIR / scan_id / "output" / filename
    if not filepath.exists():
        return jsonify({"error": "File not found"}), 404

    mimetype = "application/json" if filename.endswith(".json") else "image/png"
    return send_file(str(filepath), mimetype=mimetype)


if __name__ == "__main__":
    print("=" * 50)
    print("MoveViz Processing Server")
    print(f"  Upload dir: {UPLOAD_DIR}")
    print(f"  Script:     {EXTRACT_SCRIPT}")
    print("=" * 50)
    print()
    print("iPhone 앱에서 이 주소로 업로드하세요:")
    print()

    # Get local IP for display
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "localhost"

    print(f"  http://{local_ip}:8080/upload")
    print()

    app.run(host="0.0.0.0", port=8080, debug=True)
