import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const FONT = "'Inter', 'Pretendard', sans-serif";
const SERVER = import.meta.env.VITE_API_BASE_URL || "http://localhost:5052";

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

function MovemateLogo({ size = 48, color = "#fff" }) {
  return (
    <svg width={size} height={size * 0.85} viewBox="0 0 48 41" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 38 L2 6 L24 28 L46 6 L46 38" stroke={color} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 26 L24 38 L37 26" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerSVG() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: "spin 1s linear infinite" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="8" cy="8" r="6" fill="none" stroke="#444" strokeWidth="2" />
      <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function GlbUploader({ onData }) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const frameRef = useRef(null);
  const pendingDataRef = useRef(null);
  const pendingFileRef = useRef(null); // 원본 GLB 파일 (3D 모드용)
  const controlsRef = useRef(null);    // OrbitControls (회전 토글용)
  const modelRef = useRef(null);       // 로드된 메쉬
  const pointsRef = useRef(null);      // 포인트클라우드(정점) 그룹

  const [autoRotate, setAutoRotate] = useState(true);
  const [pointCloud, setPointCloud] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [loadPct, setLoadPct] = useState(0);
  const [analysisState, setAnalysisState] = useState("idle");
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (rendererRef.current) rendererRef.current.dispose();
  }, []);

  const startAnalysis = async (file) => {
    setAnalysisState("running");
    try {
      const health = await fetch(`${SERVER}/health`).catch(() => null);
      if (!health?.ok) { setAnalysisState("error"); return; }
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${SERVER}/convert`, { method: "POST", body: form });
      const json = await res.json();
      if (json.error) { setAnalysisState("error"); return; }
      pendingDataRef.current = json;
      setAnalysisState("done");
    } catch { setAnalysisState("error"); }
  };

  const load3D = (file) => {
    const mount = mountRef.current;
    if (!mount) return;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (rendererRef.current) { rendererRef.current.dispose(); mount.innerHTML = ""; }

    const w = mount.clientWidth || window.innerWidth;
    const h = mount.clientHeight || window.innerHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0a0a0a, 1);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0a, 10, 80);
    const camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 500);

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(5, 10, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0x8888ff, 0.3);
    fill.position.set(-5, 2, -5); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(0, -5, -8); scene.add(rim);

    const grid = new THREE.GridHelper(40, 40, 0x222222, 0x181818);
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.0;
    controls.enablePan = false;
    controlsRef.current = controls;
    modelRef.current = null; pointsRef.current = null;
    setAutoRotate(true); setPointCloud(false);

    const url = URL.createObjectURL(file);
    new GLTFLoader().load(url, (gltf) => {
      URL.revokeObjectURL(url);
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 8 / maxDim;
      model.scale.setScalar(scale);
      model.position.sub(center.multiplyScalar(scale));
      const box2 = new THREE.Box3().setFromObject(model);
      grid.position.y = box2.min.y;
      model.traverse((child) => {
        if (child.isMesh) {
          child.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.75, metalness: 0.05 });
          child.castShadow = true; child.receiveShadow = true;
        }
      });
      scene.add(model);
      // 포인트클라우드(메쉬 정점) 미리 생성 — 토글용. 같은 메쉬 좌표를 점으로 렌더.
      const ptsGroup = new THREE.Group();
      model.updateMatrixWorld(true);
      model.traverse((child) => {
        if (child.isMesh && child.geometry) {
          const pts = new THREE.Points(child.geometry,
            new THREE.PointsMaterial({ color: 0x9fd0ff, size: 0.02, sizeAttenuation: true }));
          pts.applyMatrix4(child.matrixWorld);
          ptsGroup.add(pts);
        }
      });
      ptsGroup.visible = false;
      scene.add(ptsGroup);
      modelRef.current = model;
      pointsRef.current = ptsGroup;
      const dist = maxDim * scale * 1.4;
      camera.position.set(dist, dist * 0.6, dist);
      controls.target.set(0, box2.getCenter(new THREE.Vector3()).y, 0);
      controls.update();
      setPhase("turntable");
    }, (xhr) => {
      if (xhr.total) setLoadPct(Math.round(xhr.loaded / xhr.total * 100));
    }, (err) => {
      URL.revokeObjectURL(url);
      setErrorMsg("3D 로드 실패: " + err.message);
      setPhase("error");
    });

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w2 = mount.clientWidth, h2 = mount.clientHeight;
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    window.addEventListener("resize", onResize);
  };

  const handleFile = (file) => {
    if (!file?.name.endsWith(".glb")) { setErrorMsg("GLB 파일만 지원합니다"); setPhase("error"); return; }
    setFileName(file.name);
    setFileSize(file.size);
    setPhase("loading3d");
    setLoadPct(0);
    setAnalysisState("idle");
    pendingDataRef.current = null;
    pendingFileRef.current = file;
    setTimeout(() => load3D(file), 50);
    startAnalysis(file);
  };

  const handleConfirm = () => { if (pendingDataRef.current) onData(pendingDataRef.current, pendingFileRef.current); };

  const reset = () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (rendererRef.current) { rendererRef.current.dispose(); rendererRef.current = null; }
    if (mountRef.current) mountRef.current.innerHTML = "";
    pendingDataRef.current = null;
    controlsRef.current = null; modelRef.current = null; pointsRef.current = null;
    setAutoRotate(true); setPointCloud(false);
    setPhase("idle"); setFileName(""); setFileSize(0); setErrorMsg(""); setAnalysisState("idle");
  };

  const toggleRotate = () => {
    const on = !autoRotate; setAutoRotate(on);
    if (controlsRef.current) controlsRef.current.autoRotate = on;
  };
  const togglePoints = () => {
    const on = !pointCloud; setPointCloud(on);
    if (modelRef.current) modelRef.current.visible = !on;
    if (pointsRef.current) pointsRef.current.visible = on;
  };
  const viewBtn = (active) => ({
    background: active ? "rgba(255,255,255,0.14)" : "transparent",
    color: active ? "#fff" : "#888", border: "1px solid #2a2a2a",
    borderRadius: 8, padding: "7px 11px", fontSize: 12, cursor: "pointer",
    fontFamily: FONT, whiteSpace: "nowrap",
  });

  const analysisLabel = () => {
    if (analysisState === "idle" || analysisState === "running") return "평면 분석 중...";
    if (analysisState === "done") return "평면 확인하기 →";
    return "분석 실패";
  };

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#0a0a0a", fontFamily: FONT, position: "relative", overflow: "hidden" }}>

      {/* 3D viewport */}
      <div ref={mountRef} style={{
        position: "absolute", inset: 0,
        display: (phase === "loading3d" || phase === "turntable") ? "block" : "none"
      }} />

      {/* ── IDLE: Landing screen ── */}
      {phase === "idle" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>

          {/* Top nav */}
          <div style={{ padding: "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <MovemateLogo size={32} color="#fff" />
              <span style={{ letterSpacing: "0.22em", fontSize: 12, fontWeight: 600, color: "#fff" }}>MOVE MATE</span>
            </div>
            <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em" }}>FLOOR PLAN ANALYZER</span>
          </div>

          {/* Hero */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px" }}>

            {/* Big logo mark */}
            <div style={{ marginBottom: 28 }}>
              <MovemateLogo size={72} color="#fff" />
            </div>

            <div style={{ letterSpacing: "0.35em", fontSize: 11, color: "#666", marginBottom: 10, textAlign: "center" }}>
              MOVE MATE
            </div>
            <h1 style={{ fontSize: 32, fontWeight: 700, color: "#fff", margin: "0 0 10px", textAlign: "center", letterSpacing: "-0.02em", lineHeight: 1.2 }}>
              이사, 더 스마트하게<br />시작하세요
            </h1>
            <p style={{ fontSize: 14, color: "#555", marginBottom: 40, textAlign: "center", lineHeight: 1.7 }}>
              스캔 파일 하나로 평면도를 자동 추출하고<br />이사 준비를 더 스마트하게 시작하세요
            </p>

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => {
                const el = document.createElement("input");
                el.type = "file"; el.accept = ".glb";
                el.onchange = ev => handleFile(ev.target.files[0]);
                el.click();
              }}
              style={{
                border: dragOver ? "1.5px solid #fff" : "1.5px solid #2a2a2a",
                borderRadius: 20,
                padding: "40px 60px",
                textAlign: "center",
                cursor: "pointer",
                background: dragOver ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
                transition: "all 0.2s",
                width: "100%",
                maxWidth: 380,
                boxSizing: "border-box",
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.6 }}>
                <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                  <path d="M18 4 L18 22M18 4 L12 10M18 4 L24 10" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M6 26 L6 30 Q6 32 8 32 L28 32 Q30 32 30 30 L30 26" stroke="#555" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#ccc", marginBottom: 6 }}>
                GLB 파일 업로드
              </div>
              <div style={{ fontSize: 12, color: "#444" }}>
                드래그하거나 클릭하여 선택
              </div>
              <div style={{ marginTop: 14, display: "inline-block", padding: "6px 16px", borderRadius: 20, background: "#1a1a1a", fontSize: 11, color: "#666", letterSpacing: "0.05em" }}>
                .glb
              </div>
            </div>

            {/* Feature pills */}
            <div style={{ display: "flex", gap: 10, marginTop: 32, flexWrap: "wrap", justifyContent: "center" }}>
              {["LiDAR Scan", "CAD / Rhino", "자동 평면 추출", "벽 편집"].map(f => (
                <div key={f} style={{ padding: "5px 14px", borderRadius: 20, border: "1px solid #1e1e1e", fontSize: 11, color: "#555", letterSpacing: "0.03em" }}>
                  {f}
                </div>
              ))}
            </div>
          </div>

          {/* Bottom bar */}
          <div style={{ padding: "16px 32px", borderTop: "1px solid #141414", display: "flex", justifyContent: "center" }}>
            <span style={{ fontSize: 11, color: "#333", letterSpacing: "0.08em" }}>© 2026 MOVE MATE</span>
          </div>
        </div>
      )}

      {/* ── LOADING: progress overlay ── */}
      {phase === "loading3d" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          pointerEvents: "none", background: "rgba(10,10,10,0.8)"
        }}>
          <MovemateLogo size={36} color="#fff" />
          <div style={{ color: "#555", fontSize: 12, letterSpacing: "0.2em", marginTop: 10, marginBottom: 24 }}>MOVE MATE</div>
          <div style={{ color: "#888", fontSize: 13, marginBottom: 12 }}>3D 모델 로딩 중... {loadPct}%</div>
          <div style={{ width: 180, height: 2, background: "#1e1e1e", borderRadius: 2 }}>
            <div style={{ width: loadPct + "%", height: "100%", background: "#fff", borderRadius: 2, transition: "width .3s" }} />
          </div>
        </div>
      )}

      {/* ── TURNTABLE: top bar ── */}
      {phase === "turntable" && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 56,
          background: "rgba(0,0,0,0.7)", backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex", alignItems: "center", padding: "0 20px", gap: 12
        }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 4 }}>
            <MovemateLogo size={22} color="#fff" />
            <span style={{ letterSpacing: "0.2em", fontSize: 10, fontWeight: 600, color: "#888" }}>MOVE MATE</span>
          </div>
          <div style={{ width: 1, height: 20, background: "#2a2a2a" }} />

          {/* File info */}
          <span style={{ fontSize: 12, color: "#666", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fileName}
            <span style={{ color: "#333", marginLeft: 8 }}>{formatSize(fileSize)}</span>
          </span>

          {/* 뷰 토글: 회전 멈춤 / 포인트클라우드 */}
          <button onClick={toggleRotate} style={viewBtn(autoRotate)} title="자동 회전 켜기/끄기">
            {autoRotate ? "⏸ 회전 멈춤" : "▶ 회전"}
          </button>
          <button onClick={togglePoints} style={viewBtn(pointCloud)} title="메쉬 / 포인트클라우드 전환">
            {pointCloud ? "◧ 메쉬" : "⠿ 포인트"}
          </button>

          {/* Analysis pill */}
          {analysisState === "running" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#666", fontSize: 12 }}>
              <SpinnerSVG /> 평면 분석 중
            </div>
          )}
          {analysisState === "error" && (
            <span style={{ fontSize: 12, color: "#ff5555" }}>분석 실패</span>
          )}

          {/* CTA button */}
          <button
            onClick={analysisState === "done" ? handleConfirm : undefined}
            disabled={analysisState !== "done"}
            style={{
              background: analysisState === "done" ? "#fff" : "#1a1a1a",
              color: analysisState === "done" ? "#000" : "#333",
              border: "none", borderRadius: 8,
              padding: "8px 20px", fontSize: 13, fontWeight: 600, fontFamily: FONT,
              cursor: analysisState === "done" ? "pointer" : "default",
              letterSpacing: "0.01em",
              transition: "all 0.3s",
            }}
          >
            {analysisLabel()}
          </button>

          <button onClick={reset} style={{
            background: "transparent", color: "#555", border: "1px solid #222",
            borderRadius: 8, padding: "7px 12px", fontSize: 12, cursor: "pointer", fontFamily: FONT
          }}>
            ✕
          </button>
        </div>
      )}

      {/* ── ERROR ── */}
      {phase === "error" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          color: "#fff"
        }}>
          <MovemateLogo size={40} color="#fff" />
          <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#444", marginTop: 8, marginBottom: 28 }}>MOVE MATE</div>
          <div style={{ fontSize: 13, color: "#ff5555", marginBottom: 24 }}>{errorMsg}</div>
          <button onClick={reset} style={{
            background: "#fff", color: "#000", border: "none", borderRadius: 8,
            padding: "10px 28px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT
          }}>다시 시도</button>
        </div>
      )}
    </div>
  );
}
