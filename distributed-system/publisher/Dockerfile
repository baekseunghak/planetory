# syntax=docker/dockerfile:1

FROM python:3.12-slim AS runtime
WORKDIR /app

COPY distributed-system/publisher/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Gold checksum은 공용 astro_kernel.gold_canonical로 계산한다. 기본 의존성은 numpy뿐이다(BLS용 astropy·scipy는
# 선택이라 설치하지 않는다).
COPY libs/astro-kernel/ /tmp/astro-kernel/
RUN pip install --no-cache-dir /tmp/astro-kernel && rm -rf /tmp/astro-kernel

# preflight가 DB의 Flyway 버전을 이 목록의 최신과 비교한다. 뒤처진 DB에는 적재하지 않는다.
COPY apps/backend/src/main/resources/db/migration/ /app/migrations/
ENV PUBLISHER_MIGRATIONS_DIR=/app/migrations

COPY distributed-system/publisher/ ./
RUN useradd --system --uid 10001 planetory && chown -R planetory:planetory /app

USER 10001
CMD ["python", "-m", "publisher"]
