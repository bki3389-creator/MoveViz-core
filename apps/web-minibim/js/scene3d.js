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
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1013);
  scene.fog = new THREE.Fog(0x0d1013, 30, 90);

  camera = new THREE.PerspectiveCamera(52, 1, 0.05, 300);
  camera.position.set(7, 8, 11);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  const hemi = new THREE.HemisphereLight(0xf2f4f8, 0x33393f, 0.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  sun.position.set(10, 16, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -20; sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
  scene.add(sun);

  const grid = new THREE.GridHelper(60, 60, 0x2a3038, 0x1a1f26);
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

const FURN_H = { bed: 0.5, sofa: 0.75, chair: 0.85, table: 0.72, cabinet: 1.2, refrigerator: 1.8,
                 tv: 0.7, toilet: 0.75, sink: 0.85, bathtub: 0.55, appliance: 0.9, fireplace: 1.0, stairs: 1.0 };

export function rebuild3D() {
  clearHighlight();
  while (root.children.length) {
    const c = root.children.pop();
    c.traverse?.(o => { o.geometry?.dispose?.(); });
    root.remove(c);
  }
  const P = state.project;
  if (!P?.rooms.length) return;
  const offs = layoutOffsets();

  let lightCount = 0;
  for (const r of P.rooms) {
    const off = offs[r.id];
    if (!off?.bb) continue;
    const g = new THREE.Group();
    g.position.set(off.x, 0, off.z);
    root.add(g);
    buildRoom(r, g, () => lightCount++ < 14);   // 실제 광원은 14개까지
  }
}

function finishColor(id, fallback = 0xcccccc) { return item(id)?.color ?? fallback; }

function buildRoom(r, g, allowRealLight) {
  const plan = r.plan, H = ceilH(plan);
  const bd = plan.boundary || [];
  if (bd.length < 3) return;

  // 바닥 — Shape(x, z) → rotateX(90°) → (x, 0, z)
  const shape = new THREE.Shape(bd.map(p => new THREE.Vector2(p[0], p[1])));
  const floorGeo = new THREE.ShapeGeometry(shape);
  floorGeo.rotateX(Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, colorMat(finishColor(r.floorFinish), 0.85));
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
        boxes.push({ lo: o.lo, hi: o.hi, y0: sill, y1: sill + o.h, glass: true }); // 유리
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
    }
  }

  // 가구 — 회전 OBB 박스
  if (state.showFurniture) {
    for (const f of plan.furniture || []) {
      const cs = f.obb || f.polygon || [];
      if (cs.length < 4) continue;
      const wD = Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]);
      const dD = Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]);
      const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
      const cz = cs.reduce((a, p) => a + p[1], 0) / cs.length;
      const hF = FURN_H[(f.category || '').toLowerCase()] ?? 0.8;
      const yaw = (f.yaw_deg ?? Math.atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]) * 180 / Math.PI) * Math.PI / 180;
      const m = new THREE.Mesh(new THREE.BoxGeometry(wD, hF, dD),
        new THREE.MeshStandardMaterial({ color: 0x3f8f8a, transparent: true, opacity: 0.55, roughness: 0.8 }));
      m.position.set(cx, hF / 2, cz);
      m.rotation.y = -yaw;
      m.castShadow = true;
      m.userData = { roomId: r.id, kind: 'furniture' };
      g.add(m);
    }
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
  return raycaster.intersectObjects(root.children, true).filter(h => h.object.userData?.kind);
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
  state.sel = { kind: ud.kind === 'furniture' ? 'room' : ud.kind, roomId: ud.roomId,
                wallKey: ud.wallKey, lightId: ud.lightId };
  setHighlight(h.object);
  emit('select');
}

function setHighlight(mesh) {
  clearHighlight();
  if (!mesh.material?.emissive) return;
  highlight = { mesh, prev: mesh.material.emissive.getHex(), prevI: mesh.material.emissiveIntensity };
  mesh.material.emissive.setHex(0x219ed9);
  mesh.material.emissiveIntensity = 0.45;
}
export function clearHighlight() {
  if (highlight?.mesh?.material?.emissive) {
    highlight.mesh.material.emissive.setHex(highlight.prev);
    highlight.mesh.material.emissiveIntensity = highlight.prevI ?? 1;
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
