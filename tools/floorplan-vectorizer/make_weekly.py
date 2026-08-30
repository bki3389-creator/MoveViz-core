#!/usr/bin/env python3
import base64, os, sys

if len(sys.argv) < 3:
    raise SystemExit("사용법: python make_weekly.py <original-image> <overlay-image> [output.html]")

def b64(p):
    return base64.b64encode(open(p,"rb").read()).decode()
orig=b64(sys.argv[1])
ov=b64(sys.argv[2])

html=f"""<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MoveMate · 주간 작업 보고 (2026-06-14)</title>
<style>
:root{{--white:#fff;--page:#F6F7F9;--card:#F2F3F5;--line:#E5E7EA;--ink:#1B1B1E;--sub:#8B8D92;--red:#FF3B30;--red-soft:rgba(255,59,48,.1);--green:#23A06B;
font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--page);color:var(--ink);max-width:980px;margin:0 auto;padding:48px 28px 100px;line-height:1.5}}
.head{{display:flex;align-items:center;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:20px}}
.head svg{{width:44px;height:44px}}
.head h1{{font-size:26px;font-weight:800;letter-spacing:-.5px}}
.head .meta{{margin-left:auto;text-align:right;color:var(--sub);font-size:13px}}
.head .meta b{{color:var(--ink)}}
.lead{{font-size:15px;color:var(--sub);margin:18px 0 30px;padding:16px 18px;background:#fff;border:1px solid var(--line);border-radius:18px}}
.lead b{{color:var(--ink)}}
.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:34px}}
.metric{{background:#fff;border:1px solid var(--line);border-radius:18px;padding:16px;text-align:center}}
.metric .v{{font-size:24px;font-weight:800;color:var(--red);letter-spacing:-.5px}}
.metric .v small{{font-size:13px;color:var(--sub);font-weight:700}}
.metric .l{{font-size:11px;color:var(--sub);margin-top:4px}}
section{{margin-bottom:34px}}
h2{{font-size:13px;font-weight:800;color:var(--red);letter-spacing:.5px;margin-bottom:14px;display:flex;align-items:center;gap:8px}}
h2::before{{content:"";width:18px;height:3px;background:var(--red);border-radius:3px}}
.ba{{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}}
.ba figure{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px;overflow:hidden}}
.ba img{{width:100%;border-radius:8px;display:block}}
.ba figcaption{{font-size:12px;color:var(--sub);margin-top:8px;text-align:center}}
.ba figcaption b{{color:var(--ink)}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.item{{background:#fff;border:1px solid var(--line);border-radius:18px;padding:16px 18px}}
.item h3{{font-size:15px;font-weight:800;margin-bottom:8px;display:flex;align-items:center;gap:8px}}
.item h3 .ic{{width:26px;height:26px;border-radius:8px;background:var(--red-soft);color:var(--red);display:inline-flex;align-items:center;justify-content:center;font-size:14px;flex:0 0 auto}}
.item ul{{list-style:none}}
.item li{{font-size:13px;color:#3a3a40;padding:3px 0 3px 16px;position:relative}}
.item li::before{{content:"·";position:absolute;left:4px;color:var(--red);font-weight:800}}
.item li b{{color:var(--ink)}}
.tag{{display:inline-block;font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:var(--red-soft);color:var(--red);margin-left:6px}}
.tag.done{{background:rgba(35,160,107,.12);color:var(--green)}}
.flow{{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid var(--line);border-radius:18px;padding:18px;margin-top:14px}}
.flow .s{{background:var(--card);border-radius:12px;padding:10px 13px;font-size:12.5px;font-weight:700}}
.flow .ar{{color:var(--sub);font-weight:800}}
.next li{{font-size:13.5px;padding:6px 0 6px 18px;position:relative;color:#3a3a40}}
.next li::before{{content:"→";position:absolute;left:0;color:var(--red);font-weight:800}}
.next li b{{color:var(--ink)}}
.foot{{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--sub);text-align:center}}
</style></head><body>
<div class="head">
 <svg viewBox="0 0 269 256" fill="#FF3B30"><path d="M60.87 63.8L60.61 168l-.05 33.14c0 3.75.43 19.23-.7 21.37-2.63 1.86-10.79.78-14.21.96-.73.04-1.6-.37-2.11-.98-.39-1.12-.38-3.44-.39-4.68L43.15 76.85l-.04-26.47c-.03-5.4-.36-11.79.27-17.11.19-1.62 14.81-1.36 16.46-.74 2.3 2.96 4.96 7.13 7.08 10.28l11.89 17.64 38.32 56.56 11.17 16.26c1.36 1.99 5.24 7.93 6.67 9.28 1.62-1.46 3.9-5.24 5.21-7.21l8.47-12.75 33.92-50.76c2.85-4.3 24.39-37.55 26.25-38.87 2.02-1.42 9.65-.88 12.39-.81 1.14.03 2.36.05 3.42.49.43.57.56.67.59 1.48.11 4.09.07 8.29.07 12.37l-.01 24.8-.03 104.77.02 31.07c0 1.7.26 15.43-.41 15.68-3.52 1.27-10.9.73-14.86.7-1.3-.69-1.53-1.43-1.58-2.84-.17-4.87-.05-9.76-.06-14.63l-.16-26.19c-.4-29.16-.58-58.32-.55-87.48.01-6.25.04-12.5.12-18.75.03-1.83.27-8.41.05-9.94l-.27-.04-.76 1.04c-2.97 5.11-7.84 11.96-11.17 16.89l-17.3 25.73c-13 19.24-25.79 38.64-38.79 57.88-.66.98-1.68 2.48-2.59 3.17-.3.35-2.31 1.06-2.65.8-4.03-3.12-9-11.14-11.74-15.04-5.79-8.23-11.52-16.51-17.19-24.83L60.87 63.8z"/><path d="M74.71 108.29c2.19-.03 4.67 4.4 5.96 6.21l7.16 10.12 35.06 50.25 8.2 11.74c1.27 1.82 3.74 5.69 5.14 7.08 1.12-.86 8.24-11.89 9.53-13.81l34.93-51.73c1.7-2.5 11.9-18.6 15.04-19.83 2.9-1.14 2.06 8.58 1.99 10.87-.11 3.65.42 10.6-.1 14.45-3.01 5.94-8.11 12.7-11.94 18.26l-18.22 26.6-18 26.48c-3.28 4.84-7.67 12.08-11.84 16.27-1.01 1.01-3.57-.21-4.45-1.4-3.14-4.28-6.23-8.64-9.32-12.98l-19.12-26.9-20.92-29.37c-3.61-5.08-8.08-11.08-11.37-16.28-.12-3.58-.32-22.36.36-24.82.54-.73 1.08-.87 1.92-1.22z"/></svg>
 <h1>MoveMate · 주간 작업 보고</h1>
 <div class="meta"><b>2026-06-14</b><br>이사 견적 앱 + 평면도 자동화</div>
</div>

<p class="lead">이번 주 핵심은 <b>"평면도 이미지를 편집 가능한 데이터로 자동 변환"</b>하는 파이프라인을 만들고,
사람 손 없이 코드만으로 동작함을 검증한 것입니다. 더불어 <b>주소 자동완성·네비 동선·스캔 결과 페이지</b> 등 앱 기능을 추가하고,
<b>실기기(iPhone) 빌드·설치·실행을 자동화</b>해 모든 변경을 즉시 폰에서 확인하는 흐름을 구축했습니다.</p>

<div class="metrics">
 <div class="metric"><div class="v">100<small>% 코드</small></div><div class="l">도면→데이터 자동화(사람 0)</div></div>
 <div class="metric"><div class="v">5<small>개</small></div><div class="l">앱 기능 추가</div></div>
 <div class="metric"><div class="v">자동</div><div class="l">실기기 빌드·배포</div></div>
 <div class="metric"><div class="v">2</div><div class="l">기술 리서치(평면도·3D)</div></div>
</div>

<section>
 <h2>1. 평면도 이미지 → 편집 가능 데이터 (이번 주 핵심)</h2>
 <div class="ba">
  <figure><img src="data:image/jpeg;base64,{orig}"><figcaption><b>입력</b> · 일반 2D 평면도 이미지(치수·실명 라벨 포함)</figcaption></figure>
  <figure><img src="data:image/png;base64,{ov}"><figcaption><b>출력</b> · 자동 추출된 벽(빨강)·방 분할·면적. 편집 가능한 구조 데이터</figcaption></figure>
 </div>
 <div class="grid2">
  <div class="item">
   <h3><span class="ic">⛓</span>완전 자동 파이프라인 <span class="tag done">검증</span></h3>
   <ul>
    <li><b>Apple Vision OCR</b>로 치수·한글 라벨을 위치까지 자동 인식(온디바이스·무료)</li>
    <li>치수(16400×12700) → <b>픽셀↔실측 스케일 자동 복원</b></li>
    <li>검은 벽선 추출 + 문틈 봉합 + watershed로 <b>방 자동 분할</b>(경계가 실제 벽에 정렬)</li>
    <li>멀티라인 라벨 병합·노이즈 필터까지 코드 처리 → <b>사람 입력 0으로 동일 결과</b></li>
   </ul>
  </div>
  <div class="item">
   <h3><span class="ic">▤</span>타입 라이브러리 (서비스 구조) <span class="tag done">구축</span></h3>
   <ul>
    <li>한국 아파트는 타입 표준화 → <b>타입당 1회 벡터화 → 모든 세대 재사용</b></li>
    <li>등록/면적 매칭 시스템 동작 — <b>일반 사용자 편집 0</b></li>
    <li>편집기(가구를 실측 cm로 배치·이동·회전, JSON 내보내기)는 예외 보정용</li>
    <li>한계: 임의 도면 무보정 100%는 상용도 못 함 → "자동+예외 보정"이 현실해</li>
   </ul>
  </div>
 </div>
 <div class="flow">
  <div class="s">도면 이미지</div><span class="ar">→</span>
  <div class="s">Vision OCR(치수·라벨)</div><span class="ar">→</span>
  <div class="s">벽·방 벡터화</div><span class="ar">→</span>
  <div class="s">타입 라이브러리</div><span class="ar">→</span>
  <div class="s">세대 매칭(편집 0)</div>
 </div>
</section>

<section>
 <h2>2. 앱 기능 추가</h2>
 <div class="grid2">
  <div class="item"><h3><span class="ic">⌕</span>주소 입력 고도화 <span class="tag done">완료</span></h3>
   <ul><li><b>주소 자동완성</b>(유사 주소·<b>상호명</b> 추천, MKLocalSearchCompleter)</li>
   <li><b>층수 직접 입력</b>(지하층 지원) — 기존 1층 고정 개선</li>
   <li>상호/주소 텍스트에서 <b>층수 자동 추출</b>(예: "5층","B1")</li></ul></div>
  <div class="item"><h3><span class="ic">⛬</span>네비 경로·소요시간 <span class="tag">부분</span></h3>
   <ul><li>출발↔도착 <b>소요시간·거리·지도 동선</b> 표시</li>
   <li>Apple 국내 길찾기 미지원 → <b>직선거리 추정+점선</b> 폴백(오류 제거)</li></ul></div>
  <div class="item"><h3><span class="ic">▦</span>스캔 결과 페이지 <span class="tag done">신설</span></h3>
   <ul><li>요약(면적·평수·천장고·가구수) + 평면도 + <b>감지 가구 목록</b> + 견적 + 견적요청</li></ul></div>
  <div class="item"><h3><span class="ic">⇡</span>엘리베이터 자동확인 <span class="tag">키 대기</span></h3>
   <ul><li>건축물대장 API 조회 로직 + 층수 휴리스틱 폴백</li></ul></div>
 </div>
</section>

<section>
 <h2>3. 안정화 · 실기기 배포</h2>
 <div class="grid2">
  <div class="item"><h3><span class="ic">✓</span>버그 수정 <span class="tag done">완료</span></h3>
   <ul><li><b>"응답 파싱 실패"</b> 제거 — 죽은 서버 자동업로드 제거(온디바이스 대체)</li>
   <li><b>"경로 못 찾음"</b> 해결 — 국내 길찾기 한계 우회</li></ul></div>
  <div class="item"><h3><span class="ic">⤓</span>실기기 빌드·배포 자동화 <span class="tag done">완료</span></h3>
   <ul><li>iPhone 13 Pro <b>빌드·서명·설치·실행 자동화</b>(CLI)</li>
   <li>코드 수정 시마다 <b>즉시 폰 반영</b></li></ul></div>
 </div>
</section>

<section>
 <h2>4. 기술 리서치</h2>
 <div class="grid2">
  <div class="item"><h3><span class="ic">⚖</span>평면도 소싱 현실·법적 <span class="tag done">정리</span></h3>
   <ul><li>주소+호로 세대 도면 자동확보는 사실상 불가(본인 발급만)</li>
   <li>네이버 크롤링은 DB권·저작권 리스크 → <b>사용자 업로드·스캔이 본류</b></li></ul></div>
  <div class="item"><h3><span class="ic">◉</span>단일 카메라 3D 동향 <span class="tag done">검증</span></h3>
   <ul><li>RGB 단일 카메라 3D 재구성 모델 부상(예: LingBot-Map, Apache-2.0)</li>
   <li><b>절대 치수(metric scale) 한계</b> — 견적엔 LiDAR/IMU 보정 필요(대체 아닌 보완)</li></ul></div>
 </div>
</section>

<section>
 <h2>다음 단계</h2>
 <ul class="next">
  <li><b>건축물대장 전유부 API</b> 연동 → 주소+호 → 전용면적 → 타입 자동 매칭</li>
  <li><b>방 분할 정확도 향상</b> — 개구부 검출·바닥재 색 경계·설비 앵커(변기→욕실)</li>
  <li><b>실 도로 길찾기</b> — 카카오/네이버 길찾기 API(현재 직선 추정)</li>
  <li><b>타입 라이브러리 적재</b> — 분양공고/도면 자동 벡터화로 타입 축적</li>
 </ul>
</section>

<div class="foot">MoveMate · 주간 작업 보고 · 2026-06-14 &nbsp;|&nbsp; 도면→데이터 자동화 / 앱 기능 / 실기기 배포</div>
</body></html>"""
out=sys.argv[3] if len(sys.argv)>3 else os.path.abspath("weekly_report.html")
open(out,"w").write(html)
print("생성:",out)
