// Static proposal shell. Project data is assigned as text by proposal.js.
const arrow = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const cube = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

export function proposalTemplate() {
  return `
    <header class="proposal-header">
      <div class="proposal-brand" aria-label="PlanShot 디자인 제안">
        <svg class="proposal-mark" width="29" height="29" viewBox="0 0 29 29" fill="none" aria-hidden="true"><path d="M3 12V3h9M17 3h9v9M26 17v9h-9M12 26H3v-9" stroke="currentColor" stroke-width="1.6"/><path d="M9 20V9h7a4 4 0 0 1 0 8H9" stroke="currentColor" stroke-width="1.6"/></svg>
        <span>PlanShot</span><span class="proposal-brand-label">SPACE &amp; POSSIBILITY</span>
      </div>
      <nav class="proposal-header-actions" aria-label="프로젝트 작업">
        <button id="propEdit" class="proposal-btn proposal-btn-text" type="button">작업실 <span aria-hidden="true">↗</span></button>
        <button id="propShare" class="proposal-btn proposal-btn-dark" type="button">고객에게 보내기 ${arrow}</button>
      </nav>
    </header>

    <main class="proposal-main">
      <div class="proposal-projectbar">
        <div class="proposal-breadcrumb"><span class="proposal-project-label">DESIGN PROPOSAL</span><span class="proposal-separator" aria-hidden="true">/</span><span id="propProjectName">우리 집 디자인 제안</span></div>
        <div class="proposal-room-control">
          <label for="propRoomSelect">공간</label>
          <select id="propRoomSelect" aria-label="제안을 볼 공간"></select>
          <span id="propRoomMeta" class="proposal-room-meta"></span>
        </div>
      </div>

      <p id="propSender" class="proposal-sender" hidden></p>
      <section id="propEmpty" class="proposal-empty" hidden>
        <span class="proposal-eyebrow">A PLACE TO BEGIN</span>
        <h1>새로운 공간의 시작.</h1>
        <p>작업실에서 실측 파일이나 샘플을 열면,<br>공간에 어울리는 마감과 예상 공사비를 함께 살펴볼 수 있어요.</p>
        <p class="proposal-empty-guide">위의 ‘작업실’에서 공간을 불러오세요.</p>
      </section>

      <div id="propContent">
        <section class="proposal-intro" aria-labelledby="proposalHeading">
          <div><p class="proposal-eyebrow">A SPACE FOR YOUR EVERYDAY</p><h1 id="proposalHeading">우리 집의 다음 장면.</h1></div>
          <p class="proposal-intro-copy">익숙한 공간의, 새로운 가능성.<br><span>취향에 맞는 분위기를 고르고, 비용까지 살펴보세요.</span></p>
        </section>

        <div class="proposal-grid">
          <section class="proposal-visual" aria-labelledby="propHeroTitle">
            <figure class="proposal-figure">
              <div class="proposal-image-frame">
                <img id="propHeroImg" class="proposal-hero-image" alt="선택한 디자인의 분위기 참고 이미지" width="1440" height="1024" decoding="async">
                <div class="proposal-image-top"><span id="propHeroEyebrow" class="proposal-image-label">DESIGN DIRECTION 01</span><span class="proposal-image-index" aria-hidden="true">PLANSHOT / STUDIO</span></div>
                <button id="propView3d" class="proposal-3d-btn" type="button">${cube}<span>내 공간 3D로 확인</span>${arrow}</button>
              </div>
              <figcaption id="propImageNote">스타일 참고 이미지 · 실제 공간은 3D에서 확인</figcaption>
            </figure>
            <div class="proposal-image-description"><div><h2 id="propHeroTitle">햇살을 닮은, 따뜻한 여백</h2><p id="propHeroDesc">공간의 분위기와 마감 구성을 함께 살펴보세요.</p></div><span class="proposal-detail-index" aria-hidden="true">01 — 02</span></div>
          </section>

          <aside class="proposal-config" aria-label="디자인 선택과 예상 비용">
            <div class="proposal-section-heading"><span class="proposal-step">01</span><h2>어떤 분위기가 좋으세요?</h2></div>
            <div class="proposal-option-intro">두 가지 마감 구성의 비용을 비교해 보세요.</div>
            <div id="propOptions" class="proposal-options" role="group" aria-label="디자인 제안"></div>
            <button id="propCurrent" class="proposal-current" type="button" aria-pressed="false"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 8a6 6 0 1 1 .2 4M4 8V3m0 5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>현재 설정과 비교하기</span><span aria-hidden="true">↗</span></button>

            <section class="proposal-budget" aria-labelledby="proposalCostHeading">
              <div class="proposal-section-heading"><span class="proposal-step">02</span><h2 id="proposalCostHeading">비용까지, 한눈에</h2></div>
              <p class="proposal-total-label">전체 현장 예상 비용 <span>VAT 포함</span></p>
              <p id="propTotal" class="proposal-total">—</p>
              <p id="propDelta" class="proposal-delta">현재 설정 대비 비용을 계산합니다.</p>
              <div class="proposal-room-price"><span>선택한 방 공사비<small>제경비·VAT 제외</small></span><strong id="propRoomCost">—</strong></div>
              <p id="propScopeNote" class="proposal-scope-note">실측 면적과 선택한 마감에 따른 예상 금액입니다. 최종 금액은 현장 확인과 시공자 협의로 정해집니다.</p>
              <button id="propApply" class="proposal-btn proposal-btn-dark proposal-apply" type="button"><span>이 디자인으로 적용하기</span>${arrow}</button>
              <p id="propStatus" class="proposal-status" role="status" aria-live="polite"></p>
            </section>
          </aside>
        </div>

        <section class="proposal-story" aria-labelledby="proposalStoryHeading">
          <div class="proposal-story-title"><span class="proposal-eyebrow">THE LITTLE THINGS, CONSIDERED</span><h2 id="proposalStoryHeading">이 공간을 만드는 디테일.</h2></div>
          <div class="proposal-story-grid">
            <div class="proposal-intention"><span class="proposal-detail-label">DESIGN NOTE</span><p id="propIntent">매일 머무는 공간이 조금 더 편안해질 수 있도록.</p></div>
            <div class="proposal-material-section"><span class="proposal-detail-label">MATERIAL PALETTE</span><div id="propMaterials" class="proposal-materials"></div></div>
            <div class="proposal-change-section"><span class="proposal-detail-label">WHAT CHANGES</span><div id="propChanges" class="proposal-changes"></div></div>
          </div>
        </section>

        <details class="proposal-cost-details">
          <summary><span><span class="proposal-detail-label">COST BREAKDOWN</span><strong>선택한 방의 상세 공사 내역</strong></span><span class="proposal-details-plus" aria-hidden="true">+</span></summary>
          <div class="proposal-table-wrap"><table class="proposal-cost-table"><caption class="proposal-sr-only">선택한 방의 항목별 예상 공사비, 제경비와 부가세 제외</caption><thead><tr><th scope="col">항목</th><th scope="col">수량</th><th scope="col">금액</th></tr></thead><tbody id="propCostRows"></tbody></table></div>
        </details>
      </div>

      <footer class="proposal-footer"><span class="proposal-footer-brand">PlanShot</span><p>공간의 가능성에서, 현실적인 계획까지.</p><span class="proposal-footer-note">DESIGNED AROUND YOUR SPACE</span></footer>
    </main>`;
}
