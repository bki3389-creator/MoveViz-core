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

// 뒷정리 — 다른 테스트에 전역 오염 방지
localStorage.removeItem('planshot_biz');
biz._resetBizCache();
console.log('PRO 스프린트 검증 ALL OK — 이윤행·내단가·발주', ol.length + '종 · 일정', sc.total + '일 · 링크', Math.round(link.length / 1024) + 'KB');
