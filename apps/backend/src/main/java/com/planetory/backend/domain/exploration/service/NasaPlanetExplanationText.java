package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.util.List;

import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Content;
import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Measurement;
import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;

/** 모델은 검증 가능한 문장 틀만 고른다. 수치·단위·이름은 서버가 원천에서 채운다. */
final class NasaPlanetExplanationText {

    private static final String NAME_TOKEN = "{{name}}";
    private static final String VALUE_TOKEN = "{{value}}";
    private static final List<String> NAME = List.of(
            "이번에는 {{name}}에 대해 살펴볼까요?",
            "{{name}}에 대해 함께 알아볼까요?");
    private static final List<String> PERIOD = List.of(
            "이 행성은 별 주위를 한 바퀴 도는 데 {{value}}.",
            "이 행성이 별을 한 바퀴 도는 데 {{value}}.");
    private static final List<String> RADIUS = List.of(
            "반지름을 살펴보면, {{value}}.",
            "크기를 살펴보면, 반지름은 {{value}}.");
    private static final List<String> MASS = List.of(
            "질량은 {{value}}.",
            "이 행성의 질량은 {{value}}.");
    private static final List<String> DISCOVERY = List.of(
            "이 행성은 {{value}}.",
            "발견 기록을 보면, 이 행성은 {{value}}.");
    private static final List<String> NO_PERIOD = List.of("이번 NASA 자료에서는 공전주기를 확인할 수 없어요.");
    private static final List<String> NO_RADIUS = List.of("이번 NASA 자료에서는 반지름을 확인할 수 없어요.");
    private static final List<String> NO_MASS = List.of("질량은 이번 NASA 자료에서 확인할 수 없어요.");
    private static final List<String> NO_DISCOVERY = List.of("이번 NASA 자료에는 발견 시기와 방법이 나와 있지 않아요.");

    private NasaPlanetExplanationText() {
    }

    record Draft(String sourceHash, String planetName, String name, String orbitalPeriod,
                 String radius, String mass, String discovery) {
    }

    // 선택지를 [a, b] 목록 문자열로 보이면 모델이 가끔 목록 전체를 값으로 복사했다(운영 1/2, 재현 1/24).
    // 번호만 고르게 하면 그 실패가 구조적으로 사라진다. 문장은 서버가 번호로 되찾는다 [S15P21C206-277].
    static String instructions(Planet planet, String sourceHash) {
        Facts facts = facts(planet);
        return """
                JSON 객체 한 개만 반환하세요. sourceHash는 전달된 해시를 글자 그대로 복사하세요.
                planetName은 {{name}} 토큰만 반환하세요. 실제 이름은 서버가 나중에 채웁니다.
                name, orbitalPeriod, radius, mass, discovery에는 아래 번호 목록에서 고른 문장의 번호 하나만 문자열로 쓰세요(예: "1").
                문장이나 목록을 그대로 쓰지 말고, 숫자·단위·참고문헌·추가 사실을 만들지 마세요.
                sourceHash: %s
                planetName: {{name}}
                name:
                %s
                orbitalPeriod:
                %s
                radius:
                %s
                mass:
                %s
                discovery:
                %s
                """.formatted(sourceHash, numbered(NAME),
                numbered(choices(facts.period(), PERIOD, NO_PERIOD)),
                numbered(choices(facts.radius(), RADIUS, NO_RADIUS)),
                numbered(choices(facts.mass(), MASS, NO_MASS)),
                numbered(choices(facts.discovery(), DISCOVERY, NO_DISCOVERY)));
    }

    private static String numbered(List<String> options) {
        StringBuilder lines = new StringBuilder();
        for (int i = 0; i < options.size(); i++) {
            if (i > 0) lines.append('\n');
            lines.append(i + 1).append(". ").append(options.get(i));
        }
        return lines.toString();
    }

    static Content render(Draft draft, Planet planet, String sourceHash) {
        Facts facts = facts(planet);
        if (draft == null || !sourceHash.equals(draft.sourceHash()) || !NAME_TOKEN.equals(draft.planetName())) {
            throw new IllegalArgumentException("invalid explanation draft: sourceHash or planetName");
        }
        String nameTemplate = pick("name", draft.name(), NAME);
        String periodTemplate = pick("orbitalPeriod", draft.orbitalPeriod(), choices(facts.period(), PERIOD, NO_PERIOD));
        String radiusTemplate = pick("radius", draft.radius(), choices(facts.radius(), RADIUS, NO_RADIUS));
        String massTemplate = pick("mass", draft.mass(), choices(facts.mass(), MASS, NO_MASS));
        String discoveryTemplate = pick("discovery", draft.discovery(),
                choices(facts.discovery(), DISCOVERY, NO_DISCOVERY));
        String name = nameTemplate.replace(NAME_TOKEN, planet.planetName());
        if (Boolean.TRUE.equals(planet.controversial())) {
            name += " 다만 NASA 자료에는 이 행성에 관한 연구 결과에 이견이 있다는 표시가 있어요.";
        }
        Content content = new Content(name, fill(periodTemplate, facts.period()),
                fill(radiusTemplate, facts.radius()), fill(massTemplate, facts.mass()),
                fill(discoveryTemplate, facts.discovery()));
        if (content.name().length() > 240 || content.orbitalPeriod().length() > 240
                || content.radius().length() > 240 || content.mass().length() > 240
                || content.discovery().length() > 240) {
            throw new IllegalArgumentException("explanation section is too long");
        }
        return content;
    }

    private static String fill(String template, String value) {
        return value == null ? template : template.replace(VALUE_TOKEN, value);
    }

    /** 번호("1")나 허용 문장 그대로만 받는다. 목록 복사처럼 그 밖의 값은 필드 이름만 남기고 거절한다. */
    private static String pick(String field, String value, List<String> options) {
        if (value != null && options.contains(value)) {
            return value;
        }
        if (value != null && value.matches("[1-9]") && Integer.parseInt(value) <= options.size()) {
            return options.get(Integer.parseInt(value) - 1);
        }
        throw new IllegalArgumentException("invalid explanation draft: " + field);
    }

    private static List<String> choices(String value, List<String> present, List<String> missing) {
        return value == null ? missing : present;
    }

    private static Facts facts(Planet planet) {
        if (planet == null || !"ps".equals(planet.sourceTable())
                || !"Published Confirmed".equals(planet.solutionType())
                || planet.planetName() == null || planet.planetName().isBlank()
                || planet.planetName().length() > 120
                || planet.planetName().chars().anyMatch(c -> c == '<' || c == '>' || Character.isISOControl(c))) {
            throw new IllegalArgumentException("invalid NASA planet identity");
        }
        // NASA 원문 문자열과 문헌 HTML은 모델에도 결과에도 넣지 않는다.
        String method = switch (planet.discoveryMethod() == null ? "" : planet.discoveryMethod()) {
            case "Transit" -> "별 앞을 지나며 별빛이 잠깐 어두워지는 모습을 관측해";
            case "Radial Velocity" -> "별의 움직임에 따라 별빛이 미세하게 달라지는 모습을 관측해";
            case "Imaging" -> "행성의 모습을 직접 촬영해";
            case "Microlensing" -> "중력 때문에 먼 별빛이 잠시 밝아지는 현상을 관측해";
            case "Astrometry" -> "하늘에서 별의 위치가 미세하게 흔들리는 모습을 측정해";
            case "Pulsar Timing" -> "펄서 신호가 도착하는 시각의 변화를 측정해";
            case "Transit Timing Variations" -> "다른 행성이 별 앞을 지나는 시각의 변화를 측정해";
            case "Eclipse Timing Variations" -> "두 별이 서로 가리는 시각의 변화를 측정해";
            default -> null;
        };
        Integer year = planet.discoveryYear();
        if (year != null && (year < 1600 || year > 2100)) {
            throw new IllegalArgumentException("invalid discovery year");
        }
        String discovery = method == null && year == null ? null
                : method == null ? year + "년에 발견됐어요"
                : (year == null ? "" : year + "년, ") + method + " 발견됐어요";
        return new Facts(measure(planet.periodDays(), "days", "일"),
                measure(planet.radiusEarth(), "earth_radius", "지구 반지름의 "),
                measure(planet.massEarth(), "earth_mass", "지구 질량의 "), discovery);
    }

    private static String measure(Measurement measure, String expectedUnit, String koreanUnit) {
        if (measure == null) {
            return null;
        }
        if (!expectedUnit.equals(measure.unit()) || (measure.limit() != null
                && measure.limit() != -1 && measure.limit() != 0 && measure.limit() != 1)) {
            throw new IllegalArgumentException("invalid NASA measurement unit or limit");
        }
        if (measure.value() == null) {
            return null;
        }
        if (measure.value().signum() <= 0
                || (measure.errorPlus() != null && measure.errorPlus().signum() < 0)
                || (measure.errorMinus() != null && measure.errorMinus().signum() > 0)) {
            throw new IllegalArgumentException("invalid NASA measurement sign");
        }
        // 오차는 문장에 넣지 않지만 기존 숫자 범위 검증은 유지한다.
        if (measure.errorPlus() != null) {
            decimal(measure.errorPlus());
        }
        if (measure.errorMinus() != null) {
            decimal(measure.errorMinus());
        }
        String value = expectedUnit.equals("days") ? decimal(measure.value()) + koreanUnit
                : koreanUnit + decimal(measure.value()) + "배";
        if (expectedUnit.equals("days")) {
            if (measure.limit() == null) return value + "이 걸리는 것으로 기록돼 있어요";
            if (measure.limit() == -1) return value + " 미만의 시간이 걸리는 것으로 기록돼 있어요";
            if (measure.limit() == 1) return value + "을 초과하는 시간이 걸리는 것으로 기록돼 있어요";
            return value + "이 걸려요";
        }
        if (measure.limit() == null) {
            value += "로 기록돼 있어요";
        } else if (measure.limit() == -1) {
            value += " 미만으로 기록돼 있어요";
        } else if (measure.limit() == 1) {
            value += " 초과로 기록돼 있어요";
        } else {
            value += "예요";
        }
        return value;
    }

    private static String decimal(BigDecimal value) {
        if (value.precision() > 20 || value.scale() > 12 || value.scale() < -12) {
            throw new IllegalArgumentException("NASA measurement is out of display range");
        }
        return value.toPlainString();
    }

    private record Facts(String period, String radius, String mass, String discovery) {
    }
}
