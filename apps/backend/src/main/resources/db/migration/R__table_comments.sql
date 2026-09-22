-- 테이블 설명을 DB에 심는다. ERD 도구는 모두 pg_description을 읽으므로, 여기에 한 번
-- 쓰면 도구를 바꿔도 설명이 따라간다. 컬럼 코멘트는 V1에서 들어갔고 여기서는 테이블
-- 단위만 채운다.
--
-- 반복 마이그레이션(R__)이다. 버전 번호를 갖지 않는 이유는 두 가지다.
--   1. COMMENT ON은 멱등이다. 여러 번 돌아도 결과가 같아 버전을 매길 이유가 없다.
--   2. 버전 번호는 브랜치 사이의 선점 경쟁 대상이다. 실제로 S15P21C206-140이 V10을
--      쓰기로 되어 있었다. 번호를 잡지 않으면 그 경쟁에서 빠진다.
--
-- Flyway는 버전 마이그레이션을 모두 적용한 뒤 이 파일을 돌리고, 체크섬이 바뀌었을 때만
-- 다시 돌린다. 새 테이블이 생기면 여기에 COMMENT ON을 추가하면 다음 기동에 반영된다.
-- 테이블이 사라지면 여기서도 지워야 한다. 없는 테이블에 COMMENT ON을 걸면 실패한다.

COMMENT ON TABLE users IS '회원 계정. OAuth 제공자와 제공자 쪽 ID 조합으로 식별한다';
COMMENT ON TABLE user_settings IS '회원별 공개 범위와 알림 설정';
COMMENT ON TABLE follows IS '회원의 팔로우. 대상은 다른 회원 또는 별이다';
COMMENT ON TABLE notifications IS '회원에게 발송된 알림과 읽음 여부';

COMMENT ON TABLE stars IS 'TESS 관측 대상 별의 기본 제원. tic_id가 별의 식별자다';
COMMENT ON TABLE observation_datasets IS '별의 섹터별 관측 구간 메타데이터. 어느 기간을 어떤 간격으로 찍었는지';
COMMENT ON TABLE light_curve_segments IS '별의 섹터별 광도 곡선을 비닝한 배열. 분석 화면이 읽는 원천 데이터다';
COMMENT ON TABLE publication_bundles IS '별 단위 공개 데이터 판. 세그먼트 구성과 계산 버전을 한 판으로 고정한다';
COMMENT ON TABLE periodograms IS '공개 판별로 계산한 BLS 주기도 세기 배열';

COMMENT ON TABLE candidates IS '별에서 검출된 통과 신호 후보. 판이 바뀌어도 id는 유지된다';
COMMENT ON TABLE candidate_aliases IS '후보 주기의 배수 별칭(1/2배·2배 등). 제출 주기 정정 판정에 쓴다';
COMMENT ON TABLE candidate_dispositions IS '후보의 최종 분류와 정답 근거. 규칙 버전별로 적용된다';
COMMENT ON TABLE candidate_status_history IS '후보 항목 값의 변경 이력. 판이 바뀔 때 무엇이 달라졌는지 남긴다';
COMMENT ON TABLE external_signal_references IS 'TCE·TOI·ExoFOP 등 외부 카탈로그 신호 참조. 후보 대조의 근거다';

COMMENT ON TABLE submissions IS '회원의 후보 판정 제출. 채점 결과와 판정 근거를 함께 남기는 핵심 기록이다';
COMMENT ON TABLE analysis_histories IS '제출 시점의 분석 파라미터 스냅샷. 재현과 글 첨부의 단위다';
COMMENT ON TABLE analysis_snapshots IS '히스토리에 딸린 위상 접기 곡선. 150구간으로 압축해 둔다';
COMMENT ON TABLE published_analyses IS '공식 스레드에 공개된 회원 분석';

COMMENT ON TABLE posts IS '커뮤니티 글. 회원 글과 후보별 공식 스레드를 함께 담는다';
COMMENT ON TABLE comments IS '글에 달린 답글';
COMMENT ON TABLE post_reactions IS '일반 글에 대한 회원 반응(동의/비동의)';
COMMENT ON TABLE post_source_links IS '글·답글이 참조하는 스레드 또는 분석 링크';
COMMENT ON TABLE post_history_attachments IS '글에 첨부된 분석 히스토리 연결';
COMMENT ON TABLE comment_history_attachments IS '답글에 첨부된 분석 히스토리 연결';

COMMENT ON TABLE user_star_progress IS '회원의 별 단위 탐색 진행도와 완료 사유';
COMMENT ON TABLE user_candidate_achievements IS '회원이 후보에 대해 인정받은 성과';
COMMENT ON TABLE star_unlocks IS '회원이 연 별과 은하 지도상의 배치 좌표';
COMMENT ON TABLE member_sky_revisions IS '회원 지도의 단조 증가 개정값. 발견·상태 변경과 같은 트랜잭션에서 올린다';
COMMENT ON TABLE tutorial_stars IS '튜토리얼에서 순서대로 제시하는 별과 그 의도';
COMMENT ON TABLE challenge_rounds IS '기간제 챌린지 회차. 대상 별과 진행 상태를 관리한다';

COMMENT ON TABLE ai_executions IS 'AI 모델 실행 1회의 메타데이터. 모델·체크포인트 버전과 성공 여부를 남긴다';
COMMENT ON TABLE ai_evaluations IS 'AI 실행이 후보 하나에 매긴 점수와 판정';

COMMENT ON TABLE operation_settings IS '운영 규칙 버전별 설정 값. 판정 임계값 등을 담는다';
COMMENT ON TABLE stats_snapshots IS '일자별 집계 지표 스냅샷';
