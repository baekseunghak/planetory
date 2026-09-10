# syntax=docker/dockerfile:1

FROM python:3.12-slim AS runtime
WORKDIR /app

COPY distributed-system/ingestion/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY distributed-system/ingestion/ ./
RUN useradd --system --uid 10001 planetory && chown -R planetory:planetory /app

USER 10001
CMD ["python", "-m", "ingestion"]
