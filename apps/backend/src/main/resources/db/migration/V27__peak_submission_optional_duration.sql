-- 추천 duration이 없는 봉우리 제출을 받는다 [S15P21C206-269]
-- IRREVERSIBLE: 옛 제약보다 넓은 CHECK로 바꾼다. 이미지를 되돌려도 옛 앱은 새 제약에서 그대로 동작한다. 스키마를 V4 제약으로 되돌리려면 이 버전 뒤 저장된 추천 duration 없는 봉우리 제출 행을 먼저 정리해야 한다.
--
-- V4는 봉우리 제출(source_peak_grid_index NOT NULL)에 제안 duration과 상한을 NOT NULL로 요구했다.
-- 탐사 API 5.4는 판이 주기별 BLS 값을 싣기 전까지 제안 duration을 null로 주고, 6.2는 그때 상한을 걸지
-- 않는다. 그래서 봉우리에서 시작한 제출이 모두 이 제약에 걸려 500이 됐다(S15P21C206-262 인계).
--
-- 봉우리 번호는 그대로 필수다. 제안 duration과 상한은 함께 움직인다. 둘 다 NULL(제안 없음, 상한 없음)이거나
-- 둘 다 유한한 양수다. 한쪽만 채운 행은 계속 막는다. 옛 규칙보다 넓어 기존 행은 모두 통과한다.
-- V26은 열린 S15P21C206-267이 쓰고 있어 건너뛴다.
--
-- CHECK는 NULL 결과를 통과시키므로 양수 분기에도 IS NOT NULL을 적는다(V4와 같은 이유).
ALTER TABLE submissions DROP CONSTRAINT ck_submissions_source_peak_all_or_none;

ALTER TABLE submissions
    ADD CONSTRAINT ck_submissions_source_peak_all_or_none CHECK (
        (source_peak_grid_index IS NULL AND source_peak_suggested_duration_hours IS NULL AND duration_limit_hours IS NULL)
        OR (submission_kind = 'candidate' AND source_peak_grid_index IS NOT NULL AND source_peak_grid_index >= 0
            AND ((source_peak_suggested_duration_hours IS NULL AND duration_limit_hours IS NULL)
                 OR (source_peak_suggested_duration_hours IS NOT NULL AND duration_limit_hours IS NOT NULL
                     AND source_peak_suggested_duration_hours > 0 AND source_peak_suggested_duration_hours < 'Infinity'
                     AND duration_limit_hours > 0 AND duration_limit_hours < 'Infinity'))));
