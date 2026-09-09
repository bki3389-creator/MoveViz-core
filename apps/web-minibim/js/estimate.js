// estimate.js — 실측 수량 × 유형/재료 단가 → 견적. 표 렌더 + CSV + 인쇄.
// RhinoBIM `bq`(물량 CSV)의 웹판: 모델을 바꾸면 즉시 재계산된다.

import { state, emit, metricsOf, wallsOf } from './state.js';
import { item, ratesOf, KRW, CEIL_TYPES, canonId, crewOf, DAY_RATES, furnDisposalKg, furnPriceOf,
         ORDER_PACKS, CREW_SEQ } from './catalog.js';
import { getBiz, saveBiz, setMyRate } from './biz.js';

const isWet = name => /욕실|화장실|발코니|베란다/.test(name || '');

// 견적 라인 생성: [{roomName, cat, id, name, spec, unit, qty, rate, amount}]
export function buildEstimate(P = state.project, { biz = getBiz(), customerView = state.customerView } = {}) {
  const rows = [];
  if (!P) return { rows, sub: 0, subM: 0, subL: 0, vat: 0, total: 0, laborDays: [], demoTons: 0 };
  // 단가 우선순위: 현장별 조정(project.rates) > 내 단가표(전역) > 카탈로그 기본.
  // 고객 링크 뷰에선 열람자의 내 단가표를 섞지 않는다 — 보낸 견적 그대로(감사 확정)
  const OV = customerView ? { ...(P.rates || {}) } : { ...biz?.myRates, ...(P.rates || {}) };

  for (const r of P.rooms) {
    const m = metricsOf(r, P);
    const wallsAll = wallsOf(r, P);
    const push = (cat, id, qty, note = '') => {
      const it = item(id); if (!it || qty <= 0.001) return;
      const { m: rm, l: rl } = ratesOf(id, OV);
      rows.push({ roomId: r.id, roomName: r.name, cat, id, name: it.name, spec: it.spec, unit: it.unit,
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
    if (ct && (ct.mat || ct.lab)) push('천장 유형', ct.id, ct.basis === 'perimeter' ? m.per : m.area);   // rate 필드는 v3에서 폐기 — 0원 유령 행 방지
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
      const ov = OV[fid];
      const rm2 = ov?.m ?? pr.m, rl2 = ov?.l ?? pr.l;
      rows.push({ roomId: r.id, roomName: r.name, cat: '가구', id: fid, name: pr.name + ' 구입·설치',
                  spec: f.replaced ? '교체' : '신규', unit: 'ea', qty: 1,
                  m: rm2, l: rl2, rate: rm2 + rl2, amountM: rm2, amountL: rl2, amount: rm2 + rl2,
                  note: f.replaced ? '기존 ' + f.replaced.name + ' 반출' : '가구 추가' });
    }
    // 가구 반출·폐기 — 폐기/교체 지정 시 자동 (수동 입력 있으면 중복 방지)
    const dispKg = furnDisposalKg(r.plan.furniture);
    const dispTon = dispKg > 0 ? Math.max(0.1, Math.round(dispKg / 100) / 10) : 0;   // 50kg 미만도 0.1t 최소 청구 — 반올림 소실 방지
    const manualOut = (r.extras || []).some(ex => String(ex.id).startsWith('w_furnout'));
    if (dispTon > 0 && !manualOut) push('철거·반출', 'w_furnout#1', dispTon, '자동(폐기·교체 가구)');
  }

  // 이윤·일반관리비 — 사업자 설정 %(견적 관례상 소계 전 별도 행). 노무 품 환산 오염 방지 위해 amountM 측.
  // 고객 링크는 발송 시 project.marginPct로 구워져 옴 — 프로젝트 값이 열람자 설정보다 우선
  const mp = Number(P.marginPct ?? (customerView ? 0 : biz?.marginPct)) || 0;
  if (mp > 0 && rows.length) {
    const base = rows.reduce((s, x) => s + x.amount, 0);
    const mAmt = base * mp / 100;
    rows.push({ roomName: '공통', cat: '제경비', id: 'biz_margin', name: `이윤·일반관리비 ${mp}%`,
                spec: '', unit: '식', qty: 1, m: mAmt, l: 0, rate: mAmt,
                amountM: mAmt, amountL: 0, amount: mAmt, note: '⚙ 설정에서 % 조정' });
  }

  const sub = rows.reduce((s, x) => s + x.amount, 0);
  const subM = rows.reduce((s, x) => s + x.amountM, 0);
  const subL = rows.reduce((s, x) => s + x.amountL, 0);
  const vat = sub * (P.vatPct || 0) / 100;
  // 노무 품(인·일) 환산 — 직종별 노무비 합계 ÷ 일당. 1품 미만 공종은 실제 일당 청구 가능성 경고.
  const crews = {};
  for (const x of rows) {
    if (x.amountL <= 0) continue;
    const c = crewOf(x.id) || '기타';   // 미등록 공종(욕실 패키지 등)도 일정·품에서 빠뜨리지 않는다(감사 확정)
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
  // 기준 단가 대비 편차 — 표준 단가표(카탈로그) 총액 대비 유효 견적(제경비 제외).
  // 시세 데이터 축적의 표시면: 지금은 표준 단가표가 기준, 축적되면 지역 실단가 분포로 대체.
  let benchBase = 0, benchEff = 0;
  for (const x of rows) {
    if (x.id === 'biz_margin') continue;
    const it = item(x.id); if (!it) continue;
    benchBase += x.qty * ((it.mat ?? 0) + (it.lab ?? 0));
    benchEff += x.amount;
  }
  const benchPct = benchBase > 0 ? (benchEff - benchBase) / benchBase * 100 : 0;
  return { rows, sub, subM, subL, vat, total: sub + vat, laborDays, demoTons, benchPct };
}

// ── 발주 수량 — 물량 × (1+로스) ÷ 포장 단위, 올림 ─────────────
export function buildOrderList() {
  const { rows } = buildEstimate();
  const agg = new Map();
  for (const x of rows) {
    const p = ORDER_PACKS[x.id];
    if (!p) continue;
    const e = agg.get(x.id) || { id: x.id, name: x.name, unit: item(x.id)?.unit || 'm2', need: 0, pack: p };
    e.need += x.qty;
    agg.set(x.id, e);
  }
  return [...agg.values()].map(e => ({
    ...e,
    buy: Math.ceil(e.need * (1 + e.pack.loss) / e.pack.cap),
  }));
}

// ── 공정 일정 — 노무 품을 표준 시공 순서로 (0.5일 올림, 순차 합계) ──
export function buildSchedule() {
  const { laborDays } = buildEstimate();
  const seqIdx = c => { const i = CREW_SEQ.indexOf(c); return i < 0 ? 99 : i; };
  const items = (laborDays || [])
    .filter(d => d.days > 0.05)
    .map(d => ({ crew: d.crew, days: Math.max(0.5, Math.ceil(d.days * 2) / 2) }))
    .sort((a, b) => seqIdx(a.crew) - seqIdx(b.crew));
  return { items, total: items.reduce((s, x) => s + x.days, 0) };
}

export function renderProExtras(elOrder, elSched) {
  if (!elOrder || !elSched) return;
  const ol = buildOrderList();
  elOrder.innerHTML = ol.length
    ? `<table class="est"><thead><tr><th>자재</th><th class="r">소요</th><th class="r">로스</th><th class="r">발주</th></tr></thead><tbody>`
      + ol.map(e => `<tr><td title="${e.pack.note || ''}">${e.name}</td>
          <td class="r">${e.need.toFixed(1)}${e.unit === 'm' ? 'm' : '㎡'}</td>
          <td class="r">${Math.round(e.pack.loss * 100)}%</td>
          <td class="r"><b>${e.buy} ${e.pack.pack}</b></td></tr>`).join('')
      + '</tbody></table><div class="disc">포장 규격·로스율은 제품별로 확인 후 조정하세요</div>'
    : '<div class="disc">발주 대상 자재 없음 (기존 유지 마감)</div>';
  const sc = buildSchedule();
  elSched.innerHTML = sc.items.length
    ? sc.items.map(x => `<div class="sched-row"><span>${x.crew}</span>
        <i style="width:${Math.max(8, Math.min(100, x.days / sc.total * 100))}%"></i><b>${x.days}일</b></div>`).join('')
      + `<div class="disc">총 <b>${sc.total}일</b> — 순차 시공 기준(병행 시 단축), 자재 수급 별도</div>`
    : '<div class="disc">일정 산출 대상 없음</div>';
}

// ── 내 집 모드 요약 — buildEstimate() 재활용, 방별 합계 + 자재등급 범위 ──
const esc2 = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const KRWman = v => KRW(Math.round(v / 10000) * 10000);   // 만원 라운딩 — 소비자에게 1원 단위는 소음

/// 범위 근거: 인건비·부가세율 고정, 자재비만 등급폭 −10%~+25%로 흔든 보수적 근사
export function buildEstimateHome() {
  const est = buildEstimate();
  const perRoom = [];
  let cur = null;
  for (const x of est.rows) {   // rows는 방 순서 정렬
    if (!cur || cur.name !== x.roomName) { cur = { name: x.roomName, amount: 0 }; perRoom.push(cur); }
    cur.amount += x.amount;
  }
  const vatK = 1 + (state.project?.vatPct ?? 10) / 100;
  // 자재비만 등급폭으로 흔든다 — 이윤행(amountM 측)은 고정 상수로 제외(이중 스윙 방지)
  const mAmt = est.rows.find(x => x.id === 'biz_margin')?.amount || 0;
  const matBase = est.subM - mAmt;
  return { ...est, perRoom,
           low: (est.subL + matBase * 0.90 + mAmt) * vatK,
           high: (est.subL + matBase * 1.25 + mAmt) * vatK };
}

export function renderEstimateHome(elSummary) {
  const { perRoom, low, high } = buildEstimateHome();
  if (!perRoom.length) {
    elSummary.innerHTML = '<div class="est-sum"><div class="disc">방을 추가하면 예상 비용이 나와요</div></div>';
    return;
  }
  elSummary.innerHTML = `
    <div class="est-sum est-home">
      <div class="tot"><span>총 예상 비용</span><b>${KRWman(low)} ~ ${KRWman(high)}원</b></div>
      <div class="disc">자재 등급·현장 상황에 따라 달라져요 (세금 포함)</div>
      ${perRoom.map(r => `<div><span>${esc2(r.name)}</span><b>${KRW(Math.round(r.amount))}원</b></div>`).join('')}
    </div>`;
}

export function renderEstimate(elSummary, elTable) {
  const { rows, sub, subM, subL, vat, total, laborDays, demoTons, benchPct } = buildEstimate();
  const benchBadge = rows.length
    ? `<div class="bench ${benchPct > 0.05 ? 'up' : benchPct < -0.05 ? 'down' : ''}">기준 단가 대비
        <b>${benchPct >= 0 ? '+' : ''}${benchPct.toFixed(1)}%</b>
        <small>PlanShot 표준 단가표 기준 — 현장이 쌓일수록 지역 실단가 분포로 정밀해집니다</small></div>`
    : '';
  elSummary.innerHTML = `
    <div class="est-sum">
      <div><span>재료비</span><b>${KRW(Math.round(subM))}원</b></div>
      <div><span>노무비</span><b>${KRW(Math.round(subL))}원</b></div>
      <div><span>소계</span><b>${KRW(Math.round(sub))}원</b></div>
      <div><span>부가세 ${state.project?.vatPct ?? 10}%</span><b>${KRW(Math.round(vat))}원</b></div>
      <div class="tot"><span>총계</span><b>${KRW(Math.round(total))}원</b></div>
      ${benchBadge}
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
    // XSS 방어: roomName·name 등은 고객 링크 페이로드에서 올 수 있는 사용자 데이터 — 전부 이스케이프(감사 확정)
    const rateCells = x.id === 'biz_margin'
      ? `<td class="r">—</td><td class="r">—</td>`   // 이윤행은 % 설정으로만 조정 — 입력칸 없음
      : `<td class="r"><input class="rate-in" data-id="${esc2(x.id)}" data-kind="m" value="${KRW(x.m)}" size="7"></td>
         <td class="r"><input class="rate-in" data-id="${esc2(x.id)}" data-kind="l" value="${KRW(x.l)}" size="7"></td>`;
    html += `<tr>
      <td>${x.roomName !== lastRoom ? esc2(x.roomName) : ''}</td>
      <td title="${esc2(x.cat)} · ${esc2(x.spec)}">${esc2(x.name)}</td><td>${unitKo(x.unit)}</td>
      <td class="r">${q}</td>
      ${rateCells}
      <td class="r">${KRW(Math.round(x.amount))}</td></tr>`;
    lastRoom = x.roomName;
  }
  html += `<tr class="sum"><td colspan="6">재료비 / 노무비</td><td class="r">${KRW(Math.round(subM))} / ${KRW(Math.round(subL))}</td></tr>
    <tr class="sum"><td colspan="6">소계</td><td class="r">${KRW(Math.round(sub))}</td></tr>
    <tr class="sum"><td colspan="6">부가세</td><td class="r">${KRW(Math.round(vat))}</td></tr>
    <tr class="sum tot"><td colspan="6">총계</td><td class="r">${KRW(Math.round(total))}</td></tr>
    </tbody></table>
    <label class="disc rate-my"><input type="checkbox" id="rateToMy" ${getBiz().saveToMy ? 'checked' : ''}>
      단가 수정을 <b>내 단가표</b>에도 저장 (모든 현장 기본값)</label>
    <div class="disc" style="margin-top:6px">개략 실측(iPhone LiDAR) 기반 — 시공 발주 전 정밀실측 필요. 단가 수정은 즉시 반영·저장됩니다.</div>`;
  elTable.innerHTML = html;
  const chkMy = elTable.querySelector('#rateToMy');
  if (chkMy) chkMy.onchange = () => saveBiz({ saveToMy: chkMy.checked });

  // 단가 인라인 수정
  elTable.querySelectorAll('.rate-in').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = Number(String(inp.value).replace(/[^\d]/g, ''));
      if (isNaN(v)) return;
      const id = inp.dataset.id, kind = inp.dataset.kind;
      if (id === 'biz_margin') return;   // 이윤행 조정은 ⚙ 설정의 %로만
      // 반대편 값은 화면의 짝 입력칸에서 읽는다 — 'furn:' 등 카탈로그 밖 id도 안전
      const other = elTable.querySelector(`.rate-in[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"][data-kind="${kind === 'm' ? 'l' : 'm'}"]`);
      const ov2 = Number(String(other?.value ?? '').replace(/[^\d]/g, '')) || 0;
      const nm2 = kind === 'm' ? v : ov2, nl2 = kind === 'l' ? v : ov2;
      state.project.rates[id] = { m: nm2, l: nl2 };
      if (getBiz().saveToMy && id !== 'biz_margin') setMyRate(id, nm2, nl2);   // 내 단가표에도 반영
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
  lines.push(['부가세 ' + (state.project?.vatPct ?? 10) + '%', '', '', '', '', '', '', '', '', '', Math.round(vat), '별도 표기']);
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
