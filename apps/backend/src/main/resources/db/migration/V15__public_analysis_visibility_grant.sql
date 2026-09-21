-- 본인 공개 상태만 변경한다. 운영 숨김·공개 근거·최초 공개 시각은 앱이 수정하지 않는다.
DO $$
BEGIN
    EXECUTE format('GRANT UPDATE (unpublished_at) ON %I.published_analyses TO planetory_app', current_schema());
END $$;
