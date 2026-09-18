# 분석 화면 SVG 출처

[Figma 02 분석 단계 · 1–5](https://www.figma.com/design/khh8ZkqU7ivmUftKWrxSxn?node-id=25-2)의 아이콘을 #236 구현에 사용한다. 2026-09-17 Figma MCP 디자인 문맥이 제공한 SVG 원본이다.

| 파일 | Figma asset ID | 용도 |
| --- | --- | --- |
| reset.svg | 4b8b6df6-af0f-4fd1-b11f-8421531974a1 | 전체 보기 |
| delete.svg | 60949442-121e-4599-bf89-7c9895b5df83 | 선택 구간 지우기 |
| yes.svg | 6adefdd9-34af-4192-85c5-123d869eac56 | 행성 같음 |
| no.svg | 2a25b8a9-ae82-484f-a47e-f7072dd29e51 | 아닌 것 같음 |
| unsure.svg | eb91ef61-ad03-4e55-b1ad-c57548161e4c | 모르겠음 |

아이콘은 장식 이미지로 표시하며 버튼/입력의 접근 가능한 이름은 HTML 레이블로 제공한다.

## 은하 배경

| 파일 | 출처 | 용도 |
| --- | --- | --- |
| galaxy-background.webp | 사용자 제공 이미지(2026-09-18) | 분석 화면 배경 |

Figma `00 은하 배경 · 이미지 교체 가능` 자리에 넣는 이미지다. 원본 PNG 1505×1045 · 2.0MB를 품질 0.92 WebP 206KB로 변환했고 평균 채널 오차는 1.3이다. 밝기는 평균 rgb(10,13,21), 상위 0.1% rgb(170,168,185)다.

이미지를 바꾸면 [디자인 토큰 문서](../../../../docs/design.md)의 허용 최대 밝기를 확인하고 `scripts/check-contrast.mjs`의 `BRIGHTEST`를 실측값으로 바꿔 다시 실행한다.
