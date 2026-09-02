# TESS 반자동 BLS 감광 신호 탐색 PoC

TESS Light Curve FITS에서 BLS(Box Least Squares) 주기 후보를 만들고, 사용자가 위상 접기 그래프를 직접 비교해 감광 구간을 선택하는 실험용 도구입니다. 후보 승인 시 관측점을 삭제하지 않고 승인된 모든 후보를 공동 재적합한 뒤, 모델로 나눈 잔차에서 다음 신호를 찾습니다.

이 PoC는 행성 확정 도구가 아닙니다. 식쌍성, 항성 활동, 계통 오차와 주기의 정수배·분수배도 BLS 후보로 나타날 수 있습니다.

## 예시 천체

- 행성계 · TOI-270 (TIC 259377017): TESS Sector 3·4·5
- 행성계 · L 98-59 (TIC 307210830): TESS Sector 2·5·8
- 식쌍성 · CM Draconis (TIC 199574208): TESS Sector 16

다운로더는 공식 MAST SPOC 2분 cadence Light Curve를 `sample_raw/` 아래에 저장합니다. 원본 FITS와 실행 산출물은 Git에 포함하지 않습니다.

## 분석 흐름

```text
BLS 내부 격자 계산
  → 상위 주기 후보 최대 10개 공개
  → 슬라이더로 주기를 조절하며 수동 위상 정렬
  → 그래프에서 예상 감광 구간 드래그
  → 중심·지속시간·깊이 계산 및 후보 승인
  → 원본에서 모든 승인 후보 공동 재적합
  → 후보 모델로 나눈 잔차에서 다음 BLS 실행
```

BLS가 후보 순위를 위해 내부적으로 구한 기준시각, 지속시간, 깊이와 전체 periodogram 곡선은 탐색 화면에 미리 노출하지 않습니다. 주기 그래프에는 정제된 관측점 전체를 두 주기 반복해 표시합니다. 마우스 휠은 포인터를 기준으로 X축만 확대·축소하고, 더블클릭은 전체 보기로 복귀합니다. 확대 상태에서 주기를 바꿔도 상대 위상 위치와 확대율을 유지합니다.

감광 구간은 좌클릭 드래그로 처음 만들고, 이후 양 끝 핸들을 끌어 수정합니다. 겹친 감광 신호를 보존하기 위해 관측점을 삭제하거나 마스킹하지 않습니다.

## 실행

Python 3.11 이상과 `uv`가 필요합니다.

```powershell
cd experiments/tess-bls
uv sync --locked
uv run python download_toi270.py
uv run python download_l98_59.py
uv run python download_cm_dra.py
uv run streamlit run semi_auto_bls.py
```

Windows에서는 아래 스크립트로 설치, 예제 다운로드, 앱 실행을 한 번에 수행할 수 있습니다.

```powershell
./run_semi_auto_bls.ps1
```

Streamlit이 출력한 로컬 주소를 브라우저에서 열고 다음 순서로 진행합니다.

1. 예시 천체를 선택하고 `현재 잔차에서 BLS 계산`을 누릅니다.
2. 최대 10개 후보 중 하나를 골라 주기 슬라이더로 감광점이 겹치는지 확인합니다.
3. `이 주기로 감광 구간 선택`을 누르고 그래프에서 예상 구간을 드래그합니다.
4. 계산된 중심·지속시간·깊이를 확인하고 `후보 승인`을 누릅니다.
5. 잔차에서 BLS를 다시 계산해 다음 후보를 찾습니다.

## 검증 참고값

- TOI-270: 5.66051일, 11.38194일, 3.35992일
- L 98-59의 통과 행성: 2.2531140일, 3.6906764일, 7.450729일
- CM Draconis: 문헌 공전주기 1.2683900573일. 주극소와 부극소가 비슷해 BLS에서 약 0.634195일이 더 강하게 나타날 수 있습니다.

이 값은 UI와 탐색 흐름의 검증 참고값이며, 후보 화면에는 정답으로 미리 표시하지 않습니다.

## 테스트

```powershell
uv run python -m py_compile pipeline.py phase_selector.py semi_auto_bls.py download_toi270.py download_l98_59.py download_cm_dra.py
uv run pytest -q
```

## 구성

| 파일 | 역할 |
|---|---|
| `pipeline.py` | FITS 로드, 정제, BLS, 위상 접기, 공동 재적합 커널 |
| `semi_auto_bls.py` | Streamlit 분석 흐름과 상태 관리 |
| `phase_selector.py` | 주기 및 감광 구간 선택용 대화형 그래프 |
| `download_*.py` | 공식 MAST 예시 데이터 다운로더 |
| `tests/` | BLS·재적합·프리셋·다운로더 회귀 테스트 |
