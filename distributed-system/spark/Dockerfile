# syntax=docker/dockerfile:1

# GCP x86_64에서 실행할 Spark 이미지를 빌드 인자로 전달한다.
ARG SPARK_IMAGE
FROM ${SPARK_IMAGE} AS runtime

USER root
WORKDIR /opt/planetory
COPY distributed-system/spark/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY distributed-system/spark/ ./jobs/
COPY libs/astro-kernel/astro_kernel/ ./astro_kernel/
RUN chown -R 185:0 /opt/planetory

USER 185
ENTRYPOINT ["/opt/spark/bin/spark-submit"]
CMD ["--master", "yarn", "--deploy-mode", "cluster", "/opt/planetory/jobs/tess_bronze.py", "--help"]
