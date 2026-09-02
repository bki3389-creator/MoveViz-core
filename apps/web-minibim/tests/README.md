# web-minibim 검증 스위트

브라우저 없이 node(18+)만으로 도메인 로직 전체를 검증한다. 실행:

```
node apps/web-minibim/tests/run_all.mjs        # 전체
node apps/web-minibim/tests/test_split.mjs     # 개별
```

| 파일 | 검증 내용 |
|---|---|
| test_minibim.mjs | 로드·배치·면적/둘레/wallNet·공유벽 문 전파 기본 |
| test_minibim2.mjs | 편집 연산(개구부·마감 오버라이드 ×2 양면)·견적 재검산 |
| test_ux1.mjs | 반출 톤·CSV·총계 |
| test_ux2.mjs | 걸레받이 공제·문 flip/dk/dm 전파·가구 라이프사이클(유지/폐기/교체) |
| test_split.mjs | 벽 분할(4점·개구부 회피·키 리매핑)·코너 그립 직교 동행·DXF 실무 레이어/돋움/치수 |
| test_furncsv.mjs | 가구 구입·반출 견적/CSV 자동 반영 |
| test_audit.mjs | 1차 감사 확정결함 7종 재현 방지(회피/하이재킹/코너동기/찢김/리매핑/점프/양면) |
| edge.test.mjs | 85 어서션 — 음수좌표·시계방향·b0분할 리매핑·3중분할 수량 불변·직렬화 무손실·빈 프로젝트 판별 |
| audit_dxf_csv.mjs | 17 어서션 — DXF 그룹코드/치수/상세/미닫이·견적 재검산/반출 톤/NaN 부재 |
| validate_dxf.mjs | DXF 구조 검증기(짝·NaN·섹션 균형·R12 심볼명 규칙·레이어 참조) — 캐드 멈춤 예방 |

주의: scene3d.js는 bare specifier(three-bvh-csg) 때문에 node로 import 불가 — 3D는
헤드리스 크롬(`?sample&tab=3d&rendershot=N` + 콘솔 grep)으로 검증한다.
산출물은 `tests/.out/`(gitignore)에 생성.
