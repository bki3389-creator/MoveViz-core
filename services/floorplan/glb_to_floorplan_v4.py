#!/usr/bin/env python3
"""GLB -> Consensus Floor Plan Pipeline (v4 실험)

Changes vs original:
- Priority 1: PCA-style rotation alignment before extract_slices, inverse-rotate
  the final boundary so output orientation matches the original GLB.
- Priority 2: detect_openings now classifies each opening as
  door / window / lintel (보 있는 출입구) via a lateral × vertical
  occupancy grid along each boundary edge.
- Output JSON gains `rotation_angle` and `openings` fields.
"""
import argparse, json, sys
import numpy as np


def load_glb(path):
    import trimesh
    scene = trimesh.load(path)
    if isinstance(scene, trimesh.Scene):
        return trimesh.util.concatenate(list(scene.geometry.values()))
    return scene


def estimate_rotation_angle(mesh, wall_threshold=0.3):
    """Estimate rotation angle (radians) to align dominant walls with the X/Z axes.

    Take horizontal face normals (|n_y| < wall_threshold), fold their XZ-plane
    angles into [0, pi/2) — collapsing the 4 axis-aligned wall directions into one —
    and pick the area-weighted peak. Returned angle is in [-pi/4, pi/4]; rotating
    the mesh by this angle around +Y aligns the dominant walls.
    """
    fn = mesh.face_normals
    wall_mask = np.abs(fn[:, 1]) < wall_threshold
    if int(wall_mask.sum()) < 100:
        return 0.0

    nx = fn[wall_mask, 0]
    nz = fn[wall_mask, 2]
    try:
        areas = mesh.area_faces[wall_mask]
    except Exception:
        areas = np.ones(int(wall_mask.sum()))

    angles = np.arctan2(nz, nx)
    folded = np.mod(angles, np.pi / 2)

    n_bins = 90  # 1° resolution
    bins = np.linspace(0, np.pi / 2, n_bins + 1)
    hist, edges = np.histogram(folded, bins=bins, weights=areas)
    if hist.sum() <= 0:
        return 0.0

    peak_idx = int(np.argmax(hist))
    peak = float((edges[peak_idx] + edges[peak_idx + 1]) / 2)
    if peak > np.pi / 4:
        return peak - np.pi / 2
    return peak


def rotate_xz(points_xz, angle):
    """Rotate (x, z) points around origin matching trimesh.rotation_matrix(angle, [0,1,0])
    projected to XZ. Positive angle maps (1, 0) to (cos a, -sin a) in (x, z).
    """
    if len(points_xz) == 0:
        return list(points_xz)
    c = float(np.cos(angle))
    s = float(np.sin(angle))
    pts = np.asarray(points_xz, dtype=float)
    rx = pts[:, 0] * c + pts[:, 1] * s
    rz = -pts[:, 0] * s + pts[:, 1] * c
    return [[float(x), float(z)] for x, z in zip(rx, rz)]


def _point_in_polygon(point, polygon):
    """Ray-casting point-in-polygon test. `polygon` is a closed list ending with the
    first point repeated. Returns True for strictly-interior points.
    """
    x, z = float(point[0]), float(point[1])
    n = len(polygon) - 1
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, zi = polygon[i][0], polygon[i][1]
        xj, zj = polygon[j][0], polygon[j][1]
        if ((zi > z) != (zj > z)):
            denom = (zj - zi) if (zj - zi) != 0 else 1e-12
            x_cross = (xj - xi) * (z - zi) / denom + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def find_floor_ceiling(mesh):
    from scipy.signal import find_peaks
    fn = mesh.face_normals
    ct = mesh.triangles_center
    up_y = ct[fn[:, 1] > 0.85, 1]
    dn_y = ct[fn[:, 1] < -0.85, 1]

    if len(up_y) == 0:
        floor_y = float(mesh.bounds[0][1])
    else:
        bins = np.arange(up_y.min() - 0.1, up_y.max() + 0.1, 0.02)
        h, e = np.histogram(up_y, bins=bins)
        c = (e[:-1] + e[1:]) / 2
        min_h = max(2, int(len(mesh.faces) * 0.005))
        pk, _ = find_peaks(h, height=min_h, distance=10, prominence=max(1, min_h // 2))
        floor_y = float(c[pk[np.argmax(h[pk])]]) if len(pk) else float(np.median(up_y))

    if len(dn_y) > 0:
        bins_c = np.arange(dn_y.min() - 0.1, dn_y.max() + 0.1, 0.02)
        hc, ec = np.histogram(dn_y, bins=bins_c)
        cc = (ec[:-1] + ec[1:]) / 2
        min_hc = max(2, int(len(mesh.faces) * 0.003))
        pkc, _ = find_peaks(hc, height=min_hc, distance=10)
        ceil_y = float(cc[pkc[-1]]) if len(pkc) else float(np.median(dn_y))
    else:
        ceil_y = float(mesh.bounds[1][1])
    return floor_y, ceil_y


def extract_slices(mesh, floor_y, ceil_y, step=0.2):
    fn = mesh.face_normals
    ct = mesh.triangles_center
    n = max(1, int((ceil_y - floor_y) / step) + 1)
    slices = []
    for i in range(n):
        h = i * step
        y0 = floor_y + h
        y1 = y0 + step
        band = (ct[:, 1] >= y0) & (ct[:, 1] < y1)
        wall = band & (np.abs(fn[:, 1]) < 0.3)
        xm = wall & (np.abs(fn[:, 0]) > 0.7)
        zm = wall & (np.abs(fn[:, 2]) > 0.7)
        wc = ct[wall][:, [0, 2]]
        xw = ct[xm][:, [0, 2]]
        zw = ct[zm][:, [0, 2]]
        rng = np.random.RandomState(42 + i)
        ws = wc[rng.choice(len(wc), min(400, len(wc)), replace=False)].tolist() if len(wc) else []
        slices.append({
            'label': f'slice_{i:02d}_{h:.2f}m', 'height': round(h, 2),
            'w': ws,
            'x': xw.tolist() if len(xw) else [],
            'z': zw.tolist() if len(zw) else []
        })
    return slices


def consensus_walls(slices, snap=0.06):
    from scipy.signal import find_peaks

    all_x_pts = [p for s in slices for p in s['x']]
    all_z_pts = [p for s in slices for p in s['z']]

    if len(all_x_pts) == 0 and len(all_z_pts) == 0:
        return [], [], [], [0.0, 1.0], [], [0.0, 1.0]

    def find_lines(pts_list, main_idx, other_idx, axis):
        if len(pts_list) == 0:
            return [], [0], [0.0, 1.0]
        arr = np.array(pts_list)
        main = arr[:, main_idx]
        other = arr[:, other_idx]
        bins = np.arange(main.min() - 0.1, main.max() + 0.1, 0.02)
        if len(bins) < 3:
            return [], [0], [main.min(), main.max()]
        h, e = np.histogram(main, bins=bins)
        c = (e[:-1] + e[1:]) / 2

        total_pts = len(main)
        if total_pts < 500:
            min_height = max(2, int(total_pts * 0.03))
            min_prom = max(1, min_height // 3)
        else:
            min_height = 80 if axis == 'x' else 60
            min_prom = 40 if axis == 'x' else 30
        pk, _ = find_peaks(h, height=min_height, distance=5, prominence=min_prom)

        walls = []
        for p in pk:
            pos = float(c[p])
            near = np.abs(main - pos) < snap
            coords = np.sort(other[near])
            segs = []
            if len(coords) > 1:
                st = coords[0]
                pv = coords[0]
                for cv in coords[1:]:
                    if cv - pv > 0.3:
                        if pv - st >= 0.15:
                            segs.append([round(float(st), 2), round(float(pv), 2)])
                        st = cv
                    pv = cv
                if pv - st >= 0.15:
                    segs.append([round(float(st), 2), round(float(pv), 2)])
            elif len(coords) == 1:
                segs.append([round(float(coords[0]) - 0.1, 2), round(float(coords[0]) + 0.1, 2)])

            pres = 0
            for s in slices:
                pts = s['x'] if axis == 'x' else s['z']
                ix = 0 if axis == 'x' else 1
                if sum(1 for pt in pts if abs(pt[ix] - pos) < snap) > 0:
                    pres += 1
            span = sum(sg[1] - sg[0] for sg in segs)
            r = pres / max(1, len(slices))
            struct_thresh = 0.3 if total_pts < 500 else 0.5
            cls = 'structure' if r >= struct_thresh and span > 0.2 else ('built-in' if r >= 0.15 else 'noise')
            walls.append({
                'pos': round(pos, 2), 'segs': segs, 'presence': pres,
                'support': int(h[p]), 'span': round(span, 2), 'cls': cls
            })
        return walls, h.tolist(), e.tolist()

    xw, xh, xe = find_lines(all_x_pts, 0, 1, 'x')
    zw, zh, ze = find_lines(all_z_pts, 1, 0, 'z')
    return xw, zw, xh, xe, zh, ze


def _merge_short_edges(poly, min_len=0.3):
    pts = [list(p) for p in poly[:-1]]
    changed = True
    while changed and len(pts) > 4:
        changed = False
        n = len(pts)
        for i in range(n):
            p1 = pts[i]
            p2 = pts[(i + 1) % n]
            edge_len = abs(p2[0] - p1[0]) + abs(p2[1] - p1[1])
            if edge_len < min_len:
                p0 = pts[(i - 1) % n]
                if abs(p1[0] - p0[0]) > abs(p1[1] - p0[1]):
                    pts[(i - 1) % n][1] = p2[1]
                else:
                    pts[(i - 1) % n][0] = p2[0]
                j1, j2 = i, (i + 1) % n
                if j2 > j1:
                    del pts[j2]
                    del pts[j1]
                else:
                    del pts[j1]
                    del pts[j2]
                changed = True
                break
    n = len(pts)
    result = []
    for i in range(n):
        p0, p1, p2 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
        if not (p0[0] == p1[0] == p2[0] or p0[1] == p1[1] == p2[1]):
            result.append(p1)
    if result:
        result.append(result[0][:])
    return result or poly


def _trace_manhattan_contour(interior):
    """Trace outer Manhattan boundary of filled binary grid as (ix, iz) corner list."""
    nz, nx = interior.shape
    start_iz, start_ix = None, None
    for iz in range(nz):
        cols = np.where(interior[iz])[0]
        if len(cols):
            start_iz, start_ix = iz, int(cols[0])
            break
    if start_iz is None:
        return []

    def cell_ok(ix, iz):
        return 0 <= ix < nx and 0 <= iz < nz and interior[iz, ix]

    dirs = [(1, 0), (0, 1), (-1, 0), (0, -1)]
    cx, cz = start_ix, start_iz
    direction = 0
    corners = [(cx, cz)]
    for _ in range((nz + nx) * 8):
        left_dir = (direction - 1) % 4
        if direction == 0:
            al = (cx - 1, cz)
            ah = (cx, cz)
        elif direction == 1:
            al = (cx, cz)
            ah = (cx, cz - 1)
        elif direction == 2:
            al = (cx, cz - 1)
            ah = (cx - 1, cz - 1)
        else:
            al = (cx - 1, cz - 1)
            ah = (cx - 1, cz)

        if cell_ok(*al):
            direction = left_dir
        elif not cell_ok(*ah):
            direction = (direction + 1) % 4

        dx, dz = dirs[direction]
        cx += dx
        cz += dz
        if cx == corners[0][0] and cz == corners[0][1]:
            break
        corners.append((cx, cz))
    return corners


def build_boundary(x_walls, z_walls, all_points, min_wall_len=0.4):
    """Build closed Manhattan boundary.

    Key ideas:
    1. Dilate(8) → fill_holes → erode(8): closes window gaps (up to ~80cm) before filling.
    2. Outermost-from-center snapping: when multiple x-walls are equidistant, prefer the one
       farthest from the bounding-box center (= most likely to be a structural exterior wall).
    3. Median filter on row extents removes single-row noise spikes.
    """
    from scipy.ndimage import (binary_dilation, binary_erosion,
                               binary_fill_holes, label as ndi_label, median_filter)

    pts = np.array(all_points)
    if len(pts) < 10:
        return [[0, 0], [1, 0], [1, -1], [0, -1], [0, 0]]

    has_structure = any(w['cls'] == 'structure' for w in x_walls + z_walls)
    wall_filter = 'structure' if has_structure else 'built-in'

    # Percentile-based clip: removes far outliers without hard-clipping to structure walls
    p1x, p99x = np.percentile(pts[:, 0], 1), np.percentile(pts[:, 0], 99)
    p1z, p99z = np.percentile(pts[:, 1], 1), np.percentile(pts[:, 1], 99)
    spread = max(p99x - p1x, p99z - p1z)
    mc = max(0.8, spread * 0.12)
    mask = ((pts[:, 0] >= p1x - mc) & (pts[:, 0] <= p99x + mc) &
            (pts[:, 1] >= p1z - mc) & (pts[:, 1] <= p99z + mc))
    pts = pts[mask]
    if len(pts) < 5:
        return [[0, 0], [1, 0], [1, -1], [0, -1], [0, 0]]

    RES = 0.10
    PAD = 0.4
    x0 = float(pts[:, 0].min()) - PAD
    z0 = float(pts[:, 1].min()) - PAD
    x1 = float(pts[:, 0].max()) + PAD
    z1 = float(pts[:, 1].max()) + PAD
    nx = int((x1 - x0) / RES) + 2
    nz = int((z1 - z0) / RES) + 2

    occ = np.zeros((nz, nx), bool)
    xi = np.clip(((pts[:, 0] - x0) / RES).astype(int), 0, nx - 1)
    zi = np.clip(((pts[:, 1] - z0) / RES).astype(int), 0, nz - 1)
    occ[zi, xi] = True

    for w in x_walls:
        if w['cls'] not in ('structure', wall_filter) or w['span'] < min_wall_len:
            continue
        ix = int((w['pos'] - x0) / RES)
        for seg in w['segs']:
            iz0 = int((seg[0] - z0) / RES)
            iz1 = int((seg[1] - z0) / RES)
            for dix in range(-1, 2):
                col = ix + dix
                if 0 <= col < nx:
                    occ[max(0, iz0 - 1):min(nz, iz1 + 2), col] = True

    for w in z_walls:
        if w['cls'] not in ('structure', wall_filter) or w['span'] < min_wall_len:
            continue
        iz = int((w['pos'] - z0) / RES)
        for seg in w['segs']:
            ix0 = int((seg[0] - x0) / RES)
            ix1 = int((seg[1] - x0) / RES)
            for diz in range(-1, 2):
                row = iz + diz
                if 0 <= row < nz:
                    occ[row, max(0, ix0 - 1):min(nx, ix1 + 2)] = True

    # Step 1: Large dilation to bridge window gaps (windows ~60-120cm wide need ~6-8 cells)
    CLOSE = 8
    dilated = binary_dilation(occ, iterations=CLOSE)
    # Step 2: Fill interior (now works because window gaps are bridged)
    filled = binary_fill_holes(dilated)
    # Step 3: Erode back to approximately original size (removes the dilation expansion)
    filled = binary_erosion(filled, iterations=CLOSE)

    lbl, n = ndi_label(filled)
    if n == 0:
        # Fallback: try with smaller closing if erosion removed everything
        dilated2 = binary_dilation(occ, iterations=4)
        filled = binary_fill_holes(dilated2)
        lbl, n = ndi_label(filled)
        if n == 0:
            return [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]
    best = 1 + int(np.argmax([np.sum(lbl == i) for i in range(1, n + 1)]))
    interior = (lbl == best)

    # Raw row extents
    row_map = {}
    for iz in range(nz):
        row = interior[iz]
        if row.any():
            row_map[iz] = (int(np.argmax(row)), int(len(row) - np.argmax(row[::-1]) - 1))

    if not row_map:
        return [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]

    # Build segment lookup: xwall_segs[pos] = list of (z_lo, z_hi) ranges
    xwall_segs = {}
    for w in x_walls:
        if w['cls'] not in ('structure', wall_filter) or w['span'] < min_wall_len:
            continue
        pos = round(w['pos'], 2)
        xwall_segs[pos] = [(s[0], s[1]) for s in w['segs']]

    # Bounding box center — outermost wall from center = structural exterior wall
    center_x = (x0 + x1) / 2
    seg_tol = CLOSE * RES + 0.15  # tolerance accounts for dilation + erosion shift

    def snap_x_at_z(grid_ix, z_world, snap_tol=0.65, prefer_outer=True, outer_dir=None):
        """Snap grid column to nearest structure X wall.

        prefer_outer: when multiple candidates exist, prefer the wall farthest from
        the bounding-box center (= most likely exterior structural wall).
        outer_dir: +1 = prefer rightmost (hi side), -1 = prefer leftmost (lo side).
        """
        x_world = x0 + grid_ix * RES
        cands = []
        for pos, segs in xwall_segs.items():
            dist = abs(pos - x_world)
            if dist > snap_tol:
                continue
            seg_active = any(s[0] - seg_tol <= z_world <= s[1] + seg_tol for s in segs)
            # Distance from center: more negative = farther left, more positive = farther right
            dist_from_center = pos - center_x
            # outer_score: for hi side (+1) prefer large x; for lo side (-1) prefer small x
            outer_score = -outer_dir * dist_from_center if outer_dir else 0
            cands.append((dist, not seg_active, outer_score, pos))
        if not cands:
            return grid_ix
        cands.sort()  # sort: by distance first, then seg_active, then outer
        return int(round((cands[0][3] - x0) / RES))

    iz_min = min(row_map)
    iz_max = max(row_map)
    iz_range = range(iz_min, iz_max + 1)

    hi_raw = np.array([row_map[iz][1] if iz in row_map else -1 for iz in iz_range])
    lo_raw = np.array([row_map[iz][0] if iz in row_map else nx  for iz in iz_range])
    valid = hi_raw >= 0

    hi_snapped = hi_raw.copy()
    lo_snapped = lo_raw.copy()
    for k, iz in enumerate(iz_range):
        if not valid[k]:
            continue
        z_world = z0 + iz * RES
        # hi = right side → prefer outermost rightward (+1); lo = left side → prefer outermost leftward (-1)
        hi_snapped[k] = snap_x_at_z(hi_raw[k], z_world, outer_dir=+1) - 1
        lo_snapped[k] = snap_x_at_z(lo_raw[k], z_world, outer_dir=-1)

    # Size=3 median: removes single-row spikes without smoothing real transitions
    if valid.any():
        hi_snapped = median_filter(hi_snapped.astype(float), size=3).astype(int)
        lo_snapped = median_filter(lo_snapped.astype(float), size=3).astype(int)

    smooth_map = {iz_min + k: (int(lo_snapped[k]), int(hi_snapped[k]))
                  for k in range(len(hi_snapped)) if valid[k]}

    def rx(ix): return round(x0 + ix * RES, 2)
    def rz(iz): return round(z0 + iz * RES, 2)

    right = [[rx(smooth_map[iz_min][1] + 1), rz(iz_min)]]
    prev_hi = smooth_map[iz_min][1]
    for iz in range(iz_min + 1, iz_max + 1):
        if iz not in smooth_map:
            continue
        hi = smooth_map[iz][1]
        if hi != prev_hi:
            right.append([rx(prev_hi + 1), rz(iz)])
            right.append([rx(hi + 1), rz(iz)])
            prev_hi = hi
    right.append([rx(smooth_map[iz_max][1] + 1), rz(iz_max + 1)])

    left = [[rx(smooth_map[iz_max][0]), rz(iz_max + 1)]]
    prev_lo = smooth_map[iz_max][0]
    for iz in range(iz_max - 1, iz_min - 1, -1):
        if iz not in smooth_map:
            continue
        lo = smooth_map[iz][0]
        if lo != prev_lo:
            left.append([rx(prev_lo), rz(iz + 1)])
            left.append([rx(lo), rz(iz + 1)])
            prev_lo = lo
    left.append([rx(smooth_map[iz_min][0]), rz(iz_min)])

    poly = right + left
    poly.append(poly[0][:])

    def remove_collinear(pts_list):
        n = len(pts_list) - 1
        result = []
        for i in range(n):
            p0, p1, p2 = pts_list[(i - 1) % n], pts_list[i], pts_list[(i + 1) % n]
            if not (p0[0] == p1[0] == p2[0] or p0[1] == p1[1] == p2[1]):
                result.append(p1)
        if result:
            result.append(result[0][:])
        return result

    poly = remove_collinear(poly)
    if not poly:
        return [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]

    # Snap Z coordinates to nearest structure Z wall (corrects dilation-shifted Z transitions)
    sw_z = sorted(set(round(w['pos'], 2) for w in z_walls if w['cls'] in ('structure', wall_filter)))

    def snap_z(val, tol=0.55):
        if not sw_z:
            return val
        best = min(sw_z, key=lambda v: abs(v - val))
        return best if abs(best - val) <= tol else val

    snapped = [[p[0], snap_z(p[1])] for p in poly]
    result = [snapped[0]]
    for p in snapped[1:]:
        if p != result[-1]:
            result.append(p)
    if result[0] != result[-1]:
        result.append(result[0][:])

    result = remove_collinear(result)
    if not result:
        return poly
    result = _merge_short_edges(result, min_len=0.3)
    return result


def detect_openings(mesh, boundary, floor_y, ceil_y, min_opening=0.5):
    """Detect & classify openings along Manhattan boundary edges.

    Builds a lateral × vertical occupancy grid along each edge and labels each
    lateral cell as one of:
      - 'door'   : entire vertical span empty (full floor-to-ceiling opening)
      - 'window' : top + bottom occupied, middle empty (sill + lintel, glass between)
      - 'lintel' : top only occupied — 보 있는 출입구 (doorway with header beam)
      - 'wall'   : all bands occupied (solid wall, not reported)

    Consecutive same-label lateral cells are merged into one opening if the run
    is at least `min_opening` wide.

    Returns list of {type, wall_dir, wall_pos, span, width, center}.
    """
    fn = mesh.face_normals
    ct = mesh.triangles_center
    height = float(ceil_y - floor_y)

    wall_mask = (np.abs(fn[:, 1]) < 0.4) & \
                (ct[:, 1] >= floor_y - 0.3) & \
                (ct[:, 1] <= ceil_y + 0.3)

    BIN = 0.10        # 10cm lateral bin width
    TOL = 0.35        # search radius perpendicular to wall
    N_Y_BANDS = 5     # bands 0=floor sill, 1..3=middle (glass region), 4=lintel
    OCC_MIN = 3       # min faces per (lateral, y_band) cell to count as occupied
    openings = []

    n_pts = len(boundary) - 1
    for i in range(n_pts):
        p1, p2 = boundary[i], boundary[i + 1]
        dx = p2[0] - p1[0]
        dz = p2[1] - p1[1]
        edge_len = (dx ** 2 + dz ** 2) ** 0.5
        if edge_len < min_opening:
            continue

        if abs(dx) < 0.01:  # X-wall: fixed X, runs along Z
            wall_pos = (p1[0] + p2[0]) / 2
            z_lo, z_hi = sorted([p1[1], p2[1]])
            near = wall_mask & (np.abs(fn[:, 0]) > 0.4) & \
                   (np.abs(ct[:, 0] - wall_pos) < TOL) & \
                   (ct[:, 2] >= z_lo - 0.1) & (ct[:, 2] <= z_hi + 0.1)
            lat = ct[near, 2]
            wdir, lo, hi = 'x', z_lo, z_hi
        elif abs(dz) < 0.01:  # Z-wall
            wall_pos = (p1[1] + p2[1]) / 2
            x_lo, x_hi = sorted([p1[0], p2[0]])
            near = wall_mask & (np.abs(fn[:, 2]) > 0.4) & \
                   (np.abs(ct[:, 2] - wall_pos) < TOL) & \
                   (ct[:, 0] >= x_lo - 0.1) & (ct[:, 0] <= x_hi + 0.1)
            lat = ct[near, 0]
            wdir, lo, hi = 'z', x_lo, x_hi
        else:
            continue

        y_vals = ct[near, 1]
        span = max(hi - lo, 1e-6)
        n_lat = max(3, int(span / BIN))

        # Build 2D occupancy [n_lat × N_Y_BANDS] of face counts
        H = np.zeros((n_lat, N_Y_BANDS), dtype=int)
        if len(lat):
            li = np.clip(((lat - lo) / span * n_lat).astype(int), 0, n_lat - 1)
            yi = np.clip(((y_vals - floor_y) / max(height, 1e-6) * N_Y_BANDS).astype(int),
                         0, N_Y_BANDS - 1)
            for a, b in zip(li, yi):
                H[a, b] += 1

        labels = []
        for j in range(n_lat):
            occ = H[j] >= OCC_MIN
            bottom = bool(occ[0])
            top = bool(occ[-1])
            middle_any = bool(occ[1:-1].any())
            middle_all = bool(occ[1:-1].all())

            if bottom and top and middle_all:
                labels.append('wall')
            elif not occ.any():
                labels.append('door')
            elif bottom and top and not middle_any:
                labels.append('window')
            elif top and not bottom and not middle_any:
                labels.append('lintel')
            else:
                labels.append('window')  # partial / ambiguous → window

        # Merge consecutive same-label runs into reported openings
        lat_edges = np.linspace(lo, hi, n_lat + 1)
        j = 0
        while j < n_lat:
            lbl = labels[j]
            if lbl == 'wall':
                j += 1
                continue
            k = j
            while k < n_lat and labels[k] == lbl:
                k += 1
            run_lo = float(lat_edges[j])
            run_hi = float(lat_edges[k])
            run_width = run_hi - run_lo
            if run_width >= min_opening:
                mid_lat = (run_lo + run_hi) / 2
                if wdir == 'x':
                    center = [round(float(wall_pos), 2), round(mid_lat, 2)]
                else:
                    center = [round(mid_lat, 2), round(float(wall_pos), 2)]
                openings.append({
                    'type': lbl,
                    'wall_dir': wdir,
                    'wall_pos': round(float(wall_pos), 2),
                    'span': [round(run_lo, 2), round(run_hi, 2)],
                    'width': round(run_width, 2),
                    'center': center,
                })
            j = k

    return openings


def _detect_opening_on_segment(mesh, wall_dir, wall_pos, seg_lo, seg_hi,
                                floor_y, ceil_y, min_opening=0.5):
    """Same Y-profile classification as detect_openings, but for a single wall
    segment (used for INTERIOR partition walls during room decomposition).
    """
    fn = mesh.face_normals
    ct = mesh.triangles_center
    height = float(ceil_y - floor_y)

    wall_mask = (np.abs(fn[:, 1]) < 0.4) & \
                (ct[:, 1] >= floor_y - 0.3) & \
                (ct[:, 1] <= ceil_y + 0.3)

    BIN = 0.10
    TOL = 0.35
    N_Y_BANDS = 5
    OCC_MIN = 3

    if wall_dir == 'x':
        near = wall_mask & (np.abs(fn[:, 0]) > 0.4) & \
               (np.abs(ct[:, 0] - wall_pos) < TOL) & \
               (ct[:, 2] >= seg_lo - 0.1) & (ct[:, 2] <= seg_hi + 0.1)
        lat = ct[near, 2]
    else:
        near = wall_mask & (np.abs(fn[:, 2]) > 0.4) & \
               (np.abs(ct[:, 2] - wall_pos) < TOL) & \
               (ct[:, 0] >= seg_lo - 0.1) & (ct[:, 0] <= seg_hi + 0.1)
        lat = ct[near, 0]
    y_vals = ct[near, 1]

    span = max(seg_hi - seg_lo, 1e-6)
    n_lat = max(3, int(span / BIN))
    H = np.zeros((n_lat, N_Y_BANDS), dtype=int)
    if len(lat):
        li = np.clip(((lat - seg_lo) / span * n_lat).astype(int), 0, n_lat - 1)
        yi = np.clip(((y_vals - floor_y) / max(height, 1e-6) * N_Y_BANDS).astype(int),
                     0, N_Y_BANDS - 1)
        for a, b in zip(li, yi):
            H[a, b] += 1

    labels = []
    for j in range(n_lat):
        occ = H[j] >= OCC_MIN
        bottom = bool(occ[0])
        top = bool(occ[-1])
        middle_any = bool(occ[1:-1].any())
        middle_all = bool(occ[1:-1].all())
        if bottom and top and middle_all:
            labels.append('wall')
        elif not occ.any():
            labels.append('door')
        elif bottom and top and not middle_any:
            labels.append('window')
        elif top and not bottom and not middle_any:
            labels.append('lintel')
        else:
            labels.append('window')

    lat_edges = np.linspace(seg_lo, seg_hi, n_lat + 1)
    openings = []
    j = 0
    while j < n_lat:
        lbl = labels[j]
        if lbl == 'wall':
            j += 1
            continue
        k = j
        while k < n_lat and labels[k] == lbl:
            k += 1
        run_lo = float(lat_edges[j])
        run_hi = float(lat_edges[k])
        run_width = run_hi - run_lo
        if run_width >= min_opening:
            mid_lat = (run_lo + run_hi) / 2
            if wall_dir == 'x':
                center = [round(float(wall_pos), 2), round(mid_lat, 2)]
            else:
                center = [round(mid_lat, 2), round(float(wall_pos), 2)]
            openings.append({
                'type': lbl,
                'wall_dir': wall_dir,
                'wall_pos': round(float(wall_pos), 2),
                'span': [round(run_lo, 2), round(run_hi, 2)],
                'width': round(run_width, 2),
                'center': center,
            })
        j = k
    return openings


def _identify_interior_walls(xw, zw, boundary, snap_tol=0.35, min_dist_from_boundary=0.5):
    """Split structural walls into interior partitions (not on boundary) vs others.

    Rejection rules (in order):
      1) Wall's `pos` is within `snap_tol` of a boundary edge with matching orientation
         (single physical wall often shows TWO consensus peaks ~wall thickness apart;
         this filters out the "inner face" of a boundary wall.)
      2) Every segment midpoint is closer than `min_dist_from_boundary` to ANY boundary
         edge (regardless of orientation) — i.e. the wall hugs the outline.
      3) No segment midpoint is strictly inside the polygon.

    A wall passes only if at least one segment midpoint is inside the polygon AND
    that midpoint is far enough from every boundary edge.
    """
    # Boundary edges grouped by orientation
    boundary_x_pos = []   # X coord of vertical boundary edges
    boundary_z_pos = []   # Z coord of horizontal boundary edges
    boundary_edges_x = [] # (x_const, z_lo, z_hi) for vertical edges
    boundary_edges_z = [] # (z_const, x_lo, x_hi) for horizontal edges
    for i in range(len(boundary) - 1):
        p1, p2 = boundary[i], boundary[i + 1]
        if abs(p2[0] - p1[0]) < 0.01:
            x = (p1[0] + p2[0]) / 2
            boundary_x_pos.append(x)
            boundary_edges_x.append((x, min(p1[1], p2[1]), max(p1[1], p2[1])))
        if abs(p2[1] - p1[1]) < 0.01:
            z = (p1[1] + p2[1]) / 2
            boundary_z_pos.append(z)
            boundary_edges_z.append((z, min(p1[0], p2[0]), max(p1[0], p2[0])))

    def dist_to_boundary(px, pz):
        d_min = float('inf')
        for x_const, z_lo, z_hi in boundary_edges_x:
            z_clamp = max(z_lo, min(z_hi, pz))
            d = ((px - x_const) ** 2 + (pz - z_clamp) ** 2) ** 0.5
            d_min = min(d_min, d)
        for z_const, x_lo, x_hi in boundary_edges_z:
            x_clamp = max(x_lo, min(x_hi, px))
            d = ((px - x_clamp) ** 2 + (pz - z_const) ** 2) ** 0.5
            d_min = min(d_min, d)
        return d_min

    def is_interior_wall(pos, segs, axis):
        # axis: 'x' if wall is a vertical line at fixed X (so pos compares to boundary_x_pos)
        same_axis_pos = boundary_x_pos if axis == 'x' else boundary_z_pos
        if any(abs(bp - pos) < snap_tol for bp in same_axis_pos):
            return False
        for seg in segs:
            seg_mid = (seg[0] + seg[1]) / 2
            if axis == 'x':
                p = (pos, seg_mid)
            else:
                p = (seg_mid, pos)
            if not _point_in_polygon(list(p), boundary):
                continue
            if dist_to_boundary(p[0], p[1]) >= min_dist_from_boundary:
                return True
        return False

    interior_xw = [w for w in xw
                   if w.get('cls') == 'structure'
                   and is_interior_wall(w['pos'], w['segs'], 'x')]
    interior_zw = [w for w in zw
                   if w.get('cls') == 'structure'
                   and is_interior_wall(w['pos'], w['segs'], 'z')]
    # Merge walls that are within `cluster_tol` of each other along the perpendicular
    # axis — these are usually the two faces of one thick physical wall.
    return _cluster_walls(interior_xw), _cluster_walls(interior_zw)


def _cluster_walls(walls, cluster_tol=0.25):
    """Merge walls whose `pos` values are within `cluster_tol` into single
    representatives at the average position with combined segs."""
    if not walls:
        return []
    walls_sorted = sorted(walls, key=lambda w: w['pos'])
    clusters = [[walls_sorted[0]]]
    for w in walls_sorted[1:]:
        if abs(w['pos'] - clusters[-1][-1]['pos']) <= cluster_tol:
            clusters[-1].append(w)
        else:
            clusters.append([w])
    merged = []
    for grp in clusters:
        if len(grp) == 1:
            merged.append(grp[0])
            continue
        # average pos weighted by presence (more reliable peaks count more)
        weights = [max(1, w.get('presence', 1)) for w in grp]
        avg_pos = sum(w['pos'] * wt for w, wt in zip(grp, weights)) / sum(weights)
        all_segs = []
        for w in grp:
            all_segs.extend(w['segs'])
        # merge overlapping/adjacent segs
        all_segs.sort()
        merged_segs = [list(all_segs[0])]
        for lo, hi in all_segs[1:]:
            if lo <= merged_segs[-1][1] + 0.05:
                merged_segs[-1][1] = max(merged_segs[-1][1], hi)
            else:
                merged_segs.append([lo, hi])
        merged.append({
            'pos': round(float(avg_pos), 2),
            'segs': [[round(s[0], 2), round(s[1], 2)] for s in merged_segs],
            'presence': max(w.get('presence', 0) for w in grp),
            'support': sum(w.get('support', 0) for w in grp),
            'span': sum(s[1] - s[0] for s in merged_segs),
            'cls': 'structure',
            '_merged_from': len(grp),
        })
    return merged


def decompose_rooms(mesh, xw, zw, boundary, openings_boundary,
                    floor_y, ceil_y, min_opening=0.5, res=0.10, min_room_area=2.0,
                    max_door_width=1.5):
    """Subdivide the boundary polygon into rooms using interior partition walls
    + detected doors. Returns {rooms, interior_openings, doors}.

    Doors connect two rooms (or one room + the exterior, encoded as room_id = -1).

    `max_door_width` is critical: only "door" openings narrower than this are
    treated as actual passages between rooms during room decomposition. Wider
    gaps are almost always LiDAR coverage gaps in long walls, not real passages —
    treating them as walls preserves the room split.
    """
    from scipy.ndimage import label as ndi_label, binary_fill_holes

    interior_xw, interior_zw = _identify_interior_walls(xw, zw, boundary)

    # 1) Detect openings on interior walls. Treat each wall as ONE continuous span
    #    from its first seg start to last seg end — gaps BETWEEN segments are real
    #    openings (LiDAR captured wall on one side of the gap and the other, but
    #    nothing in between = passage/door). Scanning per-segment would miss those.
    def _wall_full_span(segs):
        lo = min(s[0] for s in segs)
        hi = max(s[1] for s in segs)
        return lo, hi

    interior_openings = []
    interior_wall_spans = []  # (wall_dir, pos, lo, hi) — used for raster burn
    for w in interior_xw:
        lo, hi = _wall_full_span(w['segs'])
        interior_wall_spans.append(('x', w['pos'], lo, hi))
        interior_openings.extend(_detect_opening_on_segment(
            mesh, 'x', w['pos'], lo, hi, floor_y, ceil_y, min_opening
        ))
    for w in interior_zw:
        lo, hi = _wall_full_span(w['segs'])
        interior_wall_spans.append(('z', w['pos'], lo, hi))
        interior_openings.extend(_detect_opening_on_segment(
            mesh, 'z', w['pos'], lo, hi, floor_y, ceil_y, min_opening
        ))

    # 2) Rasterize boundary, fill interior, burn partition walls, carve doors
    pts = np.array(boundary[:-1])
    pad = 0.5
    x0 = float(pts[:, 0].min()) - pad
    z0 = float(pts[:, 1].min()) - pad
    x1 = float(pts[:, 0].max()) + pad
    z1 = float(pts[:, 1].max()) + pad
    nx = int((x1 - x0) / res) + 2
    nz = int((z1 - z0) / res) + 2

    def world_to_cell(wx, wz):
        return int(round((wx - x0) / res)), int(round((wz - z0) / res))

    def draw_line(mask, p1, p2):
        ix1, iz1 = world_to_cell(p1[0], p1[1])
        ix2, iz2 = world_to_cell(p2[0], p2[1])
        n_steps = max(abs(ix2 - ix1), abs(iz2 - iz1)) + 1
        for s in range(n_steps):
            t = s / max(1, n_steps - 1)
            ix = int(round(ix1 + t * (ix2 - ix1)))
            iz = int(round(iz1 + t * (iz2 - iz1)))
            if 0 <= ix < nx and 0 <= iz < nz:
                mask[iz, ix] = True

    boundary_mask = np.zeros((nz, nx), dtype=bool)
    for i in range(len(boundary) - 1):
        draw_line(boundary_mask, boundary[i], boundary[i + 1])

    filled = binary_fill_holes(boundary_mask)
    interior = filled & ~boundary_mask  # walkable cells

    def burn_segment(mask, wall_dir, wall_pos, seg_lo, seg_hi, value):
        if wall_dir == 'x':
            ix = int(round((wall_pos - x0) / res))
            iz_lo = int(round((seg_lo - z0) / res))
            iz_hi = int(round((seg_hi - z0) / res))
            for iz in range(max(0, iz_lo), min(nz, iz_hi + 1)):
                if 0 <= ix < nx:
                    mask[iz, ix] = value
        else:
            iz = int(round((wall_pos - z0) / res))
            ix_lo = int(round((seg_lo - x0) / res))
            ix_hi = int(round((seg_hi - x0) / res))
            for ix in range(max(0, ix_lo), min(nx, ix_hi + 1)):
                if 0 <= iz < nz:
                    mask[iz, ix] = value

    # Burn each interior wall's FULL span (lo..hi across all segs) so a wall with
    # detected door gaps still forms a solid barrier before we re-carve the doors.
    for wall_dir, pos, lo, hi in interior_wall_spans:
        burn_segment(interior, wall_dir, pos, lo, hi, value=False)

    # Carve passages for door + lintel (both allow movement between rooms)
    def carve_opening(mask, wall_dir, wall_pos, span_lo, span_hi):
        # widen the opening perpendicular to the wall by ±1 cell so connected
        # components can pass through
        if wall_dir == 'x':
            ix_base = int(round((wall_pos - x0) / res))
            iz_lo = int(round((span_lo - z0) / res))
            iz_hi = int(round((span_hi - z0) / res))
            for dix in range(-1, 2):
                ix = ix_base + dix
                if 0 <= ix < nx:
                    for iz in range(max(0, iz_lo), min(nz, iz_hi + 1)):
                        mask[iz, ix] = True
        else:
            iz_base = int(round((wall_pos - z0) / res))
            ix_lo = int(round((span_lo - x0) / res))
            ix_hi = int(round((span_hi - x0) / res))
            for diz in range(-1, 2):
                iz = iz_base + diz
                if 0 <= iz < nz:
                    for ix in range(max(0, ix_lo), min(nx, ix_hi + 1)):
                        mask[iz, ix] = True

    for op in interior_openings:
        if op['type'] not in ('door', 'lintel'):
            continue
        if op['width'] > max_door_width:
            continue   # too wide — likely a LiDAR coverage gap, not a real door
        carve_opening(interior, op['wall_dir'], op['wall_pos'],
                      op['span'][0], op['span'][1])

    # 3) Connected components → rooms
    labeled, n_cc = ndi_label(interior)

    raw_rooms = []
    for cc_id in range(1, n_cc + 1):
        cc_mask = (labeled == cc_id)
        cell_count = int(cc_mask.sum())
        area = cell_count * (res ** 2)
        if area < min_room_area:
            continue
        rows, cols = np.where(cc_mask)
        ix_lo, ix_hi = int(cols.min()), int(cols.max())
        iz_lo, iz_hi = int(rows.min()), int(rows.max())
        bbox = [
            round(float(x0 + ix_lo * res), 2),
            round(float(z0 + iz_lo * res), 2),
            round(float(x0 + (ix_hi + 1) * res), 2),
            round(float(z0 + (iz_hi + 1) * res), 2),
        ]
        cx = float(cols.mean() * res + x0)
        cz = float(rows.mean() * res + z0)
        try:
            corners_idx = _trace_manhattan_contour(cc_mask)
            poly_room = [[round(float(x0 + ci * res), 2),
                          round(float(z0 + zi * res), 2)] for ci, zi in corners_idx]
            if poly_room and poly_room[0] != poly_room[-1]:
                poly_room.append(poly_room[0][:])
        except Exception:
            poly_room = []
        raw_rooms.append({
            '_cc_id': cc_id,
            'polygon': poly_room,
            'bbox': bbox,
            'area_m2': round(area, 2),
            'center': [round(cx, 2), round(cz, 2)],
        })

    raw_rooms.sort(key=lambda r: -r['area_m2'])
    rooms = []
    cc_to_room = {}
    for new_id, r in enumerate(raw_rooms):
        cc_to_room[r['_cc_id']] = new_id
        r_out = {'id': new_id}
        r_out.update({k: v for k, v in r.items() if k != '_cc_id'})
        rooms.append(r_out)

    # 4) For each door (boundary or interior), find adjacent rooms by sampling
    #    cells a few steps to either side of the opening center.
    def adjacent_rooms(center, wall_dir, search=3):
        cx, cz = world_to_cell(center[0], center[1])
        sides = [(-1, 0), (1, 0)] if wall_dir == 'x' else [(0, -1), (0, 1)]
        found = []
        for sign_dx, sign_dz in sides:
            side_rooms = set()
            for step in range(1, search + 1):
                for lateral in range(-1, 2):
                    if wall_dir == 'x':
                        tix = cx + sign_dx * step
                        tiz = cz + lateral
                    else:
                        tix = cx + lateral
                        tiz = cz + sign_dz * step
                    if 0 <= tix < nx and 0 <= tiz < nz:
                        lbl = int(labeled[tiz, tix])
                        if lbl > 0 and lbl in cc_to_room:
                            side_rooms.add(cc_to_room[lbl])
                if side_rooms:
                    break  # got something on this side
            found.append(sorted(side_rooms))
        # found = [side_a_rooms_list, side_b_rooms_list]
        # Take one from each side if available, else mark exterior
        room_a = found[0][0] if found[0] else -1
        room_b = found[1][0] if found[1] else -1
        return sorted([room_a, room_b])

    doors = []
    next_id = 0

    def add_door(op, source):
        nonlocal next_id
        adj = adjacent_rooms(op['center'], op['wall_dir'])
        doors.append({
            'id': next_id,
            'rooms': adj,                 # [-1] means exterior
            'wall_dir': op['wall_dir'],
            'wall_pos': op['wall_pos'],
            'span': op['span'],
            'center': op['center'],
            'type': op['type'],
            'source': source,
        })
        next_id += 1

    for op in openings_boundary:
        if op['type'] in ('door', 'lintel'):
            add_door(op, 'boundary')
    for op in interior_openings:
        if op['type'] in ('door', 'lintel'):
            add_door(op, 'interior')

    return {
        'rooms': rooms,
        'interior_openings': interior_openings,
        'doors': doors,
    }


def extract_cad_plan(mesh, min_wall_len=0.3):
    """Extract floor plan from CAD/Rhino GLB."""
    from scipy.ndimage import binary_fill_holes, label as ndi_label, binary_dilation, binary_erosion

    verts = mesh.vertices
    fn = mesh.face_normals
    faces = mesh.faces

    floor_y = float(verts[:, 1].min())
    ceil_y = float(verts[:, 1].max())
    height = ceil_y - floor_y
    floor_tol = max(0.05, height * 0.05)

    print(f"  CAD mode: Floor Y: {floor_y:.3f}, Ceiling Y: {ceil_y:.3f}, Height: {height:.2f}m")

    wall_mask = np.abs(fn[:, 1]) < 0.3
    wall_faces = faces[wall_mask]

    pts2d = []
    for face in wall_faces:
        fv = verts[face]
        base = fv[fv[:, 1] <= floor_y + floor_tol]
        if len(base) >= 2:
            pts2d.extend(base[:, [0, 2]].tolist())

    if len(pts2d) < 4:
        base_all = verts[verts[:, 1] <= floor_y + floor_tol]
        pts2d = base_all[:, [0, 2]].tolist()

    pts2d = np.array(pts2d)
    print(f"  {len(pts2d)} floor-level wall points")

    segments = []
    for face in wall_faces:
        fv = verts[face]
        base_verts = fv[fv[:, 1] <= floor_y + floor_tol]
        if len(base_verts) >= 2:
            bv = base_verts[:, [0, 2]]
            if len(bv) > 2:
                idx = np.lexsort((bv[:, 1], bv[:, 0]))
                bv = bv[[idx[0], idx[-1]]]
            segments.append((bv[0], bv[1]))

    RES = 0.05
    PAD = 0.3
    x0 = float(pts2d[:, 0].min()) - PAD
    z0 = float(pts2d[:, 1].min()) - PAD
    nx = int((pts2d[:, 0].max() - x0 + PAD) / RES) + 3
    nz = int((pts2d[:, 1].max() - z0 + PAD) / RES) + 3

    occ = np.zeros((nz, nx), bool)

    def draw_line(occ, x0g, z0g, x1g, z1g):
        x0g, z0g, x1g, z1g = int(x0g), int(z0g), int(x1g), int(z1g)
        dx, dz = abs(x1g - x0g), abs(z1g - z0g)
        sx = 1 if x1g > x0g else -1
        sz = 1 if z1g > z0g else -1
        err = dx - dz
        while True:
            if 0 <= z0g < occ.shape[0] and 0 <= x0g < occ.shape[1]:
                occ[z0g, x0g] = True
            if x0g == x1g and z0g == z1g:
                break
            e2 = 2 * err
            if e2 > -dz:
                err -= dz
                x0g += sx
            if e2 < dx:
                err += dx
                z0g += sz

    for (p1, p2) in segments:
        ix1 = int((p1[0] - x0) / RES)
        iz1 = int((p1[1] - z0) / RES)
        ix2 = int((p2[0] - x0) / RES)
        iz2 = int((p2[1] - z0) / RES)
        draw_line(occ, ix1, iz1, ix2, iz2)

    xi = np.clip(((pts2d[:, 0] - x0) / RES).astype(int), 0, nx - 1)
    zi = np.clip(((pts2d[:, 1] - z0) / RES).astype(int), 0, nz - 1)
    occ[zi, xi] = True

    occ = binary_dilation(occ, iterations=10)
    filled = binary_fill_holes(occ)
    filled = binary_erosion(filled, iterations=8)

    lbl, n = ndi_label(filled)
    if n == 0:
        return None
    best = 1 + int(np.argmax([np.sum(lbl == i) for i in range(1, n + 1)]))
    interior = (lbl == best)

    row_map = {}
    for iz in range(nz):
        row = interior[iz]
        if row.any():
            row_map[iz] = (int(np.argmax(row)), int(len(row) - np.argmax(row[::-1]) - 1))

    if not row_map:
        return None

    iz_min = min(row_map)
    iz_max = max(row_map)

    def rx(ix): return round(x0 + ix * RES, 3)
    def rz(iz): return round(z0 + iz * RES, 3)

    right = [[rx(row_map[iz_min][1] + 1), rz(iz_min)]]
    prev_hi = row_map[iz_min][1]
    for iz in range(iz_min + 1, iz_max + 1):
        if iz not in row_map:
            continue
        hi = row_map[iz][1]
        if hi != prev_hi:
            right.append([rx(prev_hi + 1), rz(iz)])
            right.append([rx(hi + 1), rz(iz)])
            prev_hi = hi
    right.append([rx(row_map[iz_max][1] + 1), rz(iz_max + 1)])

    left = [[rx(row_map[iz_max][0]), rz(iz_max + 1)]]
    prev_lo = row_map[iz_max][0]
    for iz in range(iz_max - 1, iz_min - 1, -1):
        if iz not in row_map:
            continue
        lo = row_map[iz][0]
        if lo != prev_lo:
            left.append([rx(prev_lo), rz(iz + 1)])
            left.append([rx(lo), rz(iz + 1)])
            prev_lo = lo
    left.append([rx(row_map[iz_min][0]), rz(iz_min)])

    poly = right + left
    poly.append(poly[0][:])

    def remove_collinear(pts):
        n = len(pts) - 1
        result = []
        for i in range(n):
            p0, p1, p2 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
            if not (p0[0] == p1[0] == p2[0] or p0[1] == p1[1] == p2[1]):
                result.append(p1)
        if result:
            result.append(result[0][:])
        return result

    poly = remove_collinear(poly)
    if not poly:
        return None

    poly = _merge_short_edges(poly, min_len=min_wall_len)

    def snap5(v): return round(round(v / 0.05) * 0.05, 3)
    poly = [[snap5(p[0]), snap5(p[1])] for p in poly]
    poly = remove_collinear(poly)

    xw, zw = [], []
    if poly:
        for i in range(len(poly) - 1):
            p1, p2 = poly[i], poly[i + 1]
            if abs(p1[0] - p2[0]) < 0.001:
                pos = round((p1[0] + p2[0]) / 2, 3)
                span_lo, span_hi = sorted([p1[1], p2[1]])
                xw.append({'pos': pos, 'segs': [[span_lo, span_hi]], 'presence': 1,
                            'support': 99, 'span': round(span_hi - span_lo, 3), 'cls': 'structure'})
            elif abs(p1[1] - p2[1]) < 0.001:
                pos = round((p1[1] + p2[1]) / 2, 3)
                span_lo, span_hi = sorted([p1[0], p2[0]])
                zw.append({'pos': pos, 'segs': [[span_lo, span_hi]], 'presence': 1,
                            'support': 99, 'span': round(span_hi - span_lo, 3), 'cls': 'structure'})

    fp = []
    if poly:
        for i in range(len(poly) - 1):
            p1, p2 = poly[i], poly[i + 1]
            n_pts = max(2, int(((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2) ** 0.5 / 0.1))
            for t in np.linspace(0, 1, n_pts):
                fp.append([round(p1[0] + t * (p2[0] - p1[0]), 3), round(p1[1] + t * (p2[1] - p1[1]), 3)])

    return {'boundary': poly, 'xw': xw, 'zw': zw, 'fp': fp, 'floor_y': floor_y, 'ceil_y': ceil_y}


def main():
    parser = argparse.ArgumentParser(description='GLB -> Consensus Floor Plan (v4)')
    parser.add_argument('input', help='Input GLB file')
    parser.add_argument('--output', '-o', default='consensus_data.json')
    parser.add_argument('--step', type=float, default=0.2)
    parser.add_argument('--snap', type=float, default=0.06)
    parser.add_argument('--min-wall', type=float, default=0.4)
    parser.add_argument('--no-rotate', action='store_true',
                        help='Disable PCA rotation alignment (for A/B comparison)')
    parser.add_argument('--min-opening', type=float, default=0.5,
                        help='Minimum opening width to report (meters)')
    parser.add_argument('--min-room-area', type=float, default=2.0,
                        help='Minimum room area in m² to keep (smaller CCs are dropped)')
    parser.add_argument('--max-door-width', type=float, default=1.5,
                        help='Only doors narrower than this are carved during room split '
                             '(wider gaps treated as scan gaps, not real passages)')
    parser.add_argument('--no-rooms', action='store_true',
                        help='Disable multi-room decomposition (Priority 3)')
    args = parser.parse_args()

    print(f"Loading {args.input}...")
    mesh = load_glb(args.input)
    print(f"  Vertices: {mesh.vertices.shape[0]}, Faces: {mesh.faces.shape[0]}")

    IS_CAD = mesh.faces.shape[0] < 2000
    print(f"  Mode: {'CAD/Rhino' if IS_CAD else 'LiDAR scan'}")

    rotation_angle = 0.0
    openings = []
    rooms_data = {'rooms': [], 'interior_openings': [], 'doors': []}

    if IS_CAD:
        print("Extracting CAD floor plan...")
        cad = extract_cad_plan(mesh, args.min_wall)
        if cad is None:
            print("  ERROR: CAD extraction failed")
            sys.exit(1)
        boundary = cad['boundary']
        xw, zw = cad['xw'], cad['zw']
        fp = cad['fp']
        print(f"  {len(boundary) - 1} corners, {len(xw)} x-walls, {len(zw)} z-walls")
        ap = np.array(fp) if fp else np.array([[0, 0]])
        sp = {}
        xh, xe, zh, ze = [], [0.0, 1.0], [], [0.0, 1.0]
        slices = []
    else:
        # Priority 1: PCA rotation alignment — rotate mesh so dominant walls are
        # parallel to X/Z axes. All downstream processing happens in this rotated
        # space; the rotation angle is recorded in the output for downstream
        # consumers that want to display in original orientation.
        if not args.no_rotate:
            print("Estimating rotation alignment...")
            rotation_angle = estimate_rotation_angle(mesh)
            print(f"  Detected misalignment: {np.degrees(rotation_angle):+.2f}°")
            if abs(rotation_angle) > 1e-4:
                import trimesh
                R = trimesh.transformations.rotation_matrix(rotation_angle, [0, 1, 0])
                mesh = mesh.copy()
                mesh.apply_transform(R)
                print(f"  Rotated mesh by {np.degrees(rotation_angle):+.2f}° around +Y")
            else:
                print("  Already axis-aligned — skipping rotation")
        else:
            print("Rotation alignment DISABLED (--no-rotate)")

        print("Finding floor/ceiling...")
        fy, cy = find_floor_ceiling(mesh)
        print(f"  Floor Y: {fy:.3f}, Ceiling Y: {cy:.3f}, Height: {cy - fy:.2f}m")

        print(f"Extracting slices (step={args.step}m)...")
        slices = extract_slices(mesh, fy, cy, args.step)
        print(f"  {len(slices)} slices")

        print("Computing consensus walls...")
        xw, zw, xh, xe, zh, ze = consensus_walls(slices, args.snap)
        sx = sum(1 for w in xw if w['cls'] == 'structure')
        bx = sum(1 for w in xw if w['cls'] == 'built-in')
        sz = sum(1 for w in zw if w['cls'] == 'structure')
        bz = sum(1 for w in zw if w['cls'] == 'built-in')
        print(f"  X: {sx} structure, {bx} built-in | Z: {sz} structure, {bz} built-in")

        print(f"Building boundary (min wall={args.min_wall}m)...")
        all_w = [p for s in slices for p in s['w']]
        boundary = build_boundary(xw, zw, all_w, args.min_wall)
        print(f"  {len(boundary) - 1} corners")

        # Priority 2: classify openings (door / window / lintel) via Y-profile.
        print(f"Detecting openings (min width={args.min_opening}m)...")
        openings = detect_openings(mesh, boundary, fy, cy, args.min_opening)
        n_door = sum(1 for o in openings if o['type'] == 'door')
        n_win = sum(1 for o in openings if o['type'] == 'window')
        n_lin = sum(1 for o in openings if o['type'] == 'lintel')
        print(f"  {len(openings)} openings: {n_door} door, {n_win} window, {n_lin} lintel")

        # Priority 3: multi-room decomposition + door graph
        if not args.no_rooms:
            print(f"Decomposing rooms (min area={args.min_room_area}m²)...")
            rooms_data = decompose_rooms(
                mesh, xw, zw, boundary, openings, fy, cy,
                min_opening=args.min_opening,
                min_room_area=args.min_room_area,
                max_door_width=args.max_door_width,
            )
            n_int = len(rooms_data['interior_openings'])
            n_int_door = sum(1 for o in rooms_data['interior_openings'] if o['type'] == 'door')
            print(f"  {len(rooms_data['rooms'])} rooms, "
                  f"{n_int} interior openings ({n_int_door} doors), "
                  f"{len(rooms_data['doors'])} doors in graph")

        rng = np.random.RandomState(42)
        fp = [all_w[i] for i in rng.choice(len(all_w), min(2000, len(all_w)), replace=False)] if all_w else []
        ap = np.array(fp) if fp else np.array([[0, 0]])
        sp = {s['label']: s['w'] for s in slices}

    out = {
        "m": {"n": len(slices), "h": [s['height'] for s in slices] if slices else []},
        "xw": xw, "zw": zw, "boundary": boundary, "fp": fp, "sp": sp,
        "bounds": {
            "x": [float(ap[:, 0].min()), float(ap[:, 0].max())],
            "z": [float(ap[:, 1].min()), float(ap[:, 1].max())]
        },
        "xh": xh, "zh": zh,
        "xhb": {"s": float(xe[0]), "d": 0.02, "n": len(xh)},
        "zhb": {"s": float(ze[0]), "d": 0.02, "n": len(zh)},
        "source": "cad" if IS_CAD else "scan",
        # v4 additions
        "rotation_angle": float(rotation_angle),       # radians; mesh was rotated by +this
        "rotation_deg": round(float(np.degrees(rotation_angle)), 3),
        "openings": openings,                          # type ∈ {door, window, lintel}
        # v4 P3: multi-room decomposition
        "rooms": rooms_data['rooms'],
        "interior_openings": rooms_data['interior_openings'],
        "doors": rooms_data['doors'],
        "version": "v4",
    }

    with open(args.output, 'w') as f:
        json.dump(out, f)
    import os
    print(f"\nSaved: {args.output} ({os.path.getsize(args.output) / 1024:.1f} KB)")


if __name__ == '__main__':
    main()
