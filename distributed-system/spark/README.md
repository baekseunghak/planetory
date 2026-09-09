# Spark

Raw를 Bronze와 Silver로 변환하는 PySpark 작업을 둘 위치다.

운영 작업은 YARN에 제출하고 결과는 HDFS에 쓴다. 서비스 DB나 EC2 Gold를 Spark Worker가 직접 수정하지 않는다.
