# 외부 카탈로그 스냅샷·후보 조인 — 124

- Jira: S15P21C206-124
- 상태: 커널·합성 계약·122 저장 후보 및 관측 시각 연결 회귀 검산 완료. 소비자 리뷰 대기다. 운영 DB 적재 검증은 수행하지 않았다.
- 선행: [116 계약](tess-external-catalog-contract.md), [122 후보 입력](../../libs/astro-kernel/README.md#후보-동일성id후속-인계).
- 구현: `astro_kernel.external_catalog`. 네트워크·DB·current 전환·성과·AI 테이블을 변경하지 않는다.

## 입력과 책임

`build_snapshot`은 source, 명시적 TIC scope, 천문 필드만 투영한 rows, 원본 SHA-256, UTC 조회 시각, 원천 URI/table, 시간 근거, complete/validated를 받는다. exact true가 아닌 수집·구조 검증 상태, 중복 키, 유효하지 않은 rows는 해당 원천을 hold로 반환한다. 빈 성공 조회는 허용하지만 complete/validated는 호출자가 원본과 조회 범위를 검증한 사실이어야 한다. 임의 true나 임의 근거 문자열이 원천 검증을 대신하지 않는다.

어댑터는 정규화 가능한 행을 rows, 식별 가능하지만 시간 불명·비통과 등인 행을 held_rows에 함께 보존한다. 두 목록에 걸친 중복도 거부한다. 이 경우 snapshot ready는 원본 행이 누락 없이 보존됐다는 뜻이며 라벨 판정 성공이 아니다. 해당 TIC의 held_rows가 있으면 정상 행의 매칭 진단만 유지하고 통합 라벨 변경은 보류한다. TCE S1–13 범위에 없는 CM Dra S16은 scope에서 제외하여 빈 성공 조회로 해석하지 않는다.

정규화 snapshot은 source/scope·행·원본 hash·근거를 canonical JSON으로 해시한다. 조회 시각은 식별자에서 제외한다. 같은 snapshot 재조회는 최초 성공 provenance를 유지한다. source 범위 변경은 자동 승격하지 않는다. 파일 저장 어댑터는 새 실행 폴더를 생성하며 이전 파일을 덮어쓰지 않는다.

`normalize_export_row`는 116 필드 매핑을 사용한다. 명시적인 BJD-TDB만 2457000을 빼서 BTJD-TDB로 변환한다. TOI/ExoFOP의 BJD 표기, TCE 필드명만으로 TDB를 가정하지 않는다. Archive 이름·TCE 존재만으로 CP 라벨을 생성하지 않는다. 비통과 제외 행과 시간 보류 행은 진단에 남기며 성공한 빈 카탈로그로 바꾸지 않는다.

`join_catalog(catalog, deliveries, observed_times, required_sources=..., approval=..., previous=...)`는 122의 catalog_ready/candidates를 입력으로 받는다. candidate_id·TIC·bundle은 양의 bigint여야 한다. 운영 호출자는 DB 예약/할당 근거와 116 승인 참조를 전달한다. 로컬 회귀에서는 122 산출물의 테스트 ID를 그대로 사용하고 fixture_ids_only=true로 기록한다. 숫자 형식 검사나 승인 문자열 자체가 운영 ID 근거를 증명하지 않는다. 관측 시각은 실제 유효 관측점이며 채워 넣은 시간 격자를 전달하지 않는다.

## 판정과 보존

116의 distance 0.5 duration, duration 비율 2, 관측 Jaccard 0.5, 공통 관측점 1 이상을 그대로 사용한다. 최적 문턱으로 새 주장하지 않는다. 같은 원천의 일대다·다대일, 고조파 의심은 보류한다. 원천 실패 시 다른 정상 원천의 진단은 남기되 전체 rows/changes/history 게시안을 만들지 않는다. 이전 성공 결과는 retained_previous로 보존한다. 이전 판은 호출자가 실제 적용된 성공 결과를 제공해야 한다.

유효한 원천 전체에서 유일 직접 대응을 확인한 뒤 라벨을 합친다. CP/KP, FP/FA, PC/APC, 빈 값의 의미는 116을 따른다. unknown/충돌은 전체 후보 판정을 보류한다. 라벨 부재는 source/scope/snapshot/hash/complete/validated와 unmatched 또는 missing_field 근거를 함께 기록한다. 실패·시간 불명·모호성을 absence_evidence로 사용하지 않는다.

결과의 status=ready는 124 변경안 구성 완료이며 publishable은 항상 false다. 125 검증과 Publisher 적용을 생략하지 않는다.

| 출력 | 소비자 계약 |
| --- | --- |
| rows | disposition/answer_class/planet_truth/rule_version/source_refs를 같은 결정에서 공급한다. is_confirmed는 confirmed 여부다. 보류를 false로 대신하지 않는다. |
| representative_model | 자체 BLS period/epoch/duration을 보존한다. 외부 모델로 덮어쓰지 않는다. |
| external_references | 유일 직접 대응만 candidate_id를 가지며, 미연결은 null이다. match_status/snapshot은 검증용 부가 정보다. status=hold에서도 성공 원천의 진단 참조가 남는다. Publisher는 status=ready 및 별도 게시 검증을 통과한 경우에만 DB 열을 명시적으로 투영하며, hold의 참조는 적용하지 않는다. |
| changes/history | 이전 성공 결과와 다른 행만 변경안으로 만든다. disposition/planet_truth 실제 전환만 출처 근거와 함께 이력 입력을 만든다. 같은 값으로 재실행하면 이력이 없고 되돌아가는 전환은 남긴다. 적용 시각은 생성하지 않는다. |
| reference_changes | 원천/TIC/external_id별 add/update/remove 전후 값을 기록한다. 원천 실패 때는 비우며 원본 소실이 확인된 성공 snapshot에서만 remove 제안을 만든다. 실제 DELETE 명령은 실행하지 않는다. |
| applied_at | Publisher가 적용 트랜잭션에서 생성한다. 조회 시각을 대신 사용하지 않는다. |

영구 저장·원자적 전환·재시도 동시성 제어는 Publisher 책임이다. 이 커널의 순수 비교를 DB 멱등성 검증 완료로 표현하지 않는다. 외부 참조 제거/교체의 DB 적용과 이력의 최종 직렬화는 125/Publisher 검증이 필요하다.

## 검증 결과와 한계

- astro-kernel 전체 297 passed, 그중 신규 124 테스트 43개다.
- tess-bench 관련 47 passed(기존 116 매칭/실행기 41개 + 124 실행기·통제 시나리오 6개).
- 실제 122 build_candidate_catalog 함수를 호출하는 연결 테스트는 합성 입력·테스트 ID를 사용한다. 운영 DB ID 검증이 아니다.
- Downloads의 review-122-r2.zip 안 catalog/plan.json은 fixture_ids_only=true, identity_approval=synthetic-contract-test-not-production-approval다. 실제 할당 ID 근거로 재사용하지 않는다.
- 저장된 116 export 감사 실행: `run-20260922T131817Z-980db91a`. TOI 18·TCE 8·ExoFOP 18행 시간 보류, Archive 정규화 11·시간 보류 7·비통과 제외 4행이다. 총 66행 중 11/51/4로 기존 기록과 일치한다.
- 위 실행은 candidate_input_missing이며 원천 전체를 보류했다. FITS/BLS·다운로드·DB 적재를 실행하지 않았다. completed는 파일 감사 종료만 뜻한다.
- 재귀 코드 snapshot에 하위 패키지 변경이 반영되는 테스트를 포함한다. 중복 원천은 hold, 나머지 원천 진단은 유지한다.

## 122 저장 후보 연결 회귀

`tess_bench.external_catalog_candidate_regression`은 review-122-r2.zip의 외부 SHA-256, 내부 22개 checksum, 두 122 manifest 연결을 확인한다. 16개 실행 결과로 현재 build_candidate_catalog를 호출하고 저장 candidates/ID/reasons가 일치하는지 비교한다. 아래 사용자 실행과 검산에서 ready 11개를 확인했다.

실행기는 기존 후보를 재탐색하지 않는다. 122 plan에 등록된 원본 FITS·참고값·주입 격자·전처리 구현 hash를 확인하고 realclean/주입 그룹의 유효 관측 시각을 복원한다. 실제 시각 hash와 관측점 수를 기록한다. 원본 122는 확인 행성을 제거한 realclean과 쌍 주입 표본이므로 이를 원본 실제 행성 탐지 성능으로 해석하지 않는다.

- actual_external: 저장된 네 외부 원천과의 비교. 미확인 시간·비통과 행이 있으면 정상 매칭 근거가 있어도 라벨은 보류한다.
- controlled_external: 같은 후보 모델에 명시적으로 생성한 외부 행을 대조하여 직접 연결·동일 재실행·FP 변경·변경 후 재실행·행 소실·부분 실패·중복·모호성·고조파 보류를 검사한다. 실제 외부 카탈로그의 정답이나 매칭 성능 측정이 아니다.
- 후보가 준비되지 않은 122 출력은 그대로 보류하고 임의 ID·후보를 생성하지 않는다. 모델·ID·입력 불변을 확인한다.

명령과 입력 위치는 [bench README](../../experiments/tess-bench/README.md#124-저장-외부-자료-정규화후보-연결)를 따른다.

### 2026-09-22 사용자 실행·독립 검산

실행: `run-20260922T141154Z-696cda44`. 사용자가 FITS 전처리·연결 회귀를 실행했고 이후 저장 JSON과 checksum을 검산했다. 검산 때 재실행하지 않았다.

| 항목 | 결과 |
| --- | --- |
| 입력 카탈로그 | 4별·16곡선 |
| 조인 준비 완료 | 11곡선·기존 테스트 ID 18개 유지 |
| 상위 단계 보류 유지 | 5곡선 |
| 통제 외부 행 시나리오 | 11 × 9 = 99건 통과 |
| 실제 외부 자료 라벨 판정 | 11곡선 모두 hold, 갱신 rows/changes/history 없음 |
| 실제 외부 행 매칭 진단 | direct_match 3건, external_only 10건 |
| 입력·출력 checksum | 79개 경로 일치, 불일치 0 |

실제 매칭 진단은 곡선별 반복 비교 행 수다. 고유 천체 수·정밀도·회수율이 아니다. 11곡선 모두 TOI·ExoFOP의 시간 미확인 행이 있고, Archive 보류 행은 4곡선, TCE 보류 행은 6곡선에 포함된다. 사유는 중복 집계되므로 합계를 곡선 수로 읽지 않는다. 직접 대응 3건이 있어도 이를 확정 라벨 게시로 승격하지 않았다.

검산에서 같은 snapshot 재실행과 FP 변경 후 재실행의 변경·이력·참조 차이가 모두 비었음을 확인했다. FP 전환은 곡선당 disposition/planet_truth 이력 2개와 출처를 남기며, 완전한 원천 행 소실은 참조 remove 제안과 absence_evidence를 남긴다. 수집 실패·중복·모호성·고조파 시나리오는 이전 성공 결과를 보존하고 갱신안을 만들지 않는다.

- manifest SHA-256: `4fbfd8a599ea0b49903fa1028f40d6c6ef9d23a285d5902f7a126e4347c99cff`
- 리뷰 ZIP: `experiments/tess-bench/results/review-124-696cda44.zip`
- ZIP SHA-256: `b680566200d6a4808c46c166ad5f4eacf67d0097324c0dc1fe6d288833b8e08a`
- ZIP 9항목: 이번 plan/manifest/proofs/sources, 독립 audit, 원본 122 catalog의 plan/manifest/proofs, checksums. 내부 데이터 8파일 해시 재검산 완료.
- ZIP은 Git 제외 로컬 산출물이며 MR에 첨부한다. 원본 FITS·전체 export·캐시는 포함하지 않는다. ZIP만으로 FITS 전처리를 재실행할 수는 없으며 저장 판정·전환 검산 자료다.
- 실행 환경의 성능 비교·운영 DB 적재·AI/성과 테이블 권한 실험은 수행하지 않았다. AI/성과/등급을 입력에서 수정하지 않고 출력·쓰기 대상으로 삼지 않는 경계는 합성 테스트와 코드로 확인했다.

## 완료 전 남은 항목

1. 위 연결 회귀·산출물 검산은 완료했다. 사용자 Git diff 검사·커밋·푸시와 MR 검토를 진행한다.
2. Jira의 ‘D14-2 실제 후보 ID 조인’을 실제 122 후보 결과·기존 테스트 ID를 사용한 로컬 통합으로 충족하는지 소비자 리뷰에서 확인한다. Jira가 운영 DB 적재를 명시하지 않으므로 운영 ID 부재만으로 작업 전체를 중단하지 않으며, 운영 검증 완료로도 표현하지 않는다.
3. 시간 기준 불명인 행은 기존 116 계약대로 보류한다. TCE tce_time0bt의 BTJD 원점·TDB 척도 및 TOI/ExoFOP 근거 확보 전 자동 해제하지 않는다. [MAST 배포 페이지](https://archive.stsci.edu/tess/bulk_downloads/bulk_downloads_tce.html)의 Sector별 CSV 배포 안내만으로 시간 척도 검증 완료를 주장하지 않는다.
4. 125/Publisher 인계 리뷰. 필수 열 투영·DB 예약·적재·current 원자적 전환의 운영 검증은 후속 범위로 구분한다. 팀 승인·병합 전 Jira 완료로 바꾸지 않는다.

## 2026-09-23 승인 리뷰의 비차단 보완

불완전 CSV의 TIC=None은 정규화 hold로 회수하고, 관측 통과 합집합이 비어 Jaccard가 미산출이면 최소 공유 점 설정과 무관하게 직접 매칭하지 않는다. 성공 원천의 참조는 전체 hold에도 진단용으로 보존하되 Publisher 적용은 금지한다.

검증: astro-kernel 전체 300개(외부 카탈로그 46개 포함), bench 124 실행기 테스트 6개 통과. None TIC·최소 공유 점 0의 빈 합집합·일부 원천 실패 시 진단 참조 보존을 회귀로 추가했다. 기존 696cda44 실측 및 ZIP은 수정 전 실행의 근거로 유지한다. 이번 수정 후 원본 FITS 회귀를 재실행하거나 기존 79개 checksum이 새 코드를 검증한다고 주장하지 않는다.

## 2026-09-27 시간 척도 근거 반영 (S15P21C206-79)

- 남은 항목 3을 다음과 같이 반영했다. 근거와 판정은 [116 계약](tess-external-catalog-contract.md#2026-09-27-시간-척도-근거-결정-s15p21c206-79)에 있다.
  - `normalize_export_row`는 NEA TOI·ExoFOP TOI를 BJD-TDB로, MAST TCE를 `tce_time0bt`(BTJD-TDB)로 받는다.
  - PSCompPars는 행마다 `BJD-TDB`로 적힌 경우만 받는다.
  - 정규화 결과에 `time_rule_version=external-time-evidence-v1`과 원천의 원래 시간 표기(`original_time_system`)를 남긴다.
- 어댑터는 snapshot `time_evidence`에 `TIME_EVIDENCE[source]`를 넘긴다. `tess_bench.external_catalog_regression`도 이 값을 쓴다. 규칙이 바뀌면 snapshot 내용과 `bundle_version`이 바뀐다.
- 기존 실행 `run-20260922T141154Z-696cda44`의 11곡선 hold는 이전 규칙의 결과다. 같은 저장 행·관측 시각으로 다시 실행한 결과는 [116 계약 재실측](tess-external-catalog-contract.md#2026-09-27-시간-척도-근거-결정-s15p21c206-79)에 있다.
  - 7곡선(toi451 3개, wasp62 4개)이 `ready`가 됐다. wasp62의 WASP-62 b 후보는 `confirmed`다.
  - Archive 보류 행이 있는 4곡선(toi270, pi_men)은 여전히 `unresolved_external_rows`로 보류된다.
  - fixture ID로 한 재실측이며, 운영 DB 적재나 외부 라벨 게시는 아니다.
