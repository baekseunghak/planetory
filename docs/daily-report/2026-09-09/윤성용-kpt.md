# 2026-09-09 KPT

## Keep

- AstroNet-Triage의 공식 checkpoint 가중치를 실제로 복원해 공식 테스트 데이터와 Planetory TESS 후보에서 추론이 가능한지 확인했다.
- TOI-270, L 98-59, CM Draconis의 BLS 후보를 AstroNet의 `global 201`·`local 61` 입력으로 변환해 비교 실행했다.
- TOI-270 c 대응 후보는 0.258, L 98-59 c 대응 후보는 0.816, CM Draconis 식쌍성 후보는 0.998을 출력한 결과를 기록했다.
- 점수가 행성 확률이 아니라 `PC/EB 대 junk` 1차 triage 점수임을 공식 라벨 정의로 확인하고, AI 모델 실행 가능성 문서의 해석을 바로잡았다.

## Problem

- 확인된 행성 후보인 TOI-270 c와 L 98-59 c의 점수 차이가 커서, 현재 Planetory 전처리와 단일 checkpoint 결과만으로 성능이나 임계값을 결정할 수 없다.
- AstroNet-Triage는 행성 후보와 식쌍성을 구분하지 않으므로 행성 최종 판별 모델로 단독 사용할 수 없다.
- QLP 학습 전처리와 Planetory의 SPOC `PDCSAP_FLUX` 전처리 차이, 공식 10개 checkpoint ensemble 적용 여부를 추가로 평가해야 한다.

## Try

- TIC 단위로 분리한 확인 행성 후보(PC), 식쌍성(EB), 잡음(junk) 평가 세트를 만들고 1차 triage의 재현율·정밀도·PR-AUC를 측정한다.
- PC와 EB 구분에는 AstroNet-Vetting 또는 별도 검증 규칙을 비교한다.
- 팀과 AstroNet의 서비스 내 역할을 1차 후보 선별로 둘지 합의하고, GPL-3.0 라이선스와 후속 성능 평가 Jira 범위를 함께 정리한다.
