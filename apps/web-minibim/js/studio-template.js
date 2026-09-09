// App chrome only. Project values and event handlers are supplied by studio.js.
const arrow = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const upload = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 13V3m-4 4 4-4 4 4M4 12v4h12v-4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const check = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8 3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function studioTemplate() {
  return `
    <header id="studioHeader">
      <div class="studio-brand" aria-label="PlanShot 작업실">
        <svg width="28" height="28" viewBox="0 0 29 29" fill="none" aria-hidden="true"><path d="M3 12V3h9M17 3h9v9M26 17v9h-9M12 26H3v-9" stroke="currentColor" stroke-width="1.6"/><path d="M9 20V9h7a4 4 0 0 1 0 8H9" stroke="currentColor" stroke-width="1.6"/></svg>
        <span>PlanShot</span><small>STUDIO</small>
      </div>
      <div class="studio-project">
        <label class="studio-sr-only" for="studioProjectName">현장 이름</label>
        <input id="studioProjectName" type="text" placeholder="현장 이름" autocomplete="off" spellcheck="false">
        <span id="studioStatus" role="status" aria-live="polite">이 브라우저에 자동 저장</span>
      </div>
      <div class="studio-header-actions">
        <button id="studioImport" class="studio-button studio-button-plain" type="button">${upload}<span>실측 불러오기</span></button>
        <button id="studioSave" class="studio-button studio-button-outline" type="button">저장</button>
        <button id="studioTools" class="studio-button studio-button-icon" type="button" aria-label="추가 도구 열기" title="추가 도구" aria-expanded="false" aria-controls="topbar"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M8 3v4m5 1v4m-6 1v4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button>
      </div>
    </header>
    <nav id="studioWorkflow" aria-label="공간 제안 작업 순서">
      <button class="studio-step" data-studio-step="space" type="button"><span class="studio-step-number">01</span><span class="studio-step-copy"><strong>공간</strong><small>실측과 배치 확인</small></span><span class="studio-step-arrow" aria-hidden="true">›</span></button>
      <button class="studio-step" data-studio-step="design" type="button"><span class="studio-step-number">02</span><span class="studio-step-copy"><strong>디자인</strong><small>마감과 분위기 조정</small></span><span class="studio-step-arrow" aria-hidden="true">›</span></button>
      <button class="studio-step" data-studio-step="cost" type="button"><span class="studio-step-number">03</span><span class="studio-step-copy"><strong>견적</strong><small>물량과 비용 확인</small></span><span class="studio-step-arrow" aria-hidden="true">›</span></button>
      <button id="studioProposal" class="studio-step studio-step-proposal" type="button"><span class="studio-step-number">04</span><span class="studio-step-copy"><strong>제안</strong><small>고객에게 전달</small></span>${arrow}</button>
    </nav>`;
}

export function sceneTemplate() {
  return `
    <div id="studioSceneBar">
      <div class="studio-scene-context"><span class="studio-overline">MY SPACE</span><div><strong id="studioSceneTitle">공간을 불러오세요</strong><span id="studioSceneMeta"></span></div></div>
      <div class="studio-scene-actions">
        <div class="studio-view-switch" role="group" aria-label="공간 보기"><button id="studioView2d" type="button" aria-pressed="false">도면</button><button id="studioView3d" type="button" aria-pressed="true">3D</button></div>
        <button id="studioFrame" class="studio-button studio-button-icon" type="button" title="선택한 공간 전체 보기" aria-label="선택한 공간 전체 보기"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <p id="studioSceneHint">드래그로 회전 · 휠로 확대</p>
    <div class="studio-model-actions">
      <button id="studioWallToggle" class="studio-button studio-wall-toggle" type="button" aria-pressed="false" title="현재 시점의 앞벽만 엽니다. 회전해도 열린 벽은 유지됩니다.">앞벽 열기</button>
      <button id="studioCompare" class="studio-button studio-model-compare" type="button"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2v16M7 4H3v12h4m6-12h4v12h-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>변경 전후 비교</button>
      <button id="studioUndo" class="studio-button studio-model-undo" type="button" aria-label="마지막 변경 되돌리기" title="마지막 변경 되돌리기"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 7h7a5 5 0 0 1 0 10H9M5 7l4-4M5 7l4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>되돌리기</span></button>
    </div>`;
}

export function designTemplate() {
  return `
    <section id="studioDesign" aria-labelledby="studioDesignHeading">
      <div class="studio-design-content">
        <div class="studio-panel-heading"><span class="studio-overline">MATERIAL &amp; MOOD</span><h1 id="studioDesignHeading">공간의 분위기</h1><p>마감을 바꾸면 공간과 비용이 함께 바뀝니다.</p></div>
        <div class="studio-room-context"><strong id="studioRoomName">선택한 공간</strong><span id="studioRoomArea"></span></div>
        <div class="studio-section-title"><h2>AI 디자이너에게 말하기</h2><span>실측·견적 그라운딩</span></div>
        <div class="studio-ai">
          <textarea id="studioAiInput" rows="2" placeholder="예: 따뜻한 우드톤 미니멀로, 간접등 위주로 바꿔줘"></textarea>
          <button id="studioAiGo" class="studio-button studio-button-primary" type="button">제안받기</button>
          <div id="studioAiResult" aria-live="polite" hidden></div>
        </div>
        <div class="studio-section-title"><h2>마감 조합으로 시작</h2><span>선택한 방에 적용</span></div>
        <div class="studio-style-options" role="group" aria-label="마감 조합 선택">
          <button class="studio-style studio-style-warm" type="button" data-studio-style="warm" aria-pressed="false"><span class="studio-style-palette" aria-hidden="true"><i></i><i></i><i></i></span><span class="studio-style-title">따뜻한 우드</span><span class="studio-style-caption">강마루 · 실크벽지</span><span class="studio-style-check">${check}</span></button>
          <button class="studio-style studio-style-calm" type="button" data-studio-style="calm" aria-pressed="false"><span class="studio-style-palette" aria-hidden="true"><i></i><i></i><i></i></span><span class="studio-style-title">차분한 뉴트럴</span><span class="studio-style-caption">포세린 · 도장</span><span class="studio-style-check">${check}</span></button>
        </div>
        <button class="studio-current" type="button" data-studio-style="current" aria-pressed="false"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 6a5 5 0 1 1 0 4m0-4V2m0 4h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>원래 마감으로 되돌리기</button>
        <div class="studio-section-title studio-material-heading"><h2>하나씩 조정하기</h2><span>재료와 색상</span></div>
        <div id="studioFinishes"></div>
        <div class="studio-change-summary"><div class="studio-section-title"><h2>변경한 내용</h2></div><div id="studioChangeList" aria-live="polite">마감을 고르면 변경 내용이 표시됩니다.</div></div>
      </div>
      <footer class="studio-design-footer">
        <div class="studio-total-label"><span>전체 현장 예상 비용</span><small>VAT 포함</small></div>
        <strong id="studioTotal">—</strong><p id="studioDelta" aria-live="polite">현재 설정 기준</p>
        <button id="studioNext" class="studio-button studio-button-primary" type="button"><span>견적 확인하기</span>${arrow}</button>
      </footer>
    </section>`;
}
