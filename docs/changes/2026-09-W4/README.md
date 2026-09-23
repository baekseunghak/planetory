# 2026년 9월 4주차 변경 이력

기간: 2026-09-21 ~ 2026-09-27

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 일별 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | 반복 제거 8개 재실행 검산과 병합 상태 정정 | S15P21C206-111 | 2084018, dirty=false, 1127곡선, QA 377 | 실측 검산 완료·채택 리뷰 전 | [기록](2026-09-21.md) |
| 2026-09-21 | 반복 제거 상세 집계·122 인계 및 검산 첨부 준비 | S15P21C206-111 | direct alias, QA 949, 복수 실패 107, review ZIP | 리뷰 준비 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 114 최신 develop 통합·Gold QA 상태 정정 | S15P21C206-114 | 2c1c857, 119 보존, NULL, e8f62ea | 문서·검증 완료, MR 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 120 공용 BLS·확정 게이트와 진단 계약 | S15P21C206-120 | poc_linear20k, snr7_sde6, Sector, mask | 구현·합성 검증 완료, 실제 회귀 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 120 실제 4별·320곡선 회귀 통과 | S15P21C206-120 | 24dc68f1, 336신호, 해시52 | 실제 검증 완료, 통합·리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 반복 QA 0 산포 반환·다른 후보 깊이 측정 실패 처리 | S15P21C206-111 | other_depth_not_measurable, overlap, 108+93 | 코드 검증 완료·재실측 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | QA 수정 후 8개 실측 검산·리뷰 자료 갱신 | S15P21C206-111 | c68c1e2, 1127, other_depth 73, 가짜 15→12 | 재리뷰 준비 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 재리뷰의 122 인계 실행 코드·QA 규칙·최신 첨부 정정 | S15P21C206-111 | b390147, c68c1e21, other_depth_not_measurable 73 | 정정·최종 승인 대기 | [기록](2026-09-21.md) |

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 일별 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | 공개 상태 응답 호환·공통 조건 배치 규칙 보완 | S15P21C206-162 | isPublic, isEffectivelyPublic, domain, deleted | 전체 409건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | develop 테스트 컴파일 복구와 변경 이력 위치 정정 | S15P21C206-147 | ResidualResultReader.lookup, PublicAnalysisTest, 스텁 인자, 병합 후 컴파일 | 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 제출 조회·상세 보기·다시 풀기 초안 구현 | S15P21C206-145 | submissions, by-request, REQUEST_IN_PROGRESS, detail-view, DETAIL_UNAVAILABLE, retry-draft, STEP_NOT_RESTORABLE, AT-118 | 구현 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 제출 조회 리뷰 반영: 해설 자리와 힌트 대상 고정 | S15P21C206-145 | signal.explanation, detail_target_candidate_id, V17, 멱등 힌트 | 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 리뷰 반영: 겹친 상세 보기 응답을 저장된 대상으로 맞춤 | S15P21C206-145 | 상세 보기, detail_target_candidate_id, RETURNING, 겹친 요청, 힌트 대상, explanation null | 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 리뷰 반영: 빈 해설을 프론트가 받아 안내로 채움 | S15P21C206-145 | signal.explanation, decodeDetailView, nullable, 대체 안내, 6.7절 예시 | 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | HDFS marker 권한 경계 수정·Sector 7 확정 | S15P21C206-76 | stdin, UMask, immutable release, atomic rename, Sector 7 | 구현·Sector 7 검증 완료, 전체 적재 진행 중 | [기록](2026-09-21.md) |
| 2026-09-21 | Sector 1~13 완료 정정·HDFS 감사 경계 강화 | S15P21C206-76 | coverage, total_bytes, full audit, completion marker, CI | 실환경 완료·방어 코드 오프라인 검증 완료, MR 재리뷰 대기 | [기록](2026-09-21.md) |

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 일별 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | 검색 검증기 미정 입력·정렬·인계 경계 보완 | S15P21C206-170 | UNSPECIFIED, Date.parse, 합성 분포, 217, 218 | 표본 검증 완료·교차 검토 대기 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 지도 검색·A13 필터 입력 계약 | S15P21C206-223 | discovered, submitted, locate, starFilters | 일부 구현·소비자 연결 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 기본 피드·공식 스레드·공개 분석 조회와 별 접근 차단 | S15P21C206-164 | SYSTEM, cursor, REPEATABLE_READ, contributesToSummary, 공개 Graph, 442건 | 구현·백엔드 회귀 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 특정 별 기본 피드의 board=STAR 요청 호환 | S15P21C206-164 | ticId, board=STAR, 400, 커서 동치, 프론트 계약 | 구현·대상 회귀 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | TESS Raw 1~13 Sector Bronze 변환 | S15P21C206-77 | Spark, Bronze, Parquet, error contract, atomic rename, systemd | 구현·Sector 1~13 변환·전체 재감사 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | Bronze 영구 데이터 오류 재시작 차단 | S15P21C206-77 | terminal_failed, exit 65, RestartPreventExitStatus, staging attempt | 구현·오프라인 검증 완료, 재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 시제품 기준 기존 P0 화면 배치·디자인 정합화 | S15P21C206-248 | 전체 은하, 접는 퀘스트, 프로필, 커뮤니티, Chrome 145 | 구현·로컬 검증 완료, 리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 크기 변경 시 별 상세 상태 유지·시제품 일치 범위 정정 | S15P21C206-248 | 1×1 캡처, DesktopGate, 상태 보존, Chrome 66+31, 상세 이식 미완료 | 오류 검증 완료·디자인 진행 중 | [기록](2026-09-21.md) |
| 2026-09-21 | 공개 판단·챌린지 참여 수 공통 조건과 소비 계약 | S15P21C206-165 | 최신 유효 공개, 동률 ID, N=15, COUNT DISTINCT, REPEATABLE_READ, asOf | 전체 437건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 리뷰 반영: 별 결과 페이지 통계 기준 명확화 | S15P21C206-165 | 146, answerClass, judgmentStatistics, graded, public_analyses | 채택·문서 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 일반 글 반응 최종 상태·커서·상세 합계·V16 최소 권한 | S15P21C206-163 | post_reactions, NONE, 삭제 경합, 최신 닉네임, V16 | 전체 442건 검증 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 공식 스레드 네 수치 공개와 오류 계약·예제 정합화 | S15P21C206-164 | COM-17, signal, N=0, STAR_NOT_PUBLISHED, README 충돌 | 정책 채택·문서 보완 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | Bronze manifest 영구 오류 전달 누락 정정 | S15P21C206-77 | manifest, _TERMINAL, terminal_failed, exit 65, spark-submit | 구현·오프라인 검증 완료, 재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 공개 첨부 모드별 대체 안내·작업 재조회 정정 | S15P21C206-213 | 191, SUBMITTED, fallbackReason, jobId, lastMeta, Chrome 14 | 로컬 검증 완료·리뷰 전 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 120 develop 통합 테스트 중복 정리 | S15P21C206-120 | holdout, monkeypatch, 111 passed | 통합 테스트·호출 경로 확인 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 120 전체 마스킹 Sector 진단 보존 | S15P21C206-120 | sector_stats, not_evaluated, 99 passed | 수정·검증 완료, 재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 잔차 503의 원인 구분(retryable)과 미연결 안내 문구 | S15P21C206-249 | 잔차, 503, DEPENDENCY_UNAVAILABLE, retryable, START_FAILED, 미연결, 재시도, 7.1, 2.3 | 구현 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 잔차 503 리뷰 반영: 문구 정본과 분기 시점 | S15P21C206-249 | retryable, 문구 정본, 배포 순서, failure.retryable | 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 112 후보 감사·실제 두 Sector 구성 비교 | S15P21C206-112 | candidate identity, TOI270, 0.5 duration | 초기 실측·미승인 | [기록](2026-09-21.md) |
| 2026-09-21 | 112 감광 창 진단 100건·자동 병합 미채택 | S15P21C206-112 | conditional depth, possible_alias, incomplete, 44 passed | 실험 완료·규칙 미승인 | [기록](2026-09-21.md) |
| 2026-09-21 | 112 4별·추가 배율 비교 및 계약 검토안 v1 | S15P21C206-112 | possible_alias, 0.5 duration, 50 passed | 실험 완료·계약 미승인 | [기록](2026-09-21.md) |
| 2026-09-21 | 112 동일성 대칭성·원시 후보 보존·판 내부 모호성 우회 차단 | S15P21C206-112 | candidate_identity_v2, 59 passed | 실험 검증·계약 미승인 | [기록](2026-09-21.md) |

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 일별 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | 112 v3 공통 계약·정확한 모델 중복·동등성 실험 한계 | S15P21C206-112 | candidate_identity_v3_review, 69 passed, 0.25ppm | 계약 리뷰 준비·운영 자동 병합 미채택 | [기록](2026-09-21.md) |
| 2026-09-21 | 같은 별 공개 출처 저장·미리보기·무효 안내 | S15P21C206-167 | sourceLinks, available:false, V17, 출처 카드 | 구현·관련 검증 완료 | [기록](2026-09-21.md#s15p21c206-167-같은-별-공개-출처-카드와-비공개-안내) |
| 2026-09-21 | 전체 공개 집합 기반 핫 토픽·순위 커서와 동일 스냅샷 | S15P21C206-171 | COUNT DISTINCT, N>=10, hot-v1, REPEATABLE_READ, 전역 순위, 기존 인덱스 | 구현·관련 52건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 화면이 잔차 503을 retryable로 가른다 | S15P21C206-189 | retryable, DEPENDENCY_UNAVAILABLE, 정본 문구, START_FAILED, 개발용 응답, 화면 검사 | 구현 완료·실제 API 인수 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 현재 챌린지 조회·active 회차·자격 TIC·별 참여 수 | S15P21C206-168 | challenges/current, REPEATABLE_READ, GET 불변, COUNT DISTINCT | 구현·관련 54+6건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 프론트 기준 팔로우 소비 계약 | S15P21C206-219 | P1, 팔로우, 시제품 | 구현·교차 리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | CI 레지스트리 자체 호스팅·amd64 빌드 노드 분리 | S15P21C206-226 | registry, tailscale cert, REGISTRY_IMAGE_PREFIX, amd64-docker, privileged, extra_hosts, binfmt 제거, D4 충돌 | 레지스트리 검증 완료, Runner 등록 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | D4 범위 한정과 외부 관찰 EC2-B 이관 | S15P21C206-226 | D4, EC2-B, CI 빌드 노드, 외부 관찰 이관, 인계 100, 같은 AZ 한계, ap-northeast-2a | 채택, 관찰 구현 미완 | [기록](2026-09-21.md) |
| 2026-09-21 | 배포 노드 Docker 준비와 이미지 위생 도구 | S15P21C206-226 | install-docker-host.sh, docker-compose-v2, image-secret-scan, registry-prune, digest 공유 삭제, 가비지 수집 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | 배포 접속을 SSH 키 없이 tailnet 신원으로 전환 | S15P21C206-226 | Tailscale SSH, 22번 가로챔, ACL ssh 규칙, deploy 계정, sudo 없음, DEPLOY_SSH_KEY 폐기 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | MR 리뷰 지적 4건 수정과 검증 방식 정정 | S15P21C206-226 | MR !132 리뷰, GC 중 push, docker save 레이어 검사, config 블롭 created, set -e 알림 침묵, 스텁 우회 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | 출처 카드 리뷰 수정과 V18 마이그레이션 충돌 해소 | S15P21C206-167 | 교차 댓글 교착, 일괄 조회, REPEATABLE_READ, 출처 제거 재조회, 145 V17 선행, V18 | 검증 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 당시 배열이 없는데 그대로라고 말하던 안내 수정 | S15P21C206-190 | snapshot null, RETIRED_CANDIDATE, SUBMITTED 배지, 모순 문구 | 구현·검증 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 공개 History 그래프의 범위와 현재 상태 정리 | S15P21C206-191 | 8.5 공개 투영, 허용 목록 파서 불필요, lastMeta 이력, RESIDUAL_NOT_AVAILABLE 공개 전용, 공개 분석 어댑터 미연결, 두 계정 인수 미결 | 문서 확정·어댑터/인수 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 공개 분석 진입 어댑터 연결과 공개 소비 경계 공유 | S15P21C206-191 | public-analyses 상세, 공개 소비 경계, jobId 거절 공유, includeGraph=false 재조회, 두 계정 인수 미결 | 구현·검증 완료·인수 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 상세 해설 안내 문구 방향 정정과 해설 표시 검사 보강 | S15P21C206-145 | explanation, 위 비교표, explained 사례, x-fixture-outcome, 안내 문구 | 구현 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 대표 후보와 항목별 독립 일괄 공개 | S15P21C206-166 | batch, 20개, 부분 성공, NOT_PUBLISHED, 대표 후보, 독립 트랜잭션 | 구현·관련 117개 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 일괄 공개 리뷰 보완·후보 보장 범위 | S15P21C206-166 | 로그 스택, TIC_MISMATCH, CommunityQuery, 스냅샷, History 단위 후보 | 관련 81건·추가 46건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 내 별 목록 필터와 별 위치 찾기 구현 | S15P21C206-152 | stage, grade, ticId 필터, 커서 묶기, gradeRange, me/sky/locate, STAR_LOCKED | 구현 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 별 목록 조회의 트랜잭션 누락 정정과 스냅샷 계약 명시 | S15P21C206-152 | REPEATABLE_READ, 자기 호출, 프록시, 오버로드, STAR_LIST_PRIVATE, 스냅샷 | 구현 완료·재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 별 결과 페이지 구현과 8.4절 구현 규칙 | S15P21C206-146 | stars/result, DEC-28, remainingDiscoverableCount, judgmentStatistics, nextActions, PUBLISH_ALL | 구현 완료·교차 리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 127 Bronze 표본 커널 연결·비교·재실행 준비 | S15P21C206-127 | Worker, input_sha256, retry, 19 passed | 오프라인 검증, 실제 YARN 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 127 실제 Worker 수치·실패 TIC 재실행 검증 | S15P21C206-127 | YARN 0023~0026, PYTHONPATH, HADOOP_CONF_DIR, 20 TIC | 표본 검증 완료·리뷰 전 | [기록](2026-09-21.md) |
| 2026-09-21 | MR 단계 컨테이너 이미지 빌드 검증 추가 | S15P21C206-84 | web:image, nginx -t, host not found in upstream, dind | 구현 완료·파이프라인 미실행 | [기록](2026-09-21.md) |
| 2026-09-21 | EC2-A 계정 분리 적용과 CI push 차단 원인 규명 | S15P21C206-84 | planetory_service, DATABASE_PASSWORD, DEPLOY_AUX_DIR, registry push timeout, UFW, tailscale0 | EC2-A 적용 완료·EC2-B 조치 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-22 | MR 단계 마이그레이션 검사가 실행되지 않던 결함 수정 | S15P21C206-84 | alpine/git, ENTRYPOINT, entrypoint 비우기, backend:schema, V19 선점 | MR 파이프라인 통과 확인 | [기록](2026-09-22.md) |
| 2026-09-22 | 검증 경계 정정 — 로컬 실행과 CI 실행 구분 | S15P21C206-84 | 로컬 통과, CI 미실행, 실행 위치 명시 | 정정 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | Runner 동시 실행 3으로 상향·Runner 대수 정정 | S15P21C206-84 | concurrent, concurrent-0 슬롯, 202초→126초, run_untagged, vCPU 4 | 적용·실측 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 백엔드 CI 이미지 배포와 계정 분리 완료 | S15P21C206-84 | deploy:backend:ec2-a, V9→V19, planetory_service, pg_dump, BACKEND_IMAGE 어긋남 | 배포·검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | MR !161 리뷰 지적 8건 반영 | S15P21C206-84 | V19 REVOKE, 변경 파일만 검사, down --remove-orphans, 502→401, resource_group, record_image, member_sky_revisions | 수정·검증 완료·재리뷰 대기 | [기록](2026-09-22.md) |
| 2026-09-21 | 팔로우 대상·중복 제거 피드·구독 사건·173/174 인수 | S15P21C206-172 | COM-16, DEC-33, AT-78, AT-79, matchedBy, 멱등성, DEC-11 | 제안·정책 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 179 탈퇴 초안과 팔로우 접근 의존성 교차 검토 | S15P21C206-172 | W2, W3, W5, Q3, WD-12, star_unlocks, P16 | 제안·공유 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | MR !155 리뷰: 회원 재개·공통 원인·사건 복구·관계 해제 | S15P21C206-172 | 150, 174, eventId, occurredAt, P17, COM-13 | 검토안 보완·승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 122 반복 탐색·QA·후보 ID 연결 | S15P21C206-122 | iteration, rollback, candidate_catalog, BIGINT, 보류, removal_step, 170 passed | 구현·로컬 검증·리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 122 Publisher 필드별 인계 보완 | S15P21C206-122 | is_confirmed, 116·124, SDE/SNR Silver 진단, 열 투영, alias 책임 | 문서 보완·재확인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 122 실제 진단·원본 SNR 종료 기록 보완 | S15P21C206-122 | baseline_time, search_diagnostics, original_validation, 207 passed | 수정 검증·develop 통합 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 마이페이지 내 별·분석 기록 목록 연결 | S15P21C206-196 | 프로필 슬롯, 커서에 size 묶임, unpublishedSignalCount 없음과 0, detailAvailable, StrictMode 두 쪽 읽기 | 구현·검증 완료·실제 API 인수 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 근거 구간 마스킹·원본 행 장부 | S15P21C206-245 | interval mask, QUALITY, DRN4, DR42 | 구현·로컬 검증·리뷰 전 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 후보 병합·분리 정정 계약과 C19 수행 범위 고정 | S15P21C206-153 | 후보 병합, 분리, retired, GRD-06, DEC-26, C18-Q1~Q6, gold_writer 권한, 사전검사 | 결정 요청 초안·교차 검토 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 후보 정정 영향 사전검사 명령과 런북 | S15P21C206-154 | candidate-correction-precheck, dry-run, 사전 거절, 종료 코드 0/2/3, S2, S3, 읽기 전용 | 구현 완료·적용 절차 미착수 | [기록](2026-09-21.md) |
| 2026-09-21 | 정정 계약 리뷰 반영: 확정·제안 분리와 복구·역할 정정 | S15P21C206-153 | GRD-06 재계산, 제안과 확정, status 복구 불가, gold_writer SELECT 없음, 역할 분리 | 리뷰 반영 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 발견한 별 유지를 확정에서 미확정(C18-Q7)으로 | S15P21C206-153 | C18-Q7, star_unlocks, GRD-06, S4, DEC-26, 근거 철회 | 결정 요청 초안 | [기록](2026-09-21.md) |
| 2026-09-21 | 정정 계약 승인 조건의 보존 강제 해제와 실행 문턱 셋 정리 | S15P21C206-153 | C18-Q1, C18-Q2, C18-Q4, 승인 조건, retired, 실행 문턱 | 결정 요청 초안 | [기록](2026-09-21.md) |
| 2026-09-21 | 결과 페이지 리뷰 반영: 유효 공개 조건·일괄 공개 후보·은퇴 대상 | S15P21C206-146 | unpublishedSignalCount, PublicAnalysisVisibility, PUBLISH_ALL, RETRY, CANDIDATE_RETIRED | 구현 완료·재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 112 v3 소비자 인계 보완 | S15P21C206-112 | 재개, newDiscoverableCount, candidate_aliases, retired 공개물, removal_step, tolerance | 문서 보완·승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 봉우리와 미세 조정 범위(5.4절)와 미결 5 제안 | S15P21C206-141 | candidate-peaks, 최소 간격 2h+1, 고조파 허용 오차 h, peakRuleVersion, suggestedDurationHours | 구현 완료·규칙 제안 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 리뷰 반영: 고조파 판정을 주기 값으로, 간격 근거를 정책으로 | S15P21C206-141 | 고조파 반올림 결함, 2h+1 근거, peakRuleVersion 조건, BLS 제안값 계약 | 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 245 !158 NumPy JSON·최적화 모드 검증·153 기록 보존 | S15P21C206-245 | numpy scalar, python -O, assert | 로컬 검증·재리뷰 대기 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 통계 지표 사전·시간 경계 권장안·177/178 인수 | S15P21C206-176 | 첫 매칭, 10분 MV, 90일, 중앙값, null, asOf, 멱등, 탈퇴 | 제안·문서 검산 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 통계 리뷰 보완: AI 원천·지표 상태·현재 완료·검산 10개 | S15P21C206-176 | threshold_version, AI_ATTEMPT_UNKNOWN, Sector, duplicate, ST-17~26 | 제안·문서 검증 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | DEC-11 탈퇴 데이터 결정표·180 인수 준비 | S15P21C206-179 | 탈퇴, 보관기간, 익명화, 재가입, W1~W5, FE222, 세션, 현재/과거 통계 | 제안·승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 179 리뷰: 재현 필드·처리 안내·백업/세션 현황 보완 | S15P21C206-179 | MR154, 재계산, snapshot_params, T/C, 백업 없음, HttpSession, 철회 상태 | 제안·승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 172·176·179 정책 문서 병렬 변경 충돌 해결 | S15P21C206-172 | follow-policy, statistics-policy, AT-77, AT-78, AT-79 | 문서 통합·정책 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 커뮤니티 검색·공식 네 수치 본문 동기화 | S15P21C206-169 | searchIn, JS trim, SHA-256, pg_trgm, V19, 공식 요약, 10만 행 | 구현·격리 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 169 리뷰 반영·후보 요약 격리 검증 | S15P21C206-169 | MR !156, READ COMMITTED, 25000, N=0, BTJD, 540건, FE 빌드 | 수정·격리 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 122 !160 develop 통합·실제 진단 최종 검증 | S15P21C206-122 | 205 passed, 184 passed, 16곡선, search_diagnostics, review-122-r2 | 검증 완료·병합 commit 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 사전검사 재리뷰 반영: develop 통합과 승인 문턱·재실행 문구 | S15P21C206-154 | 6장 충돌, 문턱 셋, 제출 제외, 읽기 전용, 재실행 건수 | 구현 완료·재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 제출 매칭 null 계약과 111 부분 검산 | S15P21C206-128 | suggestedDurationHours, 549, N 상한, rule-1 | 부분 검증 완료·정책 미확정 | [기록](2026-09-21.md) |
| 2026-09-21 | 매칭 기존 승인·관측 통과 분모와 실제 재생 준비 | S15P21C206-128 | P_mod, observedTransits, matching_replay, 21 tests | 구현·합성 검증 완료, 실제 실행 전 | [기록](2026-09-21.md) |
| 2026-09-21 | 실제 매칭 재생과 거절 사유 검산 | S15P21C206-128 | 3e9bf8ea, 534/549, 527/549, 86 hashes | 재생·검산 완료, rule-1 미확정 | [기록](2026-09-21.md) |
| 2026-09-21 | rule-1 수치안·공동 fixture·소비자 인계 | S15P21C206-128 | 47 fixtures, 10980 rows, rule-1 | 채택안 검증 완료·v1 확인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | AstroNet 운영 채택 최종 보류 결정 | S15P21C206-118 | FP/FN, checkpoint, 126, 130, 내부 검토 | 팀 최종 보류 결정 반영 | [기록](2026-09-21.md) |
| 2026-09-22 | 개인 통계·첫 매칭 통합·현재 완료·과거 본인값 자료 부족 | S15P21C206-177 | KST, 8주, sourceObservedAt, MISSING_BASIS, 112 tests | 개인 구현·격리 검증 완료, 178 통합 별도 | [기록](2026-09-22.md) |
| 2026-09-22 | 별도 Redis 세션 저장·30분 idle·장애 경계 | S15P21C206-237 | Spring Session, Redis, TTL, stale save, OAuth, 503, 1MiB | 구현·격리 통합 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 전체 MV·일별 비교·원천 관측 시각·최소권한 | S15P21C206-178 | V21, NULLS NOT DISTINCT, sourceObservedAt, AI_ATTEMPT_UNKNOWN, 158건, V19→20→21 | 사용자 승인·격리 통합 검증 완료, 운영 미적용 | [기록](2026-09-22.md) |
| 2026-09-21 | 10분 비닝 커널과 revision 연결 | S15P21C206-123 | mean, gaps, revision, 225 tests | 부분 구현·합성 검증 완료 | [기록](2026-09-21.md) |
| 2026-09-22 | 제공 해상도 discoverable 실험 준비 | S15P21C206-115 | 10분, 5000, 발견 단계, revision | 구현·합성 검증 완료, 실측 전 | [기록](2026-09-22.md) |
| 2026-09-22 | discoverable 9별 실측 검산 | S15P21C206-115 | 2fb9d38f, 35/36, 4/9, 191 hashes | 실측 완료·규칙 승인 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 115 !165 최종 테스트 합계 정정 | S15P21C206-115 | 221 passed·1 skipped, FITS 있는 환경 222 passed, 123 후속 | 문서 정정·로컬 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 123 제공 해상도 판정·격자 비교 준비 | S15P21C206-123 | 1.15, null 전체 보류, revision, 248·225 passed, V20 | 로컬 검증·FITS 실행 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 123 9별 FITS 비교 검산 | S15P21C206-123 | 36곡선, 168 hashes, 49단계, 29/30, 변화 0 | 실측 검산·리뷰 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 123 조건부 리뷰 보완 | S15P21C206-123 | retired bool, 진입점, 253 passed, bin 중심 후속, Inf | 수정·로컬 검증, 후속 등록 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | POST 접수와 GET 복구 검증 분리 | S15P21C206-187 | 복구, 프런트엔드, 회귀 검사 | 구현·로컬 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 팔로우 관계·피드·비공개 관계 관리와 V20 | S15P21C206-173 | follows, matchedBy, relationId, 탈퇴, V20, FE219 | 구현·격리 검증 완료, 프론트/배포 별도 | [기록](2026-09-22.md) |
| 2026-09-22 | 173 리뷰: 공개 조건 공통화·커서 수명 제약 제거 | S15P21C206-173 | StarBoardVisibility, follow-v2, HMAC 제거, 정규 인코딩 | 채택·구현 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 로그아웃 CSRF 면제 제거·새 토큰 반복 계약 | S15P21C206-234 | logout, CSRF, 204, 403, 만료, 실제 HTTP, Chrome | 구현·격리 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 234 문서 정정·237 health/오류 경계·리뷰 보완 | S15P21C206-237 | Redis, health, 익명 CSRF, 84, 충돌 | 구현 완료 | [기록](2026-09-22.md) |

| 2026-09-22 | MR !170 역할 사전 생성·독립 검증·충돌 해소 | S15P21C206-178 | CREATEROLE, V21, 코호트, 630건 | 격리 검증 완료 | [기록](2026-09-22.md#s15p21c206-178-mr-170-역할-프로비저닝독립-검증충돌-해소) |
| 2026-09-22 | History 스냅샷 누락과 일시적 오류 복구 | S15P21C206-190 | 복구, 프런트엔드, 회귀 검사 | 구현·로컬 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 재도전 Q05 결정·응답 파서 | S15P21C206-192 | retry-draft, 초안, 시각 기준 | 부분 구현·기준 확인 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 현재 판 재도전 연결·Gold 중앙 시각 정합화 | S15P21C206-192 | retry-draft, bin center, 초안, requestId, 관측 창 | 프론트·로컬 검증 완료, 실제 API 인수 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 공개 검토·부분 실패·공개 취소와 재공개 연결 | S15P21C206-195 | batch-candidates, visibility, 영수증, 응답 유실 | 로컬 검증·실제 API 인수 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 195 누적 실패 20개 상한·중복 발견 표시 보완 | S15P21C206-195 | retryable, batch, 21개, newlyGranted | 로컬 검증·실제 API 인수 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 별 결과·History·공개 검토 연결 | S15P21C206-193 | curveSteps, 신호·제출, publication, star 쿼리 | 로컬 검증 완료·실제 API 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 별 결과 계산 중 잔차 상태 파서 수정 | S15P21C206-193 | residualStates, RESIDUAL_READY, 중간 상태 | 로컬 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | !175 분류 변경 번역·검증과 0단계 명세 예시 정정 | S15P21C206-193 | relabel, dispositions, removedCandidateIds, 2.1, 6.3 | 로컬 검증·커밋 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 237 재리뷰: timeout 초 단위·변경 이력 정정 | S15P21C206-237 | DurationStyle, 1800, optional OAuth, 표 | 관련 10건 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 123 develop 충돌 해결·산포 migration V22 | S15P21C206-123 | b831cd8f, V20 follow, V21 통계 예약, V22 | 통합 검증·병합 커밋 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 123 Backend 리뷰 V22 단계·Publisher 인계 | S15P21C206-123 | 254 passed, READ COMMITTED, FOR SHARE, M1 인수 | Python 검증·DB 검사 미실행 | [기록](2026-09-22.md) |
| 2026-09-22 | 123 COMMENT migration 후속 분리 | S15P21C206-123 | V22 제거, 적용 순서, start_btjd, flux_scatter | 코드·문서 정리, 후속 인수 확인 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 개인 통계 리뷰: DB 시계·프로필 용어·비교 표시·develop 통합 | S15P21C206-177 | transaction_timestamp, HISTORICAL_SOURCE_UNAVAILABLE, 79c45f35 | 수정·68건 통합 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 탈퇴 정책 재확인·영수증 복구·완료 화면 전환 | S15P21C206-222 | POLICY_CHANGED, prepare, COMPLETED, 로컬 세션, Chrome25 | 프론트·로컬 검증 완료, 정책·제공자 확인 별도 | [기록](2026-09-22.md) |

- S15P21C206-195: [별 결과 통합과 공개 검토 왕복 검증](2026-09-22.md).

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 일별 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-22 | 제출 후 공개 검토 회귀 검사 정정 | S15P21C206-195 | analysis-submit, 실제 카드, 245 통과 | 로컬 검증 완료·커밋 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 정정 이력 형식·재실행·복구 보관 확정 | S15P21C206-154 | field 속성 이름, reason 코드, IS DISTINCT FROM, candidate_correction_jobs, undo JSONB | 문서 확정, Q1 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | C18-Q1 건별 승인 결정 반영·179 리뷰 조치 | S15P21C206-154 | 건별 승인, keep 인자 검증, status 열 UPDATE, Gold 12개 서술 | 결정 채택·문서 반영 | [기록](2026-09-22.md) |
| 2026-09-22 | 판 전환 재개 후처리·재개 사건 저장 | S15P21C206-150 | notifications reopen, V22, 부분 유일 인덱스, completed_at 유지, 647 passed | 구현·로컬 검증 완료, 공유 DB 적용 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 150 나머지 범위·9.5절 모순 정정 | S15P21C206-150 | 내부 진입점, 서비스 토큰, 잔차 캐시 정리, relabel 표식, 663 passed | 구현·로컬 검증 완료, Publisher 연동 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 150 리뷰 반영: 인증 우회·교착·정리 범위·표식 복원 | S15P21C206-150 | %69nternal, deadlock, PathPatternRequestMatcher, 지목 정리, 표식 복원, 667 passed | 수정·재현·회귀 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | OAuth 안전 진단·프록시 헤더 신뢰 경계 | S15P21C206-240 | OAuth, allowlist, 튜토리얼, 503, rollback, Forwarded, 84, 239, 40 passed | 구현·격리 검증 완료, 외부 인수 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 240·84 전달 헤더 중복 키 방지와 V7 안내 통일 | S15P21C206-240 | !161, properties, none, 중복 키, V7, bootstrap-0 | 설정 회귀 2건 통과 | [기록](2026-09-22.md) |
| 2026-09-22 | 240 공통 전략 framework 정정·프록시 인수 분리 | S15P21C206-240 | framework, HTTPS, 중복 키, 42 passed, 84 담당 조율 | 구현·격리 검증 완료, 외부 인수 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 84 framework 복원과 240 양방향 통합 확인 | S15P21C206-240 | 2b7c0153, framework, 설정 키 1개, 충돌 0 | 통합 정적 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 84 2차 리뷰 반영·develop 충돌 해소 | S15P21C206-84 | 선점 차단 복구, exit 1, 대조 범위 축소, 문자열 안 --, V21 절 이동, nginx 서술 정정 | 수정·검증 완료·승인 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 240 교차 리뷰의 프록시 기본값 none 통일 | S15P21C206-84 | !161, 240, forward-headers, 중복 키, 운영 활성화 | 설정 회귀 2건 통과 | [기록](2026-09-22.md) |
| 2026-09-22 | 84 전달 헤더 기본값 framework 복원 | S15P21C206-84 | framework, 240, d02d910e 정정, 중복 키 | 설정 회귀 2건 통과 | [기록](2026-09-22.md) |
| 2026-09-22 | 첫 방문 안내 전용 저장 계약과 분석 단계 연결 | S15P21C206-197 | onboardingDone, me/onboarding, 입력 보존 | 구현·실제 인수 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 외부 원천 수집·계약 검증 초안 | S15P21C206-116 | TCE, TOI, ExoFOP, Archive, snapshot | 수집 단위 검증·실제 대조 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 외부 수집 쿼리·실패 진단 보완 | S15P21C206-116 | rowupdate, subset, HTTPError | 14 tests·재수집 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 네 외부 원천 실측 감사 | S15P21C206-116 | checksum, epoch 기준, 18·22·8·18행 | 감사 완료·매칭 검증 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 외부 매칭 검토안·원본 실측 실행기 | S15P21C206-116 | direct, ambiguous, time standard, snapshot | 합성 50개·실측 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 원본 9별 외부 매칭 실측 | S15P21C206-116 | 6348c862, 직접3·미연결8·보류55 | 실측 검산·계약 승인 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 116 disposition 필수 열 인계 | S15P21C206-116 | pc/none, source_refs, applied_at, 빈 라벨 | 41 tests·재승인 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 116 최종 리뷰 승인·문서 정합화 | S15P21C206-116 | 41 tests, MR 첨부, 124 인계 | 리뷰 승인·병합 미확인 | [기록](2026-09-22.md) |
| 2026-09-22 | 알림 정책·90일 보관·150/175 인계 정합화 | S15P21C206-174 | F15, 수신자, 읽음, 보관, 중복, FE220·221, 재개 사건, 설정 기본값 | 정책 초안·90일 사용자 승인·나머지 계약 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 174 리뷰 반영: 선택적 reason·JSONB 키·최초 저장 시각 | S15P21C206-174 | F15.5, jsonb_strip_nulls, 표현식 인덱스, ON CONFLICT, created_at | 문서 보완·도메인 발생시각 계약 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 공개 은하 전체 보유별·성과 행성·철회 재검사 | S15P21C206-251 | public-sky, all-owned, public-v1, REQUIRES_NEW, 5000별, 성과1000, 개인개수차이 | 구현·격리 검증 완료, 244 실제 인수 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 공개 완료 표식의 의미·방문자 문구 정정 | S15P21C206-251 | completedWithoutPlanets, 공개 행성, FP 재라벨, 페이지 지문 비용 | API 15·프론트 단위 11·Chrome 5건 통과, 재리뷰 전 | [기록](2026-09-22.md) |
| 2026-09-22 | 공개 은하 후속 리뷰: 파싱 예외·A13 차이·집계 비용 | S15P21C206-251 | NumberFormatException, STAR_LIST_PRIVATE, 작은 limit, 반복 측정 제거 | 격리 API 15·컨트롤러 1건 통과 | [기록](2026-09-22.md) |
| 2026-09-22 | SDE 세 정의 비교 실행 준비 | S15P21C206-243 | global, running_median, log_bins, 고정 피크, 세 seed | 구현·실측 전 | [기록](2026-09-22.md) |
| 2026-09-23 | SDE 5별 실측 검산·문턱 검토안 | S15P21C206-243 | 3f1db3f8, 2240, 254/461, SDE 8 | 실측·검산 완료, 채택 미확정 | [기록](2026-09-23.md) |
| 2026-09-23 | 243 곡선별 손익·SNR 유지 제안과 재집계 자료 | S15P21C206-243 | 곡선별 손익, CM Dra 19, 전역 SNR 유지, review ZIP | 실험 검산 완료·채택 미확정 | [기록](2026-09-23.md) |
| 2026-09-22 | 외부 스냅샷·후보 조인 커널 | S15P21C206-124 | absence_evidence, 실제 ID, snapshot, disposition | 합성 검증 완료·실제 연결 미완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 122 후보 기반 외부 조인 회귀 준비 | S15P21C206-124 | fixture IDs, held_rows, reference_changes | 합성 검증 완료·연결 회귀 대기 | [기록](2026-09-22.md) |
| 2026-09-22 | 외부 카탈로그 후보 연결 696cda44 검산 | S15P21C206-124 | 18 IDs, 99 scenarios, 79 checksums, hold | 로컬 검증 완료·리뷰 대기 | [기록](2026-09-22.md) |
| 2026-09-23 | 외부 카탈로그 승인 리뷰 보완 | S15P21C206-124 | None TIC, 빈 합집합, hold 진단 참조 | 커널 300·bench 6개 통과 | [기록](2026-09-23.md) |
| 2026-09-21 | 프론트 단독 기동·OAuth 장애와 인증 실패 구분 | S15P21C206-239 | nginx, resolver, forwarded, service_unavailable, 503, 가짜401 | 로컬 검증 완료·업로드 전 | [기록](2026-09-21.md) |
| 2026-09-23 | 최신 develop 기준 OAuth 장애 분리·재검증 | S15P21C206-239 | 84 병합, 503 분리, API 상태 보존, Chrome, nginx | 로컬 검증 완료·리뷰 대상 | [기록](2026-09-23.md) |
| 2026-09-23 | prod 쿠키·격리 DB 중단 인증 실측 | S15P21C206-235 | Secure, SESSION, nginx, 500, 503, 239, Redis, 동일 포트 복구 | 14건 통과·1건 계약 실패, 운영 인수 별도 | [기록](2026-09-23.md) |
| 2026-09-23 | 인증 DB 트랜잭션 시작 실패의 503 경계 보완 | S15P21C206-235 | CannotCreateTransactionException, /me, OAuth, 503, 복구 | 수정·15건 검증 통과 | [기록](2026-09-23.md) |
| 2026-09-23 | 235 병합 후 OAuth 장애 콜백 기대값 정합화 | S15P21C206-239 | e510d1da, service_unavailable, TLS, 실제 DB, Chrome | 인증 15개·Chrome 14개 통과, MR 갱신 | [기록](2026-09-23.md) |
| 2026-09-23 | 175 Q1 수신 범위 승인·발행 인계 조사·재개 탈퇴 경합 보완 | S15P21C206-175 | notifications, Q1, A1~A5, 지연 커밋, 회원 잠금 | 부분 구현·24건 검증, 나머지 정책 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 175 정책·비소급 확정, 알림함·수신 의도·6종 설정 | S15P21C206-175 | V23, outbox, OFF 세대, 서명 경계, RELABEL | 부분 구현·Backend 87·FE 단위 5·Chrome 1 통과, 생산자 3종 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | E3/E6/E7 DB 사건 생산·STAR_BOARD·알림 전용 권한 예외 | S15P21C206-175 | 최종 값, 지연 트리거, 실제 판정 변화, 회차 시작, S5 | 구현·격리 Backend 93·FE 단위 5 통과, 운영 인수 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 별도 서버 없는 두 계정 로컬 통합·1,000명 기록 측정 | S15P21C206-175 | MockMvc, Gold 역할, CSRF 헤더, 비소급, 팬아웃 | Notification 22·합성 Chrome 3 통과, 실제 연결 인수 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 탐사 리뷰 보완·후보 팬아웃·튜토리얼 판정 일치 | S15P21C206-175 | 원천 보존, 후보 1000개, 행별 잠금, 활성 0/4/5개 | Notification 23 통과, 보존·동시성 정책 258 인계 | [기록](2026-09-23.md) |
| 2026-09-23 | 곡선 표시·접기 중심 기준과 제출 판정 시작 기준 구분 | S15P21C206-247 | bin 중심, 5.2, 6.2, 8.3, CURRENT, SUBMITTED, v0 보존 | 문서 정정·단위 28개·타입 검사 통과 | [기록](2026-09-23.md) |
| 2026-09-23 | 247 담당자 리뷰 반영·부분 bin 및 워커 용어·근거 상태 보완 | S15P21C206-247 | D06, 부분 bin, Web Worker, 관측 창 제안 | 문서 보완, 관측 창 대안 미승인 | [기록](2026-09-23.md) |
| 2026-09-23 | 탈퇴 방향 승인·쓰기 잠금·공개 조회 차단 일부 반영 | S15P21C206-180 | DEC-11, W1~W4, 작성자 표시, 반응, 첨부, FE222 | 부분 구현·격리 검증, 실행 정책 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 권장 탈퇴 계약·T/C·영수증·앱 역할 정리 구현 | S15P21C206-180 | V24, withdrawal-v1, 재가입, Redis, 보관 만료 | 격리 203건·FE 447건 통과, 운영 활성화 보류 | [기록](2026-09-23.md) |
| 2026-09-23 | 탈퇴 대상 팔로우 경합·정본 구현 상태 정정 | S15P21C206-180 | WD-08, 잠금 순서, withdrawal-v1, 기본 비활성 | PostgreSQL 18.6 FollowTest 10건 통과, 운영 인수 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | develop 배포 Redis·렌더러 설정 공급 | S15P21C206-254 | session-redis, cache-redis, --no-deps, VITE_SKY_RENDERER_ENABLED, GalaxyPage | EC2-A 반영·완료 조건 확인, CI 배포 병합 후 | [기록](2026-09-23.md) |
| 2026-09-23 | 254 리뷰 반영: Redis 예산·캐시 의존성·축출 정책 | S15P21C206-254 | maxmemory 64mb, noeviction, volatile-lru, depends_on, mem_limit | 구현·EC2-A 재반영 완료 | [기록](2026-09-23.md) |
| 2026-09-23 | 254 리뷰 반영: 프론트 배포 헬스를 렌더러 표식으로 | S15P21C206-254 | /health/renderer-enabled, try_files =404, web:image, 과도기 롤백 | 구현·격리 이미지 검증 완료 | [기록](2026-09-23.md) |
| 2026-09-23 | 254 리뷰 반영: maxmemory 해석·캐시 잠금 정책 경계 | S15P21C206-254 | used_memory_rss, 축출≠잠금, 만료·소유권·장애 회수 | 문서 보완 완료 | [기록](2026-09-23.md) |
| 2026-09-23 | 243 승인 리뷰 보완·운영 이식 회귀 조건 | S15P21C206-243 | ddof=0, reflect, 미측정, 81행, 병합 보존 | 관련 테스트 14개 통과·채택 미확정 | [기록](2026-09-23.md) |
| 2026-09-23 | 243 완료 조건·운영 후속 인계 준비 | S15P21C206-243 | DEC-03, 채택 결정, 인계 수신, SDE 계산 경로 | 팀 결정·인계 확인 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 243 운영 SDE 버전 선택·반복 연결 | S15P21C206-243 | running median, reflect, grid guard, CM Dra | 커널 307개·관련 43개 통과, 실제 회귀 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 243 운영 5별·반복 실행 검산 | S15P21C206-243 | b5828e49, 555ceda6, CM Dra 19, 2323+100 hash | 실제 회귀 통과·재리뷰 대기 | [기록](2026-09-23.md) |
| 2026-09-23 | 243 운영 코드 승인·API와 지문 문서 보완 | S15P21C206-243 | quality_version, v0 fingerprint, 공개 API | 운영 코드 승인·문서 보완 | [기록](2026-09-23.md) |
| 2026-09-21 | Sector 파이프라인 자율 실행·Raw 검증 후 원본 회수 | S15P21C206-252 | Airflow, systemd, Raw audit, cleanup, SHA-256 | DAG·cleanup 구현 및 오프라인 검증, 운영 배포 전 | [기록](2026-09-21.md) |
| 2026-09-22 | Airflow UI Node 1 배포·Tailnet 전용 공개 | S15P21C206-252 | Airflow DB, Scheduler, Webserver, Tailscale Serve, Viewer | UI 접속 검증, DAG 실행 전 | [기록](2026-09-22.md) |
| 2026-09-22 | Airflow Viewer 초기 암호 전달 오류 정정 | S15P21C206-252 | Viewer, password reset, root-only file | 수정·검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | Sector별 단계 DAG와 빠른 Raw 재검증 착수 | S15P21C206-252 | 4 DAG, lineage, manifest checksum, cached audit, parallel cleanup | 오프라인 구현·검증, 배포 전 | [기록](2026-09-22.md) |
| 2026-09-22 | Airflow DB 유지 갱신·실패 시 이전 이미지 복귀 | S15P21C206-252 | Airflow update, paused DAG, rollback | 스크립트 검증, 운영 적용 전 | [기록](2026-09-22.md) |
| 2026-09-22 | TESS 단계별 DAG·HDFS·Bronze 불변 release 배포 | S15P21C206-252 | 20260921T230610Z, Node 1~6, import, paused, DagRun 0 | 코드 배포·import 검증, 실제 실행 전 | [기록](2026-09-22.md) |
| 2026-09-22 | MAST Sector 발견·증거 기반 재개 선택 착수 | S15P21C206-252 | MAST 일반 LC, 상한 70, read-only DAG, resume planner | 오프라인 구현·테스트, 배포 전 | [기록](2026-09-22.md) |
| 2026-09-22 | Sector 14~70 자동 admission·실패 재개 구현 | S15P21C206-252 | Airflow 조정, Worker unit, 불변 원천, 단일 Sector Raw, retry | 오프라인 구현·검증, 배포 전 | [기록](2026-09-22.md) |
| 2026-09-22 | Sector 14 제한 운영 배포·재부팅 검증 | S15P21C206-252 | 20260922T021406Z, SSH, sudo, Worker 4, Node 1, Raw, cleanup, Bronze | 4단계 완료·drain, 무인 Hadoop 복구 미검증 | [기록](2026-09-22.md) |
| 2026-09-22 | Hadoop 전 노드 부팅 복구 오프라인 구현 | S15P21C206-252 | systemd, HDFS HA standby gate, timer, YARN readiness | 오프라인 검증·운영 미배포 | [기록](2026-09-22.md) |
| 2026-09-22 | Hadoop 6대 순차 재부팅 자동 복구 운영 검증 | S15P21C206-252 | release 5fec7b88, boot ID, Journal quorum, NN Active, YARN, Airflow | 6대 순차 재부팅·복구 검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 과거 Sector 1~13 Airflow DAG 제거 | S15P21C206-252 | Airflow, legacy DAG, metadata, release 20260922T134419Z | 운영 제거·검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 현행 Airflow DAG 한국어 표시 이름 배포 | S15P21C206-252 | Airflow, dag_display_name, description, release 20260922T135740Z | 운영 배포·검증 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | Airflow 3.2.2 전환 코드·격리 import 검증 | S15P21C206-252 | Airflow 3, Task SDK, DB clone, rollback | 코드·이미지 검증, 운영 전환 전 | [기록](2026-09-22.md) |
| 2026-09-22 | Node 1 Airflow 3.2.2 운영 전환 | S15P21C206-252 | 20260922T143000Z, DB clone, API Server, DAG Processor | 배포·기본 health 검증, 실제 단계 실행 전 | [기록](2026-09-22.md) |
| 2026-09-23 | Airflow 다운로드 대기 Temporal Trigger 도입 | S15P21C206-252 | Temporal Trigger, Triggerer, 14일 deadline | 운영 배포·첫 deferred 재개 확인, 장시간 미검증 | [기록](2026-09-23.md) |
| 2026-09-23 | Triggerer 배포 후 토큰 만료 재발 정정 | S15P21C206-252 | Sector 21·22, queued, LocalExecutor, JWT | 재발 확인·원인 미해결 | [기록](2026-09-23.md) |
| 2026-09-23 | develop 연속 병합에서 서비스 배포 버튼 유지 | S15P21C206-261 | rules:changes, auto_cancel, environment ec2-a, ci_forward_deployment | 구현·lint 통과, 병합 전 | [기록](2026-09-23.md) |
