# 분석 프론트 API·Mock 계약 초안

> 상태: **Draft 0.1 — 백엔드·데이터 담당 합의 전**, 2026-09-09
>
> 기준: [요구사항 v0.12](../../requirements/planetory-requirements-spec.md), [상태표 v0.13](../../requirements/planetory-status-table.md), [와이어프레임 v0.6](../../requirements/planetory-wireframe.html) · 명세 기준 커밋 `77e4121`
>
> Jira: 미연결. 티켓 정리 전 사용자와 합의한 로컬 임시 브랜치에서 작성한다. 여기의 URI·HTTP 상태·필드명·enum·페이지 처리 방식은 제안이며 서버 구현이나 팀의 최종 API 명세가 아니다.

## 1. 목적과 범위

백지웅의 분석 화면에서 필요한 요청·응답을 먼저 맞춰, 백엔드 구현 전에도 정상·실패 화면을 재현한다. 분석 진입 → 곡선·주기·위상 구간 선택 → 제출 → 결과 → 잔차 탐색·재도전 → 미확정 분석 공개까지 다룬다. 실제 BLS·AI·보상 로직, API 서버, 회원 인증 구현은 포함하지 않는다.

- [화면 상태와 행동](state-model.md): 이미 합의한 정책을 프론트 상태 전이로 풀어 쓴다.

원본 명세의 정책은 유지한다. `open_questions`나 이 문서의 협의 목록은 미확정 사항이며, Mock에 넣은 제한값·오류코드로 제품 정책을 확정하지 않는다.

## 2. 경계와 데이터 공개

| 경계 | 제안 책임 | 연동 전에 확인할 것 |
|---|---|---|
| 그래프·입력 | 백지웅 ↔ 윤성용·강재민 | 실제 전 점 샘플, 품질 마스크, 시간·flux 단위, 기준 시각, 주기 조정·선택 폭 설정 |
| 제출·진행·재도전 | 백지웅 ↔ 강재민 | 제출·히스토리 식별자, 매칭/판단/성과/완료 응답, 구 Bundle 조회·보관 만료 |
| 잔차 계산 | 백지웅 ↔ 강재민, 계산 내부는 김동혁·윤성용 협의 | 작업 상태 조회·재시도·캐시 재사용 응답. 계산 언어·캐시 제품은 프론트가 가정하지 않음 |
| 공개·커뮤니티 | 백지웅 ↔ 백승학·하서진·강재민 | 게시 검토 화면 담당, 공개 성공과 최초 성과의 일관성, 공식 스레드·통계·출처 링크 |

모든 요청은 인증을 전제로 한다. 사용자 ID·성과·완료 여부를 클라이언트 입력으로 믿지 않는다. 서버는 별 열림, 본인 히스토리, TIC, Bundle, 현재 곡선·제거 조합, 공개·숨김 상태를 검증한다. 커뮤니티 열람 권한만으로 잠긴 별의 분석을 시작할 수 없다.

Gold의 내부 후보표·통과 모델과 브라우저 응답을 구분한다. 이 초안은 제출 전에는 관측 곡선·주기도·선택용 봉우리 참조·확정 행성 보유 여부만 제공하고, 아직 공개 조건을 충족하지 않은 후보의 정답값·개수·외부 라벨·AI를 내리지 않는 투영을 제안한다. EXP-01의 Bundle 조회 범위와 POL-05·EXP-02의 사전 공개 제한을 API에서 어떻게 나눌지 Q1에서 확인한다. 서버의 전체 후보 목록을 그대로 내려 UI에서만 숨기지 않는다.

## 3. 엔드포인트 초안

URI의 `/api/analysis`와 `/api/community` 구분은 담당 경계를 설명하는 제안이며 서비스 분리 결정을 뜻하지 않는다. 아래 표는 이 초안의 최소 목록이다. 목록 페이지·인증·일반 Post/Comment CRUD·운영 API 전체를 설계하지 않는다.

| 동작 | 메서드·경로 제안 | 요청 핵심 | 응답 핵심 | 근거 |
|---|---|---|---|---|
| 분석 시작 | `POST /api/analysis/sessions` | `request_id`, `tic_id` | 고정 세션·원본 곡선 문맥·설정·현재 진행 | EXP-01·05 |
| 세션 복구 | `GET /api/analysis/sessions/{session_id}` | 세션 ID | 같은 Bundle의 세션, 현재 서버 진행 | EXP-10 |
| 곡선 조회 | `GET /api/analysis/sessions/{session_id}/curves/{curve_id}` | 서버 발급 곡선 ID | 전 점·품질 마스크·기준 시각·주기도 | EXP-03~08 |
| 제출 | `POST /api/analysis/submissions` | 제출 원본·요청 ID·곡선 문맥 | Submission·History·파생값·분리된 결과 상태 | SUB-01~09 |
| 제출 수신 여부 복구 | `GET /api/analysis/submissions/by-request/{request_id}` | 본인 요청 ID | 이미 처리된 같은 결과, 미접수/처리 중은 별도 상태 | SUB-09, Q3 |
| 결과 카드 판단 분포 | `GET /api/analysis/submissions/{submission_id}/judgment-statistics` | 본인 매칭 제출 ID | 연결 신호의 집계 종류·시각·세 판단 인원·분모 | RES-11, COM-14 |
| 상세 열람 | `POST /api/analysis/submissions/{submission_id}/detail-views` | `request_id` | 대상 신호 해설과 `answer_viewed` | RES-09 |
| 다시 풀기 | `POST /api/analysis/submissions/{submission_id}/retry-drafts` | `request_id` | 원본 입력·제출 전 곡선을 복원한 편집 초안 | SUB-10 |
| 잔차 요청 | `POST /api/analysis/residual-jobs` | 요청 ID·출발 제출·제거 조합 | 준비된 캐시 결과 또는 작업 ID·상태 | DAT-14 |
| 잔차 상태 조회 | `GET /api/analysis/residual-jobs/{job_id}` | 작업 ID | 단계·실패 정보·완료 곡선 참조 | EXP-09 |
| 본인 히스토리 | `GET /api/analysis/histories/{history_id}` | 본인 History ID | 불변 제출·재현 문맥·현재 공개 상태 | HIS-02~06 |
| 공개 검토 | `POST /api/analysis/publication-reviews` | 요청 ID·TIC·선택 History ID들 | 신호별 검토 항목·자격·공개할 필드·대상 공간 | COM-19 |
| 개별/모두 게시 | `POST /api/community/analysis-publications` | 요청 ID·검토 ID·선택 History ID들 | 항목별 공개 기록·공식 스레드·최초 성과·실패 | COM-17~19 |
| 공개 수신 여부 복구 | `GET /api/community/analysis-publications/by-request/{request_id}` | 본인 요청 ID | 처리된 항목별 응답 | COM-19, Q3 |
| 본인 공개 취소/재공개 | `PUT /api/community/public-analyses/{public_analysis_id}/visibility` | 요청 ID·`author_public` | 본인 공개 여부·운영 숨김·실제 공개 가능 여부 | COM-18 |
| 미확정 공개 판단 통계 | `GET /api/community/signals/{candidate_id}/judgment-statistics` | 고유 신호 ID | 집계 시각·사용자 수·세 판단 인원·비율 | COM-14 |

별 결과·히스토리 목록은 같은 결과 DTO를 재사용하는 방향으로 협의한다. 페이지네이션·검색·공식 스레드 목록/상세·출처 카드의 전체 API는 서비스 담당 후속 범위다. 분석 쪽에서는 `history_id`, `candidate_id`, `official_thread_id`, `public_analysis_id`를 구분해 넘긴다.

## 4. 공통 형식과 입력

예시 파일의 `setup`·`source_requirements`·`name`·`server_event`는 시나리오 설명과 서버 선행 상태·변경 이벤트다. **실제 HTTP 본문은 각 `exchanges[].request.body`와 `response.body`뿐**이다. 이 메타데이터는 브라우저 공개 응답에 합치지 않는다.

성공 응답 본문은 `{ "kind": "응답 종류", ... }`, 실패는 `{ "kind": "error", "code": "...", "retryable": false, "message": "..." }` 형태를 제안한다. `null`은 해당 값 없음이고, AI 실행 불가를 0점으로 바꾸지 않는다. ID는 문자열로 전달하며 Mock의 `mock-` 값은 실제 천문 대상이나 회원이 아니다.

`curve_context`는 아래 필드를 함께 사용한다. `curve_step` 숫자만으로 곡선을 식별하지 않는다.

| 필드 | 의미 |
|---|---|
| `analysis_session_id`, `tic_id` | 분석 세션·별 |
| `publication_bundle_id`, `curve_id` | 고정 공개 묶음·서버가 발급한 곡선 참조 |
| `curve_step`, `removed_candidate_ids` | 해당 곡선에서 제거한 고유 신호 집합. 누적 매칭 집합과 별도 |
| `residual_model_version`, `periodogram_config_version`, `selection_rules_version` | 계산·선택 설정의 버전 |

서버가 발급한 문맥과 요청의 ID·조합이 맞는지 검사한다. 유효한 고조파도 하나의 고유 신호 ID로 정규화한다. 같은 Bundle·정렬한 제거 집합·계산 버전의 잔차만 재사용하고 다른 세션/Bundle의 곡선을 섞지 않는다.

후보 제출은 `submission_kind=candidate`, `selection={period_days, phase_start, phase_end}`, `user_judgment`, `evidence_flags`, `memo`, `view_state`, 선택적 `retry_of_submission_id`를 보낸다. `request_id`와 `curve_context`는 공통이다.

- `user_judgment`: `LIKELY_PLANET`, `UNLIKELY_PLANET`, `UNSURE`.
- `evidence_flags`의 임시 이름: `ODD_EVEN_SIMILAR`, `NO_SECONDARY_ECLIPSE`, `U_SHAPED`, `OUTSIDE_BAD_QUALITY`. 네 체크의 화면 문구·서버 enum은 협의한다. 체크는 선택이고 중심 위치 입력은 받지 않는다.
- `view_state`: 시간 곡선 표시 범위, 주기도 표시 범위, 접힌 곡선 확대 배율·중심의 재현 정보. 표시 상태는 서버 매칭 입력과 구분하고 유효 범위를 검증한다. `return_post_id`는 영속 입력에 포함하지 않는다.
- `no_candidate`·`skipped`에는 `selection`, 판단·근거·epoch·duration을 넣지 않는다. skip은 튜토리얼/서버 설정을 검사하며 운영 기본 0에서는 제공하지 않는다.

클라이언트는 `epoch`, `duration`, 고조파 정정값·성과·완료를 권위 있는 입력으로 보내지 않는다. 원본 선택은 `original_input`, 서버 파생값은 `server_derived`, 고조파 정정은 `match.correction`에 분리한다. 재도전은 `original_input`을 복원한다.

## 5. 그래프와 계산의 공통 기준

곡선 DTO는 `time_btjd`, `normalized_flux`, `quality_valid`의 같은 길이 배열, 관측 범위·Sector 구간·`fold_reference_time_btjd`, 주기도 축/값을 제공하는 제안이다. 큰 데이터의 바이너리/파일 전송 여부는 Q1에서 결정하고, Mock의 작은 JSON을 운영 용량 기준으로 삼지 않는다. 접기는 모든 유효 점을 사용한다.

`fold_reference_time_btjd`는 Bundle의 원본 품질 필터 후 유효 시각 중앙값이며 잔차도 같은 값을 상속한다. 표시 범위를 확대하거나 잔차 점을 읽을 때 다시 계산하지 않는다.

```text
0 <= phase_start < 1
phase_start < phase_end < phase_start + 1
phase(t) = (((t - reference) / period) mod 1 + 1) mod 1
phase_center = ((phase_start + phase_end) / 2) mod 1
duration_days = (phase_end - phase_start) * period_days
epoch = reference + (phase_center + k) * period_days
```

관측 범위 안의 epoch 중 reference에 가장 가까운 것을 택하고 동률이면 이른 시각을 택한다. 가능한 k가 없으면 제출 불가다. `phase_end > 1`은 정상 위상 경계 통과이며, 서버가 같은 공식과 원본 선택값으로 다시 검증한다. Mock은 `reference=1006`, 관측 `[1000,1012]`, period=3, 위상 `[0.98,1.02]`에 epoch=1006, duration=0.12일을 사용한다. 이는 계산 예제다.

주기 재선택/미세 조정은 입력 동작으로 구분한다. 미세 조정 min/max/step과 선택 폭은 서버 설정으로 받으며 Mock 제한값은 임시다. 주기를 바꾸는 것만으로 제출·잔차·BLS API를 호출하지 않는다. 초안에서는 잔차와 주기도가 모두 `COMPLETED`인 경우에만 분석 곡선을 바꾸며, 부분 곡선 미리 노출 여부는 Q4에서 결정한다.

## 6. 제출 결과의 독립 상태

| 필드 | 초안 값·의미 |
|---|---|
| `match.status` | `matched`, `matched_harmonic`, `not_matched`, `ambiguous_match`, `duplicate`; 특수 제출은 null |
| `opinion_result` | no_candidate의 `none_wrong`; 나머지는 null |
| `judgment.evaluation` | `AGREES`, `DISAGREES`, `UNSURE`, `UNSCORED`, `NOT_APPLICABLE` |
| `achievement.status` | `RECOGNIZED`, `NOT_RECOGNIZED`, `ALREADY_RECOGNIZED`; `awarded_now`와 `previously_recognized`로 이번·기존 성과 구분 |
| `achievement_summary_at_submission` | 제출 처리 당시 TIC의 유형별 인정 수·등급 스냅샷. 세션 조회의 현재 `achievement_summary`와 구분 |
| `judgment_statistics_ref` | 매칭 신호의 통계 종류·후속 조회 경로. 미매칭이면 null |
| `publication.state` | `NOT_ELIGIBLE`, `UNPUBLISHED`, `PUBLIC`, `WITHDRAWN`; 운영 숨김은 별도 flag |
| `progress.stage` | `IN_PROGRESS`, `COMPLETED`; 사유는 null / `all_found` / `undiscoverable_only` / `skipped` |
| `progress.matched_candidate_ids` | 이미 매칭한 누적 집합. 현재 곡선의 제거 집합과 별개 |
| `detail` | 사용 가능 여부·현재 매칭 신호/제출 곡선 힌트. 미매칭 힌트값은 상세 열람 전에 보내지 않음 |
| `available_actions` | 서버의 행동 가능 힌트. 버튼을 숨기는 것과 별개로 실행 요청 때 다시 검증 |

확정+LIKELY와 FP+UNLIKELY에만 최초 채점형 성과를 준다. 오판·UNSURE도 수치 매칭은 유지하고 마지막 탐색 가능 신호면 완료다. 미확정은 UNSURE를 포함하여 본인 분석의 첫 공식 공개 성공 시 성과를 인정한다. 완료 자체에는 보상이 없다.

아직 성과가 없는 재매칭은 duplicate가 아니다. 이미 인정된 미확정의 duplicate 새 기록도 선택 공개할 수 있지만 추가 성과는 없다. 결과 DTO의 당시 성과와 별 결과/프로필의 현재 누적 성과를 구분한다. 과거 결과를 다시 읽어서 보상을 재실행하지 않는다.

누적 요약은 서버가 `as_of`, `recognized_total`, `by_type={CONFIRMED, FP, UNCONFIRMED}`를 주며 유형별 값은 `{recognized_count, grade}`다. 0개면 grade=null, 확정·미확정은 1/2/3/4개 이상에 A/S/SS/SSS, FP는 최대 A다. 이번 미인정 여부나 누적 매칭 수로 현재 등급을 계산하지 않는다. 재도전·공개 처리 후 세션을 다시 조회해 최신 요약을 받는다. 재전송이 돌려준 과거 결과 스냅샷으로 최신 요약을 덮어쓰지 않는다(RES-01·10, GRD-01~08).

개인 히스토리 응답 제안은 `kind=analysis_history`, `history_id`, 당시 `submission_result`, 별도 `answer_viewed`, `current_publication`이다. `submission_result`의 원본·파생값·당시 결과는 불변이며 열람 여부·현재 공개 상태는 가변 부가 정보다. P0 기록에는 `centroid_data_status=unavailable`을 서버가 보존해 재현한다. 이 값은 사용자 근거 입력이 아니다(RES-06, HIS-02).

매칭 후 오판 상세는 방금 매칭한 신호를 설명한다. not_matched·none_wrong 힌트는 **제출 곡선의 미제거·탐색 가능 신호** 중 하나이며, 누적 매칭 집합으로 힌트를 소거하지 않는다. 대상이 없으면 상세 보기를 비활성화한다. ambiguous_match는 특정 신호를 고르거나 성과·단계를 전진시키지 않는다.

## 7. 재전송·잔차·재도전

- 같은 사용자·같은 동작의 동일 `request_id` 재전송은 기존 처리 결과를 반환한다. 같은 키의 다른 입력은 `IDEMPOTENCY_CONFLICT`로 거절하는 안이며 보관기간·처리 중 응답은 Q3에서 결정한다. 통신 실패를 이유로 즉시 새 ID로 재제출하지 않는다.
- 다시 풀기는 원본의 Bundle·제출 전 곡선·제거 집합·입력·표시 상태를 편집 초안으로 돌려준다. 이 동작만으로 새 Submission·History·성과를 만들지 않는다. 사용자가 제출할 때 새 요청 ID와 새 기록을 만들며 이전 제출 참조를 남긴다.
- 구 Bundle이 만료되거나 해당 복원이 불가능하면 명시적 오류를 돌려준다. 최신 Bundle로 조용히 바꾸지 않고 누적 진행도 유지한다. 만료 기간은 이 초안에서 정하지 않는다.
- 잔차 작업은 `QUEUED → RESIDUAL_CALCULATING → RESIDUAL_READY → PERIODOGRAM_CALCULATING → COMPLETED/FAILED`. 캐시 적중은 바로 COMPLETED 가능하다. 작업 응답은 `job_id`, `source_submission_id`, `source_curve_context`, 목표 제거 집합·버전, `failure`, `result_curve_context`를 제공한다.
- 서버는 제거 집합이 본인이 매칭한 같은 Bundle의 신호인지 검증한다. 과거 단계 재도전은 복원된 단계에서 출발한다. 잔차 실패가 제출 성공·누적 매칭·완료·성과를 취소하지 않으며 마지막 정상 곡선을 유지한다.

## 8. 선택 공개와 통계

검토 요청은 등록이 아니다. 공개할 수 있는 기록·공개할 필드·대상 신호를 보여준 뒤 사용자가 개별/모두 게시를 요청한다. 같은 신호의 대표값 기본은 최신 미공개 제출이고, 과거 기록 선택과 공개 가능 여부는 구분한다. 검토 후에도 소유권·미확정 자격·고유 신호·TIC·숨김을 게시 시점에 다시 검사한다.

첫 유효 공개 성공 시 공식 스레드 하나를 SYSTEM이 확보한다. 관리자 로그인 계정을 생성 조건으로 두지 않는다. 분석 목록 등록·신호별 최초 성과는 원자적으로 처리하며 자동 Comment·PostReaction을 만들지 않는다. 일반 Post의 태그나 첨부는 이 API 호출을 대신하지 않는다.

일괄 요청은 `items`에 각 `history_id`의 PUBLIC/FAILED와 실패코드·재시도 가능 여부를 돌려준다. 성공분만 성과·통계를 반영하고 등급별 별 열림은 순차 개별 공개와 동등해야 한다. **동일 요청 ID 재전송은 당시 응답 재현**, 실패분의 명시적 재시도는 **새 요청 ID+실패한 History ID만** 보내는 안이다. 동일 History의 공개 기록은 하나이므로 결과 수신 실패·동시 요청에서도 중복 등록/성과가 없어야 한다.

`author_public`과 `moderation_hidden`, `thread_hidden`은 독립이다. 실제 공개 가능 상태는 세 조건을 함께 계산한다. 공개 취소·운영 숨김은 기존 성과·개인 History·탐색 완료를 회수하지 않는다. 운영 복원은 본인이 취소한 공개를 다시 켜지 않는다. 숨긴 공식 스레드의 새 공개·대체 자동 생성은 금지한다.

미확정 통계는 실제 공개 가능한 기록 중 사용자×고유 신호의 최신 **서버 제출 시각**, 동률이면 `submission_sequence`로 한 건을 고른다. 게시 시각은 순서 기준이 아니다. 취소·숨김 이후 이전 유효 공개 기록으로 되돌아가며 없으면 해당 사용자를 제외한다. 세 판단 모두 분모에 포함하고 0명일 때 비율은 null이다. 필터는 목록만 바꾸고 동일 신호 통계의 분모는 유지한다. 이 API에는 개인 기록·참여자별 비공개 판단을 넣지 않는다.

결과 카드 조회는 본인의 매칭 제출에서 신호를 결정한다. 채점형은 `basis=LATEST_SUBMISSION_PER_CREDITED_USER`로 성과 인정 참여자의 최신 제출 판단, 미확정은 `LATEST_ELIGIBLE_PUBLIC_SUBMISSION_PER_USER`로 위 공개 기록 통계를 제공한다. 반환 필드는 `candidate_id`, `basis`, `as_of`, `participant_count`, 세 판단의 `counts`·`percentages`, `empty_message`다. 공식 스레드가 아직 없어도 미확정 결과 카드에는 N=0을 제공할 수 있으나, 이미 숨긴 스레드의 접근 차단을 우회하는 경로로 사용하지 않는다. 동일 신호·집계 시각의 공개 통계는 결과와 커뮤니티 조회가 일치해야 한다. 채점형 통계의 0명 문구는 `성과 인정 참여자가 없습니다`로 구분한다. 두 분포는 일반 글의 동의·비동의와 무관하다.

8/4/3명이면 N=15, 표시 비율은 53.3/26.7/20.0%다. 소수 첫째 자리 반올림은 Mock 표시 제안이며 원본 인원과 분모가 권위 있는 값이다. 일부 분포에서 반올림 합계가 100.0%와 다를 수 있으므로 표시 보정 방식은 협의한다. 기존 채점형 인정 참여자 분포와 이 공개 분석 통계를 섞지 않는다.

## 9. 미확정 사항과 협의 순서

| ID | 질문·현재 초안 | 협의 담당·시점 |
|---|---|---|
| Q1 | 브라우저 제공 DTO와 서버 내부 후보표/모델 경계, 실제 파일 형식·전 점 샘플·단위·선택용 봉우리 정보 | 데이터·코어 백엔드, 실제 데이터 연결 전 |
| Q2 | 주기 min/max/step, 위상 선택 최소·최대 폭, 관측 공백 허용, float 허용 오차 | 데이터·코어 백엔드·프론트, 입력 검증 확정 전(DEC-19) |
| Q3 | 엔드포인트·HTTP/에러 표준, 동일 ID 처리 중·보관기간·payload 충돌·수신 여부 조회 | 두 백엔드, API 연동 전 |
| Q4 | 잔차 상태 전달 방식(초안은 GET 조회), 재시도 작업 ID, 구 Bundle 만료와 부분 결과 표시 | 코어 백엔드·데이터·인프라, 잔차 연동 전(DEC-35) |
| Q5 | 게시 검토 화면·공개 서비스 담당, 신호별 최초 등록/성과 트랜잭션, 재분류 이후 새 공개 자격 | 서비스/코어 백엔드·하서진·백지웅, 공개 연동 전 |
| Q6 | 숨김·타인 기록 접근의 외부 오류 표기(초안은 내용 없이 RESOURCE_UNAVAILABLE), 목록 페이지·출처 링크 계약 | 서비스 백엔드·하서진, 커뮤니티 연동 전 |

지금 가능한 작업은 이 계약의 구조 검토, Mock 결과 화면, 브라우저 위상 접기·선택 조작이다. 계산 언어·캐시 제품·P1 전체 통계·모든 매칭 임계값 확정을 화면 골격의 선행조건으로 두지 않는다. 실제 데이터 계산 일치·보상·권한은 서버 연동 후 별도 검증한다.

## 10. 후속 예시와 작업 이력

이 커밋은 API 계약과 화면 상태 모델을 먼저 기록한다. 합성 요청·응답 예시와 정적 검증기는 후속 커밋으로 추가한다. 서비스 API·브라우저·DB·실제 BLS 테스트는 실행한 것이 아니다.

Jira 정리 후 브랜치·미푸시 커밋 메시지에 실제 작업 키를 적용하고 리뷰한다. 원격 푸시·MR 생성은 별도 진행한다.
