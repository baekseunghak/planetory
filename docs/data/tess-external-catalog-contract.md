# 외부 카탈로그 계약 검증 — 116

- Jira: S15P21C206-116
- 상태: 네 원천 수집·9별 실측·검산 완료. 사용자가 전달한 !187 리뷰에서 강재민·김동혁 승인 확인. 운영 적용과 시간 기준 보류 해소는 별도이며 병합 여부는 아직 확인하지 않았다.
- 범위: 원천 식별·단위·snapshot·후보 조인 계약. 운영 배치·DB 게시 구현은 124에서 담당한다.
- 근거: [외부 원천 검토안](tess-pipeline/external-sources-and-ai.md), [요구사항](../requirements/planetory-requirements-spec.md)의 DAT-09, [결정 기록](../requirements/planetory-decision-register.md)의 DEC-20.

## 수집 설계

실제 export를 매번 새 디렉터리에 보존하며 기존 `references.csv`와 과거 실험 입력은 갱신하지 않는다. byte SHA-256·요청/최종 URL·조회 시각·헤더·행 수를 manifest에 기록한다. `collected_schema_unverified`는 CSV 구조 확인까지의 수집 성공이며 의미·단위·매칭 검증이나 운영 승인이 아니다.

Archive·TOI는 fixture 9 TIC, TCE는 공식 S1–13 파일 하나, ExoFOP는 TOI export를 조회한다. Sector 16 CM Dra와 CTOI는 이 범위에서 검증됐다고 간주하지 않는다. 조회 시점과 원천 범위가 달라 누락이 신호 부재를 뜻하지 않는다.

실패·빈 export·HTML/XML 오류·CSV 구조 오류가 하나라도 있으면 `incomplete`로 기록한다. 이전 폴더는 유지한다. current 전환 기능은 없으며 운영 snapshot 전환 검증 완료를 주장하지 않는다. 중단된 `collecting` 실행도 미완료다.

## 필드 대조

| 원천 | 식별·수치 | 확인 및 대기 항목 |
| --- | --- | --- |
| NEA TOI | `tid`, `toi`, `tfopwg_disp`, `pl_orbper`, `pl_tranmid`, `pl_trandurh`, `pl_trandep` | TIC와 TOI 구분. 주기 day, epoch BJD, duration hour, depth ppm. BJD 표기만으로 TDB 척도를 추정하지 않는다. |
| NEA PSCompPars | `tic_id`, `pl_name`, `pl_tranmid_systemref` 및 period/epoch/duration/depth | `pl_trandep`는 percent다. ppm 변환은 10,000배다. epoch reference 값·결측은 실제 export로 대조한다. |
| MAST TCE | `ticid`, `tceid`, `tce_plnt_num`, `sectors`, `tce_time0bt`, `tce_time0` 등 실제 헤더 확인 | TIC+TCE 번호만 전역 키로 확정하지 않고 Sector 범위·배포·pipeline 근거를 보존한다. 시간 척도는 별도 확인 대상이다. |
| ExoFOP TOI | `TIC ID`, `TOI`, `TFOPWG Disposition`, `Epoch (BJD)` 등 실제 헤더 확인 | NEA TOI와 별도 export를 감사했다. BJD의 시간 척도 확인과 헤더 확인을 구분한다. |

공식 근거: [TOI 열](https://exoplanetarchive.ipac.caltech.edu/docs/API_TOI_columns.html), [PS/PSCompPars 열](https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html), [TCE 배포](https://archive.stsci.edu/tess/bulk_downloads/bulk_downloads_tce.html).

## 후속 계약 검증

TIC는 같은 별의 후보를 좁히는 키다. 112의 동일성·고조파 보류 원칙과 period·epoch·duration·관측 통과 창을 대조해 direct/ambiguous/unmatched fixture를 만든다. 현재 수집기는 후보를 매칭하지 않는다. 자동 고조파 병합이나 외부 period/epoch 덮어쓰기를 활성화하지 않는다.

DAT-09 라벨과 AI 원점수는 별도로 보존하며 외부 갱신으로 기존 인정 성과를 덮어쓰지 않는다. 외부 대표 period/epoch 반영은 DEC-20의 검토 대상이다. 원천 충돌·시간 척도 불명·일대다를 임의 우선순위로 해소하지 않는다.

## 실행·검증 상태

[fixture 사용법](../../experiments/tess-fixture/README.md#116-외부-export-수집)을 따른다. 원본은 Git 제외 `results/external-catalog/`에 저장하며 콘솔에는 행 값을 출력하지 않는다.

- 합성 단위 테스트 11개 통과: BOM·주석·인용 문자열 줄바꿈, 오류 응답·빈 CSV·헤더 중복·행 길이, 실패 후 기존 파일 보존, 원본 해시, 조회 범위.
- 실제 다운로드·헤더·단위 대조: 아래 두 실행과 원본 9별 실측 결과를 참조한다.
- 정규화·매칭 fixture·운영 snapshot 계약 및 소비자 승인: 후속 작업. 116 완료나 124 인계 완료가 아니다.

## 2026-09-22 첫 수집과 쿼리 정정

사용자 실행 `run-20260922T075142Z-85fe81f7`에서 TOI 18행, TCE 5,940행을 확보했다. Archive는 HTTPError, ExoFOP는 URLError로 실패했으며 전체 상태는 incomplete다. Archive 쿼리의 `rowupdate`는 PS 전용 열이므로 PSCompPars 조회에서 제거했다. 원천 갱신일을 조회 시각으로 대체하지 않는다. ExoFOP 실패 원인은 기존 로그만으로 확정하지 않는다.

`--source nea_pscomppars exofop_toi`로 두 원천만 새 디렉터리에 재수집할 수 있다. 부분 실행은 manifest의 subset/requested_sources로 표시하며 네 원천 전체 완료로 해석하지 않는다. HTTP 상태와 URL 오류 원인의 타입·숫자 코드를 추가 기록한다. 인증서 검증은 유지한다. 수정 후 합성 테스트 14개 통과, 실제 재수집 대기다.

## 2026-09-22 실제 export 무결성·표본 감사

두 실행 `85fe81f7`·`46337bcc`의 성공 원천만 사용했다. 네 원본의 byte 수·SHA-256·헤더·행 수를 manifest와 대조해 모두 일치했다. 과거 incomplete manifest는 수정하지 않았다.

| 원천 | 전체 행 | fixture 9 TIC에 해당하는 행 | 원본 SHA-256 |
| --- | ---: | ---: | --- |
| NEA TOI | 18 | 18 | `5b6f6a1263e2e003b8752791ac3df02d8bc4fe10479ad7847de4e7c5528a8708` |
| MAST TCE S1–13 | 5940 | 8 | `335266f382aad96cbaed77411a523ae1fc82f46fb02c7f2247c63db4acd56add` |
| NEA PSCompPars | 22 | 22 | `33527cffe02643f517cedfb1eaa70dda23bb97b04a4e165868133c48ebf16ae5` |
| ExoFOP TOI | 8148 | 18 | `172eac007325f41ea5916810d8b8113f22c14dbc1d42a8dd9083d98a18ff11a1` |

조회 시각은 manifest의 retrieved_at(UTC)에 보존했다.

Archive 22행의 epoch reference는 BJD-TDB 11행·BJD 10행·JD 1행이다. BJD/JD만 표기한 값을 무조건 TDB로 변환하지 않는다. 비통과 행성도 포함하므로 22행 모두를 통과 후보와 동일시하지 않는다.

NEA TOI와 ExoFOP는 (TIC, TOI) 18쌍 모두 일대일이며 TFOPWG 라벨과 수치상 BJD epoch가 일치했다. 같은 외부 식별자의 정합성이며 내부 BLS 후보와의 과학적 동일성 증명은 아니다.

MAST 선택 8행은 WASP-62 1·TOI-700 3·pi Men 1·L 98-59 3행이다. 파일 전문은 Search=tess2018206190142, Sectors=s0001-s0013, Created Date=2021-09-14를 포함한다. 조회 시각을 원천 생성일이나 현행 pipeline 판으로 대체하지 않는다. 행의 sectors 표기는 s0001-s00013이며 원문을 보존한다.

감사 결과는 `experiments/tess-fixture/results/external-catalog/audit-85fe81f7-46337bcc.json`이다. SHA-256은 `4e5b085b394748565cbfde43136cacab4ed9bab95f2f7840adea3cd541c0a464`다. 천문 필드만 투영했으며 자유 입력 Comments는 제외했다. TCE의 원천 내 키는 (ticid,tceid), TOI는 (tid,toi), Archive는 (tic_id,pl_name)로 중복을 확인했으며 이번 선택 표본의 중복은 0건이다. 이는 배포 간 영구 키 유일성 검증이 아니다.

감사기 테스트를 포함해 18개 통과했다. 원본 변조·원천 중복·원천 누락을 거부하며 기존 파일을 변경하지 않는다. 실제 자료 감사는 로컬 재집계이며 다운로드나 BLS 실험 재실행이 아니다. 내부 후보 조인·시간 척도 근거 확정·소비자 승인은 아직 남아 있다.

## 116 매칭 검토안 v1과 실측 준비

상태: 합성 검증·원본 광도곡선 실측 완료·!187 리뷰 승인. 운영 배치 적용 완료를 뜻하지 않는다. 구현은 [external_matching.py](../../experiments/tess-bench/tess_bench/external_matching.py), 사용자 실측은 [bench 사용법](../../experiments/tess-bench/README.md#116-원본-광도곡선외부-참조-실측)을 따른다.

### 판정과 근거

- 같은 TIC, 같은 외부 원천 배포 단위로 매칭한다. 서로 다른 원천의 동일 천체 보고를 일대다 경쟁으로 간주하지 않는다.
- 112 커널의 양방향 epoch 정렬·누적 주기 오차 distance와 tolerance=0.5를 재사용한다. 외부 적용의 독립 정확도 검증 완료를 뜻하지 않는다.
- 추가 문턱은 duration 큰 값/작은 값 <=2, 관측점 집합에서 통과 마스크 교집합/합집합 >=0.5, 교집합 관측점 >=1이다. 116 리뷰용 제안이며 보정된 운영 문턱이 아니다. 성능을 보고 같은 세트에서 문턱을 조정하면 독립 평가로 보고하지 않는다.
- 실제 유한 관측 시각에서 통과 마스크를 계산한다. 빈 구간을 균일 격자로 채워 중첩 증거를 만들지 않는다. 통과 경계는 strict `< duration/2`다. shared/union 점 수와 비율을 기록한다.
- 원천 내 일대다·다대일은 ambiguous_match다. 고조파 의심은 possible_alias이며 라벨을 확정 연결하지 않는다. 미연결 내부 ID 목록은 ambiguity·invalid 영향도 포함하므로 전부 신호 부재로 해석하지 않는다.
- BJD-TDB만 BTJD-TDB로 2457000을 빼서 변환한다. BJD·JD 또는 근거 없는 TCE 척도는 invalid_external로 남는다. Archive 비통과 행성도 직접 연결에서 제외한다. 시간 척도 보류를 푸는 데에는 명시적인 원천 근거가 필요하다.
- 현재 실험 ID는 `diagnostic:<target>:<step>`이며 운영 ID가 아니다. 124에서는 122가 확정한 실제 candidate ID를 입력해야 한다.

### 라벨과 대표값·갱신 계약 제안

직접 매칭이 끝난 TFOPWG 라벨에만 DAT-09를 적용한다. KP/CP는 planet, FP/FA는 not_planet, PC/APC/없음은 null이다. 원천끼리 의미가 다르면 source_conflict, 알 수 없는 라벨이면 unknown_label로 구분해 보류한다. 빈 값은 다른 라벨에 대한 반대 의견이 아니다. TCE 존재나 Archive 이름만으로 TFOPWG 라벨을 만들지 않는다. 이 함수는 입력 라벨의 매칭 여부를 스스로 판별하지 않으므로 124 호출 계층에서 direct_match를 강제해야 한다. 운영 disposition 및 필수 열 공급은 아래 소비자 인계 표를 따른다.

DEC-20 검토 제안은 자체 BLS 대표값 유지, 외부값 별도 보존이다. 이번 실험이 대표값 외부 정렬을 승인하지 않는다. AI 원점수·상태·과거 인정 성과에는 쓰기를 수행하지 않는다.

snapshot_proposal은 순수 검토 모델이다. 수집 완전성 또는 검증 실패는 이전 snapshot을 유지한다. 같은 source/scope/hash는 unchanged다. 내용 변경은 review_new_snapshot이며 current를 자동 전환하지 않는다. 범위가 다른 부분 snapshot으로 전체를 교체하는 요청은 거부한다. 124의 트랜잭션·권한·주기·보존 기간은 이 실험에서 구현하지 않는다.

### 실측의 한계와 완료 순서

원본 9별에 기존 전처리와 122 iterate_bls를 적용한다. 알려진 행성 제거·합성 주입은 하지 않는다. 원본 SNR 재검증을 통과한 채택 이력만 비교하되 전체 종료 사유와 QA 실패를 함께 저장한다. 실패한 별의 이전 후보 비교는 진단일 뿐 게시 가능한 후보 집합이 아니다. completed는 실험 실행 완료이며 approved=false를 유지한다.

1. 사용자 원본 9별 실측 실행.
2. manifest 입력·출력 hash, 대상 수, 후보·상태 집계, 실제 양성/모호/미매칭 근거 확인. 양성 사례가 없으면 성공으로 포장하지 않는다.
3. 시간 척도·원천 충돌·DEC-20 제안과 124 인계 범위를 재민님 리뷰에 제시한다. 추가 문턱의 실측 적절성과 보류 영향도 함께 검토한다.
4. 결과 문서·최소 검산 산출물 준비 후 사용자가 commit/push/MR을 진행한다.
5. 계약 승인·병합 뒤 Jira 116 완료 여부를 판단한다. 정책 미결을 코드 기본값으로 확정하지 않는다.

수집·감사 테스트 18개, 리뷰 보완 후 매칭·변환·실행기 합성 테스트 41개가 통과했다. 실행기 테스트는 가짜 FITS/커널 대역이며 실제 실측 성공 증거가 아니다. 사용자 실제 실행 결과는 아래 6348c862 절에 기록한다.

## 원본 9별 실측 결과 — 6348c862

사용자 실행 `run-20260922T100238Z-6348c862`, wall time 63.385초다. 입력 80개 + plan 1개 + 출력 10개(출력 목록에 plan 포함), 총 91개 checksum 검사를 수행했고 불일치 0건이다. 중복 plan 검사를 포함한 횟수이며 고유 파일 수가 아니다. 결과 manifest 자체 SHA는 리뷰 ZIP의 checksums.json에 기록한다. 설정·계산 코드는 실행 후 변경하지 않았다.

| 별 | 비교한 내부 후보 | 직접 연결 | 외부 미연결 | invalid_external | BLS 종료 |
| --- | ---: | ---: | ---: | ---: | --- |
| TOI-270 | 3 | 0 | 0 | 9 | no_quality_peak |
| L 98-59 | 3 | 0 | 0 | 14 | no_quality_peak |
| CM Dra | 0 | 0 | 0 | 0 | removal_qa_failed |
| WASP-18 | 1 | 1 | 0 | 2 | removal_qa_failed |
| WASP-62 | 1 | 1 | 0 | 3 | removal_qa_failed |
| TOI-700 | 1 | 1 | 3 | 11 | no_quality_peak |
| TOI-451 | 0 | 0 | 3 | 6 | no_quality_peak |
| pi Men | 0 | 0 | 0 | 6 | no_quality_peak |
| HD 21749 | 0 | 0 | 2 | 4 | no_quality_peak |
| 합계 | 9 | 3 | 8 | 55 | 정상 종료 6별·제거 QA 실패 3별 |

외부 66행은 원천별 참조 행 수이며 고유 천체 수가 아니다. invalid_external 55행은 시간 척도 미확인 51행(TOI 18·ExoFOP 18·TCE 8·Archive 통과 BJD 7)과 Archive 비통과 4행이다. 이 55행을 알고리즘 오매칭·누락률의 분모나 실패 건수로 쓰지 않는다. CM Dra는 이 범위의 외부 행도 없고 BLS QA도 실패했으므로 무신호의 증거가 아니다.

| Archive 직접 참조 | identity distance | duration 비율 | 관측 교집합/합집합 | Jaccard |
| --- | ---: | ---: | ---: | ---: |
| WASP-18 b | 0.0604113040 | 1.1510416667 | 2613/3019 | 0.8655183836 |
| WASP-62 b | 0.0075031334 | 1.2720000000 | 1636/2059 | 0.7945604662 |
| TOI-700 c | 0.4670639324 | 1.1833333333 | 107/129 | 0.8294573643 |

세 행은 미리 정한 검토 문턱에서 직접 대응했다. WASP-18·WASP-62의 대응은 이후 QA 실패 전에 채택·원본 SNR 확인된 후보의 **진단**이다. 별 전체 판의 게시 승인을 뜻하지 않는다. TOI-700 c도 과학적 정답 독립 검증이나 운영 ID 연결이 아니라 같은 식을 적용한 실측이다. 실제 ambiguous/possible_alias 사례는 0건이며 해당 동작은 합성 fixture로만 검증했다.

### 검토 자료

`experiments/tess-bench/results/review-116-6348c862.zip` (15개 파일): plan·실측 manifest·별별 결과 9개·선별 원천 감사·수집 manifest 2개·checksums.json. ZIP SHA-256: `368d8a03c7f64805c7d266442de9122445b08d13605be37c46538f0c2f76c658`.

원본 FITS·전체 원천 export·캐시는 포함하지 않는다. ZIP으로 별별 매칭 지표와 상태 집계를 검산할 수 있지만, 전체 입력 파일의 해시 재검증과 BLS 재현에는 plan의 원본 파일이 별도로 필요하다. JSON의 로컬 절대경로는 실행 당시 위치이며 ZIP에서는 basename으로 결과를 찾는다.

### 승인 요청 범위

124 소비자는 시간 척도 미확인 원천을 보류하는 범위, 직접/다중/고조파 조인 계약, label conflict 보류, 기존 snapshot·AI·성과 보존을 검토해야 한다. DEC-20은 자체 대표값 유지·외부값 별도 보존 제안을 승인받아야 한다. 원천별 시간 척도 근거 없이 BJD를 TDB로 추정해 55행을 강제 연결하지 않는다. 이번 자료만으로 116 완료를 선언하지 않는다.

## !187 소비자 리뷰 보완 — disposition 전체 열 인계

상태: 재민님이 3c5e48dd의 반영을 확인하고 승인했다. DB 스키마와 기존 migration은 변경하지 않는다. `disposition()`은 순수 판정 함수이며 DB INSERT 행 완성기가 아니다. 판정 규칙 버전은 `external-disposition-review-v2`로 분리했다. 매칭 규칙 `external-match-review-v1`과 다른 책임이다.

| TFOPWG 입력 | disposition | answer_class | planet_truth | 판정 |
| --- | --- | --- | --- | --- |
| KP/CP | confirmed | graded | planet | resolved |
| FP/FA | fp | graded | not_planet | resolved |
| PC/APC | pc | analysis | null | resolved |
| 유효하게 확인된 라벨 없음 | none | analysis | null | resolved |
| 서로 다른 의미의 유효 라벨 | null | analysis | null | hold, conflicting_labels |
| 알 수 없는 라벨 | null | analysis | null | hold, unknown_label |

빈 문자열/null은 missing_label_count에 기록한다. CP+빈 값은 confirmed/partial_labels, FP+null은 fp/partial_labels이며 충돌이 아니다. CP+PC는 confirmed와 pc라는 서로 다른 판정이므로 충돌이다. PC+APC는 같은 pc다. 알 수 없는 라벨과 충돌이 동시에 있으면 source_conflict=true도 보존한다. raw_labels는 그대로 유지한다.

**hold의 null disposition은 DB 저장값이 아니다.** 124는 decision_status=hold이면 INSERT/UPDATE하지 않고 기존 판정을 유지하며 보류 사유·참조를 검토 산출물에 보존한다. 신규 후보는 완성된 판정이 없으므로 125/Publisher 게시 검증에서 보류한다. none으로 바꿔 필수 열 제약을 우회하지 않는다. ai_evaluations·성과 테이블은 판정 함수의 입력/출력 대상이 아니다.

### 필수 열별 공급자

| DB 열 | 공급자 | 계약 |
| --- | --- | --- |
| candidate_id | 122 확정 ID → 124 | 실제 내부 ID. diagnostic ID나 외부 ID를 넣지 않는다. |
| disposition | 116 판정 규칙 → 124 | 위 confirmed/fp/pc/none 매핑. hold이면 행을 쓰지 않는다. |
| answer_class | 116 판정 규칙 → 124 | disposition과 같은 결정에서 graded/analysis를 함께 공급한다. |
| planet_truth | 116 판정 규칙 → 124 | 같은 결정에서 planet/not_planet/null을 공급한다. |
| rule_version | 116 판정 규칙 → 124 | 검토 모델은 external-disposition-review-v2. 승인 후 채택한 불변 버전을 manifest와 DB에 동일하게 기록한다. 제출 매칭 rule_version을 가져오지 않는다. |
| source_refs | 124 조인/출처 구성 → 125 검증 | 아래 JSON 객체. 판정에 사용한 원천 근거·결측·불일치를 보존한다. |
| applied_at | Publisher 적용 트랜잭션 | TIMESTAMPTZ 적용 시각. 조회 시각·실험 실행 시각을 대신 넣지 않는다. 변경 없는 재처리에서는 기존 행과 시각을 유지한다. |

124가 네 판정 열(disposition/answer_class/planet_truth/rule_version)과 source_refs를 같은 행으로 구성하고, 125가 일관성과 필수값을 검증하며 Publisher가 applied_at과 함께 원자적으로 적용한다. 한 열만 갱신해서 화면·통계가 다른 판정을 읽는 상태를 만들지 않는다. 운영 DB 쓰기·권한 검증은 이번 실험에서 실행하지 않았다.

### source_refs JSON 검토 계약

```json
{
  "schema_version": "external-disposition-refs-v1",
  "decision_reason": "partial_labels",
  "refs": [
    {
      "source": "nea_toi",
      "source_table": "toi",
      "snapshot_id": "<124 snapshot identifier>",
      "snapshot_sha256": "<64 lowercase hex>",
      "external_id": "<TOI string>",
      "tic_id": "<decimal string>",
      "retrieved_at": "<UTC ISO-8601>",
      "source_row_updated_at": null,
      "match_status": "direct_match",
      "matching_rule_version": "external-match-review-v1",
      "raw_disposition": "CP"
    }
  ],
  "missing_label_count": 0,
  "absence_evidence": null
}
```

이는 실제 DB 행이 아닌 구조 예시다. snapshot의 URI/query와 해시는 수집 manifest까지 연결되어야 한다. 124는 각 ref가 해당 candidate_id와 동일 TIC의 유일 직접 대응인지 검증한다. source_refs의 raw_disposition과 함수 raw_labels 순서를 맞추고, 자유 입력 댓글은 넣지 않는다. 매칭 상세 수치는 snapshot/조인 산출물에서 참조한다.

라벨이 정말 없으면 refs=[]도 JSONB NOT NULL을 만족하지만 **빈 배열만으로 none을 게시하지 않는다.** absence_evidence에 검증 완료된 source/scope/snapshot_id/hash, 조회 완전성, unmatched 또는 missing_field 사유를 남긴다. 조회 실패·부분 결과·invalid time·ambiguous·possible_alias는 유효한 라벨 부재의 증거가 아니므로 호출 전에 hold로 분기한다. 본 판정 함수는 조회 성공 여부를 알 수 없으며 이 분기는 124 책임이다. 기존 source_refs를 실패 응답으로 비우지 않는다.

PC/APC→pc와 라벨 없음→none은 DB 상태를 구분한다. 150의 pc↔none 표식 생략 규칙을 변경하지 않는다. 배치의 성과 테이블 쓰기 금지와 앱의 relabeled_at/relabel_disposition 후처리 경계도 그대로 유지한다.

### 검증·기존 실측 근거의 범위

매칭/변환/실행기/판정 테스트 41개 통과(빈 값·PC/APC·FP·실제 충돌·unknown 추가). 기존 6348c862 실측 경로는 disposition()을 호출하지 않는다. 매칭·BLS 산식과 문턱은 바꾸지 않았으므로 BLS 재실행은 하지 않았다. 기존 manifest와 ZIP은 당시 코드의 불변 근거로 보존하며 **새 HEAD의 전체 코드 checksum 일치 증거로 재사용하지 않는다.** 새 판정 동작 근거는 이번 회귀 테스트다. 124의 실제 INSERT 및 source_refs 구성·125 검증·Publisher 적용은 후속 구현 범위다.

!104와의 uv.lock 충돌은 리뷰어의 교차 MR 확인 사항이며 이번 보완에서 lockfile을 수정하지 않았다. 실제 통합 시 최신 develop과 충돌 여부를 다시 확인한다.

## 최종 리뷰 승인과 비차단 후속 인계

사용자가 전달한 !187 댓글에서 강재민은 3c5e48dd의 disposition·필수 열 인계를, 김동혁은 수집·감사·매칭 검토안·실측·인계 범위를 승인했다. 김동혁은 수집/감사 18개와 매칭/실행기 41개 테스트를 직접 실행했다. 한글 워크트리의 editable 경로 로딩은 PYTHONPATH 지정으로 해결했으며 MR 결함으로 판단하지 않았다. 두 리뷰어가 실제 BLS와 ZIP checksum을 재실행한 것으로 기록하지 않는다.

검토 자료 ZIP은 Git 제외 results 경로의 로컬 생성물이며 [GitLab MR !187](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/187)의 첨부 자료로 제공한다. 저장소 checkout만으로 생기지 않는다. 위 SHA-256으로 해당 첨부의 동일성을 확인한다.

다음은 병합 차단이 아닌 124 구현·검증 인계다. 이번 문서 보완에서는 계산·수집·실측 코드를 변경하지 않는다.

| 담당 | 후속 조치 | 검증 조건 |
| --- | --- | --- |
| 124 실행 manifest | 현재 glob("*.py")는 평면 모듈만 포함한다. 하위 패키지 도입 전 재귀 코드 snapshot으로 확대하고 정렬·범위를 고정한다. | 하위 패키지 파일 하나의 변경도 입력 hash 변경으로 감지하는 테스트 |
| 124 원천 검증 | 중복 외부 키는 해당 원천을 보류하고 기존 성공 snapshot을 유지한다. 현재 실험은 duplicate_id_in_source 예외로 실행 전체를 중단한다. | 중복 원천의 라벨 게시 금지, 다른 원천의 진단 보존. 부분 결과를 전체 성공 snapshot으로 승격하지 않음 |
| 124 라벨 호출부 | no_label 판정 호출 전에 absence_evidence·완전성·시간 기준·매칭 상태를 명시적으로 검사한다. | 실패·부분·invalid time·ambiguous·possible_alias가 none 갱신으로 이어지지 않는 테스트 |
| 124 시간 정규화 | TCE tce_time0bt의 원점뿐 아니라 TDB 시간 척도까지 공식 MAST 근거로 확인한다. | 근거 URI·변환 규칙 버전·재검증 후에만 현재 8행 보류 해소. 이름만으로 BTJD-TDB 추정 금지 |

1~4번 문서 정합성 의견(인덱스 상태·41개 테스트 수·fixture 사용법 위치·MR 첨부 안내)을 반영했다. 원천별 부분 보류와 재귀 snapshot은 후속 구현 항목이며 현재 기능으로 보고하지 않는다. 승인된 검토 범위를 운영 적용 완료 또는 모든 외부 시간 척도 검증 완료로 확대하지 않는다.

## 2026-09-27 시간 척도 근거 결정 (S15P21C206-79)

- 상태: 커널 반영·단위 검증과 저장 자료 재실측 완료(아래 재실측). 운영 수집분 재실측은 아니다.
- 결정: 열 이름에 TDB가 글자로 적히지 않아도, 공식 문서들이 이어져 척도를 정하면 받는다. 규칙 버전은 `external-time-evidence-v1`이고, 근거 URI는 커널 상수 `TIME_EVIDENCE`에 둔다. 어댑터는 이 값을 snapshot `time_evidence`로 넘긴다. 이름만 보고 추정하는 것은 여전히 금지한다.

| 원천 | 근거 | 판정 |
| --- | --- | --- |
| ExoFOP TOI `Epoch (BJD)` | [TOI 릴리스 노트](https://tess.mit.edu/toi-releases/toi-release-notes/)와 [TOI 카탈로그 논문](https://arxiv.org/abs/2103.12538)은 epoch를 바리센터 보정한 TESS Julian Day(BJD − 2457000)로 정의한다. [SPOC 제품 설명서](https://archive.stsci.edu/files/live/sites/mast/files/home/missions-and-data/active-missions/tess/_documents/EXP-TESS-ARC-ICD-TM-0014-Rev-F.pdf)는 TESS 시각을 `TIMESYS='TDB'`, `BJDREFI=2457000`으로 정의한다 | BJD-TDB로 받는다 |
| NEA TOI `pl_tranmid` | NEA TOI 목록은 ExoFOP TOI 목록으로 만든다([TESSMission](https://exoplanetarchive.ipac.caltech.edu/docs/TESSMission.html)). 116 실측에서 18쌍의 epoch가 수치상 일치했다. 나머지 근거는 ExoFOP와 같다 | BJD-TDB로 받는다 |
| MAST TCE S1~13 | CSV 머리말에 DV XML 파일에서 뽑은 통계라고 적혀 있다. SPOC 제품 설명서는 DV epoch를 `transitEpochBtjd`로 둔다. 척도 근거는 위 SPOC 설명서와 같다 | `tce_time0bt`를 BTJD-TDB로 받는다 |
| NEA PSCompPars | [열 정의](https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html)가 표기값의 뜻을 정하지 않는다. 아카이브는 `BJD-TDB`와 `BJD-UTC`를 따로 쓰므로, 아무 표기 없는 `BJD`·`JD`·`HJD`는 척도를 알 수 없다 | v1: 행마다 `BJD-TDB`로 적힌 경우만 받는다. v2는 아래 추가 결정을 본다 |

- 정정: 기존 커널은 TCE에서 전체 BJD 열 `tce_time0`을 읽고 척도를 `unverified`로 두었다. 이 문서(22·223행)가 가리키던 열은 `tce_time0bt`이므로 커널을 그에 맞췄다. Sector 1 CSV의 첫 두 행에서 두 열의 차이는 정확히 2457000이다.
- 한계:
  - TCE CSV의 epoch는 소수 둘째 자리(0.01일, 약 14.4분)까지만 있다. 116 매칭 허용치(duration의 0.5배)보다 작지만 여유가 줄어든다. 모호하면 기존대로 보류한다.
  - QLP는 S74~79에 최대 약 3분의 바리센터 보정 오류를 공지했다. 초기 공개 범위인 S3·4·5와는 관계없다.
- 재실측(2026-09-27):
  - 입력은 MR !187의 `review-116-6348c862.zip`(SHA-256이 위 기록과 일치)에 든 해시 검증 감사 행, 이 PC에서 새로 돌린 123 회귀(`run-20260926T192658Z-f951ab55`), 공식 MAST FITS다.
  - 124 방식으로 다시 만든 관측 시각은 16곡선 모두 MR !190 `review-124-696cda44.zip`의 `observed_times_sha256`과 같았다. 그래서 09-22 실행과 달라진 것은 시간 규칙뿐이다.
  - 정규화 결과: TOI 18행·ExoFOP 18행·TCE 8행이 모두 정규화됐고, PSCompPars는 정규화 11·보류 7·비통과 제외 4로 이전과 같다.
  - 후보가 준비된 11곡선 중 7곡선(toi451 3개, wasp62 4개)이 `hold`에서 `ready`로 바뀌었다.
  - wasp62에서 BLS 후보(주기 약 4.4117일)가 ExoFOP·NEA TOI(KP)·TCE·PSCompPars 네 원천과 직접 매칭돼 `confirmed`가 됐다. 이는 WASP-62 b다. 주입 신호 후보는 외부 행이 없어 `none`이다.
  - 남은 4곡선(toi270, pi_men)은 PSCompPars의 표기 없는 BJD 행 때문에 `nea_pscomppars:unresolved_external_rows`로 계속 보류된다.
  - 도구는 `python -m tess_bench.aggregation_replay`, 결과는 Git 제외 `experiments/tess-bench/results/aggregation-replay-79/run-20260926T193436Z-7581421a`(manifest SHA-256 `f87a11bc72408d547517f21f079ede97e36351b67ff0896859978f6be2603952`, 입력 ZIP 외부 해시 고정·리뷰 반영 뒤 최종 커널)에 있다.
  - 이 재실측은 TDB와 UTC 사이 약 1분 차이를 판별하지 못한다. 매칭 허용치(분~시간 단위) 안에서 BJD − 2457000 원점과 epoch 정렬이 맞는다는 근거일 뿐이다.
- 검토: 79 작업에서 자체 리뷰(코드·계약·문서 대조)와 위 재실측으로 확인했다. 팀 병합 규칙의 비작성자 승인을 대신하지 않는다.

### v2 추가 결정: PSCompPars 행별 논문 근거와 BJD-UTC 변환 (2026-09-27)

규칙 버전을 `external-time-evidence-v2`로 올렸다. v1의 TOI·ExoFOP·TCE 판정은 그대로다.

- **행별 논문 근거(`ROW_TIME_EVIDENCE`).** 표기 없는 `BJD` 행은 Archive의 `pl_tranmid_reflink`가 가리키는 논문의 epoch 표로 척도를 확인한 경우에만 받는다. 근거는 행성 이름과 정확한 epoch 값에 묶는다. Archive 행이 바뀌면(참조 논문·값 변경) 다시 보류된다. 정규화 결과에는 `time_evidence`로 논문과 표 위치를 남긴다.

| 행 | 논문 | 표기 | 판정 |
| --- | --- | --- | --- |
| TOI-270 b·c·d | [Kaye et al. 2022](https://arxiv.org/abs/2308.10763) | 표 3 각주: T0를 BJD_TDB − 2457000으로 적는다(표 5와 같은 값) | BJD-TDB |
| pi Men c | [Kunovac Hodžić et al. 2021](https://arxiv.org/abs/2007.11564) | 표 4: T0를 BJD_UTC − 2450000으로 적는다 | BJD-UTC를 변환 |
| L 98-59 b·c·d | [Cadieux et al. 2025](https://arxiv.org/abs/2507.09343) | 표 5: t0를 TBJD(BJD − 2457000)로 적는다. TESS BJD 체계는 SPOC 설명서상 TDB다 | BJD-TDB |

  일곱 행 모두 논문 값과 Archive 값이 자릿수까지 같았다.
- **BJD-UTC 변환.** 명시적 `BJD-UTC`(Archive 표기 또는 위 논문 근거)는 바리센터 TDB − UTC = TT − UTC(2 ms 이내, Eastman et al. 2010)로 바꾼다. 2017-01-01(BJD 2457754.5) 이후에는 32.184초 + 윤초 37 = 69.184초를 더한다. 그 이전 UTC epoch는 윤초표가 없어 보류한다.
- **바꾸지 않은 것.** `JD`·`HJD`·표기 없음은 여전히 보류한다. 비통과(`tran_flag=0`) 행이 그 TIC의 분류를 막는 124 규칙도 그대로 둔다. `tran_flag=0`은 "통과로 발견되지 않음"이지 "통과하지 않음"이 아니다. 우리 BLS 신호가 그 행성일 가능성을 배제하려면 새 매칭 규칙이 필요하고, 이는 79 범위 밖의 과학 결정이다.
- **v2 재실측.** 같은 입력으로 다시 실행한 결과(`run-20260926T195124Z-68cce2c5`, manifest SHA-256 `774ccc8998c245ac6c165a284aff5d84c583a646ac8a8a88070f51b63eb52320`)다.
  - PSCompPars 통과 행 18개가 모두 정규화됐고, 비통과 제외는 4개다.
  - 준비된 11곡선 중 9곡선이 `ready`다. v1 대비 toi270 2곡선이 늘었다. toi270 후보는 알려진 행성을 지운 곡선의 주입 신호라 외부 행이 없어 `none`이다.
  - 남은 2곡선(pi_men g108·g110)은 비통과 행(HD 39091 b, pi Men d) 때문에 보류다.
  - 79 run 4개 모두 `complete`이고 스키마 오류는 0건이다.
