-- S15P21C206-268: 모델 호출 시도의 UTC 일일 한도. 회원 탈퇴 뒤에도 전체 비용 상한은 유지한다.
CREATE TABLE nasa_explanation_daily_usage (
    usage_day DATE NOT NULL,
    member_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
    PRIMARY KEY (usage_day, member_id)
);

CREATE TABLE nasa_explanation_daily_total (
    usage_day DATE PRIMARY KEY,
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0)
);

COMMENT ON TABLE nasa_explanation_daily_usage IS '268: UTC 날짜와 회원별 모델 생성 시도권';
COMMENT ON TABLE nasa_explanation_daily_total IS '268: 탈퇴와 무관하게 유지하는 UTC 날짜별 전체 모델 생성 시도권';

GRANT SELECT, INSERT, UPDATE ON nasa_explanation_daily_usage TO planetory_app;
GRANT SELECT, INSERT, UPDATE ON nasa_explanation_daily_total TO planetory_app;
