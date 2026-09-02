// textures.js — 웹 미니BIM 바닥 텍스처 프로시저럴 생성 (순수 Canvas 2D, three.js 비의존)
//
// export: floorCanvas(finishId, baseColor) → { canvas, size } | null
//   canvas : 512×512 HTMLCanvasElement (반복 타일링 seamless)
//   size   : 텍스처 1장이 덮는 실제 반복 주기(m) — 호출측에서 repeat = 실치수/size 로 사용
//   baseColor : catalog.js color 값(0xRRGGBB number) 또는 '#rrggbb' 문자열
//
// id → 패턴 매핑 (catalog.js FINISH_FLOOR 전 항목)
// ┌──────────────┬────────────────────────────────────────────────┬─────────┐
// │ id           │ 패턴                                            │ size(m) │
// ├──────────────┼────────────────────────────────────────────────┼─────────┤
// │ fl_keep      │ 무지 + 미세 노이즈 + 옅은 얼룩 (기존 유지)       │ 1.0     │
// │ fl_laminate  │ 플랭크 0.15×0.6 (줄눈+판별 명도 변주+나뭇결)     │ 1.2     │
// │ fl_lamin12   │ 플랭크 0.20×0.6 광폭 클릭 (결 약함)             │ 1.2     │
// │ fl_ondol     │ 플랭크 0.15×0.6 합판 무늬목 (결 중간)           │ 1.2     │
// │ fl_hardwood  │ 플랭크 0.12×1.2 원목 장척 (변주·결 강함)        │ 1.2     │
// │ fl_herring   │ 진짜 헤링본 — ±45° 플랭크 0.09×0.45 V자 맞물림  │ 1.273   │
// │ fl_sheet18   │ 장판 시트 — 미세 노이즈 + 옅은 세로 잔줄        │ 1.0     │
// │ fl_sheet45   │ 장판(층간소음) — 노이즈 굵고 잔줄 성김          │ 1.0     │
// │ fl_decotile  │ 데코타일 450각 그리드, 타일별 결 방향 교차      │ 0.9     │
// │ fl_tile600   │ 포세린 600각 줄눈 그리드 (무광)                 │ 1.2     │
// │ fl_tile300   │ 욕실 300각 줄눈 그리드 (줄눈 굵음)              │ 0.6     │
// │ fl_polish    │ 폴리싱 800각 — 부드러운 얼룩 그라데이션+광 줄기 │ 1.6     │
// └──────────────┴────────────────────────────────────────────────┴─────────┘
//
// 헤링본 기하: 축정렬 헤링본(가로/세로 5:1 판재 격자 규칙 d=(cx+cy) mod 10,
// d<5→가로판, d≥5→세로판)을 캔버스 중심 45° 회전 1패스로 렌더 → 플랭크가 ±45°,
// V자 지그재그 열이 세로 방향. 반복 주기 = 10셀×0.09m×√2 = 0.9√2 ≈ 1.273m (seamless).
//
// 모든 난수는 좌표 해시 기반(결정적) — 같은 입력이면 항상 같은 텍스처.

const S = 512; // 캔버스 픽셀

// ── 색 유틸 ──────────────────────────────────────────────────────────

function toRGB(c) {
  if (typeof c === 'number' && isFinite(c)) {
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  }
  if (typeof c === 'string') {
    const m = c.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  }
  return [200, 190, 170]; // 폴백: 중성 베이지
}

// 명도 배율 f (1=원색, <1 어둡게, >1 밝게), a 생략 시 불투명
function shade(rgb, f, a) {
  const r = Math.max(0, Math.min(255, Math.round(rgb[0] * f)));
  const g = Math.max(0, Math.min(255, Math.round(rgb[1] * f)));
  const b = Math.max(0, Math.min(255, Math.round(rgb[2] * f)));
  return a === undefined ? 'rgb(' + r + ',' + g + ',' + b + ')'
                         : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// ── 결정적 해시 난수 [0,1) — 정수 인자 나열 ─────────────────────────

function h01() {
  let h = 0x811c9dc5;
  for (let i = 0; i < arguments.length; i++) {
    h ^= Math.imul(arguments[i] | 0, 2654435761);
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function makeCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  return canvas;
}

// 기존 픽셀 위에 미세 그레이 노이즈 가산 (고주파 → 경계 이음새 무관)
function addNoise(ctx, amp, seed) {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  let s = (seed * 2246822519) | 0;
  for (let i = 0; i < d.length; i += 4) {
    s = (Math.imul(s, 48271) + 11) | 0;
    const v = ((s >>> 8) / 16777216 - 0.5) * 2 * amp;
    d[i] += v; d[i + 1] += v; d[i + 2] += v;
  }
  ctx.putImageData(img, 0, 0);
}

// ── 플랭크(판재류) ───────────────────────────────────────────────────
// o = { rows: 세로 판 수, segs: 가로 판 수(길이=S/segs), varAmp: 판별 명도 변주,
//       grain: 나뭇결 알파 강도, seed }

function paintSeg(ctx, rgb, x, y, w, h, f, o, r, k) {
  ctx.fillStyle = shade(rgb, f);
  ctx.fillRect(x, y, w, h);
  // 가는 나뭇결 곡선 (세그먼트 내부 클리핑)
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y + 1, w - 2, h - 2);
  ctx.clip();
  const n = Math.max(2, Math.round(h / 9));
  for (let i = 0; i < n; i++) {
    const gy = y + (i + 0.5 + (h01(o.seed, r, k, i, 3) - 0.5) * 0.8) * (h / n);
    const dark = h01(o.seed, r, k, i, 5) < 0.6;
    ctx.strokeStyle = shade(rgb, dark ? 0.78 : 1.15,
      o.grain * (0.5 + h01(o.seed, r, k, i, 9)));
    ctx.lineWidth = 0.7 + h01(o.seed, r, k, i, 13) * 0.9;
    ctx.beginPath();
    ctx.moveTo(x + 2, gy);
    const segN = 4;
    let py = gy;
    for (let q = 0; q < segN; q++) {
      const cx = x + w * (q + 0.5) / segN;
      const cy = py + (h01(o.seed, r, k, i, q, 17) - 0.5) * 4;
      const ex = x + w * (q + 1) / segN;
      const ey = gy + (h01(o.seed, r, k, i, q, 19) - 0.5) * 2.5;
      ctx.quadraticCurveTo(cx, cy, ex, ey);
      py = ey;
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlanks(ctx, rgb, o) {
  const rowH = S / o.rows;
  const segW = S / o.segs;
  ctx.fillStyle = shade(rgb, 1);
  ctx.fillRect(0, 0, S, S);
  for (let r = 0; r < o.rows; r++) {
    const off = Math.floor(h01(o.seed, r, 7) * segW); // 행별 엇갈림(스태거)
    for (let k = 0; k < o.segs; k++) {
      const x0 = (off + k * segW) % S;
      const f = 1 + (h01(o.seed, r, k, 11) - 0.5) * 2 * o.varAmp; // 판별 명도 변주
      paintSeg(ctx, rgb, x0, r * rowH, segW, rowH, f, o, r, k);
      if (x0 + segW > S) paintSeg(ctx, rgb, x0 - S, r * rowH, segW, rowH, f, o, r, k);
    }
    // 세로 줄눈(판 이음매)
    ctx.fillStyle = shade(rgb, 0.6, 0.85);
    for (let k = 0; k < o.segs; k++) {
      const x0 = (off + k * segW) % S;
      ctx.fillRect(x0 - 0.7, r * rowH, 1.4, rowH);
      if (x0 < 0.7) ctx.fillRect(x0 - 0.7 + S, r * rowH, 1.4, rowH);
      if (x0 > S - 0.7) ctx.fillRect(x0 - 0.7 - S, r * rowH, 1.4, rowH);
    }
  }
  // 가로 줄눈(판 폭 경계)
  ctx.fillStyle = shade(rgb, 0.58, 0.9);
  for (let r = 0; r <= o.rows; r++) ctx.fillRect(0, r * rowH - 0.7, S, 1.4);
  addNoise(ctx, 3, o.seed + 100);
  return o.size;
}

// ── 헤링본 ───────────────────────────────────────────────────────────
// 판재 0.09×0.45m(5:1). 축정렬 헤링본 격자 규칙:
//   셀(cx,cy)에서 d=(cx+cy) mod 10 → d<5: 가로판(원점 cx-d,cy, 5×1셀)
//                                    d≥5: 세로판(원점 cx,cy-(d-5), 1×5셀)
// 이를 캔버스 중심 45° 회전 상태로 그리면 두 방향 플랭크가 V자로 맞물린다.
// 반복 주기: 0.9√2 m (셀 10개 × 0.09m × √2) — 512px 캔버스와 정확히 일치해 seamless.

function drawHerringbone(ctx, rgb) {
  const n = 5;                              // 판 길이/폭 비 (0.45/0.09)
  const size = 2 * n * 0.09 * Math.SQRT2;   // ≈ 1.2728 m
  const px = S / (2 * n * Math.SQRT2);      // 셀 1개(0.09m) ≈ 36.2 px
  ctx.fillStyle = shade(rgb, 0.58);         // 줄눈 바탕
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.rotate(Math.PI / 4);
  const R = Math.ceil((S * Math.SQRT2 / 2) / px) + n + 1;
  const done = new Set();
  for (let cy = -R; cy <= R; cy++) {
    for (let cx = -R; cx <= R; cx++) {
      const d = ((cx + cy) % (2 * n) + 2 * n) % (2 * n);
      let ox, oy, horiz;
      if (d < n) { ox = cx - d; oy = cy; horiz = true; }
      else { ox = cx; oy = cy - (d - n); horiz = false; }
      const key = ox + ',' + oy + (horiz ? 'h' : 'v');
      if (done.has(key)) continue;
      done.add(key);
      // 색 시드는 원점 mod 10 → 회전 후에도 캔버스 주기와 일치(이음새 없음)
      const mx = ((ox % (2 * n)) + 2 * n) % (2 * n);
      const my = ((oy % (2 * n)) + 2 * n) % (2 * n);
      const f = 1 + (h01(31, mx, my, horiz ? 1 : 0) - 0.5) * 0.24;
      const x = ox * px, y = oy * px;
      const w = horiz ? n * px : px;
      const h = horiz ? px : n * px;
      ctx.fillStyle = shade(rgb, f);
      ctx.fillRect(x + 0.8, y + 0.8, w - 1.6, h - 1.6); // 0.8px 여백 = 줄눈
      // 판 장축 방향 가는 나뭇결
      for (let li = 0; li < 3; li++) {
        ctx.strokeStyle = shade(rgb, h01(37, mx, my, li) < 0.5 ? 0.8 : 1.12, 0.13);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        if (horiz) {
          const gy = y + (li + 1) * h / 4 + (h01(41, mx, my, li) - 0.5) * 3;
          ctx.moveTo(x + 3, gy);
          ctx.quadraticCurveTo(x + w / 2, gy + (h01(43, mx, my, li) - 0.5) * 4,
                               x + w - 3, gy + (h01(47, mx, my, li) - 0.5) * 2);
        } else {
          const gx = x + (li + 1) * w / 4 + (h01(41, mx, my, li) - 0.5) * 3;
          ctx.moveTo(gx, y + 3);
          ctx.quadraticCurveTo(gx + (h01(43, mx, my, li) - 0.5) * 4, y + h / 2,
                               gx + (h01(47, mx, my, li) - 0.5) * 2, y + h - 3);
        }
        ctx.stroke();
      }
    }
  }
  ctx.restore();
  addNoise(ctx, 3, 555);
  return size;
}

// ── 타일류(그리드) ───────────────────────────────────────────────────
// o = { n: 한 변 타일 수, grout: 줄눈 px, groutShade, varAmp, seed, size,
//       wood: 데코타일 결(체커 방향 교차), blotch: 폴리싱 얼룩 }

function drawTiles(ctx, rgb, o) {
  const t = S / o.n;
  for (let i = 0; i < o.n; i++) {
    for (let j = 0; j < o.n; j++) {
      const f = 1 + (h01(o.seed, i, j) - 0.5) * 2 * o.varAmp;
      ctx.fillStyle = shade(rgb, f);
      ctx.fillRect(i * t, j * t, t, t);
      if (o.wood) { // 데코타일: 타일마다 결 방향 90° 교차
        const horiz = (i + j) % 2 === 0;
        for (let li = 0; li < 8; li++) {
          ctx.strokeStyle = shade(rgb, h01(o.seed, i, j, li, 2) < 0.5 ? 0.86 : 1.1, 0.12);
          ctx.lineWidth = 1;
          const p = (li + 0.5) * t / 8 + (h01(o.seed, i, j, li, 4) - 0.5) * 5;
          ctx.beginPath();
          if (horiz) { ctx.moveTo(i * t + 2, j * t + p); ctx.lineTo((i + 1) * t - 2, j * t + p); }
          else       { ctx.moveTo(i * t + p, j * t + 2); ctx.lineTo(i * t + p, (j + 1) * t - 2); }
          ctx.stroke();
        }
      }
      if (o.blotch) { // 폴리싱/에폭시류: 부드러운 얼룩 그라데이션 (타일 내부 클리핑)
        ctx.save();
        ctx.beginPath();
        ctx.rect(i * t, j * t, t, t);
        ctx.clip();
        for (let b = 0; b < 5; b++) {
          const bx = i * t + h01(o.seed, i, j, b, 21) * t;
          const by = j * t + h01(o.seed, i, j, b, 22) * t;
          const br = t * (0.25 + h01(o.seed, i, j, b, 23) * 0.45);
          const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
          const light = h01(o.seed, i, j, b, 24) < 0.5;
          g.addColorStop(0, shade(rgb, light ? 1.1 : 0.9, 0.32));
          g.addColorStop(1, shade(rgb, 1, 0));
          ctx.fillStyle = g;
          ctx.fillRect(bx - br, by - br, br * 2, br * 2);
        }
        // 은은한 광 줄기(유광)
        const gl = ctx.createLinearGradient(i * t, j * t, (i + 1) * t, (j + 1) * t);
        gl.addColorStop(0, shade(rgb, 1.18, 0));
        gl.addColorStop(0.45 + h01(o.seed, i, j, 25) * 0.1, shade(rgb, 1.18, 0.07));
        gl.addColorStop(1, shade(rgb, 1.18, 0));
        ctx.fillStyle = gl;
        ctx.fillRect(i * t, j * t, t, t);
        ctx.restore();
      }
    }
  }
  // 줄눈 그리드 (0/512 양끝 절반씩 → 반복 시 온줄눈)
  ctx.fillStyle = shade(rgb, o.groutShade, 0.92);
  for (let i = 0; i <= o.n; i++) {
    ctx.fillRect(i * t - o.grout / 2, 0, o.grout, S);
    ctx.fillRect(0, i * t - o.grout / 2, S, o.grout);
  }
  addNoise(ctx, o.blotch ? 1.5 : 3, o.seed + 200);
  return o.size;
}

// ── 장판/시트류 ──────────────────────────────────────────────────────
// 미세 노이즈 + 옅은 세로 잔줄 + 넓은 톤 밴드(롤 방향)

function drawSheet(ctx, rgb, o) {
  ctx.fillStyle = shade(rgb, 1);
  ctx.fillRect(0, 0, S, S);
  // 넓은 톤 밴드 (경계 넘침은 좌측 재드로우로 wrap)
  for (let b = 0; b < 3; b++) {
    const x0 = h01(o.seed, b, 51) * S;
    const w = 50 + h01(o.seed, b, 53) * 60;
    const f = h01(o.seed, b, 57) < 0.5 ? 0.95 : 1.05;
    for (const dx of [0, -S]) {
      const g = ctx.createLinearGradient(x0 + dx, 0, x0 + dx + w, 0);
      g.addColorStop(0, shade(rgb, f, 0));
      g.addColorStop(0.5, shade(rgb, f, 0.5));
      g.addColorStop(1, shade(rgb, f, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x0 + dx, 0, w, S);
    }
  }
  // 옅은 세로 잔줄
  for (let i = 0; i < o.lines; i++) {
    const x = ((i + 0.3 + h01(o.seed, i, 61) * 0.4) * S / o.lines) % S;
    ctx.strokeStyle = shade(rgb, h01(o.seed, i, 63) < 0.5 ? 0.9 : 1.08,
      0.05 + h01(o.seed, i, 67) * 0.05);
    ctx.lineWidth = 1 + h01(o.seed, i, 69) * o.lineW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, S);
    ctx.stroke();
  }
  addNoise(ctx, o.noise, o.seed + 300);
  return 1.0;
}

// ── 무지(기존 유지) ──────────────────────────────────────────────────

function drawPlain(ctx, rgb) {
  ctx.fillStyle = shade(rgb, 1);
  ctx.fillRect(0, 0, S, S);
  // 옅은 대형 얼룩 — 3×3 오프셋 재드로우로 wrap(seamless)
  for (let b = 0; b < 4; b++) {
    const bx = h01(71, b) * S, by = h01(73, b) * S;
    const br = S * (0.2 + h01(79, b) * 0.3);
    const light = h01(83, b) < 0.5;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const g = ctx.createRadialGradient(bx + dx * S, by + dy * S, 0,
                                           bx + dx * S, by + dy * S, br);
        g.addColorStop(0, shade(rgb, light ? 1.04 : 0.96, 0.3));
        g.addColorStop(1, shade(rgb, 1, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
      }
    }
  }
  addNoise(ctx, 4, 999);
  return 1.0;
}

// ── 디스패처 ─────────────────────────────────────────────────────────

const GEN = {
  fl_keep:     function (ctx, rgb) { return drawPlain(ctx, rgb); },
  fl_laminate: function (ctx, rgb) { return drawPlanks(ctx, rgb, { rows: 8,  segs: 2, varAmp: 0.07, grain: 0.10, seed: 1, size: 1.2 }); },
  fl_lamin12:  function (ctx, rgb) { return drawPlanks(ctx, rgb, { rows: 6,  segs: 2, varAmp: 0.05, grain: 0.07, seed: 2, size: 1.2 }); },
  fl_ondol:    function (ctx, rgb) { return drawPlanks(ctx, rgb, { rows: 8,  segs: 2, varAmp: 0.09, grain: 0.14, seed: 3, size: 1.2 }); },
  fl_hardwood: function (ctx, rgb) { return drawPlanks(ctx, rgb, { rows: 10, segs: 1, varAmp: 0.12, grain: 0.18, seed: 4, size: 1.2 }); },
  fl_herring:  function (ctx, rgb) { return drawHerringbone(ctx, rgb); },
  fl_sheet18:  function (ctx, rgb) { return drawSheet(ctx, rgb, { lines: 22, lineW: 0.8, noise: 5, seed: 6 }); },
  fl_sheet45:  function (ctx, rgb) { return drawSheet(ctx, rgb, { lines: 14, lineW: 1.4, noise: 6, seed: 7 }); },
  fl_decotile: function (ctx, rgb) { return drawTiles(ctx, rgb, { n: 2, grout: 1.2, groutShade: 0.72, varAmp: 0.06, seed: 8,  size: 0.9, wood: true }); },
  fl_tile600:  function (ctx, rgb) { return drawTiles(ctx, rgb, { n: 2, grout: 2,   groutShade: 0.62, varAmp: 0.05, seed: 9,  size: 1.2 }); },
  fl_tile300:  function (ctx, rgb) { return drawTiles(ctx, rgb, { n: 2, grout: 3,   groutShade: 0.6,  varAmp: 0.07, seed: 10, size: 0.6 }); },
  fl_polish:   function (ctx, rgb) { return drawTiles(ctx, rgb, { n: 2, grout: 1.5, groutShade: 0.82, varAmp: 0.04, seed: 11, size: 1.6, blotch: true }); },
};

/**
 * 바닥 마감 id → 프로시저럴 텍스처 캔버스.
 * @param {string} finishId  catalog.js FINISH_FLOOR의 id
 * @param {number|string} baseColor  0xRRGGBB 또는 '#rrggbb'
 * @returns {{canvas: HTMLCanvasElement, size: number}|null} size = 반복 주기(m)
 */
export function floorCanvas(finishId, baseColor) {
  const gen = GEN[finishId];
  if (!gen) return null;
  const rgb = toRGB(baseColor);
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const size = gen(ctx, rgb);
  return { canvas: canvas, size: size };
}
