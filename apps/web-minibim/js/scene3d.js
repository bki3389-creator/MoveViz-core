// scene3d.js — three.js 3D 스튜디오: 바닥/벽(개구부 컷)/천장/가구/조명 실물 + 클릭 선택·조명 배치.
// 좌표: 평면 (x, z) → three (x, y=높이, z). 방들은 layoutOffsets 대로 X축 나열.

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/addons/controls/OrbitControls.js';
import { state, emit, layoutOffsets, wallsOf, ceilH, addLight, room } from './state.js';
import { item, rateOf, FINISH_WALL } from './catalog.js';

let renderer, scene, camera, controls, root, raycaster, container;
let highlight = null;   // { mesh, prevEmissive }
let hoverMarker = null;

export function init3D(el) {
  container = el;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NoToneMapping;   // 재료 색 그대로(기본) — 조명효과 켜면 ACES
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef1f5);
  scene.fog = new THREE.Fog(0xeef1f5, 40, 110);

  camera = new THREE.PerspectiveCamera(52, 1, 0.05, 300);
  camera.position.set(7, 8, 11);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa1a9, 1.0);
  scene.add(hemi);
  window.__psHemi = hemi;
  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  sun.position.set(10, 16, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -20; sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
  scene.add(sun);

  const grid = new THREE.GridHelper(60, 60, 0xc6cdd6, 0xdde2e9);
  grid.position.y = -0.011;
  scene.add(grid);

  root = new THREE.Group();
  scene.add(root);
  raycaster = new THREE.Raycaster();

  hoverMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.11, 24),
    new THREE.MeshBasicMaterial({ color: 0xe9c46a, side: THREE.DoubleSide }));
  hoverMarker.rotation.x = -Math.PI / 2;
  hoverMarker.visible = false;
  scene.add(hoverMarker);

  renderer.domElement.addEventListener('pointerdown', e => { _down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', onClick);
  renderer.domElement.addEventListener('pointermove', onHover);
  new ResizeObserver(resize).observe(el);
  resize();
  animate();
}

let _down = null;
function resize() {
  if (!container) return;
  const w = container.clientWidth || 400, h = container.clientHeight || 300;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ── 씬 구성 ─────────────────────────────────────────

const matCache = new Map();
function colorMat(color, rough = 0.9, metal = 0.0) {
  const key = color + ':' + rough;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  }
  return matCache.get(key).clone();   // emissive 하이라이트를 위해 clone
}

// 바닥 마감 절차 텍스처: 캔버스 1장이 실제 SIZE(m)×SIZE(m) 를 표현 → UV(m좌표)에 맞춰 반복
const texCache = new Map();
function floorTexture(finishId, baseColor) {
  if (texCache.has(finishId)) return texCache.get(finishId);
  const SPEC = {
    fl_laminate: { size: 1.2, kind: 'wood', plank: 0.15 },
    fl_hardwood: { size: 1.2, kind: 'wood', plank: 0.12 },
    fl_tile600:  { size: 1.2, kind: 'tile', tile: 0.6 },
    fl_tile300:  { size: 1.2, kind: 'tile', tile: 0.3 },
    fl_sheet:    { size: 1.2, kind: 'flat' },
  }[finishId];
  if (!SPEC) { texCache.set(finishId, null); return null; }
  const px = 512, c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const col = '#' + baseColor.toString(16).padStart(6, '0');
  g.fillStyle = col; g.fillRect(0, 0, px, px);
  const mpp = px / SPEC.size;   // px per meter
  if (SPEC.kind === 'wood') {
    const rows = Math.round(SPEC.size / SPEC.plank);
    for (let i = 0; i < rows; i++) {
      const y = i * SPEC.plank * mpp;
      // 플랭크별 미묘한 명도 변화 + 접합선 + 세로 조인트(엇갈림)
      g.fillStyle = `rgba(${(i % 3) * 8 + 60},40,20,${0.05 + (i % 2) * 0.04})`;
      g.fillRect(0, y, px, SPEC.plank * mpp);
      g.strokeStyle = 'rgba(60,35,15,0.35)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(0, y); g.lineTo(px, y); g.stroke();
      const jx = ((i * 0.37) % 1) * px;
      g.beginPath(); g.moveTo(jx, y); g.lineTo(jx, y + SPEC.plank * mpp); g.stroke();
    }
  } else if (SPEC.kind === 'tile') {
    g.strokeStyle = 'rgba(70,80,90,0.45)'; g.lineWidth = 2;
    for (let v = 0; v <= SPEC.size + 1e-6; v += SPEC.tile) {
      const q = v * mpp;
      g.beginPath(); g.moveTo(q, 0); g.lineTo(q, px); g.stroke();
      g.beginPath(); g.moveTo(0, q); g.lineTo(px, q); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(1 / SPEC.size, 1 / SPEC.size);
  tex.anisotropy = 4;
  texCache.set(finishId, tex);
  return tex;
}

// ── 파라메트릭 가구 (footprint w×d 에 맞춰 조립) ──────────────
const FM = {
  wood: 0x9a7b52, woodDark: 0x7a5f3e, fabric: 0x93a7b1, fabricDark: 0x7b8f99,
  white: 0xf2f2ef, metal: 0xdadee2, dark: 0x3a3f45, glass: 0x9fc4dd, bedding: 0xdfe6e2,
};
function fpart(g2, w, h, d, color, x, y, z, rough = 0.85) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: rough }));
  m.position.set(x, y, z);
  g2.add(m);
  return m;
}
function fcyl(g2, r1, h, color, x, y, z, rotZ90 = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r1, h, 18),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
  if (rotZ90) m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  g2.add(m);
  return m;
}
// 로컬: x=폭방향, z=깊이방향(문/등받이 = -z 쪽), y=위
function buildFurniture(cat, w, d) {
  const g2 = new THREE.Group();
  const legs = (h, inset = 0.06, r = 0.022) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1])
      fcyl(g2, r, h, FM.woodDark, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset));
  };
  switch (cat) {
    case 'bed': {
      fpart(g2, w, 0.22, d, FM.wood, 0, 0.11, 0);                          // 프레임
      fpart(g2, w * 0.96, 0.18, d * 0.96, FM.white, 0, 0.31, 0, 0.95);     // 매트리스
      fpart(g2, w, 0.55, 0.06, FM.woodDark, 0, 0.35, -d / 2 + 0.03);       // 헤드보드
      const pw = w > 1.2 ? 2 : 1;
      for (let i = 0; i < pw; i++)
        fpart(g2, w * 0.34, 0.09, 0.42, FM.bedding, (i - (pw - 1) / 2) * w * 0.42, 0.45, -d / 2 + 0.32, 0.98);
      fpart(g2, w * 0.98, 0.06, d * 0.55, FM.fabric, 0, 0.42, d * 0.2, 0.98);  // 이불
      break;
    }
    case 'sofa': case 'couch': {
      fpart(g2, w, 0.32, d, FM.fabricDark, 0, 0.16, 0);                    // 베이스
      fpart(g2, w, 0.45, d * 0.28, FM.fabric, 0, 0.52, -d / 2 + d * 0.14); // 등받이
      for (const sx of [-1, 1])
        fpart(g2, w * 0.1, 0.5, d, FM.fabricDark, sx * (w / 2 - w * 0.05), 0.28, 0);  // 팔걸이
      const nc = w > 1.7 ? 3 : 2;
      for (let i = 0; i < nc; i++)
        fpart(g2, (w * 0.78) / nc - 0.02, 0.1, d * 0.55, FM.fabric,
              (i - (nc - 1) / 2) * (w * 0.78) / nc, 0.37, d * 0.1, 0.98);  // 방석
      break;
    }
    case 'chair': case 'stool': {
      fpart(g2, w * 0.9, 0.06, d * 0.9, FM.wood, 0, 0.45, 0);
      fpart(g2, w * 0.86, 0.45, 0.05, FM.wood, 0, 0.72, -d / 2 + 0.04);
      legs(0.44, 0.05, 0.018);
      break;
    }
    case 'table': case 'desk': {
      fpart(g2, w, 0.05, d, FM.wood, 0, 0.72, 0);
      legs(0.70);
      break;
    }
    case 'refrigerator': case 'fridge': {
      fpart(g2, w, 1.8, d, FM.metal, 0, 0.9, 0, 0.5);
      fpart(g2, w * 0.98, 0.015, d * 0.98, FM.dark, 0, 1.15, 0);                    // 냉장/냉동 분리선
      for (const sy of [1.45, 0.8])
        fpart(g2, 0.03, 0.35, 0.03, FM.dark, w * 0.32, sy, -d / 2 - 0.015);        // 손잡이
      break;
    }
    case 'cabinet': case 'wardrobe': case 'storage': case 'shelf': case 'rack': {
      const h = 1.2;
      fpart(g2, w, h, d, FM.wood, 0, h / 2, 0);
      const doors = Math.max(1, Math.round(w / 0.5));
      for (let i = 1; i < doors; i++)
        fpart(g2, 0.012, h * 0.92, 0.012, FM.woodDark, -w / 2 + (w / doors) * i, h / 2, -d / 2 - 0.005);
      for (let i = 0; i < doors; i++)
        fpart(g2, 0.025, 0.12, 0.02, FM.dark, -w / 2 + (w / doors) * (i + 0.78), h * 0.55, -d / 2 - 0.012);
      break;
    }
    case 'appliance': case 'washer': case 'washerdryer': {
      fpart(g2, w, 0.88, d, FM.white, 0, 0.44, 0, 0.4);
      const dm = fcyl(g2, Math.min(w, 0.88) * 0.33, 0.03, FM.dark, 0, 0.46, -d / 2 - 0.012, true);
      dm.material.roughness = 0.2;
      fpart(g2, w * 0.9, 0.1, 0.02, FM.metal, 0, 0.8, -d / 2 - 0.005);   // 조작부
      break;
    }
    case 'toilet': {
      fpart(g2, w * 0.9, 0.38, d * 0.3, FM.white, 0, 0.42, -d / 2 + d * 0.15, 0.3);  // 물탱크
      const bowl = fcyl(g2, Math.min(w, d * 0.6) * 0.5, 0.38, FM.white, 0, 0.19, d * 0.12);
      bowl.scale.z = 1.25;
      break;
    }
    case 'sink': case 'washbasin': case 'basin': {
      fpart(g2, w * 0.3, 0.62, d * 0.35, FM.white, 0, 0.31, 0, 0.3);
      fpart(g2, w, 0.13, d, FM.white, 0, 0.72, 0, 0.25);
      fpart(g2, 0.03, 0.14, 0.03, FM.metal, 0, 0.86, -d * 0.2);          // 수전
      break;
    }
    case 'bathtub': case 'tub': {
      fpart(g2, w, 0.55, d, FM.white, 0, 0.275, 0, 0.3);
      fpart(g2, w * 0.84, 0.04, d * 0.78, 0xdcebf2, 0, 0.54, 0, 0.15);   // 수면 느낌
      break;
    }
    case 'tv': case 'television': case 'monitor': {
      fpart(g2, w * 0.3, 0.04, Math.max(d, 0.25), FM.dark, 0, 0.02, 0);
      fpart(g2, 0.05, 0.35, 0.05, FM.dark, 0, 0.2, 0);
      fpart(g2, w, w * 0.34, 0.045, FM.dark, 0, 0.42 + w * 0.17, 0, 0.25);  // 패널
      break;
    }
    default: {
      const hF = FURN_H[cat] ?? 0.8;
      const m = fpart(g2, w, hF, d, 0x3f8f8a, 0, hF / 2, 0);
      m.material.transparent = true; m.material.opacity = 0.55;
    }
  }
  return g2;
}

const FURN_H = { bed: 0.5, sofa: 0.75, chair: 0.85, table: 0.72, cabinet: 1.2, refrigerator: 1.8,
                 tv: 0.7, toilet: 0.75, sink: 0.85, bathtub: 0.55, appliance: 0.9, fireplace: 1.0, stairs: 1.0 };

export function rebuild3D() {
  clearHighlight();
  for (const c of [...root.children]) {
    c.traverse?.(obj => {
      obj.geometry?.dispose?.();
      const m = obj.material;
      (Array.isArray(m) ? m : m ? [m] : []).forEach(x => x.dispose?.());
    });
    root.remove(c);
  }
  const P = state.project;
  if (!P?.rooms.length) return;
  const offs = layoutOffsets();

  // 모드: 재료 확인(밝고 균일) vs 조명 효과(실광원·톤매핑)
  if (window.__psHemi) window.__psHemi.intensity = state.lightFX ? 0.55 : 2.4;
  renderer.toneMapping = state.lightFX ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = state.lightFX ? 1.15 : 1.0;

  let lightCount = 0;
  for (const r of P.rooms) {
    const off = offs[r.id];
    if (!off?.bb) continue;
    const g = new THREE.Group();
    g.position.set(off.x, 0, off.z);
    root.add(g);
    buildRoom(r, g, () => state.lightFX && lightCount++ < 14);   // 실광원은 '조명 효과' 모드에서만
  }
}

function finishColor(id, fallback = 0xcccccc) { return item(id)?.color ?? fallback; }

function inPoly3(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0]) c = !c;
  }
  return c;
}

function buildRoom(r, g, allowRealLight) {
  const plan = r.plan, H = ceilH(plan);
  const bd = plan.boundary || [];
  if (bd.length < 3) return;

  // 바닥 — Shape(x, z) → rotateX(90°) → (x, 0, z)
  const shape = new THREE.Shape(bd.map(p => new THREE.Vector2(p[0], p[1])));
  const floorGeo = new THREE.ShapeGeometry(shape);
  floorGeo.rotateX(Math.PI / 2);
  const ftex = floorTexture(r.floorFinish, finishColor(r.floorFinish));
  const fmat = ftex
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, map: ftex, roughness: 0.82 })
    : colorMat(finishColor(r.floorFinish), 0.85);
  const floor = new THREE.Mesh(floorGeo, fmat);
  floor.material.side = THREE.DoubleSide;
  floor.receiveShadow = true;
  floor.userData = { roomId: r.id, kind: 'floor' };
  g.add(floor);

  // 천장
  const ceilGeo = floorGeo.clone();
  const ceil = new THREE.Mesh(ceilGeo, colorMat(finishColor(r.ceilFinish, 0xf2efe9), 0.95));
  ceil.material.side = THREE.DoubleSide;
  ceil.material.transparent = true;
  ceil.material.opacity = 0.92;
  ceil.position.y = H;
  ceil.visible = state.showCeiling;
  ceil.userData = { roomId: r.id, kind: 'ceiling', isCeil: true };
  g.add(ceil);
  // 간접등 박스: 둘레 단내림 느낌의 얇은 밴드
  if (r.ceilingType === 'ct_indirect' || r.ceilingType === 'ct_well') {
    for (const w of wallsOf(r).filter(w => !w.inner)) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(
        w.dir === 'z' ? w.len : 0.35, 0.15, w.dir === 'z' ? 0.35 : w.len),
        colorMat(0xe8e2d5, 0.95));
      const cx = w.dir === 'z' ? (w.lo + w.hi) / 2 : w.pos;
      const cz = w.dir === 'z' ? w.pos : (w.lo + w.hi) / 2;
      // 벽에서 방 안쪽으로 살짝
      band.position.set(cx, H - 0.075, cz);
      band.visible = state.showCeiling;
      band.userData = { roomId: r.id, kind: 'ceiling', isCeil: true };
      g.add(band);
    }
  }

  // 벽 — 세그먼트·개구부 컷
  const wallT = 0.12;
  for (const w of wallsOf(r)) {
    const finish = r.wallOverrides?.[w.key] || r.wallFinish;
    const col = finishColor(finish, 0xdedad2);
    const demo = r.wallTypes?.[w.key] === 'wt_demo';
    const boxes = [];   // {lo, hi, y0, y1}
    let cursor = w.lo;
    for (const o of w.openings) {
      if (o.lo > cursor + 0.01) boxes.push({ lo: cursor, hi: o.lo, y0: 0, y1: H });
      if (o.type === 'door') {
        boxes.push({ lo: o.lo, hi: o.hi, y0: o.h, y1: H });                       // 인방
      } else {
        const sill = Math.max(0.1, (H - o.h) * 0.55);                              // 창대 높이 근사
        boxes.push({ lo: o.lo, hi: o.hi, y0: 0, y1: sill });
        boxes.push({ lo: o.lo, hi: o.hi, y0: Math.min(H, sill + o.h), y1: H });
        if (!o.foreign) boxes.push({ lo: o.lo, hi: o.hi, y0: sill, y1: sill + o.h, glass: true }); // 유리(소유 방만)
      }
      cursor = Math.max(cursor, o.hi);
    }
    if (cursor < w.hi - 0.01) boxes.push({ lo: cursor, hi: w.hi, y0: 0, y1: H });
    if (!w.openings.length) { boxes.length = 0; boxes.push({ lo: w.lo, hi: w.hi, y0: 0, y1: H }); }

    for (const b of boxes) {
      const len = b.hi - b.lo, hgt = b.y1 - b.y0;
      if (len < 0.02 || hgt < 0.02) continue;
      let mesh;
      if (b.glass) {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w.dir === 'z' ? len : 0.02, hgt, w.dir === 'z' ? 0.02 : len),
          new THREE.MeshStandardMaterial({ color: 0x9fc8e8, transparent: true, opacity: 0.3, roughness: 0.1 }));
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w.dir === 'z' ? len : wallT, hgt, w.dir === 'z' ? wallT : len),
          colorMat(col, 0.92));
        if (demo) { mesh.material.transparent = true; mesh.material.opacity = 0.25; mesh.material.color.set(0xd9534f); }
        mesh.castShadow = true; mesh.receiveShadow = true;
      }
      const cx = w.dir === 'z' ? (b.lo + b.hi) / 2 : w.pos;
      const cz = w.dir === 'z' ? w.pos : (b.lo + b.hi) / 2;
      mesh.position.set(cx, (b.y0 + b.y1) / 2, cz);
      mesh.userData = { roomId: r.id, kind: 'wall', wallKey: w.key };
      g.add(mesh);
      // 걸레받이 (바닥에 닿는 조각만)
      if (!b.glass && b.y0 === 0 && !demo) {
        const bb2 = new THREE.Mesh(new THREE.BoxGeometry(
          w.dir === 'z' ? (b.hi - b.lo) : wallT + 0.02, 0.08, w.dir === 'z' ? wallT + 0.02 : (b.hi - b.lo)),
          colorMat(0x6e5a44, 0.85));
        bb2.position.set(cx, 0.04, cz);
        bb2.userData = { roomId: r.id, kind: 'wall', wallKey: w.key };
        g.add(bb2);
      }
    }
    // 개구부 디테일: 창틀 / 문틀+문짝(안쪽으로 25° 열림)
    for (const op2 of w.openings) {
      const mid = (op2.lo + op2.hi) / 2;
      const px = w.dir === 'z' ? mid : w.pos, pz = w.dir === 'z' ? w.pos : mid;
      const alongLen = op2.hi - op2.lo;
      if (op2.type === 'window' && !op2.foreign) {
        const sill = Math.max(0.1, (H - op2.h) * 0.55);
        const fr = colorMat(0xf5f5f2, 0.5);
        const mk = (lw, lh, ld, y, offA = 0) => {
          const fm = new THREE.Mesh(new THREE.BoxGeometry(
            w.dir === 'z' ? lw : ld, lh, w.dir === 'z' ? ld : lw), fr.clone());
          fm.position.set(w.dir === 'z' ? px + offA : px, y, w.dir === 'z' ? pz : pz + offA);
          fm.userData = { roomId: r.id, kind: 'wall', wallKey: w.key };
          g.add(fm);
        };
        mk(alongLen + 0.06, 0.05, 0.16, sill - 0.025);                    // 하틀
        mk(alongLen + 0.06, 0.05, 0.16, sill + op2.h + 0.025);            // 상틀
        mk(0.05, op2.h + 0.1, 0.16, sill + op2.h / 2, -alongLen / 2 - 0.025);
        mk(0.05, op2.h + 0.1, 0.16, sill + op2.h / 2, alongLen / 2 + 0.025);
      }
      if (op2.type === 'door' && !op2.foreign) {
        // 문틀
        const fr = colorMat(0xf2efe9, 0.6);
        const jamb = (offA) => {
          const jm = new THREE.Mesh(new THREE.BoxGeometry(
            w.dir === 'z' ? 0.06 : 0.16, op2.h, w.dir === 'z' ? 0.16 : 0.06), fr.clone());
          jm.position.set(w.dir === 'z' ? px + offA : px, op2.h / 2, w.dir === 'z' ? pz : pz + offA);
          jm.userData = { roomId: r.id, kind: 'wall', wallKey: w.key };
          g.add(jm);
        };
        jamb(-alongLen / 2 - 0.03); jamb(alongLen / 2 + 0.03);
        // 문짝 — 힌지(lo)에서 방 안쪽으로 25° 열림
        const hx = w.dir === 'z' ? op2.lo : w.pos;
        const hz = w.dir === 'z' ? w.pos : op2.lo;
        const nx = w.dir === 'z' ? 0 : 1, nz = w.dir === 'z' ? 1 : 0;
        const ax = w.dir === 'z' ? 1 : 0, az = w.dir === 'z' ? 0 : 1;
        const sgn = inPoly3(hx + (ax + nx) * op2.w * 0.42, hz + (az + nz) * op2.w * 0.42, bd) ? 1 : -1;
        const th2 = 25 * Math.PI / 180;
        const dx2 = ax * Math.cos(th2) + nx * sgn * Math.sin(th2);
        const dz2 = az * Math.cos(th2) + nz * sgn * Math.sin(th2);
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(op2.w - 0.06, op2.h - 0.04, 0.04),
          colorMat(0xc7b299, 0.7));
        leaf.position.set(hx + dx2 * (op2.w / 2), op2.h / 2, hz + dz2 * (op2.w / 2));
        leaf.rotation.y = -Math.atan2(dz2, dx2);
        leaf.castShadow = true;
        leaf.userData = { roomId: r.id, kind: 'wall', wallKey: w.key };
        g.add(leaf);
      }
    }
  }

  // 가구 — 회전 OBB 박스
  if (state.showFurniture) {
    (plan.furniture || []).forEach((f, fi) => {
      const cs = f.obb || f.polygon || [];
      if (cs.length < 4) return;
      const wD = Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]);
      const dD = Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]);
      const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
      const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
      const yaw = (f.yaw_deg ?? Math.atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]) * 180 / Math.PI) * Math.PI / 180;
      const grp = buildFurniture((f.category || '').toLowerCase(), wD, dD);
      grp.position.set(cx, 0, cz);
      grp.rotation.y = -yaw;
      grp.traverse(obj => {
        obj.castShadow = true;
        obj.userData = { roomId: r.id, kind: 'furniture', furnIdx: fi };
      });
      g.add(grp);
    });
  }

  // 조명 — 픽스처 + (수 제한 내) 실제 광원
  for (const l of r.lights || []) {
    const li = item(l.type); if (!li) continue;
    const y = H - 0.02;
    if (li.kind === 'line' && l.x2 != null) {
      const len = Math.hypot(l.x2 - l.x, l.z2 - l.z);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.03, 0.05),
        new THREE.MeshStandardMaterial({ color: li.color, emissive: li.color, emissiveIntensity: 1.4 }));
      bar.position.set((l.x + l.x2) / 2, y, (l.z + l.z2) / 2);
      bar.rotation.y = -Math.atan2(l.z2 - l.z, l.x2 - l.x);
      bar.userData = { roomId: r.id, kind: 'light', lightId: l.id };
      g.add(bar);
      if (allowRealLight()) {
        const pl = new THREE.PointLight(li.color, 12, 6);
        pl.position.set((l.x + l.x2) / 2, y - 0.25, (l.z + l.z2) / 2);
        g.add(pl);
      }
    } else {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(l.type === 'lt_pendant' ? 0.12 : 0.05, l.type === 'lt_pendant' ? 0.12 : 0.05, 0.03, 20),
        new THREE.MeshStandardMaterial({ color: li.color, emissive: li.color, emissiveIntensity: 1.6 }));
      const dy = l.type === 'lt_pendant' ? 0.8 : 0.015;
      disc.position.set(l.x, y - dy + 0.015, l.z);
      disc.userData = { roomId: r.id, kind: 'light', lightId: l.id };
      g.add(disc);
      if (l.type === 'lt_pendant') {
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, dy, 6),
          new THREE.MeshBasicMaterial({ color: 0x555555 }));
        cord.position.set(l.x, y - dy / 2, l.z);
        g.add(cord);
      }
      if (allowRealLight()) {
        const pl = new THREE.PointLight(li.color, l.type === 'lt_pendant' ? 10 : 7, 5, 1.6);
        pl.position.set(l.x, y - dy - 0.15, l.z);
        pl.castShadow = false;
        g.add(pl);
      }
    }
  }
}

// ── 선택 / 조명 배치 ────────────────────────────────

function pickAt(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nd = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1,
                               -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(nd, camera);
  return raycaster.intersectObjects(root.children, true).filter(h => h.object.visible && h.object.userData?.kind);
}

function onHover(e) {
  if (state.mode !== 'light') { hoverMarker.visible = false; return; }
  const hits = pickAt(e).filter(h => h.object.userData.kind === 'floor' || h.object.userData.kind === 'ceiling');
  if (hits.length) {
    hoverMarker.visible = true;
    const p = hits[0].point;
    const r = room(hits[0].object.userData.roomId);
    hoverMarker.position.set(p.x, r ? ceilH(r.plan) - 0.01 : p.y + 0.01, p.z);
  } else hoverMarker.visible = false;
}

function onClick(e) {
  if (_down && Math.hypot(e.clientX - _down[0], e.clientY - _down[1]) > 5) { _down = null; return; } // 드래그=궤도
  _down = null;
  const hits = pickAt(e);
  if (!hits.length) { clearHighlight(); state.sel = null; state.pendingLine = null; emit('select'); return; }

  if (state.mode === 'light') {
    const h = hits.find(h => ['floor', 'ceiling'].includes(h.object.userData.kind));
    if (!h) return;
    const r = room(h.object.userData.roomId);
    if (!r) return;
    // 방 로컬 좌표로 변환 (그룹 오프셋 제거)
    const local = h.object.parent.worldToLocal(h.point.clone());
    const li = item(state.lightType);
    if (li.kind === 'line') {
      if (!state.pendingLine || state.pendingLine.roomId !== r.id) {
        state.pendingLine = { roomId: r.id, x: local.x, z: local.z };
        emit('select');
      } else {
        addLight(r, state.lightType, state.pendingLine.x, state.pendingLine.z, local.x, local.z);
        state.pendingLine = null;
      }
    } else {
      addLight(r, state.lightType, local.x, local.z);
    }
    state.selRoom = r.id;
    return;
  }

  // 선택 모드: light > wall > furniture > floor/ceiling 순
  const order = { light: 0, wall: 1, furniture: 2, ceiling: 3, floor: 4 };
  hits.sort((a, b) => (order[a.object.userData.kind] ?? 9) - (order[b.object.userData.kind] ?? 9) || a.distance - b.distance);
  const h = hits[0], ud = h.object.userData;
  state.selRoom = ud.roomId;
  state.sel = { kind: ud.kind, roomId: ud.roomId,
                wallKey: ud.wallKey, lightId: ud.lightId, furnIdx: ud.furnIdx };
  setHighlight(h.object);
  emit('select');
}

function setHighlight(mesh) {
  clearHighlight();
  const ud = mesh.userData || {};
  // 벽은 개구부 때문에 여러 조각 — 같은 wallKey 조각 전체를 한 부재로 하이라이트
  const targets = [];
  if (ud.kind === 'wall' && ud.wallKey != null) {
    root.traverse(obj => {
      const u = obj.userData || {};
      if (u.kind === 'wall' && u.roomId === ud.roomId && u.wallKey === ud.wallKey
          && obj.material?.emissive) targets.push(obj);
    });
  } else if (mesh.material?.emissive) {
    targets.push(mesh);
  }
  if (!targets.length) return;
  highlight = targets.map(m => ({ mesh: m, prev: m.material.emissive.getHex(),
                                  prevI: m.material.emissiveIntensity }));
  for (const m of targets) {
    m.material.emissive.setHex(0x219ed9);
    m.material.emissiveIntensity = 0.45;
  }
}
export function clearHighlight() {
  if (Array.isArray(highlight)) {
    for (const h of highlight) {
      if (h.mesh?.material?.emissive) {
        h.mesh.material.emissive.setHex(h.prev);
        h.mesh.material.emissiveIntensity = h.prevI ?? 1;
      }
    }
  }
  highlight = null;
}

export function frameAll() {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.z) * 1.1 + 4;
  camera.position.set(c.x + d * 0.55, d * 0.7, c.z + d * 0.8);
  controls.target.copy(c.setY(1));
}
