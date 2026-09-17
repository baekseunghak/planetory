-- 탐사 도메인 제약·권한 [S15P21C206-135]
--
-- V1의 제출·히스토리·스냅샷·성과·진행·발견·운영 설정·튜토리얼·챌린지 테이블을 재사용하고
-- 누락된 제약과 불변 권한만 보완한다. V1 checksum을 유지하기 위해 ALTER로만 수정한다.

-- ---------------------------------------------------------------------------
-- 1. submissions 정합 제약
-- ---------------------------------------------------------------------------

-- 위상 선택이 없는 제출에는 파생값도 없어야 한다. 서버는 phase_start·phase_end에서
-- epoch·duration을 계산하므로(EXP-06·07) 선택이 없으면 계산할 것이 없다.
-- V1은 user_judgment·submitted_period·위상만 검사하고 파생값 셋은 보지 않았다.
ALTER TABLE submissions
    ADD CONSTRAINT ck_submissions_derived_only_for_candidate CHECK (
        submission_kind = 'candidate'
        OR (epoch_btjd IS NULL AND duration_hours IS NULL AND matched_period IS NULL)
    );

-- 성과 결과는 매칭 결과와 함께 성립한다(GRD-02·03·04, SUB-06).
--   recognized·judgment_mismatch·pending_publish : 매칭에 성공해야 나온다
--   already_recognized                           : 이미 인정된 신호를 다시 맞춘 경우다
--   none                                         : 그 밖의 결과
-- 이 제약이 없으면 not_matched 제출에 recognized가 저장돼 등급 집계가 오염된다.
ALTER TABLE submissions
    ADD CONSTRAINT ck_submissions_achievement_matches_result CHECK (
        (achievement_result IN ('recognized', 'judgment_mismatch', 'pending_publish')
            AND match_result IN ('matched', 'matched_harmonic'))
        OR (achievement_result = 'already_recognized' AND match_result = 'duplicate')
        OR (achievement_result = 'none'
            AND match_result NOT IN ('matched', 'matched_harmonic', 'duplicate'))
    );

-- 고조파 정정 기록은 실제로 정정했을 때만 남긴다(SUB-04·05).
-- 정정이 없었는데 correction_reason에 적을 사유가 없으므로 세 열을 한 묶음으로 둔다.
-- 허용 배율 집합(1/2·2 외)은 과학 계약(D20, 탐사 API 12.2 미결 5)이라 값은 검사하지 않는다.
ALTER TABLE submissions
    ADD CONSTRAINT ck_submissions_correction_only_for_harmonic CHECK (
        (match_result = 'matched_harmonic'
            AND matched_period IS NOT NULL AND harmonic_multiplier IS NOT NULL)
        OR (match_result <> 'matched_harmonic'
            AND matched_period IS NULL AND harmonic_multiplier IS NULL
            AND correction_reason IS NULL)
    );

-- ---------------------------------------------------------------------------
-- 2. star_unlocks 은하 배치 순번
-- ---------------------------------------------------------------------------

-- 은하 배치는 "이 회원의 몇 번째 별인가"로 나선 팔 위의 자리를 정한다. 발견 경로가
-- 튜토리얼·성과·챌린지로 나뉘어도 회원 안에서는 하나의 연속 순번을 공유해야 한다.
-- 기존 seq는 한 성과가 연 별들의 순번이라 다른 개념이며 튜토리얼 발견에는 없다.
--
-- 기존 행이 있어도 적용되도록 nullable로 추가한 뒤 발견 순서대로 채우고 승격한다.
-- 순번이 없던 행에 처음 부여하는 것이며 이미 있는 순번을 재배치하지 않는다.
ALTER TABLE star_unlocks ADD COLUMN layout_ordinal INTEGER;

UPDATE star_unlocks s
   SET layout_ordinal = n.ordinal
  FROM (SELECT id,
               row_number() OVER (PARTITION BY user_id ORDER BY unlocked_at, id) - 1 AS ordinal
          FROM star_unlocks) n
 WHERE s.id = n.id;

ALTER TABLE star_unlocks
    ALTER COLUMN layout_ordinal SET NOT NULL,
    ADD CONSTRAINT ck_star_unlocks_layout_ordinal_range
        CHECK (layout_ordinal BETWEEN 0 AND 2147483647),
    -- 두 요청이 동시에 같은 순번을 잡으면 두 별이 같은 자리에 겹친다. 하나를 실패시켜
    -- 재시도하게 만든다(139·144의 동시 순번 배정 검증 대상).
    ADD CONSTRAINT uq_star_unlocks_user_layout_ordinal UNIQUE (user_id, layout_ordinal);

COMMENT ON COLUMN star_unlocks.layout_ordinal IS '회원별 발견 순번(0부터) · 모든 발견 종류가 공유';

-- ---------------------------------------------------------------------------
-- 3. challenge_rounds 진행 회차 단일성
-- ---------------------------------------------------------------------------

-- 퀘스트 패널은 진행 중인 챌린지 하나를 보여주고(HOME-07), 튜토리얼 5개를 끝낸 회원에게
-- 그 회차의 별을 발견 처리한다(HOME-02). active가 둘이면 어느 별을 열지 정해지지 않는다.
-- planned·closed는 몇 개든 괜찮으므로 부분 유일 인덱스를 쓴다.
CREATE UNIQUE INDEX uq_challenge_rounds_active
    ON challenge_rounds (status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 4. 탐사 도메인 권한
-- ---------------------------------------------------------------------------

-- V2에서 만든 앱 역할에 탐사 도메인 권한을 준다. Gold(B 묶음)와 달리 앱이 직접 쓰는
-- 데이터지만, 불변이어야 하는 기록에는 수정·삭제를 주지 않는다.
--
-- analysis_histories·analysis_snapshots는 생성 후 수정하지 않으며 사용자 삭제 기능도
-- 제공하지 않는다(HIS-06). ERD 미결 5·6의 불변 강제를 트리거가 아니라 권한 회수로
-- 처리한다. 트리거는 쓰기마다 비용이 붙고 비활성화로 우회되지만 권한은 DB가 막는다.
--
-- DELETE는 어느 테이블에도 주지 않는다. 탈퇴 처리(S27)에 필요해지면 그때 범위를 정한다.
DO $$
DECLARE
    target_schema TEXT := current_schema();
    -- 앱이 행을 만들고 갱신하는 테이블
    writable TEXT[] := ARRAY['submissions', 'user_candidate_achievements',
                             'user_star_progress', 'star_unlocks'];
    -- 앱이 만들되 고치지 않는 테이블(불변 기록)
    append_only TEXT[] := ARRAY['analysis_histories', 'analysis_snapshots'];
    -- 앱이 읽기만 하는 테이블(운영이 설정한다)
    readable TEXT[] := ARRAY['operation_settings', 'tutorial_stars', 'challenge_rounds'];
    t TEXT;
BEGIN
    FOREACH t IN ARRAY writable LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO planetory_app', target_schema, t);
        EXECUTE format('REVOKE DELETE, TRUNCATE ON %I.%I FROM planetory_app', target_schema, t);
    END LOOP;

    FOREACH t IN ARRAY append_only LOOP
        EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO planetory_app', target_schema, t);
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.%I FROM planetory_app',
                       target_schema, t);
    END LOOP;

    FOREACH t IN ARRAY readable LOOP
        EXECUTE format('GRANT SELECT ON %I.%I TO planetory_app', target_schema, t);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.%I FROM planetory_app',
                       target_schema, t);
    END LOOP;

    -- IDENTITY 열의 암묵 시퀀스. INSERT 권한이 있는 테이블에 필요하다.
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO planetory_app',
                   target_schema);
END $$;
