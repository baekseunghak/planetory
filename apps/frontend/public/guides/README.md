# 사용법 다시 보기 에셋

Planetory 내부 조작 안내용 도식 5개(GIF)와 대응 정지 프레임(PNG)이다. 실제 NASA 이미지나 분석 화면 녹화가 아니다. 이 저장소의 scripts/generate-guides.py가 선·도형·문자를 생성하며 외부 이미지 자산은 사용하지 않는다. Windows 글꼴은 생성 시 렌더링에 사용하고 글꼴 파일은 배포하지 않는다.

1. 01-star-select: 별 선택
2. 02-bls-peak: 봉우리 선택
3. 03-transit-interval: 구간 선택
4. 04-judgment: 판단과 근거
5. 05-submission: 검토 후 제출

재생성: Pillow를 사용할 수 있는 Python으로 `python scripts/generate-guides.py --output public/guides`를 실행한다. Windows 글꼴 경로를 사용할 수 없는 환경은 생성기의 글꼴 선택을 환경에 맞게 지정한다. GIF/PNG는 기능 UI에서 사용하는 배포 자산이고 테스트 로그가 아니다.

UsageGuide.tsx는 이미지 실패 시에도 단계 제목·본문·버튼을 유지하고 모션 줄이기/수동 정지에는 PNG를 사용한다. 내용은 설명용 초안이며 A14 실제 조작과 문구의 팀 교차 검토는216-214에 남아 있다. 제출 성공을 탐색 완료/새 성과와 동일시하지 않는다.
