// estimate.js — 실측 수량 × 유형/재료 단가 → 견적. 표 렌더 + CSV + 인쇄.
// RhinoBIM `bq`(물량 CSV)의 웹판: 모델을 바꾸면 즉시 재계산된다.

import { state, emit, metricsOf, wallsOf } from './state.js';
import { item, ratesOf, KRW, CEIL_TYPES, canonId, crewOf, DAY_RATES, furnDisposalKg, furnPriceOf } from './catalog.js';

const isWet = name => /욕실|화장실|발코니|베란다/.test(name || '');

// 견적 라인 생성: [{roomName, cat, id, name, spec, unit, qty, rate, amount}]
export function buildEstimate() {
  const rows = [];
  const P = state.project;
  if (!P) return { rows, sub: 0, vat: 0, total: 0 };

  for (const r of P.rooms) {
    const m = metricsOf(r);
    const wallsAll = wallsOf(r);
    const push = (cat, id, qty, note = '') => {
      const it = item(id); if (!it || qty <= 0.001) return;
      const { m: rm, l: rl } = ratesOf(id, P.rates);
      rows.push({ roomName: r.name, cat, id, name: it.name, spec: it.spec, unit: it.unit,
                  qty, m: rm, l: rl, rate: rm + rl,
                  amountM: qty * rm, amountL: qty * rl, amount: qty * (rm + rl), note });
    };

    // 바닥
    push('바닥', canonId(r.floorFinish), m.area);
    // 벽: 기본 마감 = 순면적 − 오버라이드 벽 면적, 오버라이드는 개별
    let overrideA = 0, innerBoth = 0;
    for (const w of wallsAll) {   // 가벽은 양면 도배 — 기본 벽마감 수량에 합산
      if (w.inner && !(r.wallOverrides || {})[w.key]) innerBoth += w.netArea * 2;
    }
    for (const [wk, fid] of Object.entries(r.wallOverrides || {})) {
      const w = wallsAll.find(x => x.key === wk); if (!w) continue;
      if (!w.inner) overrideA += w.netArea;      // 내부벽은 기본 벽마감(둘레 기준)에 안 들어 있음
      push('벽(개별)', fid, w.netArea * (w.inner ? 2 : 1), '벽 ' + wk + (w.inner ? ' 양면' : ''));
    }
    push('벽', r.wallFinish, Math.max(0, m.wallNet - overrideA) + innerBoth);
    // 천장
    push('천장', r.ceilFinish, m.area);
    const ct = CEIL_TYPES.find(c => c.id === r.ceilingType);
    if (ct && ct.rate !== 0) push('천장 유형', ct.id, ct.basis === 'perimeter' ? m.per : m.area);
    // 벽체 유형(신설/철거)
    for (const [wk, tid] of Object.entries(r.wallTypes || {})) {
      const w = wallsAll.find(x => x.key === wk); if (!w) continue;
      push('벽체 유형', tid, w.netArea, '벽 ' + wk);
    }
    // 부자재 — 건식 실만
    if (!isWet(r.name)) {
      push('부자재', 'tr_base', m.baseboard);
      push('부자재', 'tr_mold', m.molding);
    }
    // 조명 — 유형별 개수/길이 합산
    const cnt = {}, len = {};
    for (const l of r.lights || []) {
      const li = item(l.type); if (!li) continue;
      if (li.kind === 'line' && l.x2 != null) len[l.type] = (len[l.type] || 0) + Math.hypot(l.x2 - l.x, l.z2 - l.z);
      else cnt[l.type] = (cnt[l.type] || 0) + 1;
    }
    for (const [id, n] of Object.entries(cnt)) push('조명', id, n);
    for (const [id, L] of Object.entries(len)) push('조명', id, L);
    // 추가 공사 (창호·문·주방·욕실·전기·설비)
    for (const ex of r.extras || []) push('추가공사', ex.id, ex.qty, '수동 입력');

    // 가구 — 신규/교체 가구 구입·설치 자동 반영 (스캔된 기존 가구 제외)
    for (const f of r.plan.furniture || []) {
      if (f.status === 'dispose') continue;
      if (!(f.existing === false || f.replaced)) continue;
      const pr = furnPriceOf(f);
      if (!pr) continue;
      const fid = 'furn:' + pr.name;
      const ov = P.rates?.[fid];
      const rm2 = ov?.m ?? pr.m, rl2 = ov?.l ?? pr.l;
      rows.push({ roomName: r.name, cat: '가구', id: fid, name: pr.name + ' 구입·설치',
                  spec: f.replaced ? '교체' : '신규', unit: 'ea', qty: 1,
                  m: rm2, l: rl2, rate: rm2 + rl2, amountM: rm2, amountL: rl2, amount: rm2 + rl2,
                  note: f.replaced ? '기존 ' + f.replaced.name + ' 반출' : '가구 추가' });
    }
    // 가구 반출·폐기 — 폐기/교체 지정 시 자동 (수동 입력 있으면 중복 방지)
    const dispTon = Math.round(furnDisposalKg(r.plan.furniture) / 100) / 10;
    const manualOut = (r.extras || []).some(ex => String(ex.id).startsWith('w_furnout'));
    if (dispTon > 0 && !manualOut) push('철거·반출', 'w_furnout#1', dispTon, '자동(폐기·교체 가구)');
  }

  const sub = rows.reduce((s, x) => s + x.amount, 0);
  const subM = rows.reduce((s, x) => s + x.amountM, 0);
  const subL = rows.reduce((s, x) => s + x.amountL, 0);
  const vat = sub * (P.vatPct || 0) / 100;
  // 노무 품(인·일) 환산 — 직종별 노무비 합계 ÷ 일당. 1품 미만 공종은 실제 일당 청구 가능성 경고.
  const crews = {};
  for (const x of rows) {
    const c = crewOf(x.id);
    if (!c || x.amountL <= 0) continue;
    crews[c] = (crews[c] || 0) + x.amountL;
  }
  const laborDays = Object.entries(crews).map(([c, won]) => ({
    crew: c, won, days: won / (DAY_RATES[c] || 250000),
  })).sort((a, b) => b.won - a.won);
  // 철거 폐기물 추정(참고): 마감 철거 ㎡→kg + 벽 철거 + 가구 반출 톤
  const DEMO_KG = { 'w_demo#0': 4, 'w_demo#1': 14, 'w_demo#2': 22, wt_demo: 90 };
  let demoKg = 0;
  for (const x of rows) {
    if (DEMO_KG[x.id] != null) demoKg += x.qty * DEMO_KG[x.id];
    else if (String(x.id).startsWith('w_furnout')) demoKg += x.qty * 1000;
  }
  const demoTons = Math.round(demoKg / 100) / 10;
  return { rows, sub, subM, subL, vat, total: sub + vat, laborDays, demoTons };
}

export function renderEstimate(elSummary, elTable) {
  const { rows, sub, subM, subL, vat, total, laborDays, demoTons } = buildEstimate();
  elSummary.innerHTML = `
    <div class="est-sum">
      <div><span>재료비</span><b>${KRW(Math.round(subM))}원</b></div>
      <div><span>노무비</span><b>${KRW(Math.round(subL))}원</b></div>
      <div><span>소계</span><b>${KRW(Math.round(sub))}원</b></div>
      <div><span>부가세 ${state.project?.vatPct ?? 10}%</span><b>${KRW(Math.round(vat))}원</b></div>
      <div class="tot"><span>총계</span><b>${KRW(Math.round(total))}원</b></div>
      <div class="disc">참고 단가(재료/노무 분리) — 표에서 우리 회사 단가로 수정하세요</div>
      ${laborDays?.length ? `<div class="crewdays">노무 품 환산(참고): ${laborDays.map(d =>
        `${d.crew} ${d.days.toFixed(1)}품${d.days < 1 ? '⚠' : ''}`).join(' · ')}
        <span>⚠ = 1품(1일) 미만 — 실제로는 일당 단위 청구될 수 있어 소량 공정은 상향 조정 권장</span></div>` : ''}
      ${demoTons ? `<div class="crewdays">철거 폐기물 추정 ≈ <b>${demoTons}톤</b> — 철거·가구반출 수량 기반 (2.5톤 차량 ${Math.ceil(demoTons / 2.5)}대분)</div>` : ''}
    </div>`;

  let html = `<table class="est"><thead><tr>
    <th>실</th><th>품명</th><th>단위</th>
    <th class="r">수량</th><th class="r">재료단가</th><th class="r">노무단가</th><th class="r">금액</th></tr></thead><tbody>`;
  let lastRoom = '';
  for (const x of rows) {
    const q = x.unit === 'ea' ? String(Math.round(x.qty)) : x.qty.toFixed(1);
    html += `<tr>
      <td>${x.roomName !== lastRoom ? x.roomName : ''}</td>
      <td title="${x.cat} · ${x.spec}">${x.name}</td><td>${unitKo(x.unit)}</td>
      <td class="r">${q}</td>
      <td class="r"><input class="rate-in" data-id="${x.id}" data-kind="m" value="${KRW(x.m)}" size="7"></td>
      <td class="r"><input class="rate-in" data-id="${x.id}" data-kind="l" value="${KRW(x.l)}" size="7"></td>
      <td class="r">${KRW(Math.round(x.amount))}</td></tr>`;
    lastRoom = x.roomName;
  }
  html += `<tr class="sum"><td colspan="6">재료비 / 노무비</td><td class="r">${KRW(Math.round(subM))} / ${KRW(Math.round(subL))}</td></tr>
    <tr class="sum"><td colspan="6">소계</td><td class="r">${KRW(Math.round(sub))}</td></tr>
    <tr class="sum"><td colspan="6">부가세</td><td class="r">${KRW(Math.round(vat))}</td></tr>
    <tr class="sum tot"><td colspan="6">총계</td><td class="r">${KRW(Math.round(total))}</td></tr>
    </tbody></table>
    <div class="disc" style="margin-top:6px">개략 실측(iPhone LiDAR) 기반 — 시공 발주 전 정밀실측 필요. 단가 수정은 즉시 반영·저장됩니다.</div>`;
  elTable.innerHTML = html;

  // 단가 인라인 수정
  elTable.querySelectorAll('.rate-in').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = Number(String(inp.value).replace(/[^\d]/g, ''));
      if (isNaN(v)) return;
      const id = inp.dataset.id, kind = inp.dataset.kind;
      // 반대편 값은 화면의 짝 입력칸에서 읽는다 — 'furn:' 등 카탈로그 밖 id도 안전
      const other = elTable.querySelector(`.rate-in[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"][data-kind="${kind === 'm' ? 'l' : 'm'}"]`);
      const ov2 = Number(String(other?.value ?? '').replace(/[^\d]/g, '')) || 0;
      state.project.rates[id] = { m: kind === 'm' ? v : ov2, l: kind === 'l' ? v : ov2 };
      emit('rates');
    });
  });
}

function unitKo(u) { return { m2: '㎡', m: 'm', ea: '개', sik: '식', ton: '톤' }[u] || u; }

export function exportCSV() {
  const { rows, sub, subM, subL, vat, total, laborDays, demoTons } = buildEstimate();
  const d2 = new Date();
  const dateStr = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
  const lines = [];
  lines.push([`${state.project?.name || '미니빔'} — 인테리어 견적서`]);
  lines.push([state.project?.company || '', '', '', '', '', '', '', '', '', '', '작성일', dateStr]);
  lines.push([]);
  lines.push(['실', '공종', '품명', '규격', '단위', '수량',
              '재료 단가', '재료 금액', '노무 단가', '노무 금액', '합계', '비고']);
  let curRoom = null, rm = 0, rl = 0, rt = 0;
  const flushRoom = () => {
    if (curRoom === null) return;
    lines.push([`${curRoom} 소계`, '', '', '', '', '', '', Math.round(rm), '', Math.round(rl), Math.round(rt), '']);
    lines.push([]);
    rm = rl = rt = 0;
  };
  for (const x of rows) {
    if (x.roomName !== curRoom) { flushRoom(); curRoom = x.roomName; lines.push([`■ ${curRoom}`]); }
    lines.push(['', x.cat, x.name, x.spec, unitKo(x.unit),
                x.unit === 'ea' ? Math.round(x.qty) : Number(x.qty.toFixed(2)),
                x.m, Math.round(x.amountM), x.l, Math.round(x.amountL), Math.round(x.amount), x.note || '실측 자동']);
    rm += x.amountM; rl += x.amountL; rt += x.amount;
  }
  flushRoom();
  lines.push(['합계', '', '', '', '', '', '재료비', Math.round(subM), '노무비', Math.round(subL), Math.round(sub), '']);
  lines.push(['부가세 10%', '', '', '', '', '', '', '', '', '', Math.round(vat), '별도 표기']);
  lines.push(['총계(VAT 포함)', '', '', '', '', '', '', '', '', '', Math.round(total), '']);
  lines.push([]);
  if (laborDays?.length) {
    lines.push(['노무 품 환산(참고)', laborDays.map(x2 => `${x2.crew} ${x2.days.toFixed(1)}품`).join(' · ')]);
  }
  if (demoTons) lines.push(['철거 폐기물 추정', `${demoTons}톤 (2.5톤 차량 ${Math.ceil(demoTons / 2.5)}대분)`]);
  lines.push(['개략 실측 - 시공 발주 전 정밀실측 필요 · 단가=참고값(재료/노무 분리)']);
  const csv = '\uFEFF' + lines.map(l => l.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = (state.project?.name || '미니빔') + '_견적.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
