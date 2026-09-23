-- 판 전환 후처리가 남기는 재개 사건 [S15P21C206-150]
--
-- 재개 사건은 별도 테이블을 만들지 않고 V1 `notifications`를 쓴다. ERD가 이미 type에
-- 'reopen'을 두었고 payload JSONB가 {ticId, bundleId, newDiscoverableCount, reason}을
-- 담기에 충분하다. 알림 전달(NTF-01, S22)은 같은 행을 뒤에 소비한다.
--
-- V11이 notifications를 "필요한 동사를 코드로 확정할 수 없으므로 각 기능 티켓이 같은
-- 커밋에서 추가한다"로 남겼다. 이 티켓이 첫 쓰기 경로이므로 여기서 확정한다.
--
-- 앱은 사건을 만들기만 한다. 읽음 표시(read_at)의 UPDATE는 알림 조회·읽음 처리를
-- 구현하는 티켓이 그 경로와 같은 커밋에서 받는다. 지금 주면 쓰지도 않는 권한이 열린
-- 채로 남는다. IDENTITY 시퀀스는 V5·V11의 ALL SEQUENCES가 이미 덮는다.
DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT ON %I.notifications TO planetory_app', current_schema());
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.notifications FROM planetory_app', current_schema());
END $$;

-- 같은 판의 재개 사건은 회원×별당 하나다. 후처리를 두 번 실행해도 사건이 늘지 않아야
-- 하는데(150 완료 조건), 응용에서 세는 대신 DB가 막는다. 부분 인덱스라 다른 알림
-- 종류에는 제약이 걸리지 않는다.
CREATE UNIQUE INDEX uq_notifications_reopen_per_bundle
    ON notifications (user_id, (payload ->> 'ticId'), (payload ->> 'bundleId'))
 WHERE type = 'reopen';
