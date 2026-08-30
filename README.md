# MoveViz Core

Private, curated source repository for the MoveViz spatial-processing stack.

MoveViz captures an indoor space, derives a floor plan and furniture inventory,
and prepares that information for visualization and moving-volume workflows.
This repository intentionally contains source code and small synthetic fixtures
only. Raw home scans, photos, external datasets, generated models, credentials,
legal documents, and the original large Git history are not included.

## Repository map

- apps/ios: current Swift/SwiftUI capture application
- apps/web-floorplan: React/Vite floor-plan viewer and uploader
- services/floorplan: GLB/mesh to floor plan and furniture pipeline
- ingest_server.py: local upload and processing server used by the iOS app
- modules/reconstruction: texture, vision, USDZ, and representative-model tools
- tools: floor-plan vectorization and IFC export experiments
- experiments/validation: evaluation scripts and compact metric outputs
- prototypes: growth and furniture-analysis prototypes
- archive/ply-pipeline: first-generation PLY pipeline, retained for reference
- docs: architecture, setup, research notes, and repository scope

## Quick start

Core Python environment:

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements-core.txt

Floor-plan API and web app:

    python services/floorplan/server_furniture_v5.py

    cd apps/web-floorplan
    npm ci
    npm run dev

The API listens on port 5052 and Vite normally uses port 5173.

Local iOS ingest service:

    python ingest_server.py

Runtime scan files are written under data/scans by default. Set
MOVEVIZ_SCANS_DIR to store them elsewhere.

Optional vision and reconstruction features require requirements-vision.txt.

## Current status

- The GLB floor-plan path is the most complete desktop pipeline.
- Furniture v5 improves recall but still produces meaningful false positives.
- RoomPlan, RGB vision, non-LiDAR reconstruction, vectorization, and IFC export
  remain experimental or partially integrated.
- The repository does not contain an independently verified production accuracy
  claim. See docs/research for the recorded validation caveats.

## Related private repositories

Earlier hackathon components remain in their original private repositories:

- https://github.com/bki3389-creator/MoveMate-ai-server
- https://github.com/bki3389-creator/MoveMate-client
- https://github.com/bki3389-creator/MoveMate-backend
- https://github.com/bki3389-creator/MoveMate-iOS
- https://github.com/bki3389-creator/MoveMate-web
- https://github.com/bki3389-creator/MoveViz-iOS

## Security and data policy

- Keep this repository private until patent, team ownership, and third-party
  licensing reviews are complete.
- Never commit API keys, tunnel URLs, raw uploads, home scans, keyframes, or
  third-party datasets.
- The furniture-analysis prototype calls a server proxy. Provider credentials
  must remain on that server and must never be exposed through Vite variables.
- A previously hardcoded Gemini key in the source workspace was intentionally
  excluded from this repository and should be revoked and replaced.

No open-source license is granted by this repository at this time.
