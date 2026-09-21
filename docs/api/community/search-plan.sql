-- 일회용 PostgreSQL + pg_trgm 전용. 운영 DB에서 실행하지 않는다.
-- psql -v ON_ERROR_STOP=1 -f search-plan.sql
BEGIN;
CREATE TEMP TABLE s17_posts (
    id bigint PRIMARY KEY, tic_id bigint, kind text, board text, tag text,
    title text, body text, status text, created_at timestamptz
) ON COMMIT DROP;
INSERT INTO s17_posts
SELECT n, 123456789 + n % 100, 'user', 'star', 'question',
       CASE WHEN n % 1000 = 0 THEN 'raretransit' ELSE 'observation' END || n,
       CASE WHEN n % 1500 = 0 THEN 'raretransit body' ELSE repeat('common observation ', 20) END,
       CASE WHEN n % 17 = 0 THEN 'hidden' ELSE 'visible' END,
       timestamptz '2026-09-01 00:00:00+00' + n * interval '1 second'
FROM generate_series(1,100000) n;
CREATE INDEX s17_title_trgm ON s17_posts USING gin(title public.gin_trgm_ops);
CREATE INDEX s17_body_trgm ON s17_posts USING gin(body public.gin_trgm_ops);
CREATE INDEX s17_tic_kind_created ON s17_posts(tic_id, kind, created_at DESC);
ANALYZE s17_posts;
SELECT version(), datcollate FROM pg_database WHERE datname=current_database();
-- 각 SELECT를 동일 조건으로 3회 실행하고 각 회차의 값을 따로 기록한다.
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id FROM s17_posts WHERE status='visible' AND title ILIKE '%raretransit%'
ORDER BY created_at DESC,id DESC LIMIT 20;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id FROM s17_posts WHERE status='visible'
AND (title ILIKE '%raretransit%' OR body ILIKE '%raretransit%')
ORDER BY created_at DESC,id DESC LIMIT 20;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id FROM s17_posts WHERE status='visible' AND body ILIKE '%co%'
ORDER BY created_at DESC,id DESC LIMIT 20;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id FROM s17_posts WHERE status='visible' AND tic_id=123456790
AND board='star' AND tag='question' AND body ILIKE '%common%'
AND (created_at,id) < (timestamptz '2026-09-02 00:00:00+00',86400)
ORDER BY created_at DESC,id DESC LIMIT 20;
ROLLBACK;
