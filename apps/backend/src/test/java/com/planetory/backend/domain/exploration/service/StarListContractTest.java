package com.planetory.backend.domain.exploration.service;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.time.OffsetDateTime;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

import com.planetory.backend.domain.exploration.service.StarViews.StarList;
import com.planetory.backend.domain.exploration.service.StarViews.StarListItem;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 별 목록 커서·직렬화 계약 [S15P21C206-138].
 *
 * <p>DB 없이 돈다. 두 결함 모두 질의가 아니라 값 변환에서 생기므로 순수 단위로 잡을 수 있다.
 * !57 리뷰(하서진)에서 나온 두 지적을 재현한다.
 */
class StarListContractTest {

    /**
     * 커서가 시각을 잘라 담으면 같은 시각의 나머지 별이 다음 페이지에서 빠진다.
     *
     * <p>운영 발견 시각은 {@code CURRENT_TIMESTAMP}라 PostgreSQL 마이크로초 정밀도다. 커서가
     * 밀리초로 잘라 담으면 복원한 기준 시각이 실제보다 작아지고, 이어읽기 조건
     * {@code (시각, -ticId) < (기준, -기준ticId)}에서 같은 시각의 별이 모두 거짓이 된다.
     *
     * <p>이전 테스트는 시각을 정각 초로만 넣어 밀리초 아래가 0이었다. 잘라도 손실이 없어 결함이
     * 보이지 않았다. 여기서는 일부러 마이크로초를 채운다.
     */
    @Test
    void 커서는_마이크로초까지_잃지_않는다() {
        OffsetDateTime lastActivity = OffsetDateTime.parse("2026-09-10T02:30:00.123456Z");
        StarListCursor expected = new StarListCursor(1, 1, "discovered", "recent", 4, "", 0, 0);

        String encoded = StarListCursor.after(1, 1, "discovered", "recent", 4, "", lastActivity, 42)
                .encode();
        StarListCursor decoded = StarListCursor.decode(encoded, expected).orElseThrow();

        assertEquals(lastActivity.toInstant(), decoded.afterActivity().toInstant(),
                "기준 시각이 잘리면 같은 시각의 나머지 별이 다음 페이지에서 빠진다");
        assertEquals(42, decoded.afterTicId());
    }

    /**
     * 등급 필터와 등급 표시가 <b>같은 규칙</b>이어야 한다(S15P21C206-152). 갈라지면 「S로 걸렀는데
     * A가 나온다」가 된다. 성과 수를 넓게 훑어 둘이 서로의 역인지 본다.
     */
    @Test
    void 등급_필터_범위는_등급_표시의_역이다() {
        for (int count = 0; count <= 12; count++) {
            String grade = StarService.grade(count);
            if (grade == null) {
                assertEquals(0, count, "성과가 있는데 등급이 없으면 필터가 그 별을 영영 못 찾는다");
                continue;
            }
            int[] range = StarService.gradeRange(grade);
            assertNotNull(range, grade);
            assertTrue(range[0] <= count && count <= range[1],
                    "성과 " + count + "은 " + grade + " 범위 " + range[0] + "~" + range[1] + " 안이어야 한다");
        }
        // 범위 안의 수는 모두 그 등급이어야 한다. 한쪽만 넓으면 다른 등급이 섞인다.
        for (String grade : java.util.List.of("A", "S", "SS", "SSS")) {
            int[] range = StarService.gradeRange(grade);
            int upper = Math.min(range[1], range[0] + 8);
            for (int count = range[0]; count <= upper; count++) {
                assertEquals(grade, StarService.grade(count), "성과 " + count);
            }
        }
        assertNull(StarService.gradeRange("B"), "계약 밖 등급은 범위가 없다");
    }

    /** DB 해상도는 마이크로초다. 나노초 자리는 늘 0이므로 마이크로초면 손실이 없다. */
    @Test
    void 마이크로초_경계값도_그대로_돌아온다() {
        StarListCursor expected = new StarListCursor(1, 1, "submitted", "recent", 20, "", 0, 0);
        for (String value : List.of("2026-09-10T02:30:00.000001Z", "2026-09-10T02:30:00.999999Z",
                "1970-01-01T00:00:00.000001Z", "2026-09-10T02:30:00Z")) {
            OffsetDateTime at = OffsetDateTime.parse(value);
            StarListCursor decoded = StarListCursor.decode(
                    StarListCursor.after(1, 1, "submitted", "recent", 20, "", at, 7).encode(), expected)
                    .orElseThrow();

            assertEquals(at.toInstant(), decoded.afterActivity().toInstant(), value);
        }
    }

    /**
     * 타인 조회에서 미게시 수를 뺀다. null로 남기면 필드가 응답에 그대로 나간다(NFR-14).
     *
     * <p>명세는 "타인 조회는 필드를 뺀다"다. 운영 직렬화기는 Jackson 3이고 null 포함 규칙을 따로
     * 두지 않아 기본값(null도 씀)이다. 그래서 레코드에 null을 넣는 것만으로는 빠지지 않는다.
     */
    @Test
    void 타인_응답에는_미게시_수_필드가_없다() {
        JsonMapper json = JsonMapper.builder().build();

        String forOther = json.writeValueAsString(new StarList(List.of(item(null)), null, false));
        String forSelf = json.writeValueAsString(new StarList(List.of(item(0)), null, false));

        assertFalse(forOther.contains("unpublishedSignalCount"),
                "타인 응답에 키가 남으면 명세의 '필드를 뺀다'를 어긴다: " + forOther);
        assertTrue(forSelf.contains("\"unpublishedSignalCount\":0"),
                "본인은 0이어도 필드가 있어야 한다. 없음과 0은 다른 뜻이다: " + forSelf);
    }

    /** 미게시 수 말고 다른 null 필드는 그대로 null로 나가야 한다. 명세 예제가 "marker": null이다. */
    @Test
    void 다른_null_필드는_그대로_나간다() {
        String body = JsonMapper.builder().build()
                .writeValueAsString(new StarList(List.of(item(null)), null, false));

        assertTrue(body.contains("\"marker\":null"), body);
        assertTrue(body.contains("\"grade\":null"), body);
        assertTrue(body.contains("\"nextCursor\":null"), body);
    }

    private static StarListItem item(Integer unpublishedSignalCount) {
        return new StarListItem("123456789", "in_progress", 0, false, 0, null, null, false, false,
                unpublishedSignalCount, OffsetDateTime.parse("2026-09-10T02:30:00.123456Z"),
                "tutorial", null);
    }

    /**
     * 목록 조회의 <b>모든 공개 진입점</b>이 같은 스냅샷 설정을 들고 있어야 한다.
     *
     * <p>공개 여부 검사와 목록 조회가 다른 시점을 읽으면, 상대가 비공개로 바꾸며 만든 기록까지
     * 돌려준다. 필터를 더하면서 실제 조회를 새 오버로드로 옮겼는데 애너테이션은 옛 메서드에
     * 남아, 컨트롤러가 늘 부르는 운영 경로만 트랜잭션 밖에 있었다(!138 리뷰).
     *
     * <p>자기 호출은 프록시를 타지 않으므로 "하나만 붙여도 안쪽이 따라온다"가 성립하지 않는다.
     * 그래서 개수를 함께 센다. 오버로드가 늘어나면 이 검사가 먼저 걸린다.
     */
    @Test
    void 목록_조회의_모든_진입점이_같은_스냅샷을_요구한다() {
        int checked = 0;
        for (Method method : StarService.class.getDeclaredMethods()) {
            if (!method.getName().equals("list") || !Modifier.isPublic(method.getModifiers())) continue;
            Transactional tx = method.getAnnotation(Transactional.class);
            assertNotNull(tx, method + " 에 트랜잭션이 없다. 컨트롤러가 이 진입점을 부르면 검사와"
                    + " 조회가 다른 스냅샷을 읽는다");
            assertTrue(tx.readOnly(), method.toString());
            assertEquals(Isolation.REPEATABLE_READ, tx.isolation(), method.toString());
            checked++;
        }
        assertEquals(2, checked, "필터 있는 조회와 없는 조회 둘 다 검사해야 한다");
    }
}
