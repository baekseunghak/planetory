# syntax=docker/dockerfile:1

FROM eclipse-temurin:21-jdk-alpine AS development
WORKDIR /workspace

COPY apps/backend/ ./
RUN chmod +x gradlew
EXPOSE 8080
CMD ["./gradlew", "bootRun", "--no-daemon"]

FROM development AS build
RUN ./gradlew bootJar --no-daemon

FROM eclipse-temurin:21-jre-alpine AS runtime
WORKDIR /app

RUN addgroup -S planetory && adduser -S planetory -G planetory
COPY --from=build --chown=planetory:planetory /workspace/build/libs/*.jar app.jar

USER planetory
# 기본 프로필(local)의 로컬 DB 비밀번호·Swagger가 배포에 적용되지 않도록 한다.
ENV SPRING_PROFILES_ACTIVE=prod
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
