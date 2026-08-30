import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

function LayerToggle({ layer, label, color, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer", color: "#cdd5e0" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(layer, event.target.checked)}
        style={{ accentColor: color }}
      />
      <span style={{ width: 11, height: 11, background: color, borderRadius: 3, display: "inline-block" }} />
      {label}
    </label>
  );
}

/**
 * 3D 모드: 원본 스캔 메쉬(GLB) + extrude된 평면도(벽/바닥/가구) 오버레이.
 * 좌표계: Explorer의 프론트 좌표(x는 이미 -x 반전됨, z). 3D에선 x→X, z→Z, 높이→Y.
 * props:
 *  - boundary: [[x,z],...] (프론트 좌표)
 *  - rooms, openings: detected.* (프론트 좌표)
 *  - furniture: [{polygon:[[x,z]], height_m, builtin}]
 *  - glbFile: File | null (원본 메쉬)
 *  - wallHeight: m
 */
export default function Plan3DView({ boundary, rooms, furniture, openings = [], glbFile, rotationRad = 0, floorY = 0, wallHeight = 2.4 }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const [show, setShow] = useState({ mesh: true, walls: true, floor: true, furniture: true, openings: true });
  const [meshOpacity, setMeshOpacity] = useState(70);
  const [clipPct, setClipPct] = useState(40); // 천장에서 위로 몇 % 잘라낼지
  const showRef = useRef(show);
  const clipRef = useRef(clipPct);
  const opacRef = useRef(meshOpacity);

  useEffect(() => { showRef.current = show; }, [show]);
  useEffect(() => { clipRef.current = clipPct; }, [clipPct]);
  useEffect(() => { opacRef.current = meshOpacity; }, [meshOpacity]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const w = mount.clientWidth, h = mount.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h); renderer.setPixelRatio(devicePixelRatio);
    renderer.setClearColor(0x0c0f16, 1);
    renderer.localClippingEnabled = true;
    mount.appendChild(renderer.domElement);
    // 천장 클리핑: y < cutY 만 보임 (normal=(0,-1,0))
    const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), wallHeight);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(50, w / h, 0.01, 500);
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(5, 12, 7); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.35); d2.position.set(-6, 8, -5); scene.add(d2);
    scene.add(new THREE.GridHelper(40, 40, 0x223, 0x152));
    const ctrl = new OrbitControls(cam, renderer.domElement);
    ctrl.enableDamping = true;

    const groups = { mesh: new THREE.Group(), walls: new THREE.Group(), floor: new THREE.Group(), furniture: new THREE.Group(), openings: new THREE.Group() };
    // 2D 뷰는 z축을 화면 위로 뒤집어 그림(tz = zMax - z). 3D도 동일하게 보이도록
    // 전체 콘텐츠를 z방향으로 미러(scale.z=-1). 카메라/그리드는 영향 없음.
    const root = new THREE.Group();
    root.scale.z = -1;
    Object.values(groups).forEach(g => root.add(g));
    scene.add(root);

    // ── extrude: 평면도 → 입체 ──
    // 좌표 규칙: 평면도 (x,z) → 3D (X=x, Z=z, 높이=Y). 벽은 position.z=z(양수) 그대로 쓰므로
    // 바닥/가구도 z부호가 +가 되도록 rotation.x=+π/2 사용 (shape y → 3D +Z).
    // 바닥(방 폴리곤)
    (rooms || []).forEach((r, i) => {
      const poly = r.polygon; if (!poly || poly.length < 3) return;
      const shape = new THREE.Shape();
      poly.forEach((p, k) => k === 0 ? shape.moveTo(p[0], p[1]) : shape.lineTo(p[0], p[1]));
      const geo = new THREE.ShapeGeometry(shape);
      const mat = new THREE.MeshStandardMaterial({ color: [0x2563eb, 0x10b981, 0xf59e0b, 0xec4899, 0x8b5cf6, 0x14b8a6][i % 6], transparent: true, opacity: 0.25, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = Math.PI / 2; m.position.y = 0.005;
      groups.floor.add(m);
    });

    // 벽: boundary를 따라 높이만큼 세움
    if (boundary && boundary.length >= 2) {
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x888f9c, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
      for (let i = 0; i < boundary.length - 1; i++) {
        const [x1, z1] = boundary[i], [x2, z2] = boundary[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1); if (len < 1e-3) continue;
        const geo = new THREE.PlaneGeometry(len, wallHeight);
        const m = new THREE.Mesh(geo, wallMat);
        m.position.set((x1 + x2) / 2, wallHeight / 2, (z1 + z2) / 2);
        m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
        groups.walls.add(m);
      }
    }

    // ── 개구부(문/창): boundary edge 위 pos/len(m) → 입체 박스 ──
    // 문=목재 패널(불투명), 창=유리(반투명 하늘색). 벽과 같은 rotation.y로 정렬.
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    const winMat = new THREE.MeshStandardMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    (openings || []).forEach(op => {
      if (!boundary || op.wallIdx == null) return;
      const p1 = boundary[op.wallIdx], p2 = boundary[op.wallIdx + 1];
      if (!p1 || !p2) return;
      const ex = p2[0] - p1[0], ez = p2[1] - p1[1];
      const elen = Math.hypot(ex, ez); if (elen < 1e-3) return;
      const ux = ex / elen, uz = ez / elen;
      const len = op.len || 0.9;
      const cx = p1[0] + ux * (op.pos + len / 2), cz = p1[1] + uz * (op.pos + len / 2);
      const isDoor = op.type === "door";
      const oh = isDoor ? Math.min(2.05, wallHeight - 0.05) : 1.2;
      const yc = isDoor ? oh / 2 : 0.9 + 1.2 / 2;        // 문=바닥부터, 창=sill 0.9
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, oh, 0.16), isDoor ? doorMat : winMat);
      m.position.set(cx, yc, cz);
      m.rotation.y = -Math.atan2(ez, ex);
      groups.openings.add(m);
    });

    // 가구: footprint를 높이만큼 박스로. 바닥과 동일 rotation.x=+π/2 (XZ 정합).
    // +π/2 회전이면 extrude(+Z)가 -Y(아래)로 가므로, position.y=hgt 로 올려 바닥(0)~hgt 차지.
    (furniture || []).forEach(f => {
      const poly = f.polygon; if (!poly || poly.length < 3) return;
      const shape = new THREE.Shape();
      poly.forEach((p, k) => k === 0 ? shape.moveTo(p[0], p[1]) : shape.lineTo(p[0], p[1]));
      const hgt = Math.max(0.1, f.height_m || 0.7);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: hgt, bevelEnabled: false });
      const col = f.builtin ? 0xf59e0b : 0x64748b;
      const mat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = Math.PI / 2;   // 바닥과 동일 → XZ 정합
      m.position.y = hgt;           // extrude가 -Y로 가므로 위로 올려 바닥~hgt
      groups.furniture.add(m);
    });

    // ── 원본 GLB 메쉬 (있으면) ──
    // 메쉬는 ARKitScenes/스캔 좌표라 평면도와 정합이 안 맞을 수 있음 →
    // 평면도 bbox에 맞춰 정렬 시도(센터+스케일). 정합 안되면 메쉬 끄고 보면 됨.
    let meshObj = null;
    if (glbFile) {
      const url = URL.createObjectURL(glbFile);
      new GLTFLoader().load(url, (gltf) => {
        meshObj = gltf.scene;
        // 평면도 = 원본메쉬 × Ry(rotationRad) × (x→-x), 그리고 바닥(floorY)을 Y=0으로 내림.
        // 합성 순서(왼쪽부터 적용): Translate(-floorY) · FlipX · Ry(rot)
        const rotY = new THREE.Matrix4().makeRotationY(rotationRad);
        const flipX = new THREE.Matrix4().makeScale(-1, 1, 1);
        const transY = new THREE.Matrix4().makeTranslation(0, -floorY, 0);
        const M = new THREE.Matrix4().multiply(transY).multiply(flipX).multiply(rotY);
        meshObj.applyMatrix4(M);
        meshObj.traverse(o => { if (o.isMesh) {
          const hasVC = o.geometry.attributes.color !== undefined;
          o.material = new THREE.MeshStandardMaterial({ vertexColors: hasVC, color: hasVC ? 0xffffff : 0x9aa3b0, roughness: 0.95, transparent: true, opacity: opacRef.current / 100, side: THREE.DoubleSide, clippingPlanes: [clipPlane] });
        }});
        groups.mesh.add(meshObj);
        stateRef.current.meshObj = meshObj;
        URL.revokeObjectURL(url);
      });
    }

    // 카메라 핏 (평면도 bbox 기준)
    const allX = (boundary || []).map(p => p[0]), allZ = (boundary || []).map(p => p[1]);
    const cx = allX.length ? (Math.min(...allX) + Math.max(...allX)) / 2 : 0;
    const cz = allZ.length ? (Math.min(...allZ) + Math.max(...allZ)) / 2 : 0;
    const span = Math.max(allX.length ? Math.max(...allX) - Math.min(...allX) : 5, allZ.length ? Math.max(...allZ) - Math.min(...allZ) : 5, 3);
    // root가 scale.z=-1 이므로 카메라도 -cz 기준으로 맞춤
    ctrl.target.set(cx, wallHeight / 2, -cz);
    cam.position.set(cx + span * 0.8, wallHeight + span * 0.9, -cz + span * 0.8);

    let raf;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = showRef.current;
      groups.mesh.visible = s.mesh; groups.walls.visible = s.walls;
      groups.floor.visible = s.floor; groups.furniture.visible = s.furniture;
      groups.openings.visible = s.openings;
      if (stateRef.current.meshObj) stateRef.current.meshObj.traverse(o => { if (o.isMesh) o.material.opacity = opacRef.current / 100; });
      // 천장 클리핑: clipPct% 만큼 위에서 잘라냄 (cutY = 천장 - 높이*pct/100)
      clipPlane.constant = wallHeight - wallHeight * (clipRef.current / 100);
      ctrl.update(); renderer.render(scene, cam);
    };
    loop();

    const onResize = () => { const W = mount.clientWidth, H = mount.clientHeight; cam.aspect = W / H; cam.updateProjectionMatrix(); renderer.setSize(W, H); };
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); renderer.dispose(); mount.innerHTML = ""; };
  }, [boundary, rooms, furniture, openings, glbFile, rotationRad, floorY, wallHeight]);

  const setLayerVisible = (layer, checked) => {
    setShow((current) => ({ ...current, [layer]: checked }));
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      <div style={{ position: "absolute", top: 12, left: 12, background: "rgba(18,26,43,.92)", border: "1px solid #22304d", borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
        <LayerToggle layer="mesh" label="원본 스캔" color="#9aa3b0" checked={show.mesh} onChange={setLayerVisible} />
        <LayerToggle layer="walls" label="벽 (입체)" color="#888f9c" checked={show.walls} onChange={setLayerVisible} />
        <LayerToggle layer="floor" label="바닥 (방)" color="#2563eb" checked={show.floor} onChange={setLayerVisible} />
        <LayerToggle layer="furniture" label="가구 (입체)" color="#f59e0b" checked={show.furniture} onChange={setLayerVisible} />
        <LayerToggle layer="openings" label="문/창" color="#7fc4ff" checked={show.openings} onChange={setLayerVisible} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9aa", borderTop: "1px solid #2a3550", paddingTop: 7 }}>
          <span>스캔 투명도</span>
          <input type="range" min="0" max="100" step="5" value={meshOpacity} onChange={e => setMeshOpacity(Number(e.target.value))} style={{ width: 70, accentColor: "#9aa3b0" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9aa" }}>
          <span>천장 자르기</span>
          <input type="range" min="0" max="95" step="5" value={clipPct} onChange={e => setClipPct(Number(e.target.value))} style={{ width: 70, accentColor: "#22d3ee" }} />
          <span style={{ fontSize: 11, minWidth: 26 }}>{clipPct}%</span>
        </div>
        <div style={{ fontSize: 11, color: "#789", lineHeight: 1.6, maxWidth: 160 }}>드래그=회전 · 휠=확대<br />스캔과 도면이 안 겹치면 '원본 스캔' 끄세요</div>
      </div>
    </div>
  );
}
