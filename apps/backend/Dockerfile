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
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
