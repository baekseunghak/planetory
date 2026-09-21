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
| 2026-09-21 | 같은 별 공개 출처 저장·미리보기·무효 안내 | S15P21C206-167 | sourceLinks, available:false, V17, 출처 카드 | 구현·관련 검증 완료 | [기록](2026-09-21.md#s15p21c206-167-같은-별-공개-출처-카드와-비공개-안내) |
| 2026-09-21 | 전체 공개 집합 기반 핫 토픽·순위 커서와 동일 스냅샷 | S15P21C206-171 | COUNT DISTINCT, N>=10, hot-v1, REPEATABLE_READ, 전역 순위, 기존 인덱스 | 구현·관련 52건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 화면이 잔차 503을 retryable로 가른다 | S15P21C206-189 | retryable, DEPENDENCY_UNAVAILABLE, 정본 문구, START_FAILED, 개발용 응답, 화면 검사 | 구현 완료·실제 API 인수 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 현재 챌린지 조회·active 회차·자격 TIC·별 참여 수 | S15P21C206-168 | challenges/current, REPEATABLE_READ, GET 불변, COUNT DISTINCT | 구현·관련 54+6건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | CI 레지스트리 자체 호스팅·amd64 빌드 노드 분리 | S15P21C206-226 | registry, tailscale cert, REGISTRY_IMAGE_PREFIX, amd64-docker, privileged, extra_hosts, binfmt 제거, D4 충돌 | 레지스트리 검증 완료, Runner 등록 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | D4 범위 한정과 외부 관찰 EC2-B 이관 | S15P21C206-226 | D4, EC2-B, CI 빌드 노드, 외부 관찰 이관, 인계 100, 같은 AZ 한계, ap-northeast-2a | 채택, 관찰 구현 미완 | [기록](2026-09-21.md) |
| 2026-09-21 | 배포 노드 Docker 준비와 이미지 위생 도구 | S15P21C206-226 | install-docker-host.sh, docker-compose-v2, image-secret-scan, registry-prune, digest 공유 삭제, 가비지 수집 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | 배포 접속을 SSH 키 없이 tailnet 신원으로 전환 | S15P21C206-226 | Tailscale SSH, 22번 가로챔, ACL ssh 규칙, deploy 계정, sudo 없음, DEPLOY_SSH_KEY 폐기 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | MR 리뷰 지적 4건 수정과 검증 방식 정정 | S15P21C206-226 | MR !132 리뷰, GC 중 push, docker save 레이어 검사, config 블롭 created, set -e 알림 침묵, 스텁 우회 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | 출처 카드 리뷰 수정과 V18 마이그레이션 충돌 해소 | S15P21C206-167 | 교차 댓글 교착, 일괄 조회, REPEATABLE_READ, 출처 제거 재조회, 145 V17 선행, V18 | 검증 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 당시 배열이 없는데 그대로라고 말하던 안내 수정 | S15P21C206-190 | snapshot null, RETIRED_CANDIDATE, SUBMITTED 배지, 모순 문구 | 구현·검증 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 상세 해설 안내 문구 방향 정정과 해설 표시 검사 보강 | S15P21C206-145 | explanation, 위 비교표, explained 사례, x-fixture-outcome, 안내 문구 | 구현 완료 | [기록](2026-09-21.md) |
| 2026-09-21 | 대표 후보와 항목별 독립 일괄 공개 | S15P21C206-166 | batch, 20개, 부분 성공, NOT_PUBLISHED, 대표 후보, 독립 트랜잭션 | 구현·관련 117개 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 일괄 공개 리뷰 보완·후보 보장 범위 | S15P21C206-166 | 로그 스택, TIC_MISMATCH, CommunityQuery, 스냅샷, History 단위 후보 | 관련 81건·추가 46건 검증 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 내 별 목록 필터와 별 위치 찾기 구현 | S15P21C206-152 | stage, grade, ticId 필터, 커서 묶기, gradeRange, me/sky/locate, STAR_LOCKED | 구현 완료 | [2026-09-21](2026-09-21.md) |
| 2026-09-21 | 별 목록 조회의 트랜잭션 누락 정정과 스냅샷 계약 명시 | S15P21C206-152 | REPEATABLE_READ, 자기 호출, 프록시, 오버로드, STAR_LIST_PRIVATE, 스냅샷 | 구현 완료·재리뷰 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 127 Bronze 표본 커널 연결·비교·재실행 준비 | S15P21C206-127 | Worker, input_sha256, retry, 19 passed | 오프라인 검증, 실제 YARN 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | 127 실제 Worker 수치·실패 TIC 재실행 검증 | S15P21C206-127 | YARN 0023~0026, PYTHONPATH, HADOOP_CONF_DIR, 20 TIC | 표본 검증 완료·리뷰 전 | [기록](2026-09-21.md) |
| 2026-09-21 | MR 단계 컨테이너 이미지 빌드 검증 추가 | S15P21C206-84 | web:image, nginx -t, host not found in upstream, dind | 구현 완료·파이프라인 미실행 | [기록](2026-09-21.md) |
| 2026-09-21 | EC2-A 계정 분리 적용과 CI push 차단 원인 규명 | S15P21C206-84 | planetory_service, DATABASE_PASSWORD, DEPLOY_AUX_DIR, registry push timeout, UFW, tailscale0 | EC2-A 적용 완료·EC2-B 조치 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-22 | MR 단계 마이그레이션 검사가 실행되지 않던 결함 수정 | S15P21C206-84 | alpine/git, ENTRYPOINT, entrypoint 비우기, backend:schema, V19 선점 | MR 파이프라인 통과 확인 | [기록](2026-09-22.md) |
| 2026-09-22 | 검증 경계 정정 — 로컬 실행과 CI 실행 구분 | S15P21C206-84 | 로컬 통과, CI 미실행, 실행 위치 명시 | 정정 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | Runner 동시 실행 3으로 상향·Runner 대수 정정 | S15P21C206-84 | concurrent, concurrent-0 슬롯, 202초→126초, run_untagged, vCPU 4 | 적용·실측 완료 | [기록](2026-09-22.md) |
| 2026-09-22 | 백엔드 CI 이미지 배포와 계정 분리 완료 | S15P21C206-84 | deploy:backend:ec2-a, V9→V19, planetory_service, pg_dump, BACKEND_IMAGE 어긋남 | 배포·검증 완료 | [기록](2026-09-22.md) |
