# syntax=docker/dockerfile:1

# OCI ARM64 실행이 확인된 Airflow 이미지를 빌드 인자로 전달한다.
ARG AIRFLOW_IMAGE
FROM ${AIRFLOW_IMAGE} AS runtime

USER airflow
COPY --chown=airflow:0 distributed-system/airflow/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY --chown=airflow:0 distributed-system/airflow/dags/ /opt/airflow/dags/
