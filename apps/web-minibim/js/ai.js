// ai.js — AI 인테리어 디자이너 (대화형 에이전트, 승리안 1단계 MVP)
// 걷기/궤도 시점 캡처 → Claude(vision)와 대화 → 카탈로그 id 기반 변경 제안 → 원클릭 적용.
// 브라우저에서 Claude API 직접 호출(raw HTTP + CORS 허용 헤더). 키는 localStorage.

import { state, emit, room, addLight, addExtra, addFurniture, lightGridOf, metricsOf,
         setFurnStatus } from './state.js';
import { FINISH_FLOOR, FINISH_WALL, FINISH_CEIL, CEIL_TYPES, LIGHTS, FURN_ITEMS,
         WORK_ITEMS, item } from './catalog.js';
import { getSceneRefs } from './scene3d.js';

const MODEL = 'claude-opus-5';
let chat = [];            // Claude 대화 이력 (content 블록 그대로 — thinking 블록 포함 재전송)

export function apiKey() { try { return localStorage.getItem('planshot_api_key') || ''; } catch { return ''; } }
export function setApiKey(k) { try { localStorage.setItem('planshot_api_key', (k || '').trim()); } catch {} }
export function resetChat() { chat = []; }

/// 현재 3D 시점(걷기로 멈춘 그 화면) 캡처 — 한 프레임 다시 그리고 즉시 추출
export function captureViewpoint() {
  const { scene, camera, renderer } = getSceneRefs();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/jpeg', 0.85);
}

// ── 컨텍스트 브리핑 (시스템 프롬프트에 주입) ─────────────────
function catBrief() {
  const li = a => a.map(x => `${x.id}=${x.name}(${((x.mat || 0) + (x.lab || 0)).toLocaleString()}원/${x.unit})`).join(', ');
  const wi = WORK_ITEMS.slice(0, 43).map(w => w.grades.map((g, i) =>
    `${w.id}#${i}=${w.name}·${g.g}`).join(', ')).join(', ');
  return `[바닥] ${li(FINISH_FLOOR)}\n[벽] ${li(FINISH_WALL)}\n[천장] ${li(FINISH_CEIL)}\n[천장유형] ${li(CEIL_TYPES)}\n[조명] ${li(LIGHTS)}\n[가구] ${FURN_ITEMS.map(f => f.name).join(', ')}\n[공사항목] ${wi}`;
}
function planBrief() {
  const rooms = (state.project?.rooms || []).map(r => {
    const m = metricsOf(r);
    return `${r.name}: ${m.area.toFixed(1)}㎡ CH${Math.round(m.H * 1000)} 바닥=${item(r.floorFinish)?.name} 벽=${item(r.wallFinish)?.name} 천장=${item(r.ceilFinish)?.name}/${item(r.ceilingType)?.name || '기존'} 조명${(r.lights || []).length} 가구[${(r.plan.furniture || []).map(f => f.category_ko || f.category).join(',')}]`;
  }).join('\n');
  return `\n\n[현재 공간]\n${rooms}`;
}

const SYS = `너는 PlanShot의 AI 인테리어 디자이너다. 사용자가 자기 집 3D 모델 안을 걸어다니며 고른 시점 캡처를 보여주고 원하는 분위기를 말한다.
역할: ①시점 이미지를 읽고 현재 상태 진단 ②원하는 스타일을 구체 마감·조명·가구로 번역 ③아래 카탈로그의 실재 id만 써서 변경안 제시(개략 비용 감각 포함) ④짧고 단정한 한국어.
반드시 답변 끝에 적용 가능한 변경을 JSON 코드블록으로 붙여라(없으면 빈 배열):
\`\`\`json
{"changes":[
 {"action":"set_finish","room":"거실","kind":"floor|wall|ceil","id":"fl_..."},
 {"action":"set_ceiling","room":"거실","id":"ct_..."},
 {"action":"set_color","room":"거실","kind":"floor|wall|ceil","hex":"D8CFC0"},
 {"action":"add_light","room":"거실","id":"lt_...","count":4},
 {"action":"add_work","room":"거실","id":"w_xxx#1","qty":26},
 {"action":"add_furniture","room":"거실","name":"소파 3인"}
]}
\`\`\`
규칙: id는 카탈로그에 실재하는 것만. room은 실제 실명. 제안은 3~6건으로 압축. 이미지가 없으면 공간 요약만으로 제안.
[카탈로그]\n` + '';

// ── API 호출 ─────────────────────────────────────
export async function askDesigner(userText, imageDataUrl) {
  if (!apiKey()) throw new Error('API 키가 없습니다 — AI 패널의 "키 설정"에 Anthropic API 키를 넣어주세요');
  const content = [];
  if (imageDataUrl) {
    content.push({ type: 'image', source: {
      type: 'base64', media_type: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  }
  content.push({ type: 'text', text: userText });
  chat.push({ role: 'user', content });
  // 이력 상한: 오래된 턴은 통째로 제거(중간 편집 금지 — 캐시·thinking 규약)
  while (chat.length > 10) chat.splice(0, 2);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        fallbacks: 'default',              // 안전 거절 시 자동 폴백 라우팅
        system: SYS + catBrief() + planBrief(),
        messages: chat,
      }),
    });
  } catch (err) {
    chat.pop();
    throw new Error('네트워크 오류: ' + (err?.message || err));
  }
  if (!res.ok) {
    chat.pop();
    const t = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${t.slice(0, 240)}`);
  }
  const data = await res.json();
  chat.push({ role: 'assistant', content: data.content });
  if (data.stop_reason === 'refusal') {
    return { text: '요청을 처리할 수 없었습니다(안전 정책). 다르게 표현해 주세요.', changes: [] };
  }
  const full = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = full.match(/```json\s*([\s\S]*?)```/);
  let changes = [];
  if (m) { try { changes = JSON.parse(m[1]).changes || []; } catch { changes = []; } }
  return { text: full.replace(/```json[\s\S]*?```/, '').trim(), changes };
}

// ── 제안 적용 ─────────────────────────────────────
export function describeChange(ch) {
  const nm = id => item(id)?.name || id;
  switch (ch.action) {
    case 'set_finish': return `${ch.room} ${({ floor: '바닥', wall: '벽', ceil: '천장' })[ch.kind]} → ${nm(ch.id)}`;
    case 'set_ceiling': return `${ch.room} 천장 유형 → ${nm(ch.id)}`;
    case 'set_color': return `${ch.room} ${({ floor: '바닥', wall: '벽', ceil: '천장' })[ch.kind]} 색 → #${ch.hex}`;
    case 'add_light': return `${ch.room} ${nm(ch.id)} ×${ch.count || 1}`;
    case 'add_work': return `${ch.room} ${nm(ch.id)} ${ch.qty ?? ''}`;
    case 'add_furniture': return `${ch.room} 가구 추가: ${ch.name}`;
    default: return JSON.stringify(ch);
  }
}

export function applyChange(ch) {
  const r = (state.project?.rooms || []).find(x => x.name === ch.room) || room(state.selRoom);
  if (!r) return false;
  switch (ch.action) {
    case 'set_finish': {
      if (!item(ch.id)) return false;
      if (ch.kind === 'floor') r.floorFinish = ch.id;
      else if (ch.kind === 'wall') r.wallFinish = ch.id;
      else if (ch.kind === 'ceil') r.ceilFinish = ch.id;
      else return false;
      if (r.finishColors) delete r.finishColors[ch.kind];
      break;
    }
    case 'set_ceiling':
      if (!CEIL_TYPES.some(c => c.id === ch.id)) return false;
      r.ceilingType = ch.id; break;
    case 'set_color': {
      const v = parseInt(String(ch.hex || '').replace('#', ''), 16);
      if (isNaN(v)) return false;
      if (!r.finishColors) r.finishColors = {};
      r.finishColors[ch.kind] = v; break;
    }
    case 'add_light': {
      if (!item(ch.id)) return false;
      const pts = lightGridOf(r);
      const n = Math.max(1, Math.min(ch.count || 1, pts.length || 1));
      const step = Math.max(1, Math.floor((pts.length || 1) / n));
      for (let i = 0; i < n; i++) {
        const p = pts[Math.min(pts.length - 1, i * step)] || [1, 1];
        addLight(r, ch.id, p[0], p[1]);
      }
      break;
    }
    case 'add_work':
      if (!item(ch.id)) return false;
      addExtra(r, ch.id, ch.qty || 1); break;
    case 'add_furniture': {
      const f = FURN_ITEMS.find(x => x.name === ch.name) ||
                FURN_ITEMS.find(x => ch.name && x.name.includes(String(ch.name).slice(0, 2)));
      if (!f) return false;
      const bbm = metricsOf(r);
      addFurniture(r, f.category, f.name, f.w, f.d, bbm.w / 2, bbm.d / 2);
      break;
    }
    default: return false;
  }
  emit('project');
  return true;
}
