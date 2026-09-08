# Planetory 용어 사전 v0.2 (2026-09-07)

원칙
1. 화면에는 쉬운 말만 쓴다. 정확한 용어는 툴팁·괄호·문서에만 둔다.
2. 한 화면에 핵심 메시지는 하나. 숫자와 근거는 접힌 상세로 내린다.
3. 정답·오답·행성을 발견·맞춘 개수 같은 표현은 쓰지 않는다(SRS 8장).
4. 측정하지 않은 값은 긍정·부정 판단처럼 쓰지 않고 `데이터 없음`으로 명시한다.

## 곡선·분석

| 지금 쓰는 말 | 화면에 쓰는 말 | 툴팁·정확한 용어 | 쓰는 곳 |
|---|---|---|---|
| 원본 정제곡선 | 밝기 변화 곡선 | detrended light curve | 분석 |
| 주기도 (BLS) | 반복 주기 그래프 | periodogram / BLS | 분석 |
| 피크 | 봉우리 | peak | 분석 |
| 접힌 곡선 | 주기로 겹친 곡선 | phase-folded curve | 분석·스레드 |
| 잔차 N / 잔차 곡선 | 찾은 신호를 뺀 곡선 N (칩: 뺀 곡선 N) | residual curve · 사용자용 결과는 EC2 온라인 계산 | 분석·결과 |
| transit 위상 구간 | 가려지는 구간 | `phase_start`·`phase_end`, 접힌 곡선에서만 선택 | 분석 |
| 주기 P | 반복 주기 (일) | period | 전체 |
| 주기 재선택 | 다른 봉우리 선택 | periodogram peak reselection · 이후 입력과 x축 확대를 1배로 초기화 | 분석 |
| 주기 미세 조정 | 반복 주기 미세 조정 | fine period adjustment · 현재 주기 허용 범위 안에서 이동, 접힌 곡선 x축 확대 배율만 유지 | 분석 |
| 접힌 곡선 x축 확대 | 가로 확대 | folded-curve x-axis zoom, 1~8배 | 분석·히스토리 |
| 접기 기준 시각 | 화면에 직접 표시하지 않음 | `fold_reference_time_btjd` · 공개 묶음의 각 곡선이 제공하며 브라우저·서버가 공통 사용 | 분석 내부 |
| epoch (BTJD) | 기준 시각 | epoch, BTJD · 선택 중 브라우저 미리보기, 제출 시 서버 최종 파생 | 분석·결과 |
| 지속시간 | 가려진 시간 (시간) | duration · 선택 중 브라우저 미리보기, 제출 시 서버 최종 파생, 직접 입력 없음 | 전체 |
| 깊이 ppm / ppt | 어두워진 정도 (%) | depth · 1 ppt = 0.1% | 전체 |
| 위상 0.5 | 주기 절반 지점 | phase 0.5 | 도구 |
| 2배 조화 | 2배 주기 (같은 신호) | harmonic | 결과·스레드 |
| 판별 도구 | 확인 도구 | vetting | 분석 |
| 근거 체크 | 근거 표시 | evidence flags | 분석 |
| 홀짝 깊이 비슷 | 홀수·짝수 밝기 같음 | odd/even depth | 도구 |
| 2차 식 없음 | 반대편 가려짐 없음 | no secondary eclipse | 도구 |
| U형 통과 / V형 | 바닥 평평한 모양 / 뾰족한 모양 | U-shaped / V-shaped | 도구 |
| 중심 위치(P0) | 중심 위치: 데이터 없음 | centroid unavailable · `중심 이동 없음`의 뜻이 아니며 선택 근거가 아님 | 도구 |
| 품질 구간 밖 | 불량 구간 아님 | quality mask | 도구 |
| 식쌍성 | 서로 가리는 쌍성 | eclipsing binary | 스레드 |

## 신호·성과

| 지금 쓰는 말 | 화면에 쓰는 말 | 툴팁·정확한 용어 | 쓰는 곳 |
|---|---|---|---|
| 후보 / 후보표 | 신호 / 기록된 신호 목록 | candidate (TCE) | 전체 |
| 확정 행성 | 확인된 행성 | confirmed (CP·KP) | 전체 |
| 미확정 후보 | 아직 확인 안 된 신호 | PC·APC | 전체 |
| FP | 행성 아님 | false positive (FP·FA) | 전체 |
| 매칭 | 일치 / 찾음 | match | 전체 |
| 성과 인정 | 인정됨 | credited | 전체 |
| 정답 / 오답 (금지) | 기록과 일치 / 판단이 달라요 / 일치하는 신호 없음 | — | 결과 카드 |
| not_matched | 후보표와 일치하지 않는 신호 | no candidate-table match · 후보 자동 생성 없음 | 결과·스레드 |
| 후보 없음 의견 | 더 없음 의견 | no-more-candidate opinion | 분석·결과 |
| DISCUSSION | 토론 | user-selected discussion · 현재 분석 기록 첨부 | 스레드 |
| 판정 | 확인 | verdict | 버튼 |
| AI 판정 | AI 점수 (인정에는 쓰이지 않음) | AI score | 결과 |

## 별·기타

| 지금 쓰는 말 | 화면에 쓰는 말 | 툴팁·정확한 용어 | 쓰는 곳 |
|---|---|---|---|
| TIC 231663901 | TIC 231663901 (유지) | TESS Input Catalog ID | 전체 |
| Sector | 관측 회차 | sector | 전체 |
| Tmag | 밝기 등급 | TESS magnitude | 전체 |
| BTJD | (단위 숨김) | Barycentric TESS Julian Date | 결과 |
| 열린 별 / 잠긴 별 | 발견한 별 / 아직 못 찾은 별 | unlocked / locked | 홈 |
| 열린 사유 | 발견 경로 | unlock source | 패널 |
| 등급 A·S·SS·SSS | 유지 | star grade | 전체 |
| 튜토리얼 / 챌린지 | 유지 | — | 홈 |
