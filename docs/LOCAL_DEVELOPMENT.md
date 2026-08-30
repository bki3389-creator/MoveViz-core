# Local development

## Python

Create a virtual environment at the repository root and install the core
requirements. Use requirements-vision.txt only when running OWLv2, Open3D, or
USD conversion features.

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements-core.txt

Run the floor-plan service:

    python services/floorplan/server_furniture_v5.py

Run the iOS ingest service:

    python ingest_server.py

Environment variables:

- MOVEVIZ_SCANS_DIR: runtime upload/output directory
- MOVEVIZ_RECON_PYTHON: Python executable with optional reconstruction packages
- CHROME_BIN: Chrome or Chromium executable used for optional SVG screenshots
- FURN_TEMPLATES: set to 1 to enable representative furniture templates

## Web

    cd apps/web-floorplan
    cp .env.example .env
    npm ci
    npm run dev

Set VITE_API_BASE_URL when the floor-plan API is not at localhost:5052.

## iOS

Open apps/ios/MoveViz.xcodeproj or regenerate it with XcodeGen from project.yml.
Choose your own Apple development team before installing on a physical device.
In the app settings, enter the LAN URL of the Mac running ingest_server.py.

## Data

External validation datasets are deliberately absent. Evaluation scripts expect
a separately downloaded dataset root and still include some legacy workspace
path assumptions; treat experiments/validation as research tooling rather than
a turnkey benchmark.
