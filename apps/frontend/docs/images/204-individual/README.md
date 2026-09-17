# 204 개별 별 시각 검증

2026-09-15, 설치된 Edge에서 Playwright가 생성한 로컬 fixture 캡처다. 실물 관측 사진이나 실제 운영 계정이 아니다. v1.3 참조와 동일한 안정 순번·저장 좌표를 사용한다.

- [별1개](reference-1.png), [10개](reference-10.png), [100개](reference-100.png), [1000개](reference-1000.png): 캔버스1440×836, DPR1, `{x:0.8116955263673162,y:-104.409147077857,zoom:1.0568820479252328,yaw:0.12,tilt:1,roll:-0.28}`.
- [회전](reference-rotated.png): 같은1000개, yaw0.72/tilt1.1575. 나머지 값 동일.
- [선택 별의 행성5개](five-planets.png): 캔버스1440×936, 고정 합성 TIC900000001에 근접, zoom8. 이 이미지의 조작/목록/정보 패널은206 완성 화면이 아니다.

원본 기준은 [MR !41 sky-reference](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/tree/7f67c5683f79e541da556ef4e6aed966ff317c11/docs/development/sky-reference)다. 같은 평면 위치와 깊이로 개인 은하 형상을 유지하며 군집으로 치환하지 않는다. DOM 메뉴/마커는 이번204 외형 비교 대상에서 제외한다. GPU별 미세 픽셀 차이는 허용한다. 이 자료로10만 별 성능이나 실제 소유권/DB 계약을 합격 처리하지 않는다.
