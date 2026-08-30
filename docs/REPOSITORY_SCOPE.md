# Repository scope

This repository was rebuilt from a 20 GB working directory using an explicit
source allowlist.

Included:

- Current iOS source snapshot
- Active floor-plan Python service and React UI
- Current ingest server changes
- Reconstruction, vision, vectorization, IFC, and validation source
- Small code-only prototypes and compact metric summaries

Excluded:

- The original 5 GB Git history and all nested Git metadata
- Raw scans, home photos, keyframes, floor-plan outputs, and user uploads
- ARKitScenes, ScanNet, SceneCAD, and derived large dataset files
- Python virtual environments, node_modules, Xcode builds, logs, and binaries
- Patent drafts, team-rights documents, consent forms, internal conversations,
  and meeting notes
- Hardcoded provider credentials and historical tunnel endpoints

The earlier MoveMate repositories were not duplicated because they already have
separate private remotes. Only links are retained in the root README.
