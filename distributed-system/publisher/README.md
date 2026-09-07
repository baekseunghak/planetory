# Publisher

완료된 Silver를 검사하고 EC2용 Gold 묶음으로 포장·전송하는 코드를 둘 위치다.

경로, 버전과 checksum을 검증한 뒤 전달한다. 전송이나 검증에 실패하면 기존 Gold를 바꾸지 않는다.
