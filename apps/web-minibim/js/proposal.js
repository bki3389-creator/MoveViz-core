// 공간 제안 — 비교는 독립 프로젝트에서, 명시적인 적용만 현재 현장에 반영한다.
import { state, on, emit, pushProjectHistory } from './state.js';
import { getBiz } from './biz.js';
import { item } from './catalog.js';
import { buildProposal, applyProposal } from './proposal-model.js';
import { proposalTemplate } from './proposal-template.js';
import { captureProposalRoom, exitWalk } from './scene3d.js';

const IMAGES = { warm: './assets/proposal/warm.jpg', calm: './assets/proposal/calm.jpg' };
const TITLES = { current: '지금의 공간을 기준으로.', warm: '온기가 머무는, 오크.', calm: '빛을 담은, 뉴트럴.' };
const money = n => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';
const diff = n => Math.abs(n) < .5 ? '비용 변동 없음' : `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`;
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const dry = r => !/욕실|화장실|발코니|베란다/.test(r.name || '');

export function initProposal({ onEdit, onShare }) {
  const view = document.createElement('div');
  view.id = 'proposalView';
  view.innerHTML = proposalTemplate();
  document.getElementById('layout').before(view);
  const $ = id => view.querySelector('#' + id);
  let projectRef, roomId, selectedId = 'warm', data, modelPreview = false;
  const previews = new Map();
  const options = () => ({ roomId, biz: state.customerView ? {} : getBiz(), customerView: !!state.customerView });
  const currentOption = () => data?.options.find(x => x.id === selectedId) || data?.options[0];
  view.querySelector('.proposal-brand').onclick = e => { e.preventDefault(); window.scrollTo({top:0,behavior:'smooth'}); };

  function status(text) { $('propStatus').textContent = text; }

  function render() {
    if (!document.body.classList.contains('proposal-open')) return;
    const p = state.project;
    if (!p?.rooms?.some(r => r.id === roomId && dry(r))) {
      roomId = p?.rooms?.find(r => r.id === p.proposal?.roomId && dry(r))?.id
        || p?.rooms?.find(r => /거실/.test(r.name) && dry(r))?.id
        || p?.rooms?.find(dry)?.id;
    }
    if (projectRef !== p) {
      projectRef = p;
      previews.clear();
      data = buildProposal(p, options());
      selectedId = data?.selectedId || 'warm';
    } else data = buildProposal(p, options());
    $('propProjectName').textContent = p?.name || '새 현장';
    $('propSender').hidden = !state.customerView;
    $('propSender').textContent = state.customerView ? document.getElementById('custBanner').textContent : '';
    $('propShare').hidden = !!state.customerView || !p?.rooms?.length;
    $('propEdit').textContent = state.customerView ? '실측 보기' : '작업실 열기';
    const eligible = p?.rooms?.some(dry) && data?.options?.length > 1;
    $('propEmpty').hidden = !!eligible;
    $('propContent').hidden = !eligible;
    if (!eligible) {
      $('propEmpty').textContent = p?.rooms?.length
        ? '이 제안은 거실과 침실의 마감을 위한 공간입니다. 작업실에서 이 현장의 도면과 견적을 확인해 주세요.'
        : '아직 공간이 없습니다. 작업실에서 스캔 파일을 열거나 샘플 현장을 선택하면 디자인과 비용을 함께 비교할 수 있습니다.';
      return;
    }
    roomId = data.roomId;
    const selectedRoom = p.rooms.find(r => r.id === roomId);
    $('propRoomSelect').replaceChildren(...p.rooms.filter(dry).map(r => {
      const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; return o;
    }));
    $('propRoomSelect').value = roomId;
    $('propRoomMeta').textContent = `${p.proposalDemo ? '샘플 현장 · ' : ''}${data.area.toFixed(1)}㎡ · ${p.rooms.length}개 공간 중 ${selectedRoom.name}`;
    if (!data.options.some(o => o.id === selectedId)) selectedId = data.selectedId || 'warm';
    const option = currentOption();
    $('propOptions').innerHTML = data.options.filter(o => o.id !== 'current').map(o => `
      <button class="proposal-option" type="button" data-style="${o.id}" aria-pressed="${selectedId === o.id}">
        <img class="proposal-option-thumb" src="${IMAGES[o.id]}" alt="" width="100" height="76">
        <span class="proposal-option-copy"><span class="proposal-option-name">${escape(o.title)}</span>
          <span class="proposal-option-desc">${o.id === 'warm' ? '오크 강마루 · 크림 실크벽지' : '밝은 포세린 · 화이트 페인트'}</span>
          <span class="proposal-option-meta">${diff(o.delta)} <span>기준안 대비</span></span></span>
        <span class="proposal-option-check" aria-hidden="true">${selectedId === o.id ? '✓' : ''}</span>
      </button>`).join('');
    $('propCurrent').setAttribute('aria-pressed', String(selectedId === 'current'));
    $('propCurrent').textContent = data.appliedId && data.appliedId !== 'current' ? '제안 전 마감' : '현재 마감';
    $('propHeroEyebrow').textContent = selectedId === 'current' ? 'THE STARTING POINT' : selectedId === 'warm' ? '01 / WARM OAK' : '02 / SOFT NEUTRAL';
    $('propHeroTitle').textContent = TITLES[selectedId];
    $('propHeroDesc').textContent = selectedId === 'current'
      ? '같은 공간, 같은 수량. 마감의 차이를 비교해 보세요.'
      : selectedId === 'warm' ? '부드러운 나뭇결과 크림 톤으로, 편안한 일상의 배경.' : '밝은 바닥과 담백한 벽면으로, 더 가볍고 정돈된 인상.';
    $('propIntent').textContent = option.description || '';
    const r = option.project.rooms.find(x => x.id === roomId);
    $('propMaterials').innerHTML = [['floor','바닥',r.floorFinish],['wall','벽',r.wallFinish],['ceil','천장',r.ceilFinish]].map(([kind,label,id]) => {
      const finish = item(id);
      const color = Number(r.finishColors?.[kind] ?? finish?.color ?? 0xdddddd);
      const hex = '#' + (Number.isFinite(color) ? Math.max(0,Math.min(0xffffff,color)) : 0xdddddd).toString(16).padStart(6,'0');
      return `<div class="proposal-material"><span class="proposal-swatch" style="background:${hex}"></span><span><small>${label}</small><strong>${escape(finish?.name || id)}</strong></span></div>`;
    }).join('');
    $('propChanges').innerHTML = option.changes.length ? option.changes.map(c => `
      <div class="proposal-change"><span>${escape(c.label)}</span><span>${escape(c.before)} <span aria-hidden="true">→</span> <strong>${escape(c.after)}</strong></span></div>`).join('')
      : '<div class="proposal-change"><span>기준 마감</span><span>비교의 기준이 되는 현재 구성입니다.</span></div>';
    $('propTotal').textContent = money(option.estimate.total);
    $('propDelta').textContent = `${diff(option.delta)} · 기준안 대비, 세금 포함`;
    $('propRoomCost').textContent = money(option.roomSubtotal);
    $('propScopeNote').textContent = `${selectedRoom.name}의 바닥·벽·천장 마감만 변경합니다. 기존 가구·조명·구조는 유지하며, 참고 이미지의 소품과 가구는 추가 견적에 포함되지 않습니다.`;
    const roomRows = option.estimate.rows.filter(row => row.roomId === roomId);
    $('propCostRows').innerHTML = roomRows.map(row => `<tr><td>${escape(row.cat)} · ${escape(row.name)}</td><td>${Number(row.qty).toLocaleString('ko-KR',{maximumFractionDigits:2})} ${escape(row.unit === 'm2' ? '㎡' : row.unit === 'ea' ? '개' : row.unit)}</td><td>${money(row.amount)}</td></tr>`).join('');
    const applied = data.appliedId === selectedId && !data.stale;
    $('propApply').disabled = !state.customerView && applied;
    $('propApply').textContent = state.customerView ? '이 안의 상담 내용 복사' : applied ? '현재 현장에 적용된 디자인' : selectedId === 'current' ? '제안 전 마감으로 복원' : '이 디자인을 현장에 적용';
    if (data.stale) status('작업실에서 변경한 마감을 새 기준으로 비교합니다.');
    showImage(option);
  }

  function showImage(option) {
    const isModel = selectedId === 'current' || modelPreview;
    $('propView3d').textContent = isModel && selectedId !== 'current' ? '스타일 이미지 보기' : '실측 모델로 확인';
    $('propView3d').hidden = selectedId === 'current';
    $('propImageNote').textContent = isModel ? '실측 모델 · 천장과 앞벽을 열어 본 마감 미리보기' : '스타일 참고 이미지 · 실제 공간의 구조와 가구 배치는 실측 모델에서 확인';
    $('propHeroImg').alt = isModel ? `${data.roomName} ${option.title} 실측 모델` : `${option.title} 스타일 참고 이미지`;
    if (!isModel) { $('propHeroImg').src = IMAGES[selectedId]; return; }
    const room = option.project.rooms.find(r => r.id === roomId);
    const key = JSON.stringify(room);
    try {
      let src = previews.get(key);
      if (!src) {
        src = captureProposalRoom(room, option.project);
        if (previews.size > 8) previews.clear();
        previews.set(key, src);
      }
      $('propHeroImg').src = src;
    } catch {
      $('propHeroImg').removeAttribute('src');
      $('propImageNote').textContent = '모델 이미지를 만들지 못했습니다. 작업실의 3D 보기에서 확인해 주세요.';
    }
  }

  async function copySelection() {
    const o = currentOption();
    const text = `${state.project.name} / ${data.roomName}\n상담 희망안: ${o.title}\n전체 현장 예상 비용: ${money(o.estimate.total)} (${diff(o.delta)})\n${o.changes.map(c => `${c.label}: ${c.before} → ${c.after}`).join('\n')}\n마감 비교를 위한 상담 내용이며 발송 원본을 변경하지 않았습니다.`;
    try { await navigator.clipboard.writeText(text); status('상담 내용이 복사됐습니다. 시공자와의 대화에 붙여넣어 주세요.'); }
    catch { window.prompt('상담 내용을 복사해 시공자에게 전달해 주세요.', text); }
  }

  $('propOptions').addEventListener('click', e => {
    const button = e.target.closest('[data-style]'); if (!button) return;
    selectedId = button.dataset.style;
    status('비교 중입니다. 적용하기 전에는 현재 현장이 바뀌지 않습니다.');
    render();
    $('propOptions').querySelector(`[data-style="${selectedId}"]`)?.focus({preventScroll:true});
  });
  $('propCurrent').onclick = () => { selectedId = 'current'; render(); };
  $('propView3d').onclick = () => { modelPreview = !modelPreview; render(); };
  $('propRoomSelect').onchange = e => { roomId = e.target.value; selectedId = 'warm'; previews.clear(); status(''); render(); };
  $('propApply').onclick = () => {
    if (state.customerView) { copySelection(); return; }
    const next = applyProposal(state.project, selectedId, options());
    pushProjectHistory();
    state.project = next;
    state.selRoom = roomId; state.sel = {kind:'room',roomId};
    emit('project');
    status(selectedId === 'current' ? '제안 전 마감과 견적으로 복원했습니다.' : '디자인과 견적을 현장에 반영했습니다. 작업실에서 계속 다듬거나 고객에게 보내세요.');
  };
  $('propShare').onclick = async () => {
    if (state.customerView || !currentOption()) return;
    $('propShare').disabled = true;
    try {
      const project = applyProposal(state.project, selectedId, options());
      const ok = await onShare(project);
      if (ok) status('선택한 디자인과 견적이 담긴 고객 링크를 복사했습니다.');
    } catch { status('고객 링크를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally { $('propShare').disabled = false; }
  };
  $('propEdit').onclick = () => { close(); onEdit(state.customerView ? '3d' : '2d'); };
  function open() {
    exitWalk();
    previews.clear();
    document.getElementById('modeOverlay').hidden = true;
    document.body.classList.add('proposal-open');
    document.getElementById('toast').hidden = true;
    view.inert = false;
    document.getElementById('layout').inert = true;
    render();
    window.scrollTo(0,0);
  }
  function close() {
    document.body.classList.remove('proposal-open');
    view.inert = true;
    document.getElementById('layout').inert = false;
    window.scrollTo(0,0);
  }
  view.inert = true;
  on(what => {
    if (what === 'project' || what === 'lights') previews.clear();
    if (['project','lights','meta','rates','mode','init'].includes(what)) render();
  });
  return { open, close, render };
}
