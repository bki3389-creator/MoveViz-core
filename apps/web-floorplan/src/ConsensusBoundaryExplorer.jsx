import { useState, useEffect, useRef, useCallback } from "react";
import Plan3DView from "./Plan3DView";

const SK = "consensus_bex_v1";
const SNAP = 0.1;
const WALL_T = 0.1;
const FONT = "'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const storage = {
  get: (key) => { try { const v = localStorage.getItem(key); return v ? { value: v } : null; } catch { return null; } },
  set: (key, val) => { try { localStorage.setItem(key, val); } catch { /* storage may be disabled */ } },
  delete: (key) => { try { localStorage.removeItem(key); } catch { /* storage may be disabled */ } },
};

const snap = (v) => Math.round(v / SNAP) * SNAP;

// Find intersection of two infinite lines defined by Manhattan segments
// Returns point even if outside segment bounds (for extend/trim)
// Accounts for wall thickness: the trimmed wall extends to the EDGE of the cutting wall
function lineIntersect(cutSeg, targetSeg) {
  const cutVert = Math.abs(cutSeg.x2 - cutSeg.x1) < 0.01;
  const tgtVert = Math.abs(targetSeg.x2 - targetSeg.x1) < 0.01;
  if (cutVert === tgtVert) return null; // parallel

  const halfT = WALL_T / 2;
  if (tgtVert) {
    // Target is vertical, cut is horizontal → target end meets cut wall's edge
    // Target X stays, Z = cut wall's Z ± halfT (whichever side target approaches from)
    const cutZ = cutSeg.z1;
    const tgtMidZ = (targetSeg.z1 + targetSeg.z2) / 2;
    const edgeZ = tgtMidZ < cutZ ? cutZ - halfT : cutZ + halfT;
    return [snap(targetSeg.x1), snap(edgeZ)];
  } else {
    // Target is horizontal, cut is vertical → target end meets cut wall's edge
    const cutX = cutSeg.x1;
    const tgtMidX = (targetSeg.x1 + targetSeg.x2) / 2;
    const edgeX = tgtMidX < cutX ? cutX - halfT : cutX + halfT;
    return [snap(edgeX), snap(targetSeg.z1)];
  }
}

export default function ConsensusBoundaryExplorer({ initialData = null, glbFile = null, onExit }) {
  const cvs = useRef(null);
  const wrapRef = useRef(null);
  const [viewMode, setViewMode] = useState("2d"); // "2d" | "3d"
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [boundary, setBoundary] = useState([]);
  const [openings, setOpenings] = useState([]);
  const [innerWalls, setInnerWalls] = useState([]); // {start:[x,z], end:[x,z]}
  const originalBoundaryRef = useRef([]); // import 시 원본 boundary 저장
  const [detected, setDetected] = useState(null); // v4 자동 감지 결과(방/개구부/도어) — 읽기전용 오버레이
  const [showDetected, setShowDetected] = useState(true);
  const [tool, setTool] = useState("select"); // select | door | window | wall | split | trim
  const [selectedCorner, setSelectedCorner] = useState(null);
  const [selectedOpeningIdx, setSelectedOpeningIdx] = useState(null); // index into openings[]
  const [selectedInnerWall, setSelectedInnerWall] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [pointOpacity, setPointOpacity] = useState(90);
  const [planeOpacity, setPlaneOpacity] = useState(10); // 바닥(방 채움) 불투명도 %
  const [wallOpacity, setWallOpacity] = useState(85); // 벽 불투명도 %
  const [furnOpacity, setFurnOpacity] = useState(30); // 가구 불투명도 %
  const [showFurniture, setShowFurniture] = useState(true); // 가구 표시
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [hoverInfo, setHoverInfo] = useState(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 }); // pan offset in px, zoom multiplier
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, cx: 0, cy: 0 });
  const [drawStart, setDrawStart] = useState(null); // wall draw tool: first click
  const [trimFirst, setTrimFirst] = useState(null); // trim tool: first wall {type, idx}
  const [mouseWorld, setMouseWorld] = useState(null); // current mouse in world coords
  const [doorSize, setDoorSize] = useState(900); // door size in mm
  const [windowSize, setWindowSize] = useState(1200); // window size in mm
  const [doorFlip, setDoorFlip] = useState(0); // 0~3: 4 orientations (space to cycle)

  // Live refs for keyboard handler (avoid stale closures in the keydown effect)
  const toolRef = useRef(tool);
  const selectedOpeningIdxRef = useRef(selectedOpeningIdx);
  const selectedInnerWallRef = useRef(selectedInnerWall);
  const openingsRef = useRef(openings);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { selectedOpeningIdxRef.current = selectedOpeningIdx; }, [selectedOpeningIdx]);
  useEffect(() => { selectedInnerWallRef.current = selectedInnerWall; }, [selectedInnerWall]);
  useEffect(() => { openingsRef.current = openings; }, [openings]);

  // Undo history
  const historyRef = useRef([]);
  const MAX_HISTORY = 50;

  const pushHistory = useCallback(() => {
    historyRef.current.push({
      boundary: boundary.map(p => [...p]),
      openings: openings.map(o => ({ ...o })),
      innerWalls: innerWalls.map(w => ({ start: [...w.start], end: [...w.end] })),
    });
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
  }, [boundary, openings, innerWalls]);

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    setBoundary(prev.boundary);
    setOpenings(prev.openings);
    setInnerWalls(prev.innerWalls);
    setSelectedCorner(null);
    setSelectedOpeningIdx(null);
    setSelectedInnerWall(null);
    setDrawStart(null);
  }, []);

  // Coordinate transform refs
  const txRef = useRef(null);
  const tzRef = useRef(null);
  const itxRef = useRef(null);
  const itzRef = useRef(null);
  const scaleRef = useRef(1);
  const oxBaseRef = useRef(0);
  const ozBaseRef = useRef(0);

  const tryLoad = useCallback((text) => {
    try {
      const d = JSON.parse(text);
      if (!d.boundary || !d.xw || !d.zw) { setErr("Invalid format"); return; }
      d.boundary = d.boundary.map(([x, z]) => [-x, z]);
      if (d.fp) d.fp = d.fp.map(([x, z]) => [-x, z]);
      if (d.sp) { for (const key of Object.keys(d.sp)) d.sp[key] = d.sp[key].map(([x, z]) => [-x, z]); }
      if (d.bounds?.x) d.bounds.x = [-d.bounds.x[1], -d.bounds.x[0]];
      setData(d); setErr("");
      // v4 자동 감지 오버레이 — 백엔드 [x,z]를 프론트 좌표(-x)로 변환
      const invXY = ([x, z]) => [-x, z];
      setDetected({
        rotationDeg: typeof d.rotation_deg === "number" ? d.rotation_deg : null,
        rooms: Array.isArray(d.rooms) ? d.rooms.map(r => ({
          ...r,
          polygon: (r.polygon || []).map(invXY),
          center: r.center ? invXY(r.center) : null,
        })) : [],
        openings: Array.isArray(d.openings) ? d.openings.map(o => ({
          ...o, center: o.center ? invXY(o.center) : null,
        })) : [],
        doors: Array.isArray(d.doors) ? d.doors.map(o => ({
          ...o, center: o.center ? invXY(o.center) : null,
        })) : [],
        furniture: Array.isArray(d.furniture) ? d.furniture.map(f => ({
          ...f,
          polygon: (f.polygon && f.polygon.length >= 3
            ? f.polygon
            : [[f.bbox[0], f.bbox[1]], [f.bbox[2], f.bbox[1]], [f.bbox[2], f.bbox[3]], [f.bbox[0], f.bbox[3]]]
          ).map(invXY),
        })) : [],
        countsV4V5: d.counts || null,
      });
      const b = d.boundary.map(([x, z]) => [snap(x), snap(z)]);
      originalBoundaryRef.current = b.map(p => [...p]);
      setBoundary(b);
      setInnerWalls([]);

      setOpenings([]);
      setSelectedCorner(null);
      setSelectedOpeningIdx(null);
      setSelectedInnerWall(null);
      historyRef.current = [];
      storage.set(SK, text);
    } catch (e) { setErr("Parse error: " + e.message); }
  }, []);

  const handleFile = useCallback((f) => {
    const r = new FileReader();
    r.onload = (e) => tryLoad(e.target.result);
    r.readAsText(f);
  }, [tryLoad]);

  useEffect(() => {
    if (initialData) {
      tryLoad(JSON.stringify(initialData));
    } else {
      const r = storage.get(SK);
      if (r?.value) tryLoad(r.value);
    }
    setLoading(false);
  }, [tryLoad, initialData]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      setCanvasSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [data]);

  // ── Draw ──
  useEffect(() => {
    const c = cvs.current;
    if (!c || !data || boundary.length < 3) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvasSize.w, H = canvasSize.h;
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = W + "px"; c.style.height = H + "px";
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);

    // Bounds
    const allX = boundary.map(p => p[0]);
    const allZ = boundary.map(p => p[1]);
    // Include inner walls in bounds
    for (const iw of innerWalls) {
      allX.push(iw.start[0], iw.end[0]);
      allZ.push(iw.start[1], iw.end[1]);
    }
    const bx0 = Math.min(...allX), bx1 = Math.max(...allX);
    const bz0 = Math.min(...allZ), bz1 = Math.max(...allZ);
    const pad = 1.2;
    const xMin = bx0 - pad, xMax = bx1 + pad, zMin = bz0 - pad, zMax = bz1 + pad;
    const margin = { t: 20, r: 20, b: 20, l: 20 };
    const pw = W - margin.l - margin.r, ph = H - margin.t - margin.b;
    const baseScale = Math.min(pw / (xMax - xMin), ph / (zMax - zMin));
    const scale = baseScale * camera.zoom;
    scaleRef.current = scale;
    const oxBase = margin.l + (pw - (xMax - xMin) * baseScale) / 2;
    const ozBase = margin.t + (ph - (zMax - zMin) * baseScale) / 2;
    oxBaseRef.current = oxBase;
    ozBaseRef.current = ozBase;
    const ox = oxBase + camera.x;
    const oz = ozBase + camera.y;
    const tx = (x) => ox + (x - xMin) * scale;
    const tz = (z) => oz + (zMax - z) * scale;
    const itx = (sx) => (sx - ox) / scale + xMin;
    const itz = (sy) => zMax - (sy - oz) / scale;
    txRef.current = tx; tzRef.current = tz; itxRef.current = itx; itzRef.current = itz;

    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);

    // Grid
    const gridStep = scale * 0.1 > 8 ? 0.1 : scale * 0.5 > 8 ? 0.5 : 1;
    ctx.strokeStyle = gridStep === 0.1 ? "#f5f5f5" : "#eee"; ctx.lineWidth = 0.5;
    for (let x = Math.ceil(xMin / gridStep) * gridStep; x <= xMax; x += gridStep) { ctx.beginPath(); ctx.moveTo(tx(x), 0); ctx.lineTo(tx(x), H); ctx.stroke(); }
    for (let z = Math.ceil(zMin / gridStep) * gridStep; z <= zMax; z += gridStep) { ctx.beginPath(); ctx.moveTo(0, tz(z)); ctx.lineTo(W, tz(z)); ctx.stroke(); }
    if (gridStep < 1) {
      ctx.strokeStyle = "#e8e8e8"; ctx.lineWidth = 0.8;
      for (let x = Math.ceil(xMin); x <= xMax; x++) { ctx.beginPath(); ctx.moveTo(tx(x), 0); ctx.lineTo(tx(x), H); ctx.stroke(); }
      for (let z = Math.ceil(zMin); z <= zMax; z++) { ctx.beginPath(); ctx.moveTo(0, tz(z)); ctx.lineTo(W, tz(z)); ctx.stroke(); }
    }

    // Point cloud
    if (pointOpacity > 0 && data.fp) {
      const alpha = (pointOpacity / 100) * 0.25;
      ctx.fillStyle = `rgba(0,0,0,${alpha})`;
      for (const [x, z] of data.fp) ctx.fillRect(tx(x) - 0.5, tz(z) - 0.5, 1.5, 1.5);
    }

    // ── v4 감지 결과: 방 채우기 (벽 아래 배경) — 투명도 슬라이더 연동 ──
    const _pa = planeOpacity / 100;
    const ROOM_RGB = ["37,99,235","16,185,129","245,158,11","236,72,153","139,92,246","20,184,166"];
    const ROOM_FILL = ROOM_RGB.map(c => `rgba(${c},${_pa})`);
    const ROOM_LINE = ["#2563eb","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6"];
    if (showDetected && detected?.rooms?.length) {
      detected.rooms.forEach((r, ri) => {
        if (!r.polygon || r.polygon.length < 3) return;
        ctx.beginPath();
        ctx.moveTo(tx(r.polygon[0][0]), tz(r.polygon[0][1]));
        for (let i = 1; i < r.polygon.length; i++) ctx.lineTo(tx(r.polygon[i][0]), tz(r.polygon[i][1]));
        ctx.closePath();
        ctx.fillStyle = ROOM_FILL[ri % ROOM_FILL.length]; ctx.fill();
        ctx.strokeStyle = ROOM_LINE[ri % ROOM_LINE.length]; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
        if (r.center) {
          ctx.font = `600 12px ${FONT}`; ctx.fillStyle = ROOM_LINE[ri % ROOM_LINE.length];
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(`R${r.id} · ${r.area_m2}m²`, tx(r.center[0]), tz(r.center[1]) + 24);
        }
      });
    }

    // ── 가구 바운더리(v5) 오버레이 ──
    if (showFurniture && detected?.furniture?.length) {
      detected.furniture.forEach(f => {
        const poly = f.polygon;
        if (!poly || poly.length < 3) return;
        ctx.beginPath();
        ctx.moveTo(tx(poly[0][0]), tz(poly[0][1]));
        for (let i = 1; i < poly.length; i++) ctx.lineTo(tx(poly[i][0]), tz(poly[i][1]));
        ctx.closePath();
        const col = f.builtin ? "245,158,11" : "100,116,139"; // 빌트인=주황, 자립=회색
        ctx.fillStyle = `rgba(${col},${furnOpacity / 100})`; ctx.fill();
        ctx.strokeStyle = `rgb(${col})`; ctx.lineWidth = 1.5; ctx.stroke();
      });
    }

    // Helper: draw a thick wall segment (centered, for inner walls)
    const drawThickWallCentered = (x1, z1, x2, z2, color, isSelected) => {
      const isVert = Math.abs(x2 - x1) < 0.01;
      const isHorz = Math.abs(z2 - z1) < 0.01;
      const ht = WALL_T / 2;
      if (!isVert && !isHorz) {
        ctx.strokeStyle = color; ctx.lineWidth = WALL_T * scale;
        ctx.beginPath(); ctx.moveTo(tx(x1), tz(z1)); ctx.lineTo(tx(x2), tz(z2)); ctx.stroke();
        return;
      }
      let wx1, wz1, wx2, wz2;
      if (isVert) {
        wx1 = tx(x1 - ht); wz1 = tz(Math.max(z1, z2));
        wx2 = tx(x1 + ht); wz2 = tz(Math.min(z1, z2));
      } else {
        wx1 = tx(Math.min(x1, x2)); wz1 = tz(z1 + ht);
        wx2 = tx(Math.max(x1, x2)); wz2 = tz(z1 - ht);
      }
      ctx.fillStyle = isSelected ? "rgba(37,99,235,0.3)" : color;
      ctx.fillRect(Math.min(wx1, wx2), Math.min(wz1, wz2), Math.abs(wx2 - wx1), Math.abs(wz2 - wz1));
      if (isSelected) {
        ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
        ctx.strokeRect(Math.min(wx1, wx2), Math.min(wz1, wz2), Math.abs(wx2 - wx1), Math.abs(wz2 - wz1));
      }
    };

    // ── Boundary walls ──
    const b = boundary;
    // Compute signed area to determine winding (for inward normal)
    let windingArea = 0;
    for (let i = 0; i < b.length - 1; i++) {
      windingArea += b[i][0] * b[i + 1][1] - b[i + 1][0] * b[i][1];
    }
    const ccw = windingArea > 0;

    // Compute inward-offset polygon (inner face = outer boundary, vertices offset inward by WALL_T)
    const innerPoly = [];
    for (let i = 0; i < b.length - 1; i++) {
      // Get prev and next edges to compute inward offset at this corner
      const prev = (i - 1 + b.length - 1) % (b.length - 1);
      const [px, pz] = b[prev];
      const [cx, cz] = b[i];
      const [nx2, nz2] = b[(i + 1) % (b.length - 1)];

      // Edge before this corner: prev → current
      const e1x = cx - px, e1z = cz - pz;
      const e1len = Math.sqrt(e1x * e1x + e1z * e1z) || 1;
      // Edge after this corner: current → next
      const e2x = nx2 - cx, e2z = nz2 - cz;
      const e2len = Math.sqrt(e2x * e2x + e2z * e2z) || 1;

      // Inward normals for each edge
      const sign = ccw ? 1 : -1;
      const n1x = sign * (e1z / e1len), n1z = sign * -(e1x / e1len);
      const n2x = sign * (e2z / e2len), n2z = sign * -(e2x / e2len);

      // Average normal (works for 90° Manhattan corners)
      // For Manhattan, one normal is (±1,0) and other is (0,±1), so offset each axis independently
      const offX = cx + (Math.abs(n1x) > 0.5 ? n1x : n2x) * WALL_T;
      const offZ = cz + (Math.abs(n1z) > 0.5 ? n1z : n2z) * WALL_T;
      innerPoly.push([offX, offZ]);
    }
    innerPoly.push([...innerPoly[0]]); // close

    // Draw filled boundary as outer polygon minus inner polygon (even-odd fill)
    // Draw solid boundary: outer polygon (b) → inner polygon (innerPoly), cut out openings
    // Use even-odd fill: trace outer CW, then inner CCW (or vice versa)
    ctx.fillStyle = `rgba(0,0,0,${wallOpacity / 100})`;
    ctx.beginPath();
    // Outer path (vertex line = outer face)
    ctx.moveTo(tx(b[0][0]), tz(b[0][1]));
    for (let i = 1; i < b.length; i++) ctx.lineTo(tx(b[i][0]), tz(b[i][1]));
    ctx.closePath();
    // Inner path (offset inward by WALL_T) — reverse direction for cutout
    ctx.moveTo(tx(innerPoly[0][0]), tz(innerPoly[0][1]));
    for (let i = innerPoly.length - 1; i >= 0; i--) ctx.lineTo(tx(innerPoly[i][0]), tz(innerPoly[i][1]));
    ctx.closePath();
    ctx.fill("evenodd");

    // Cut out openings (draw white rectangles where doors/windows are)
    for (let i = 0; i < b.length - 1; i++) {
      const [x1, z1] = b[i], [x2, z2] = b[i + 1];
      const isVert = Math.abs(x2 - x1) < 0.01;
      const isHorz = Math.abs(z2 - z1) < 0.01;
      if (!isVert && !isHorz) continue;
      const elen = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
      const ex = (x2 - x1) / elen, ez = (z2 - z1) / elen;
      const sign = ccw ? 1 : -1;
      const nx = sign * ez, nz = sign * -ex;

      const wallOpenings = openings.filter(o => o.wallIdx === i);
      if (wallOpenings.length === 0) continue;
      const dx = ex, dz = ez;
      for (const op of wallOpenings) {
        const ox1 = x1 + dx * op.pos, oz1 = z1 + dz * op.pos;
        const ox2 = x1 + dx * (op.pos + op.len), oz2 = z1 + dz * (op.pos + op.len);
        // Clear the wall area at this opening
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(tx(ox1), tz(oz1));
        ctx.lineTo(tx(ox2), tz(oz2));
        ctx.lineTo(tx(ox2 + nx * WALL_T), tz(oz2 + nz * WALL_T));
        ctx.lineTo(tx(ox1 + nx * WALL_T), tz(oz1 + nz * WALL_T));
        ctx.closePath(); ctx.fill();

        // Draw opening symbols
        const isSel = selectedOpeningIdx !== null && openings[selectedOpeningIdx] === op;
        if (op.type === "door") {
          const flip = op.flip || 0;
          const hingeAtEnd = flip >= 2;
          const swingDir = (flip % 2 === 0) ? 1 : -1;
          const hsx = hingeAtEnd ? tx(ox2) : tx(ox1);
          const hsy = hingeAtEnd ? tz(oz2) : tz(oz1);
          const tsx = hingeAtEnd ? tx(ox1) : tx(ox2);
          const tsy = hingeAtEnd ? tz(oz1) : tz(oz2);
          const arcR = Math.sqrt((tsx - hsx) ** 2 + (tsy - hsy) ** 2);
          const angleTip = Math.atan2(tsy - hsy, tsx - hsx);
          const angleLeaf = angleTip + swingDir * Math.PI / 2;
          const lex = hsx + Math.cos(angleLeaf) * arcR;
          const ley = hsy + Math.sin(angleLeaf) * arcR;
          ctx.strokeStyle = isSel ? "#2563eb" : "#666"; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(hsx, hsy); ctx.lineTo(lex, ley); ctx.stroke();
          ctx.beginPath(); ctx.arc(hsx, hsy, arcR, angleLeaf, angleTip, swingDir > 0); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(tx(ox1), tz(oz1)); ctx.lineTo(tx(ox2), tz(oz2)); ctx.stroke();
          // Entrance label
          if (op.role === "entrance") {
            const lx = (tx(ox1) + tx(ox2)) / 2;
            const ly = (tz(oz1) + tz(oz2)) / 2;
            // Position label on the outward side of the wall
            const snxD = nx * scale, snzD = -nz * scale;
            const dlen = Math.sqrt(snxD * snxD + snzD * snzD) || 1;
            ctx.font = `bold 11px ${FONT}`;
            ctx.fillStyle = "#dc2626"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("현관", lx + snxD / dlen * 18, ly + snzD / dlen * 18);
          }
        } else {
          const snx2 = nx * scale, snz2 = -nz * scale;
          const slen = Math.sqrt(snx2 * snx2 + snz2 * snz2);
          const unx = snx2 / slen * 3, unz = snz2 / slen * 3;
          ctx.strokeStyle = isSel ? "#2563eb" : "#333"; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(tx(ox1) + unx, tz(oz1) + unz); ctx.lineTo(tx(ox2) + unx, tz(oz2) + unz); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(tx(ox1) - unx, tz(oz1) - unz); ctx.lineTo(tx(ox2) - unx, tz(oz2) - unz); ctx.stroke();
          const mmx = (tx(ox1) + tx(ox2)) / 2, mmz = (tz(oz1) + tz(oz2)) / 2;
          ctx.beginPath(); ctx.moveTo(mmx + unx, mmz + unz); ctx.lineTo(mmx - unx, mmz - unz); ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);

    // Selected wall highlight
    if (selectedCorner !== null && selectedCorner < b.length - 1) {
      const si = selectedCorner;
      const [sx1, sz1] = b[si], [sx2, sz2] = b[si + 1];
      const [ix1, iz1] = innerPoly[si], [ix2, iz2] = innerPoly[(si + 1) % (innerPoly.length - 1)];
      ctx.fillStyle = "rgba(37,99,235,0.2)";
      ctx.beginPath();
      ctx.moveTo(tx(sx1), tz(sz1)); ctx.lineTo(tx(sx2), tz(sz2));
      ctx.lineTo(tx(ix2), tz(iz2)); ctx.lineTo(tx(ix1), tz(iz1));
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.stroke();
    }

    // ── Inner walls ──
    for (let i = 0; i < innerWalls.length; i++) {
      const w = innerWalls[i];
      drawThickWallCentered(w.start[0], w.start[1], w.end[0], w.end[1], "rgba(0,0,0,0.85)", selectedInnerWall === i);
    }

    // ── Wall draw preview ──
    if (tool === "wall" && drawStart && mouseWorld) {
      const dx = Math.abs(mouseWorld[0] - drawStart[0]);
      const dz = Math.abs(mouseWorld[1] - drawStart[1]);
      let ex, ez;
      if (dx >= dz) { ex = snap(mouseWorld[0]); ez = drawStart[1]; }
      else { ex = drawStart[0]; ez = snap(mouseWorld[1]); }
      ctx.strokeStyle = "#2563eb"; ctx.lineWidth = WALL_T * scale; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(tx(drawStart[0]), tz(drawStart[1])); ctx.lineTo(tx(ex), tz(ez)); ctx.stroke();
      ctx.setLineDash([]);
      // Length preview
      const len = Math.sqrt((ex - drawStart[0]) ** 2 + (ez - drawStart[1]) ** 2);
      const mm = Math.round(len * 1000);
      if (mm > 0) {
        const label = mm >= 1000 ? (mm / 1000).toFixed(1) + "m" : mm + "mm";
        ctx.font = `bold 13px ${FONT}`; ctx.fillStyle = "#2563eb"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(label, (tx(drawStart[0]) + tx(ex)) / 2, (tz(drawStart[1]) + tz(ez)) / 2 - 6);
      }
      // Start point
      ctx.beginPath(); ctx.arc(tx(drawStart[0]), tz(drawStart[1]), 4, 0, Math.PI * 2);
      ctx.fillStyle = "#2563eb"; ctx.fill();
    }

    // ── Split preview ──
    if (tool === "split" && hoverInfo?.type === "wall") {
      const i = hoverInfo.idx;
      const [x1, z1] = b[i], [x2, z2] = b[i + 1];
      const px = x1 + (x2 - x1) * hoverInfo.t, pz = z1 + (z2 - z1) * hoverInfo.t;
      const sx = snap(px), sz = snap(pz);
      ctx.beginPath(); ctx.arc(tx(sx), tz(sz), 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(220,38,38,0.3)"; ctx.fill();
      ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2; ctx.stroke();
    }

    // ── Trim preview (Revit-style: highlight first selected wall) ──
    if (tool === "trim" && trimFirst) {
      let seg;
      if (trimFirst.type === "wall" && trimFirst.idx < b.length - 1) {
        const [x1, z1] = b[trimFirst.idx], [x2, z2] = b[trimFirst.idx + 1];
        seg = { x1, z1, x2, z2 };
      } else if (trimFirst.type === "innerWall" && trimFirst.idx < innerWalls.length) {
        const w = innerWalls[trimFirst.idx];
        seg = { x1: w.start[0], z1: w.start[1], x2: w.end[0], z2: w.end[1] };
      }
      if (seg) {
        ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = WALL_T * scale + 6; ctx.setLineDash([8, 4]); ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(tx(seg.x1), tz(seg.z1)); ctx.lineTo(tx(seg.x2), tz(seg.z2)); ctx.stroke();
        ctx.globalAlpha = 1; ctx.setLineDash([]);
      }
    }

    // ── Dimensions ──
    for (let i = 0; i < b.length - 1; i++) {
      const [x1, z1] = b[i], [x2, z2] = b[i + 1];
      const len = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
      if (len < 0.05) continue;
      const mm = Math.round(len * 1000);
      const label = mm >= 1000 ? (mm / 1000).toFixed(mm % 100 === 0 ? 1 : 2) + "m" : mm + "mm";
      const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
      const isVert = Math.abs(x2 - x1) < 0.01;
      const offset = 24;
      ctx.strokeStyle = "#c00"; ctx.lineWidth = 1; ctx.setLineDash([]);
      if (isVert) {
        const side = mx < (bx0 + bx1) / 2 ? -1 : 1;
        const lx = tx(mx) + side * offset;
        ctx.beginPath(); ctx.moveTo(tx(mx) + side * 8, tz(z1)); ctx.lineTo(lx + side * 4, tz(z1)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tx(mx) + side * 8, tz(z2)); ctx.lineTo(lx + side * 4, tz(z2)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(lx, tz(z1)); ctx.lineTo(lx, tz(z2)); ctx.stroke();
        [tz(z1), tz(z2)].forEach((y, j) => {
          const dir = j === 0 ? 1 : -1;
          ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(lx - 3, y + dir * 5); ctx.lineTo(lx + 3, y + dir * 5); ctx.closePath(); ctx.fillStyle = "#c00"; ctx.fill();
        });
        ctx.save(); ctx.translate(lx + side * 6, (tz(z1) + tz(z2)) / 2); ctx.rotate(-Math.PI / 2);
        ctx.font = `bold 13px ${FONT}`; ctx.fillStyle = "#c00"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, 0, 0); ctx.restore();
      } else {
        const side = mz < (bz0 + bz1) / 2 ? 1 : -1;
        const ly = tz(mz) + side * offset;
        ctx.beginPath(); ctx.moveTo(tx(x1), tz(mz) + side * 8); ctx.lineTo(tx(x1), ly + side * 4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tx(x2), tz(mz) + side * 8); ctx.lineTo(tx(x2), ly + side * 4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tx(x1), ly); ctx.lineTo(tx(x2), ly); ctx.stroke();
        [tx(x1), tx(x2)].forEach((x, j) => {
          const dir = j === 0 ? 1 : -1;
          ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + dir * 5, ly - 3); ctx.lineTo(x + dir * 5, ly + 3); ctx.closePath(); ctx.fillStyle = "#c00"; ctx.fill();
        });
        ctx.font = `bold 13px ${FONT}`; ctx.fillStyle = "#c00"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, (tx(x1) + tx(x2)) / 2, ly + side * 14);
      }
    }
    ctx.setLineDash([]);

    // ── Area label ──
    if (b.length > 3) {
      // Shoelace formula + area-weighted centroid
      let signedArea = 0, cx = 0, cz = 0;
      for (let i = 0; i < b.length - 1; i++) {
        const cross = b[i][0] * b[i + 1][1] - b[i + 1][0] * b[i][1];
        signedArea += cross;
        cx += (b[i][0] + b[i + 1][0]) * cross;
        cz += (b[i][1] + b[i + 1][1]) * cross;
      }
      const area = Math.abs(signedArea) / 2;
      cx /= (3 * signedArea);
      cz /= (3 * signedArea);
      const sqm = area.toFixed(2);
      const pyeong = (area / 3.306).toFixed(1);
      ctx.font = `bold 16px ${FONT}`;
      ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`${sqm} m²`, tx(cx), tz(cz) - 10);
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillText(`${pyeong} 평`, tx(cx), tz(cz) + 12);
    }

    // Corner handles
    for (let i = 0; i < b.length - 1; i++) {
      const [px, pz] = b[i];
      const sel = selectedCorner === i;
      ctx.beginPath(); ctx.arc(tx(px), tz(pz), sel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = sel ? "#2563eb" : "#fff"; ctx.strokeStyle = sel ? "#2563eb" : "#333"; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
    }

    // ── v4 감지 결과: 도어 그래프 + 개구부 마커 (최상단) ──
    if (showDetected && detected) {
      // 도어 그래프: 두 방을 잇는 도어를 방 중심선으로 연결
      const roomCenter = {};
      (detected.rooms || []).forEach(r => { if (r.center) roomCenter[r.id] = r.center; });
      ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(124,58,237,0.55)";
      (detected.doors || []).forEach(d2 => {
        const rr = d2.rooms || [];
        if (rr.length === 2 && rr[0] >= 0 && rr[1] >= 0 && rr[0] !== rr[1] && roomCenter[rr[0]] && roomCenter[rr[1]]) {
          ctx.beginPath();
          ctx.moveTo(tx(roomCenter[rr[0]][0]), tz(roomCenter[rr[0]][1]));
          ctx.lineTo(tx(roomCenter[rr[1]][0]), tz(roomCenter[rr[1]][1]));
          ctx.stroke();
        }
      });
      ctx.setLineDash([]);
      // 개구부 마커 (door=녹색, window=파랑, lintel=주황)
      const OP_COLOR = { door: "#16a34a", window: "#2563eb", lintel: "#f59e0b" };
      (detected.openings || []).forEach(o => {
        if (!o.center) return;
        ctx.beginPath(); ctx.arc(tx(o.center[0]), tz(o.center[1]), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = OP_COLOR[o.type] || "#999"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      });
    }

  }, [data, boundary, openings, innerWalls, selectedCorner, selectedOpeningIdx, selectedInnerWall, canvasSize, pointOpacity, planeOpacity, wallOpacity, furnOpacity, showFurniture, tool, hoverInfo, drawStart, mouseWorld, trimFirst, camera, showDetected, detected]);

  // ── Hit test ──
  const hitTest = useCallback((mx, my) => {
    const tx = txRef.current, tz = tzRef.current;
    if (!tx || !tz || boundary.length < 3) return null;

    // Corners
    for (let i = 0; i < boundary.length - 1; i++) {
      const [px, pz] = boundary[i];
      if (Math.sqrt((tx(px) - mx) ** 2 + (tz(pz) - my) ** 2) < 10) return { type: "corner", idx: i };
    }

    // Openings (for doors: hit inside arc area)
    for (let oi = 0; oi < openings.length; oi++) {
      const op = openings[oi]; const i = op.wallIdx;
      if (i >= boundary.length - 1) continue;
      const [x1, z1] = boundary[i], [x2, z2] = boundary[i + 1];
      const wl = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
      if (wl < 0.01) continue;
      const ddx = (x2 - x1) / wl, ddz = (z2 - z1) / wl;
      const o1x = x1 + ddx * op.pos, o1z = z1 + ddz * op.pos;
      const o2x = x1 + ddx * (op.pos + op.len), o2z = z1 + ddz * (op.pos + op.len);

      if (op.type === "door") {
        // Hinge point in screen coords
        const flip = op.flip || 0;
        const hingeAtEnd = flip >= 2;
        const hsx = hingeAtEnd ? tx(o2x) : tx(o1x);
        const hsy = hingeAtEnd ? tz(o2z) : tz(o1z);
        const arcR = Math.sqrt((tx(o2x) - tx(o1x)) ** 2 + (tz(o2z) - tz(o1z)) ** 2);
        // Click inside arc radius → select door
        const dist = Math.sqrt((mx - hsx) ** 2 + (my - hsy) ** 2);
        if (dist <= arcR + 6) return { type: "opening", idx: oi };
      } else {
        // Window: check center point
        const omx = (o1x + o2x) / 2, omz = (o1z + o2z) / 2;
        if (Math.sqrt((tx(omx) - mx) ** 2 + (tz(omz) - my) ** 2) < 16) return { type: "opening", idx: oi };
      }
    }

    // Inner walls
    for (let i = 0; i < innerWalls.length; i++) {
      const w = innerWalls[i];
      const ax = tx(w.start[0]), ay = tz(w.start[1]), bx = tx(w.end[0]), by = tz(w.end[1]);
      const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      if (len < 1) continue;
      const t = Math.max(0, Math.min(1, ((mx - ax) * (bx - ax) + (my - ay) * (by - ay)) / (len * len)));
      const px = ax + t * (bx - ax), py = ay + t * (by - ay);
      if (Math.sqrt((px - mx) ** 2 + (py - my) ** 2) < 8) return { type: "innerWall", idx: i, t };
    }

    // Boundary walls
    for (let i = 0; i < boundary.length - 1; i++) {
      const [x1, z1] = boundary[i], [x2, z2] = boundary[i + 1];
      const ax = tx(x1), ay = tz(z1), bx = tx(x2), by = tz(z2);
      const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      if (len < 1) continue;
      const t = Math.max(0, Math.min(1, ((mx - ax) * (bx - ax) + (my - ay) * (by - ay)) / (len * len)));
      const px = ax + t * (bx - ax), py = ay + t * (by - ay);
      if (Math.sqrt((px - mx) ** 2 + (py - my) ** 2) < 8) return { type: "wall", idx: i, t };
    }
    return null;
  }, [boundary, openings, innerWalls]);

  const getMousePos = useCallback((e) => {
    const rect = cvs.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // ── Mouse handlers ──
  const onMouseDown = useCallback((e) => {
    const { x, y } = getMousePos(e);
    const hit = hitTest(x, y);
    const itx = itxRef.current, itz = itzRef.current;
    if (!itx) return;

    // Wall draw tool (continuous: end point becomes next start)
    if (tool === "wall") {
      const wx = snap(itx(x)), wz = snap(itz(y));
      if (!drawStart) {
        setDrawStart([wx, wz]);
      } else {
        const dx = Math.abs(wx - drawStart[0]), dz = Math.abs(wz - drawStart[1]);
        let ex, ez;
        if (dx >= dz) { ex = wx; ez = drawStart[1]; }
        else { ex = drawStart[0]; ez = wz; }
        const len = Math.sqrt((ex - drawStart[0]) ** 2 + (ez - drawStart[1]) ** 2);
        if (len >= 0.1) {
          pushHistory();
          setInnerWalls(prev => [...prev, { start: [...drawStart], end: [ex, ez] }]);
          // Continue: end point becomes next start
          setDrawStart([ex, ez]);
        }
      }
      return;
    }

    // Split tool: insert 4 points (notch) → A—C—C'—D'—D—B
    // C,D on original wall line, C',D' same initially → drag C'-D' segment perpendicular
    if (tool === "split" && hit?.type === "wall") {
      const i = hit.idx;
      const [x1, z1] = boundary[i], [x2, z2] = boundary[i + 1];
      const wallLen = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
      const dx = (x2 - x1) / wallLen, dz = (z2 - z1) / wallLen;
      // 1000mm (1m) gap centered on click
      const halfGap = 0.5;
      const clickDist = hit.t * wallLen;
      const d1 = snap(Math.max(0.1, clickDist - halfGap));
      const d2 = snap(Math.min(wallLen - 0.1, clickDist + halfGap));
      if (d2 - d1 < 0.2) return; // wall too short
      // C and D on original wall line
      const c = [snap(x1 + dx * d1), snap(z1 + dz * d1)];
      const d = [snap(x1 + dx * d2), snap(z1 + dz * d2)];
      // Don't insert if too close to existing corners
      if (Math.sqrt((c[0] - x1) ** 2 + (c[1] - z1) ** 2) < 0.1) return;
      if (Math.sqrt((d[0] - x2) ** 2 + (d[1] - z2) ** 2) < 0.1) return;
      // C' and D' start at same position (zero-height notch)
      const cPrime = [...c];
      const dPrime = [...d];
      pushHistory();
      const newBoundary = [...boundary];
      // Insert: C, C', D', D between i and i+1
      newBoundary.splice(i + 1, 0, c, cPrime, dPrime, d);
      setOpenings(prev => prev.map(o => o.wallIdx > i ? { ...o, wallIdx: o.wallIdx + 4 } : o));
      setBoundary(newBoundary);
      // Select the C'-D' segment (index i+2) for immediate perpendicular drag
      setSelectedCorner(i + 2);
      setTool("select");
      return;
    }

    // Trim tool (Revit-style): 1st click = cutting wall, 2nd click = wall to trim/extend
    if (tool === "trim") {
      const wallHit = hit?.type === "wall" || hit?.type === "innerWall" ? hit : null;
      if (!wallHit) { setTrimFirst(null); return; }

      if (!trimFirst) {
        // First click: select cutting wall
        setTrimFirst(wallHit);
        return;
      }

      // Second click: trim/extend this wall to meet the cutting wall
      const getWallSeg = (h) => {
        if (h.type === "wall") {
          const [x1, z1] = boundary[h.idx], [x2, z2] = boundary[h.idx + 1];
          return { x1, z1, x2, z2 };
        }
        const w = innerWalls[h.idx];
        return { x1: w.start[0], z1: w.start[1], x2: w.end[0], z2: w.end[1] };
      };

      const cutSeg = getWallSeg(trimFirst);
      const targetSeg = getWallSeg(wallHit);
      const ipt = lineIntersect(cutSeg, targetSeg);
      if (!ipt) { setTrimFirst(null); return; } // parallel, no intersection

      pushHistory();

      if (wallHit.type === "innerWall") {
        // Trim inner wall: keep the side the user clicked on
        const w = innerWalls[wallHit.idx];
        const isVert = Math.abs(w.end[0] - w.start[0]) < 0.01;
        const clickCoord = isVert ? (w.start[1] + (w.end[1] - w.start[1]) * wallHit.t) : (w.start[0] + (w.end[0] - w.start[0]) * wallHit.t);
        const iptCoord = isVert ? ipt[1] : ipt[0];
        const startCoord = isVert ? w.start[1] : w.start[0];
        // If click is on the start side of intersection, keep start→ipt; else keep ipt→end
        const clickOnStartSide = (clickCoord - startCoord) * (iptCoord - startCoord) >= 0 && Math.abs(clickCoord - startCoord) < Math.abs(iptCoord - startCoord);
        setInnerWalls(prev => prev.map((iw, idx) => {
          if (idx !== wallHit.idx) return iw;
          if (clickOnStartSide) return { start: [...iw.start], end: [...ipt] };
          return { start: [...ipt], end: [...iw.end] };
        }));
      } else {
        // Trim boundary wall: move the nearest corner to the intersection point
        const i = wallHit.idx;
        // Move the farther corner (trim the excess), or the side the user clicked
        const newBoundary = boundary.map(p => [...p]);
        if (wallHit.t < 0.5) {
          // Clicked near start → trim start side → move start to intersection
          newBoundary[i] = [...ipt];
          if (i === 0) newBoundary[newBoundary.length - 1] = [...ipt];
        } else {
          // Clicked near end → trim end side → move end to intersection
          newBoundary[i + 1] = [...ipt];
          if (i + 1 === newBoundary.length - 1) newBoundary[0] = [...ipt];
        }
        setBoundary(newBoundary);
      }
      setTrimFirst(null);
      return;
    }

    // Erase tool
    if (tool === "erase") {
      if (hit?.type === "innerWall") {
        pushHistory();
        setInnerWalls(prev => prev.filter((_, idx) => idx !== hit.idx));
      } else if (hit?.type === "opening") {
        pushHistory();
        setOpenings(prev => prev.filter((_, idx) => idx !== hit.idx));
      }
      return;
    }

    // Door/window
    if (tool === "door" || tool === "window") {
      if (hit?.type === "wall") {
        const i = hit.idx;
        const [x1, z1] = boundary[i], [x2, z2] = boundary[i + 1];
        const wallLen = Math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2);
        const openingLen = tool === "door" ? doorSize / 1000 : windowSize / 1000;
        if (wallLen < openingLen + 0.2) return;
        const pos = snap(hit.t * wallLen - openingLen / 2);
        const clampedPos = Math.max(0.1, Math.min(wallLen - openingLen - 0.1, pos));
        pushHistory();
        // Doors on boundary walls default to 'entrance', can be toggled
        const role = tool === "door" ? "entrance" : undefined;
        setOpenings(prev => [...prev, { wallIdx: i, pos: snap(clampedPos), len: snap(openingLen), type: tool, flip: tool === "door" ? doorFlip : 0, role }]);
        setTool("select");
      }
      return;
    }

    // Select tool
    if (!hit) {
      setSelectedCorner(null); setSelectedOpeningIdx(null); setSelectedInnerWall(null);
      return;
    }
    if (hit.type === "corner") {
      setSelectedCorner(hit.idx); setSelectedOpeningIdx(null); setSelectedInnerWall(null);
      setDragging({ type: "corner", idx: hit.idx, startMouse: { x, y }, startPts: boundary.map(p => [...p]) });
    } else if (hit.type === "wall") {
      setSelectedCorner(hit.idx); setSelectedOpeningIdx(null); setSelectedInnerWall(null);
      setDragging({ type: "wall", idx: hit.idx, startMouse: { x, y }, startPts: boundary.map(p => [...p]) });
    } else if (hit.type === "opening") {
      setSelectedOpeningIdx(hit.idx); setSelectedCorner(null); setSelectedInnerWall(null);
      setDragging({ type: "opening", idx: hit.idx, startMouse: { x, y }, startPos: openings[hit.idx].pos, startWallIdx: openings[hit.idx].wallIdx });
    } else if (hit.type === "innerWall") {
      setSelectedInnerWall(hit.idx); setSelectedCorner(null); setSelectedOpeningIdx(null);
      setDragging({ type: "innerWall", idx: hit.idx, startMouse: { x, y }, startWall: { ...innerWalls[hit.idx], start: [...innerWalls[hit.idx].start], end: [...innerWalls[hit.idx].end] } });
    }
  }, [hitTest, getMousePos, tool, boundary, openings, innerWalls, drawStart, pushHistory, doorSize, windowSize, doorFlip, trimFirst]);

  const onMouseMove = useCallback((e) => {
    const { x, y } = getMousePos(e);
    const itx = itxRef.current, itz = itzRef.current;
    if (!itx) return;

    setMouseWorld([snap(itx(x)), snap(itz(y))]);

    if (dragging) {
      const worldX = snap(itx(x)), worldZ = snap(itz(y));
      const startWorldX = snap(itx(dragging.startMouse.x)), startWorldZ = snap(itz(dragging.startMouse.y));
      const deltaX = worldX - startWorldX, deltaZ = worldZ - startWorldZ;

      if (dragging.type === "corner") {
        const i = dragging.idx;
        const newB = dragging.startPts.map(p => [...p]);
        const prev = i > 0 ? i - 1 : newB.length - 2;
        const next = i < newB.length - 1 ? i + 1 : 1;
        const origPt = dragging.startPts[i];
        const prevPt = dragging.startPts[prev];
        const nextPt = dragging.startPts[next >= newB.length ? 1 : next];
        newB[i] = [snap(origPt[0] + deltaX), snap(origPt[1] + deltaZ)];
        if (Math.abs(prevPt[0] - origPt[0]) < 0.01) newB[prev][0] = newB[i][0]; else newB[prev][1] = newB[i][1];
        const ni = next >= newB.length ? 1 : next;
        if (Math.abs(nextPt[0] - origPt[0]) < 0.01) newB[ni][0] = newB[i][0]; else newB[ni][1] = newB[i][1];
        newB[newB.length - 1] = [...newB[0]];
        setBoundary(newB);
      } else if (dragging.type === "wall") {
        const i = dragging.idx;
        const newB = dragging.startPts.map(p => [...p]);
        const [x1, z1] = dragging.startPts[i], [x2, z2] = dragging.startPts[i + 1];
        if (Math.abs(x2 - x1) < 0.01) {
          newB[i][0] = snap(x1 + deltaX); newB[i + 1][0] = snap(x2 + deltaX);
          if (i === 0) newB[newB.length - 1][0] = newB[0][0];
          if (i + 1 === newB.length - 1) newB[0][0] = newB[newB.length - 1][0];
        } else {
          newB[i][1] = snap(z1 + deltaZ); newB[i + 1][1] = snap(z2 + deltaZ);
          if (i === 0) newB[newB.length - 1][1] = newB[0][1];
          if (i + 1 === newB.length - 1) newB[0][1] = newB[newB.length - 1][1];
        }
        setBoundary(newB);
      } else if (dragging.type === "innerWall") {
        const w = dragging.startWall;
        setInnerWalls(prev => prev.map((iw, idx) => idx === dragging.idx
          ? { start: [snap(w.start[0] + deltaX), snap(w.start[1] + deltaZ)], end: [snap(w.end[0] + deltaX), snap(w.end[1] + deltaZ)] }
          : iw
        ));
      } else if (dragging.type === "opening") {
        // Slide opening along its wall
        const oi = dragging.idx;
        const op = openings[oi];
        const wi = op.wallIdx;
        if (wi < boundary.length - 1) {
          const [wx1, wz1] = boundary[wi], [wx2, wz2] = boundary[wi + 1];
          const wallLen = Math.sqrt((wx2 - wx1) ** 2 + (wz2 - wz1) ** 2);
          // Project mouse onto wall line to get new position
          const dx = (wx2 - wx1) / wallLen, dz = (wz2 - wz1) / wallLen;
          const mouseProj = (worldX - wx1) * dx + (worldZ - wz1) * dz;
          const newPos = snap(mouseProj - op.len / 2);
          const clamped = Math.max(0, Math.min(wallLen - op.len, newPos));
          setOpenings(prev => prev.map((o, idx) => idx === oi ? { ...o, pos: snap(clamped) } : o));
        }
      }
    } else {
      const hit = hitTest(x, y);
      setHoverInfo(hit);
      if (tool === "wall") cvs.current.style.cursor = "crosshair";
      else if (tool === "split") cvs.current.style.cursor = hit?.type === "wall" ? "crosshair" : "default";
      else if (tool === "trim") cvs.current.style.cursor = (hit?.type === "wall" || hit?.type === "innerWall") ? "crosshair" : "default";
      else if (tool === "erase") cvs.current.style.cursor = (hit?.type === "innerWall" || hit?.type === "opening") ? "not-allowed" : "default";
      else if (tool === "door" || tool === "window") cvs.current.style.cursor = hit?.type === "wall" ? "crosshair" : "default";
      else if (hit) cvs.current.style.cursor = (hit.type === "corner" || hit.type === "opening") ? "move" : "pointer";
      else cvs.current.style.cursor = "default";
    }
  }, [dragging, getMousePos, hitTest, tool, boundary, openings]);

  const onMouseUp = useCallback(() => {
    if (dragging) {
      // Push history on drag end (before drag started state was the startPts)
      historyRef.current.push({
        boundary: (dragging.startPts || boundary).map(p => [...p]),
        openings: openings.map(o => ({ ...o })),
        innerWalls: innerWalls.map(w => ({ start: [...w.start], end: [...w.end] })),
      });
      if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    }
    setDragging(null);
  }, [dragging, boundary, openings, innerWalls]);

  // ── Wheel zoom ──
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const rect = cvs.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setCamera(prev => {
      const newZoom = Math.max(0.2, Math.min(10, prev.zoom * factor));
      // Keep world point under mouse fixed:
      // sx = oxBase + cx + (worldX - xMin) * baseScale * zoom
      // Solve: cx_new = cx_old + (mx - oxBase - cx_old) * (1 - newZoom / oldZoom)
      const r = newZoom / prev.zoom;
      const ob = oxBaseRef.current;
      const obz = ozBaseRef.current;
      const nx = prev.x + (mx - ob - prev.x) * (1 - r);
      const ny = prev.y + (my - obz - prev.y) * (1 - r);
      return { x: nx, y: ny, zoom: newZoom };
    });
  }, []);

  // ── Right-click pan wrappers ──
  const onCanvasMouseDown = useCallback((e) => {
    if (e.button === 2 || e.button === 1) {
      // Right click or middle click → pan
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y };
      return;
    }
    onMouseDown(e);
  }, [onMouseDown, camera]);

  const onCanvasMouseMove = useCallback((e) => {
    if (isPanning.current) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setCamera(prev => ({ ...prev, x: panStart.current.cx + dx, y: panStart.current.cy + dy }));
      return;
    }
    onMouseMove(e);
  }, [onMouseMove]);

  const onCanvasMouseUp = useCallback((e) => {
    if (isPanning.current) {
      isPanning.current = false;
      return;
    }
    onMouseUp(e);
  }, [onMouseUp]);

  const deleteSelected = useCallback(() => {
    if (selectedOpeningIdx !== null) {
      pushHistory();
      setOpenings(prev => prev.filter((_, idx) => idx !== selectedOpeningIdx));
      setSelectedOpeningIdx(null);
    } else if (selectedInnerWall !== null) {
      pushHistory();
      setInnerWalls(prev => prev.filter((_, i) => i !== selectedInnerWall));
      setSelectedInnerWall(null);
    }
  }, [selectedOpeningIdx, selectedInnerWall, pushHistory]);

  // Keyboard
  useEffect(() => {
    const handler = (e) => {
      // Don't hijack keys while typing in form fields (mm inputs, etc.)
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;

      // Read latest state via refs (handler is attached once → avoid stale closures)
      const curTool = toolRef.current;
      const curSelOpening = selectedOpeningIdxRef.current;
      const curSelInner = selectedInnerWallRef.current;
      const curOpenings = openingsRef.current;

      // Normalize so Shift / CapsLock variants (e.g. "V") still match.
      const k = (e.key || "").toLowerCase();

      // Ctrl+Z / Cmd+Z undo
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undo(); return; }
      // Ignore other modifier combos (e.g. Cmd+W) so we don't fight the browser.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
      if (e.key === "Escape") { setTool("select"); setSelectedCorner(null); setSelectedOpeningIdx(null); setSelectedInnerWall(null); setDrawStart(null); setTrimFirst(null); return; }
      if (k === " " && curTool === "door") { e.preventDefault(); setDoorFlip(f => (f + 1) % 4); return; }
      if (k === " " && curSelOpening !== null && curOpenings[curSelOpening]?.type === "door") {
        e.preventDefault();
        pushHistory();
        setOpenings(prev => prev.map((o, idx) => idx === curSelOpening ? { ...o, flip: ((o.flip || 0) + 1) % 4 } : o));
        return;
      }
      if (k === "d") { setTool("door"); return; }
      if (k === "w") { setTool("wall"); setDrawStart(null); return; }
      if (k === "q") { setTool("window"); return; }
      if (k === "s") { setTool("split"); return; }
      if (k === "e") { if (curSelOpening !== null || curSelInner !== null) deleteSelected(); else setTool("erase"); return; }
      if (k === "t") { setTool("trim"); setTrimFirst(null); return; }
      if (k === "v") { setTool("select"); return; }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteSelected, undo, pushHistory]);

  // Export
  const exportJSON = () => {
    const exportBoundary = boundary.map(([x, z]) => [-x, z]);
    const exportInner = innerWalls.map(w => ({ start: [-w.start[0], w.start[1]], end: [-w.end[0], w.end[1]] }));
    const out = { boundary: exportBoundary, openings, innerWalls: exportInner, wallThickness: WALL_T };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "floorplan_edited.json"; a.click();
  };

  // ── MOVE MATE Logo SVG ──
  const MovemateLogo = ({ size = 40 }) => (
    <svg width={size} height={size * 0.85} viewBox="0 0 48 41" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 38 L2 6 L24 28 L46 6 L46 38" stroke="#111" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <path d="M11 26 L24 38 L37 26" stroke="#111" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );

  // ── Upload screen ──
  if (loading) return <div style={{ padding: 40, textAlign: "center", fontFamily: FONT, color: "#999" }}>Loading...</div>;
  if (!data) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#fff" }}
      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
      <div style={{ maxWidth: 440, width: "100%", textAlign: "center", padding: 32 }}>
        {/* Logo */}
        <div style={{ marginBottom: 16 }}>
          <MovemateLogo size={56} />
        </div>
        <div style={{ letterSpacing: "0.35em", fontSize: 13, fontWeight: 500, color: "#111", marginBottom: 4 }}>MOVE MATE</div>
        <div style={{ fontSize: 12, color: "#bbb", letterSpacing: "0.1em", marginBottom: 36 }}>FLOOR PLAN EDITOR</div>

        {err && <p style={{ color: "#e11d48", fontSize: 13, marginBottom: 12 }}>{err}</p>}
        <div
          onClick={() => { const el = document.createElement("input"); el.type = "file"; el.accept = ".json,.glb"; el.onchange = ev => { if (ev.target.files[0]) handleFile(ev.target.files[0]); }; el.click(); }}
          style={{ border: "1.5px dashed #ccc", borderRadius: 16, padding: "52px 32px", cursor: "pointer", transition: "all 0.2s" }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "#111"; e.currentTarget.style.background = "#fafafa"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = "#ccc"; e.currentTarget.style.background = "#fff"; }}
        >
          <div style={{ fontSize: 28, marginBottom: 10 }}>+</div>
          <div style={{ fontSize: 14, color: "#444", fontWeight: 500 }}>파일을 드래그하거나 클릭하세요</div>
          <div style={{ fontSize: 12, color: "#aaa", marginTop: 6, letterSpacing: "0.05em" }}>GLB · JSON</div>
        </div>
      </div>
    </div>
  );

  // ── Main editor ──
  const ToolBtn = ({ id, label, shortcut }) => (
    <button onClick={() => { setTool(id); setDrawStart(null); }}
      style={{
        padding: "6px 12px", fontSize: 13, fontFamily: FONT, fontWeight: 500,
        border: tool === id ? "2px solid #111" : "1px solid #ddd",
        background: tool === id ? "#111" : "#fff",
        color: tool === id ? "#fff" : "#333",
        borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
      }}>
      {label}
      {shortcut && <span style={{ fontSize: 10, color: "#aaa", background: "#f5f5f5", padding: "1px 4px", borderRadius: 3 }}>{shortcut}</span>}
    </button>
  );

  const selOpening = selectedOpeningIdx !== null ? openings[selectedOpeningIdx] : null;
  const canDelete = selOpening || selectedInnerWall !== null;

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", height: "100vh", background: "#fafafa" }}>
      <div style={{ padding: "7px 14px", borderBottom: "1px solid #e8e8e8", background: "#fff", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
        {/* MOVE MATE branding */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}>
          <MovemateLogo size={28} />
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ letterSpacing: "0.2em", fontSize: 10, fontWeight: 600, color: "#111" }}>MOVE MATE</span>
            <span style={{ letterSpacing: "0.08em", fontSize: 9, color: "#aaa" }}>FLOOR PLAN</span>
          </div>
        </div>
        <div style={{ width: 1, height: 24, background: "#e8e8e8" }} />

        <ToolBtn id="select" label="Select" shortcut="V" />
        <ToolBtn id="wall" label="Wall" shortcut="W" />
        <ToolBtn id="split" label="Split" shortcut="S" />
        <ToolBtn id="trim" label="Trim" shortcut="T" />
        <ToolBtn id="erase" label="Erase" shortcut="E" />
        <ToolBtn id="door" label="Door" shortcut="D" />
        {tool === "door" && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#555" }}>
            <input type="number" value={doorSize} onChange={e => setDoorSize(Number(e.target.value) || 900)} step="100" min="400" max="2400"
              style={{ width: 55, padding: "3px 4px", border: "1px solid #ddd", borderRadius: 4, fontSize: 12, textAlign: "center", fontFamily: FONT }}
            />
            <span style={{ color: "#999", fontSize: 11 }}>mm</span>
            <span style={{ color: "#aaa", fontSize: 10, marginLeft: 2 }}>Space: flip</span>
          </div>
        )}
        <ToolBtn id="window" label="Window" shortcut="Q" />
        {tool === "window" && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#555" }}>
            <input type="number" value={windowSize} onChange={e => setWindowSize(Number(e.target.value) || 1200)} step="100" min="300" max="3000"
              style={{ width: 55, padding: "3px 4px", border: "1px solid #ddd", borderRadius: 4, fontSize: 12, textAlign: "center", fontFamily: FONT }}
            />
            <span style={{ color: "#999", fontSize: 11 }}>mm</span>
          </div>
        )}

        <div style={{ width: 1, height: 24, background: "#e5e5e5" }} />

        <div style={{ display: "flex", border: "1px solid #ddd", borderRadius: 6, overflow: "hidden" }}>
          {["2d", "3d"].map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              style={{ padding: "6px 14px", fontSize: 13, border: "none", cursor: "pointer",
                background: viewMode === m ? "#111" : "#fff", color: viewMode === m ? "#fff" : "#555",
                fontWeight: viewMode === m ? 700 : 400 }}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 24, background: "#e5e5e5" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555" }}>
          <span>Point cloud</span>
          <input type="range" min="0" max="100" step="10" value={pointOpacity}
            onChange={e => setPointOpacity(Number(e.target.value))}
            style={{ width: 80, accentColor: "#111", cursor: "pointer" }} />
          <span style={{ fontSize: 11, color: "#999", minWidth: 28, textAlign: "right" }}>{pointOpacity}%</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555" }}>
          <span>벽</span>
          <input type="range" min="0" max="100" step="5" value={wallOpacity}
            onChange={e => setWallOpacity(Number(e.target.value))}
            style={{ width: 70, accentColor: "#111", cursor: "pointer" }} />
          <span style={{ fontSize: 11, color: "#999", minWidth: 28, textAlign: "right" }}>{wallOpacity}%</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555" }}>
          <span>바닥</span>
          <input type="range" min="0" max="60" step="5" value={planeOpacity}
            onChange={e => setPlaneOpacity(Number(e.target.value))}
            style={{ width: 70, accentColor: "#2563eb", cursor: "pointer" }} />
          <span style={{ fontSize: 11, color: "#999", minWidth: 28, textAlign: "right" }}>{planeOpacity}%</span>
        </div>

        {detected?.furniture?.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={showFurniture} onChange={e => setShowFurniture(e.target.checked)} style={{ accentColor: "#f59e0b", cursor: "pointer" }} />
              가구 ({detected.furniture.length})
            </label>
            <input type="range" min="0" max="100" step="5" value={furnOpacity}
              onChange={e => setFurnOpacity(Number(e.target.value))}
              style={{ width: 70, accentColor: "#f59e0b", cursor: "pointer" }} />
            <span style={{ fontSize: 11, color: "#999", minWidth: 28, textAlign: "right" }}>{furnOpacity}%</span>
            {detected.countsV4V5 && (
              <span style={{ fontSize: 11, color: "#999" }}>v4 {detected.countsV4V5.v4}/v5 {detected.countsV4V5.v5}</span>
            )}
          </div>
        )}

        {detected && (detected.rooms.length > 0 || detected.openings.length > 0) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#555" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={showDetected} onChange={e => setShowDetected(e.target.checked)} style={{ accentColor: "#2563eb", cursor: "pointer" }} />
              감지결과
            </label>
            <span style={{ fontSize: 11, color: "#999" }}>
              방 {detected.rooms.length} · 개구부 {detected.openings.length}
              {detected.rotationDeg != null ? ` · 회전 ${detected.rotationDeg}°` : ""}
            </span>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {selOpening && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#555" }}>
            <span>{selOpening.type === "door" ? "Door" : "Window"}</span>
            <input type="number" value={Math.round(selOpening.len * 1000)}
              onChange={e => {
                const mm = Number(e.target.value);
                if (!mm || mm < 200 || mm > 4000) return;
                pushHistory();
                const newLen = snap(mm / 1000);
                setOpenings(prev => prev.map((o, idx) => idx === selectedOpeningIdx ? { ...o, len: newLen } : o));
              }}
              step="100" min="200" max="4000"
              style={{ width: 55, padding: "3px 4px", border: "1px solid #ddd", borderRadius: 4, fontSize: 12, textAlign: "center", fontFamily: FONT }}
            />
            <span style={{ color: "#999", fontSize: 11 }}>mm</span>
            {selOpening.type === "door" && (<>
              <span style={{ color: "#aaa", fontSize: 10, marginLeft: 2 }}>Space: flip</span>
              <button onClick={() => {
                  pushHistory();
                  const newRole = selOpening.role === "entrance" ? "interior" : "entrance";
                  setOpenings(prev => prev.map((o, idx) => idx === selectedOpeningIdx ? { ...o, role: newRole } : o));
                }}
                style={{
                  marginLeft: 4, padding: "2px 8px", fontSize: 11, borderRadius: 4, cursor: "pointer", fontFamily: FONT,
                  background: selOpening.role === "entrance" ? "#fef2f2" : "#f0fdf4",
                  color: selOpening.role === "entrance" ? "#dc2626" : "#16a34a",
                  border: selOpening.role === "entrance" ? "1px solid #fca5a5" : "1px solid #86efac",
                }}>
                {selOpening.role === "entrance" ? "현관문" : "실내문"}
              </button>
            </>)}
          </div>
        )}

        {canDelete && (
          <button onClick={deleteSelected}
            style={{ padding: "5px 12px", fontSize: 12, background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 5, cursor: "pointer", fontFamily: FONT }}>
            Delete (Del)
          </button>
        )}

        <button onClick={() => {
            if (!originalBoundaryRef.current.length) return;
            pushHistory();
            setBoundary(originalBoundaryRef.current.map(p => [...p]));
            setOpenings([]); setInnerWalls([]);
            setSelectedCorner(null); setSelectedOpeningIdx(null); setSelectedInnerWall(null); setDrawStart(null);
          }}
          style={{ padding: "6px 12px", fontSize: 13, background: "#fff8f0", color: "#c2410c", border: "1px solid #fed7aa", borderRadius: 6, cursor: "pointer", fontFamily: FONT }}>
          Revert
        </button>
        <button onClick={undo}
          style={{ padding: "6px 12px", fontSize: 13, background: "#fff", color: "#555", border: "1px solid #ddd", borderRadius: 6, cursor: "pointer", fontFamily: FONT }}>
          Undo (Ctrl+Z)
        </button>
        <button onClick={exportJSON}
          style={{ padding: "6px 12px", fontSize: 13, background: "#111", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FONT, fontWeight: 500 }}>
          Export
        </button>
        <button onClick={() => { storage.delete(SK); setData(null); setBoundary([]); setOpenings([]); setInnerWalls([]); setDetected(null); historyRef.current = []; onExit?.(); }}
          style={{ padding: "6px 12px", fontSize: 13, background: "#fff", color: "#666", border: "1px solid #ddd", borderRadius: 6, cursor: "pointer", fontFamily: FONT }}>
          Reset
        </button>
      </div>

      <div ref={wrapRef} style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <canvas ref={cvs}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
          onWheel={onWheel}
          onContextMenu={e => e.preventDefault()}
          style={{ display: viewMode === "3d" ? "none" : "block" }}
        />
        {viewMode === "3d" && (
          <div style={{ position: "absolute", inset: 0 }}>
            <Plan3DView
              boundary={boundary}
              rooms={detected?.rooms || []}
              furniture={(showFurniture && detected?.furniture) ? detected.furniture : []}
              openings={openings}
              glbFile={glbFile}
              rotationRad={typeof data?.rotation_angle === "number" ? data.rotation_angle : 0}
              floorY={typeof data?.floor_y === "number" ? data.floor_y : 0}
              wallHeight={data?.ceil_y && data?.floor_y ? (data.ceil_y - data.floor_y) : (data?.m?.h?.length ? Math.max(...data.m.h) + 0.2 : 2.4)}
            />
          </div>
        )}
        <div style={{
          position: "absolute", bottom: 8, left: 8, padding: "4px 10px",
          background: "rgba(255,255,255,0.9)", borderRadius: 4, fontSize: 12, color: "#888",
          backdropFilter: "blur(4px)", border: "1px solid #eee",
        }}>
          {Math.round(camera.zoom * 100)}% &middot; Snap: {SNAP * 1000}mm &middot;
          {boundary.length - 1} corners &middot; {innerWalls.length} inner walls &middot; {openings.length} openings
          {mouseWorld && <> &middot; ({mouseWorld[0].toFixed(1)}, {mouseWorld[1].toFixed(1)})</>}
          <span onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}
            style={{ marginLeft: 6, cursor: "pointer", color: "#2563eb", textDecoration: "underline" }}>Fit</span>
        </div>
        {tool !== "select" && (
          <div style={{
            position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
            padding: "6px 16px", background: "rgba(37,99,235,0.9)", borderRadius: 6,
            fontSize: 13, color: "#fff", fontWeight: 500, backdropFilter: "blur(4px)",
          }}>
            {tool === "wall" && (drawStart ? "Click next point (Esc to stop)" : "Click start point")}
            {tool === "split" && "Click on boundary wall to split"}
            {tool === "trim" && (!trimFirst ? "1st: Click cutting wall" : "2nd: Click wall to trim/extend")}
            {tool === "erase" && "Click inner wall or opening to erase"}
            {tool === "door" && `Click wall to add door (${doorSize}mm) · Space to flip`}
            {tool === "window" && `Click wall to add window (${windowSize}mm)`}
          </div>
        )}
      </div>
    </div>
  );
}
