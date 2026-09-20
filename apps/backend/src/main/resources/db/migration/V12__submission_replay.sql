-- 제출 멱등성 [S15P21C206-143]. 과거 요청/응답을 추측해 backfill하지 않는다.
ALTER TABLE submissions
    ADD COLUMN request_hash TEXT,
    ADD COLUMN request_hash_version SMALLINT,
    ADD COLUMN response_snapshot JSONB,
    ADD CONSTRAINT ck_submission_request_hash CHECK (
        (request_hash IS NULL AND request_hash_version IS NULL AND response_snapshot IS NULL)
        OR (request_hash IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$'
            AND request_hash_version IS NOT NULL AND request_hash_version = 1
            AND (response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object'))
    );
COMMENT ON COLUMN submissions.request_hash IS '경로 TIC + 정규화 요청 SHA-256';
COMMENT ON COLUMN submissions.request_hash_version IS '정규화 규칙 버전. 기존 행은 NULL';
COMMENT ON COLUMN submissions.response_snapshot IS '최초 성공 POST 본문. 같은 트랜잭션에서 저장, 재전송 때 재현';
