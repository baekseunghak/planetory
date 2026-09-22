# 외부 카탈로그 계약 검증 — 116

- Jira: S15P21C206-116
- 상태: 네 원천 수집·9별 실측·검산 완료. 외부 시간 기준 보완과 매칭 계약 승인은 남아 있다. 운영 채택 전 검토안이다.
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
| MAST TCE | 실제 헤더 대조 대기 | TIC+TCE 번호만 전역 키로 확정하지 않고 Sector 범위·배포·pipeline 근거를 보존한다. |
| ExoFOP TOI | 실제 헤더 대조 대기 | NEA TOI를 대신 받아 ExoFOP 검증으로 표시하지 않는다. |

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

상태: 합성 검증·원본 광도곡선 실측 완료·팀 미승인. 구현은 [external_matching.py](../../experiments/tess-bench/tess_bench/external_matching.py), 사용자 실측은 [bench 사용법](../../experiments/tess-bench/README.md#116-원본-광도곡선외부-참조-실측)을 따른다.

### 판정과 근거

- 같은 TIC, 같은 외부 원천 배포 단위로 매칭한다. 서로 다른 원천의 동일 천체 보고를 일대다 경쟁으로 간주하지 않는다.
- 112 커널의 양방향 epoch 정렬·누적 주기 오차 distance와 tolerance=0.5를 재사용한다. 외부 적용의 독립 정확도 검증 완료를 뜻하지 않는다.
- 추가 문턱은 duration 큰 값/작은 값 <=2, 관측점 집합에서 통과 마스크 교집합/합집합 >=0.5, 교집합 관측점 >=1이다. 116 리뷰용 제안이며 보정된 운영 문턱이 아니다. 성능을 보고 같은 세트에서 문턱을 조정하면 독립 평가로 보고하지 않는다.
- 실제 유한 관측 시각에서 통과 마스크를 계산한다. 빈 구간을 균일 격자로 채워 중첩 증거를 만들지 않는다. 통과 경계는 strict `< duration/2`다. shared/union 점 수와 비율을 기록한다.
- 원천 내 일대다·다대일은 ambiguous_match다. 고조파 의심은 possible_alias이며 라벨을 확정 연결하지 않는다. 미연결 내부 ID 목록은 ambiguity·invalid 영향도 포함하므로 전부 신호 부재로 해석하지 않는다.
- BJD-TDB만 BTJD-TDB로 2457000을 빼서 변환한다. BJD·JD 또는 근거 없는 TCE 척도는 invalid_external로 남는다. Archive 비통과 행성도 직접 연결에서 제외한다. 시간 척도 보류를 푸는 데에는 명시적인 원천 근거가 필요하다.
- 현재 실험 ID는 `diagnostic:<target>:<step>`이며 운영 ID가 아니다. 124에서는 122가 확정한 실제 candidate ID를 입력해야 한다.

### 라벨과 대표값·갱신 계약 제안

직접 매칭이 끝난 TFOPWG 라벨에만 DAT-09를 적용한다. KP/CP는 planet, FP/FA는 not_planet, PC/APC/없음은 null이다. 원천끼리 의미가 다르거나 알 수 없는 라벨이면 source_conflict로 보류한다. TCE 존재나 Archive 이름만으로 TFOPWG 라벨을 만들지 않는다. 이 함수는 입력 라벨의 매칭 여부를 스스로 판별하지 않으므로 124 호출 계층에서 direct_match를 강제해야 한다.

DEC-20 검토 제안은 자체 BLS 대표값 유지, 외부값 별도 보존이다. 이번 실험이 대표값 외부 정렬을 승인하지 않는다. AI 원점수·상태·과거 인정 성과에는 쓰기를 수행하지 않는다.

snapshot_proposal은 순수 검토 모델이다. 수집 완전성 또는 검증 실패는 이전 snapshot을 유지한다. 같은 source/scope/hash는 unchanged다. 내용 변경은 review_new_snapshot이며 current를 자동 전환하지 않는다. 범위가 다른 부분 snapshot으로 전체를 교체하는 요청은 거부한다. 124의 트랜잭션·권한·주기·보존 기간은 이 실험에서 구현하지 않는다.

### 실측의 한계와 완료 순서

원본 9별에 기존 전처리와 122 iterate_bls를 적용한다. 알려진 행성 제거·합성 주입은 하지 않는다. 원본 SNR 재검증을 통과한 채택 이력만 비교하되 전체 종료 사유와 QA 실패를 함께 저장한다. 실패한 별의 이전 후보 비교는 진단일 뿐 게시 가능한 후보 집합이 아니다. completed는 실험 실행 완료이며 approved=false를 유지한다.

1. 사용자 원본 9별 실측 실행.
2. manifest 입력·출력 hash, 대상 수, 후보·상태 집계, 실제 양성/모호/미매칭 근거 확인. 양성 사례가 없으면 성공으로 포장하지 않는다.
3. 시간 척도·원천 충돌·DEC-20 제안과 124 인계 범위를 재민님 리뷰에 제시한다. 추가 문턱의 실측 적절성과 보류 영향도 함께 검토한다.
4. 결과 문서·최소 검산 산출물 준비 후 사용자가 commit/push/MR을 진행한다.
5. 계약 승인·병합 뒤 Jira 116 완료 여부를 판단한다. 정책 미결을 코드 기본값으로 확정하지 않는다.

수집·감사 테스트 18개, 매칭·변환·실행기 합성 테스트 32개가 통과했다. 실행기 테스트는 가짜 FITS/커널 대역이며 실제 실측 성공 증거가 아니다. 실제 실행과 Git 명령은 사용자 실행 전이다.

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
