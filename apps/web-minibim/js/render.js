// render.js — 실사 렌더샷 (three-gpu-pathtracer, MIT — gkjohnson/three-gpu-pathtracer)
// 현재 3D 씬을 패스트레이싱으로 프로그레시브 렌더 → PNG 저장/견적서 첨부용.
// 오픈소스 전수조사 톱5 중 "설치만으로 적용 가능한" 1순위 이식.

import * as THREE from '../vendor/three.module.js';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';

let running = false, stopFlag = false;

export function isRendering() { return running; }
export function stopRender() { stopFlag = true; }

/// scene/camera 를 받아 modalCanvas 에 프로그레시브 패스트레이싱.
/// onProgress(samples, target) 콜백. 완료/중지 시 resolve(dataURL).
export async function renderShot(root, camera, canvas, {
  width = 1280, height = 800, samples = 200, onProgress = () => {},
  camPose = null,          // {pos:[x,y,z], look:[x,y,z], fov} — 실내 시점 프리셋
} = {}) {
  if (running) return null;
  running = true; stopFlag = false;

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
  const envTex = new GradientEquirectTexture();
  envTex.topColor.set(0xe3ecf5);
  envTex.bottomColor.set(0x9aa1a8);
  envTex.update();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe6ee);
  scene.environment = envTex;
  // three r160 호환 심: r162+에서 추가된 회전 속성을 pathtracer가 읽는다
  scene.environmentRotation = new THREE.Euler();
  scene.backgroundRotation = new THREE.Euler();
  scene.backgroundIntensity = 0.7;
  scene.environmentIntensity = 0.55;
  const model = root.clone(true);
  // 렌더 전용 보정: 천장 닫기 + 조명 픽스처 발광 강화(빛나는 광원으로) + 재질 미세 러프니스
  model.traverse(obj => {
    if (obj.userData?.isCeil) obj.visible = true;
    const m2 = obj.material;
    if (m2?.emissive && (m2.emissiveIntensity ?? 0) > 0.5 && m2.emissive.getHex() !== 0) {
      m2.emissiveIntensity = 14;   // 패스트레이서에서 실제 광원 역할
    }
  });
  scene.add(model);
  // 태양광 — 창으로 빛이 들어와 명암을 만든다
  const sun = new THREE.DirectionalLight(0xfff0dc, 5.5);
  sun.position.set(6, 9, -7);
  scene.add(sun);
  scene.add(sun.target);

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
  pt.tiles.set(2, 2);
  try {
    onProgress(0, samples, 'compile');
    await new Promise(r2 => setTimeout(r2, 60));   // 라벨 페인트 후 동기 컴파일(수 초~수십 초) 진입
    pt.setScene(scene, cam);   // 동기 BVH 빌드 — 세대 규모 씬이면 1초 미만 (setSceneAsync는 워커 필요)

    await new Promise(resolve => {
      const loop = () => {
        if (stopFlag || pt.samples >= samples) { resolve(); return; }
        try {
          pt.renderSample();
        } catch (err2) {
          console.error('렌더 루프 오류:', err2);
          window.__shotErr = String(err2?.message || err2);
          resolve(); return;
        }
        onProgress(Math.floor(pt.samples), samples);
        requestAnimationFrame(loop);
      };
      loop();
    });
    const url = canvas.toDataURL('image/png');
    return url;
  } catch (err) {
    console.error('렌더샷 실패:', err);
    window.__shotErr = String(err?.message || err);
    return null;
  } finally {
    pt.dispose?.();
    renderer.dispose();
    running = false;
  }
}
