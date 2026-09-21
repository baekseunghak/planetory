-- 상세 보기의 힌트 대상 [S15P21C206-145]. 6.7절이 반복 호출에 같은 대상을 약속하는데,
-- 매번 현재 후보에서 다시 고르면 판이 바뀔 때 같은 제출의 답이 달라진다. 최초 선택을 남긴다.
-- 기존 행은 NULL이며 추측해 backfill하지 않는다. 다음 상세 보기에서 처음 고른 값이 들어간다.
ALTER TABLE submissions
    ADD COLUMN detail_target_candidate_id BIGINT,
    ADD CONSTRAINT fk_submissions_detail_target_candidate_id
        FOREIGN KEY (detail_target_candidate_id) REFERENCES candidates(id);
COMMENT ON COLUMN submissions.detail_target_candidate_id IS
    '상세 보기에서 처음 연 신호. 한 번 정하면 바꾸지 않는다(탐사 API 6.7절)';
