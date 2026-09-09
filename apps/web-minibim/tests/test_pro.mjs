// 프로 스프린트 검증: 내 단가표 우선순위 · 이윤행 불변식 · 발주 수량 · 공정 일정 · 고객 링크 코덱
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
const _ls = new Map();
globalThis.localStorage = {
  getItem: k => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: k => _ls.delete(k),
};
const base = (await import('url')).fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');
const st = await import(pathToFileURL(base + 'js/state.js'));
const est = await import(pathToFileURL(base + 'js/estimate.js'));
const biz = await import(pathToFileURL(base + 'js/biz.js'));
const share = await import(pathToFileURL(base + 'js/share.js'));
const A = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
const near = (a, b, t = 0.5) => Math.abs(a - b) < t;

st.loadJSONText(readFileSync(base + 'sample/sample_apt3.json', 'utf-8'), 'apt3');

// 1) 기준선 — 이윤 0%: 불변식 (Σamount=sub, subM+subL=sub, vat, total)
let e = est.buildEstimate();
const sub0 = e.sub;
A(near(e.rows.reduce((s, x) => s + x.amount, 0), e.sub), 'Σamount=sub');
A(near(e.subM + e.subL, e.sub), 'subM+subL=sub');
A(near(e.total, e.sub + e.vat), 'total=sub+vat');
A(!e.rows.some(x => x.id === 'biz_margin'), '이윤 0% → 이윤행 없음');

// 2) 이윤 10% — 이윤행 1개, sub = 기존×1.1, 불변식 유지
localStorage.setItem('planshot_biz', JSON.stringify({ marginPct: 10, myRates: {} }));
biz._resetBizCache();
e = est.buildEstimate();
const mrow = e.rows.filter(x => x.id === 'biz_margin');
A(mrow.length === 1, '이윤행 1개');
A(near(e.sub, sub0 * 1.10, 1), `sub=기존×1.1: ${e.sub} vs ${sub0 * 1.1}`);
A(near(e.rows.reduce((s, x) => s + x.amount, 0), e.sub), '이윤 포함 Σamount=sub');
A(near(e.subM + e.subL, e.sub), '이윤 포함 subM+subL=sub');
A(near(e.total, e.sub + e.vat), '이윤 포함 total');
// 노무 품 오염 없음 — 이윤은 amountM 측
A(!e.laborDays.some(d => d.crew === undefined || d.crew === 'undefined'), '이윤행이 노무 품에 안 섞임');

// 3) 내 단가표 우선순위: myRates < project.rates
biz._resetBizCache();
localStorage.setItem('planshot_biz', JSON.stringify({ marginPct: 0, myRates: { wl_silk: { m: 9000, l: 9000 } } }));
biz._resetBizCache();
e = est.buildEstimate();
const silk = e.rows.find(x => x.id === 'wl_silk');
A(silk && silk.m === 9000 && silk.l === 9000, '내 단가표 적용: ' + silk?.m);
st.state.project.rates = { wl_silk: { m: 7000, l: 8000 } };
e = est.buildEstimate();
const silk2 = e.rows.find(x => x.id === 'wl_silk');
A(silk2 && silk2.m === 7000 && silk2.l === 8000, '현장 단가가 내 단가표를 이김');
st.state.project.rates = {};

// 4) 발주 수량 — 로스·포장 올림 재검산
const ol = est.buildOrderList();
A(ol.length >= 3, '발주 대상 ' + ol.length + '종');
for (const o of ol) {
  const expect = Math.ceil(o.need * (1 + o.pack.loss) / o.pack.cap);
  A(o.buy === expect && o.buy >= 1, `발주 재검산 ${o.id}: ${o.buy} vs ${expect}`);
}
const silkOrder = ol.find(o => o.id === 'wl_silk' || o.id === 'cl_silk' || o.id === 'wl_paper');
A(silkOrder, '도배 발주 존재');

// 5) 공정 일정 — 표준 순서 · 0.5일 단위 · 총합
const sc = est.buildSchedule();
A(sc.items.length >= 2, '공정 ' + sc.items.length + '개');
A(sc.items.every(x => Math.abs(x.days * 2 - Math.round(x.days * 2)) < 1e-9 && x.days >= 0.5), '0.5일 단위');
A(near(sc.total, sc.items.reduce((s, x) => s + x.days, 0), 1e-9), '총합 일치');
const order = sc.items.map(x => x.crew);
const iDemol = order.indexOf('철거·보통인부'), iPaper = order.indexOf('도배');
if (iDemol >= 0 && iPaper >= 0) A(iDemol < iPaper, '철거가 도배보다 먼저');

// 6) 고객 링크 코덱 — 왕복 무손실 + 배너 정보
const link = await share.makeShareLink(st.state.project, { name: '테스트인테리어', phone: '010-1234-5678' }, 'https://x.test/app/');
A(link && link.includes('#r='), '링크 생성');
const parsed = await share.parseShareHash(link.slice(link.indexOf('#')));
A(parsed && parsed.biz.name === '테스트인테리어', '사업자명 왕복');
A(JSON.stringify(parsed.p) === JSON.stringify(st.state.project), '프로젝트 왕복 무손실');
A(await share.parseShareHash('#r=%%%broken') === null, '손상 링크 → null(크래시 없음)');

// 7) [감사수정] 발송 시 이윤·내단가 굽기 — 고객 화면 총액 = 프로 총액
localStorage.setItem('planshot_biz', JSON.stringify({ marginPct: 15, myRates: { wl_silk: { m: 9000, l: 9000 } } }));
biz._resetBizCache();
const proTotal = est.buildEstimate().total;
const baked = JSON.parse(JSON.stringify(st.state.project));
baked.rates = { ...biz.getBiz().myRates, ...(baked.rates || {}) };
baked.marginPct = 15;
const link2 = await share.makeShareLink(baked, biz.getBiz(), 'https://x.test/');
const got = await share.parseShareHash(link2.slice(link2.indexOf('#')));
localStorage.removeItem('planshot_biz'); biz._resetBizCache();          // 고객 브라우저 = 빈 biz
st.loadJSONText(JSON.stringify(got.p), 'cust');
st.state.customerView = true;
const custTotal = est.buildEstimate().total;
A(near(custTotal, proTotal, 1), `고객 총액=프로 총액: ${custTotal} vs ${proTotal}`);

// 8) [감사수정] 고객 화면에서 열람자 내 단가표 무시
localStorage.setItem('planshot_biz', JSON.stringify({ myRates: { wl_silk: { m: 1, l: 1 } } }));
biz._resetBizCache();
A(near(est.buildEstimate().total, proTotal, 1), '열람자 내단가가 고객 견적을 오염시키지 않음');
st.state.customerView = false;
localStorage.removeItem('planshot_biz'); biz._resetBizCache();
st.loadJSONText(readFileSync(base + 'sample/sample_apt3.json', 'utf-8'), 'apt3');

// 9) [감사수정] 미등록 공종도 일정 '기타'로 집계
const t0 = est.buildSchedule().total;
st.state.project.rooms[2].extras.push({ id: 'w_bath_pkg#1', qty: 1 });
const t1 = est.buildSchedule().total;
A(t1 > t0, `욕실 패키지 추가로 일정 증가: ${t0} → ${t1}`);
st.state.project.rooms[2].extras.pop();

// 10) [감사수정] home 범위에서 이윤행은 고정 상수(스윙 제외)
st.state.project.marginPct = 10;
const eh = est.buildEstimateHome();
const mrow2 = eh.rows.find(x => x.id === 'biz_margin');
const matB = eh.subM - mrow2.amount;
const vatK2 = 1.1;
A(near(eh.high - eh.low, matB * 0.35 * vatK2, 1), '스윙 폭 = 자재비(이윤 제외)×0.35');
delete st.state.project.marginPct;

// 11) [플라이휠] 기준단가 편차 — 무조정=0%, 인하 시 음수, 이윤행 무관
let eb = est.buildEstimate();
A(Math.abs(eb.benchPct) < 0.01, '무조정 benchPct=0: ' + eb.benchPct);
st.state.project.rates = { wl_silk: { m: 1250, l: 2750 } };
eb = est.buildEstimate();
A(eb.benchPct < -0.1, '단가 인하 시 음수: ' + eb.benchPct);
st.state.project.marginPct = 10;
A(Math.abs(est.buildEstimate().benchPct - eb.benchPct) < 1e-9, '이윤행이 benchPct에 무영향');
delete st.state.project.marginPct;
st.state.project.rates = {};

// 12) [플라이휠] 지표 스텁 — 누적·요약 라인
const met = await import(pathToFileURL(base + 'js/metrics.js'));
met.track('scan_load'); met.track('ai_suggest', 3); met.track('share');
const mm = met.getMetrics();
A(mm.scan_load === 1 && mm.ai_suggest === 3 && mm.share === 1, '지표 누적: ' + JSON.stringify(mm));
A(met.metricsLine().includes('실측 로드 1회') && met.metricsLine().includes('AI 제안 3건'), '지표 요약 라인');
localStorage.removeItem('planshot_metrics');

// 뒷정리 — 다른 테스트에 전역 오염 방지
localStorage.removeItem('planshot_biz');
biz._resetBizCache();
console.log('PRO 스프린트 검증 ALL OK — 이윤행·내단가·발주', ol.length + '종 · 일정', sc.total + '일 · 링크', Math.round(link.length / 1024) + 'KB');
