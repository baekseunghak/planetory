-- 임시 배치로 저장된 개발 행 차단 [S15P21C206-136]
--
-- BootstrapGalaxyLayout은 모든 별을 원점에 두던 자리표시 구현이고 이 판에서 삭제했다.
-- 그 구현이 남긴 `layout_version = 'bootstrap-0'` 행은 좌표가 (0,0,0)이라 실제 배치와 섞이면
-- 한 회원 지도에 두 배치 버전이 공존한다. 메타는 personal-spiral-v1을 알리는데 그 별만
-- 계약을 따르지 않으므로 응답이 거짓이 된다.
--
-- 지우지 않고 멈추는 이유: 발견 행을 지우면 그 회원의 별이 0개가 되는데, 튜토리얼 1번은
-- 가입 처리에서만 열리므로 다시 생기지 않는다. 탐사 API 4.1의 "회원의 별이 0개는 없다"가
-- 깨진다. 무엇을 지울지는 그 DB를 쓰는 사람이 정한다.
--
-- 운영에는 이런 행이 없다. 임시 구현은 develop에 배포된 적이 없고 출시 전이다.

DO $$
DECLARE
    stale_rows BIGINT;
BEGIN
    SELECT count(*) INTO stale_rows FROM star_unlocks WHERE layout_version = 'bootstrap-0';

    IF stale_rows > 0 THEN
        RAISE EXCEPTION
            '임시 배치(bootstrap-0)로 저장된 별 발견 행이 %건 있습니다. 실제 배치와 섞을 수 없습니다.',
            stale_rows
            USING HINT = '개발 DB라면 회원과 발견 기록을 함께 비운 뒤 다시 적용하십시오: '
                       || 'TRUNCATE users CASCADE;';
    END IF;
END $$;
