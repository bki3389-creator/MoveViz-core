// render.js — 실사 렌더샷 (three-gpu-pathtracer, MIT — gkjohnson/three-gpu-pathtracer)
// 현재 3D 씬을 패스트레이싱으로 프로그레시브 렌더 → PNG 저장/견적서 첨부용.
// 오픈소스 전수조사 톱5 중 "설치만으로 적용 가능한" 1순위 이식.

import * as THREE from '../vendor/three.module.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { natureEquirect } from './scene3d.js';

// 인스턴스 토큰(gen): stop/forceReset/새 시작마다 증가 — 진행 중이던 이전 루프는
// 자기 토큰과 어긋나는 순간 스스로 종료한다. (전역 stopFlag 공유로 좀비 루프가
// 새 렌더의 stopFlag=false를 보고 부활해 같은 캔버스에 이중 렌더하던 결함 수정)
let running = false, gen = 0;

/// 자연 배경을 패스트레이서가 읽는 DataTexture(Float RGBA)로 변환 — CanvasTexture는
/// EquirectHdrInfoUniform이 image.data를 요구해 크래시한다(자연 배경 도입 후 렌더 실패 원인).
// 배경(눈에 보이는 자연)은 원색 유지, 환경광(빛으로 쓰이는 쪽)은 탈채도 —
// 잔디 초록이 지붕·벽에 물드는 것(녹색 지붕) 방지.
let natureTexes = null;
function natureEnvData() {
  if (natureTexes) return natureTexes;
  const cnv = natureEquirect(1024).image;
  const w = cnv.width, h = cnv.height;
  const src = cnv.getContext('2d').getImageData(0, 0, w, h).data;
  const mk = desat => {
    const data = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      let r = Math.pow(src[i * 4] / 255, 2.2);        // sRGB→linear
      let g = Math.pow(src[i * 4 + 1] / 255, 2.2);
      let b = Math.pow(src[i * 4 + 2] / 255, 2.2);
      if (desat) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r += (l - r) * desat; g += (l - g) * desat; b += (l - b) * desat;
      }
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 1;
    }
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.needsUpdate = true;
    return t;
  };
  natureTexes = { bg: mk(0), env: mk(0.6) };
  return natureTexes;
}

export function isRendering() { return running; }
export function stopRender() { gen++; }
/// 강제 종료 — 느린 샘플/걸린 컴파일로 안 멈출 때 상태를 리셋(다음 렌더 즉시 가능)
export function forceReset() { gen++; running = false; }

/// scene/camera 를 받아 modalCanvas 에 프로그레시브 패스트레이싱.
/// onProgress(samples, target) 콜백. 완료/중지 시 resolve(dataURL).
export async function renderShot(root, camera, canvas, {
  width = 1280, height = 800, samples = 200, onProgress = () => {},
  camPose = null,          // {pos:[x,y,z], look:[x,y,z], fov} — 실내 시점 프리셋
} = {}) {
  if (running) return null;
  running = true;
  const myGen = ++gen;
  let loopErr = false;

  // three r160 ↔ pathtracer 신버전 호환 가드: undefined Euler 를 안전 처리(+1회 스택 로그)
  if (!window.__mrePatched) {
    window.__mrePatched = true;
    const origMRE = THREE.Matrix4.prototype.makeRotationFromEuler;
    THREE.Matrix4.prototype.makeRotationFromEuler = function (e) {
      if (!e || e.x === undefined) {
        if (!window.__mreLogged) {
          window.__mreLogged = true;
          console.log('MRE_STACK ' + String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).join(' | '));
        }
        e = new THREE.Euler();
      }
      return origMRE.call(this, e);
    };
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // 방 지오메트리만 복제한 전용 씬 — GridHelper 등 헬퍼(LineSegments)는 패스트레이서가 못 다룸
  const texes = natureEnvData();   // Float DataTexture — 패스트레이서 호환
  const scene = new THREE.Scene();
  scene.background = texes.bg;     // 창밖 = 원색 자연
  scene.environment = texes.env;   // 환경광 = 탈채도(녹색 캐스트 방지)
  // three r160 호환 심: r162+에서 추가된 회전 속성을 pathtracer가 읽는다
  scene.environmentRotation = new THREE.Euler();
  scene.backgroundRotation = new THREE.Euler();
  scene.backgroundIntensity = 0.7;
  scene.environmentIntensity = 0.75;   // 자연광(하늘) 기여 상향 — 닫힌 천장 보상
  const model = root.clone(true);
  // 렌더 전용 보정: 천장은 무조건 켜고 불투명하게(반투명 천장은 PT에서 빛이 새 우유빛),
  // 조명 픽스처 발광 강화(빛나는 광원으로). clone(true)는 재질 공유 — 수정 전 반드시 clone.
  model.traverse(obj => {
    if (obj.userData?.isCeil) {
      obj.visible = true;
      if (obj.material?.transparent) {
        obj.material = obj.material.clone();
        obj.material.transparent = false;
        obj.material.opacity = 1;
      }
    }
    const m2 = obj.material;
    if (m2?.emissive && (m2.emissiveIntensity ?? 0) > 0.5 && m2.emissive.getHex() !== 0) {
      obj.material = m2.clone();
      obj.material.emissiveIntensity = 20;   // 패스트레이서에서 실제 광원 역할
    }
    // 유리(창·유리문·가구 유리)는 진짜 투과 재질로 — 천장이 닫힌 렌더에서 자연광은
    // 창을 통해서만 들어오므로, 알파 유리로는 햇빛이 막힌다
    else if (m2?.transparent && m2.opacity < 0.9 && (m2.roughness ?? 1) <= 0.2) {
      obj.material = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, transmission: 1, roughness: 0.04, ior: 1.5,
        thickness: 0.006, metalness: 0,
      });
    }
  });
  scene.add(model);
  // 조명은 라이브 뷰의 '조명 효과' 모드와 무관하게 렌더에선 전부 켠다 —
  // 픽스처 메시마다 실광원(PointLight)을 강제 생성(발광 디스크만으론 어둡고 노이즈 큼)
  model.updateMatrixWorld(true);
  const fixtures = [];
  model.traverse(o => {
    if (o.userData?.kind === 'light' && o.material?.emissive) fixtures.push(o);
  });
  for (const f of fixtures.slice(0, 24)) {
    const p = new THREE.Vector3();
    f.getWorldPosition(p);
    const pl = new THREE.PointLight(0xfff1dc, 5.5, 0, 2);
    pl.position.set(p.x, p.y - 0.09, p.z);
    scene.add(pl);
  }
  // 태양광 — 창으로 빛이 들어와 명암을 만든다
  const sun = new THREE.DirectionalLight(0xfff0dc, 5.5);
  sun.position.set(6, 9, -7);
  scene.add(sun);
  scene.add(sun.target);
  // 잔디 지면 — 건물 주변 자연 바닥
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48),
    new THREE.MeshStandardMaterial({ color: 0x99a38d, roughness: 1 }));   // 저채도 — 녹색 반사 완화
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const cam = camera.clone();
  if (camPose) {
    cam.position.set(...camPose.pos);
    cam.fov = camPose.fov || 62;
    cam.lookAt(...camPose.look);
  }
  cam.aspect = width / height;
  cam.updateProjectionMatrix();

  const pt = new WebGLPathTracer(renderer);
  pt.bounces = 5;
  pt.renderScale = 1;
  pt.tiles.set(3, 3);   // 프레임당 부하 분산 — UI 응답성
  try {
    renderer.render(scene, cam);   // 셰이더 컴파일 동안 보일 래스터 미리보기 1프레임
    onProgress(0, samples, 'compile');
    await new Promise(r2 => setTimeout(r2, 60));   // 라벨 페인트 후 동기 컴파일(수 초~수십 초) 진입
    pt.setScene(scene, cam);   // 동기 BVH 빌드 — 세대 규모 씬이면 1초 미만 (setSceneAsync는 워커 필요)

    await new Promise(resolve => {
      const loop = () => {
        if (myGen !== gen || pt.samples >= samples) { resolve(); return; }
        try {
          pt.renderSample();
        } catch (err2) {
          console.error('렌더 루프 오류:', err2);
          window.__shotErr = String(err2?.message || err2);
          loopErr = true;
          resolve(); return;
        }
        onProgress(Math.floor(pt.samples), samples);
        requestAnimationFrame(loop);
      };
      loop();
    });
    // 첫 renderSample 실패(가장 흔한 실패 지점)를 '완료'로 위장하지 않는다 —
    // 캔버스엔 래스터 미리보기가 남아 있어 url이 항상 truthy이기 때문 (2차 감사 확정)
    if (loopErr && pt.samples < 1) return null;
    const url = canvas.toDataURL('image/png');
    return url;
  } catch (err) {
    console.error('렌더샷 실패:', err);
    window.__shotErr = String(err?.message || err);
    return null;
  } finally {
    pt.dispose?.();
    renderer.dispose();
    if (myGen === gen) running = false;   // 대체된 구 인스턴스가 새 렌더의 running을 끄지 않게
  }
}
