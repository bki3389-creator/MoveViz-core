# Architecture

## Primary data path

1. The iOS app captures a mesh or structured room result plus optional RGB
   keyframes and camera poses.
2. ingest_server.py stores the upload outside Git under data/scans.
3. services/floorplan extracts floor, boundary, wall, opening, room, and
   furniture data from the mesh.
4. modules/reconstruction can add RGB vertex color, vision-derived furniture,
   representative models, or USDZ conversion.
5. The React app renders the mesh and derived floor-plan JSON.

## On-device product path (PlanShot, 2026-08)

RoomPlan (iOS 17, LiDAR) → `PlanData.fromRoomPlan` (floor polygon, wall heights,
opening heights) → `FloorPlanView` drawing sheet → `PlanPDFExporter` / `BOQEngine` +
`BOQXLSXExporter` / `DXFExporter`. No server involved. See docs/PLANSHOT.md.
The mesh pipeline below remains the desktop/validation path.

## Core service

The active web API is services/floorplan/server_furniture_v5.py. Its structural
floor-plan path uses glb_to_floorplan_v4.py; the v5 designation refers primarily
to the furniture extractor. run_v4.py also applies furniture_postprocess.py, so
CLI and web outputs should be compared carefully when changing parameters.

## Experimental paths

- RoomPlan supplies semantic walls, openings, and furniture on supported devices.
- Non-LiDAR reconstruction uses keyframes and metric camera poses.
- The vectorizer converts uploaded 2D plan images into editable geometry.
- IFC export is an early proof of concept and does not yet model complete BIM
  openings, slabs, storeys, or furniture relationships.

## Storage boundary

Source control contains code and synthetic fixtures. Runtime meshes, images,
camera keyframes, generated floor plans, models, and dataset downloads belong in
data or another path configured with MOVEVIZ_SCANS_DIR.
