# #182 프로토타입 관측 데이터 연결

현재 화면에 TOI-270, L 98-59, CM Draconis의 기존 TESS 관측 export를 연결하는 로컬 개발 모드이다. 실제 관측에서 유래한 곡선을 사용하지만 공식 Gold·실제 인증·회원 진행·후보 카탈로그 API의 연동은 아니다. 디자인은 이후 한 번에 적용한다. 이전 기능 단계와 합성 오류 예제는 [분석 개발 안내](analysis-data.md)를 따른다.

## 입력과 재현

입력은 `experiments/analysis-ui/public/observations/`에 제공된 `manifest.json`, `toi270.json`, `l98-59.json`, `cm-dra.json`이다. 준비 스크립트는 명시적으로 지정한 폴더만 읽으며 manifest의 SHA-256·파일 크기·TIC·Bundle·점 수를 검사한다. 원본 FITS·export는 변경하지 않는다.

프론트 디렉터리에서 실행한다.

```powershell
npm.cmd run data:prepare -- --source-dir "<기존 observations 폴더>"
npm.cmd run dev:observations
```

결과는 Git에서 제외한 `dev/observations/`에 생성한다. `public/`에 두지 않으므로 Vite가 정적 파일로 배포하지 않는다. 합성 fixture와 달리 파일을 제공받거나 위 명령을 실행해야 한다. 입력 파일이 없거나 해시가 다르면 준비를 중단한다. 실행 중 로컬 데이터가 없거나 변조되면 503을 반환하고 합성 정상 곡선으로 대체하지 않는다.

현재 워크스페이스에는 원본 저장소 `Planetory/experiments/analysis-ui/public/observations`의 export를 사용했다. 저장소 밖 `tools/analysis-182/prepare-data.cmd`가 그 경로를 지정하고 `dev.cmd`는 5182 관측 모드를 시작한다. 일반 `dev:fixture`와 기존 브라우저 검사는 종전의 14점 합성 응답을 유지한다.

## 실제 데이터와 로컬 메타데이터의 구분

기존 export는 TESS SPOC 2분 cadence의 PDCSAP_FLUX에서 QUALITY 불량·비유한·비양수 입력을 제외하고, Sector별 중앙값 정규화·Savitzky–Golay 추세 제거·상단 5-MAD clipping을 적용한 결과다. 이번 작업에서 정제나 BLS를 새로 적용하지 않았다. 상세 원본 추적과 기존 처리법은 저장소의 `experiments/analysis-ui/scripts/README-observations.md`에 있다.

| 항목                      | 이번 연결의 출처·처리                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| TIC·Sector·밝기·관측 범위 | 프로토타입의 실제 관측 export                                                                                                       |
| 기준 시각                 | export의 `fold_reference_time_btjd` float64 그대로 보존; 비닝 후 다시 계산하지 않음                                                 |
| 밝기 배열                 | Sector별 10분 bin에 포함되는 정제값의 산술평균                                                                                      |
| bin 시각                  | 해당 Sector의 export 관측 시작을 격자 시작으로 사용. `startBtjd + index × 10/1440`은 bin의 왼쪽 경계이며 원본 개별 관측 시각과 구분 |
| 빈 bin                    | null, 연속 null은 폐구간 gaps로 표시. 보간하지 않음                                                                                 |
| 부분 bin                  | 하나 이상의 관측값이 있으면 그 점들의 평균. 마지막 부분 bin도 포함                                                                  |
| 산포                      | Sector 정제값 전체의 `1.4826 × median(abs(flux - median(flux)))`                                                                    |
| Bundle·세그먼트 ID        | 입력 해시와 변환 버전에서 만든 로컬 숫자 문자열 ID; 서비스 DB ID 아님                                                               |
| 버전·진행                 | 로컬 버전 1, 원본(step 0), 제거 후보 없음                                                                                           |
| 확정 행성 보유 여부       | 카탈로그 미연결. DTO boolean은 형식용 placeholder이며 화면은 `미연결`로 표시                                                        |

평균·산포·부분 bin 처리는 **로컬 변환 규칙 `prototype-observation-10m-mean-v1`**이다. Gold 명세에서 이 세부 방법은 별도 결정 대상이므로 이 구현을 운영 규칙으로 확정하지 않는다. 모든 정제 관측점은 정확히 한 bin의 평균에 기여하며 개별 2분 값·시각을 그대로 화면에 표시하는 방식은 아니다. 원본 export는 보존하고 출력 provenance의 bin별 기여 점 수로 총수를 대조한다. Sector당 20,000 bin을 넘으면 자동 정책을 발명하지 않고 준비를 중단한다.

CM Draconis의 입력 11,558점은 이전 clipping 뒤의 결과다. 기존 전처리는 정제 전 유효점 14,900개에서 상단 3,342개를 제외했다. 이번 연결은 그 결과를 재사용하며 해당 clipping의 과학적 적합성을 새로 보증하지 않는다.

## 데이터 응답과 조작

`observations` 모드의 Vite 개발 서버가 기존 GET `analysis-context` → `curves`에 생성 파일의 문맥·곡선을 각각 JSON으로 반환한다. 성공 응답의 `X-Current-Bundle`도 로컬 Bundle ID와 일치한다. 프로토타입의 BLS·피크·정답·행별 출처 파일 전체를 API에 내보내지 않는다. 원본 단계만 제공하고 임의의 잔차 요청은 400이다. 실제 서버 모드의 요청 경로·클라이언트·어댑터·차트는 같은 구조를 사용한다.

화면의 항성 선택 링크로 세 TIC를 이동하고, 휠·확대 버튼·드래그·키보드로 차트를 확인한다. 주소는 다음과 같다.

| 항성        | TIC 경로              | Sector | 입력 정제점 | 전체 10분 bin | 유효 bin | 결측 bin |
| ----------- | --------------------- | ------ | ----------: | ------------: | -------: | -------: |
| TOI-270     | `/analysis/259377017` | 3·4·5  |      44,551 |        10,250 |    9,016 |    1,234 |
| L 98-59     | `/analysis/307210830` | 2·5·8  |      47,579 |        10,928 |    9,627 |    1,301 |
| CM Draconis | `/analysis/199574208` | 16     |      11,558 |         3,420 |    2,727 |      693 |

## 검증 기록 — 2026-09-15

- 기존 `verify_observations.py`를 로컬 FITS 7개에 실행했다. 세 별 모두 원본 해시·제외 마스크·전체 정제값·원본 시각·float64 기준 시각의 일치가 확인됐다. BLS는 다시 계산하지 않았다.
- 변환 시 세 export의 manifest 해시·건수와 모든 입력점의 bin 기여 총수를 확인하고, 생성 문맥·곡선을 현재 프론트 decoder로 검사했다.
- 전체 단위 37개, 기존 Chromium 17개, 프로덕션 2개와 별도 관측 브라우저 검사 1개가 통과했다(57개). 관측 검사는 세 항성 전환, 전체 HTTP 곡선 배열과 파일의 일치, 점 수, 차트 확대·초기화·수동 재조회, 1024px 가로 넘침과 브라우저 오류를 확인한다.
- 빌드·포맷 검사와 개발 데이터의 운영 번들 제외 검사가 통과했다. 5182 실행 화면에서 TOI-270의 실제 곡선·Sector·공백을 확인했다.

관측 데이터 브라우저 검사는 로컬 데이터를 준비한 뒤 별도로 실행한다. 원본을 포함하지 않는 새 checkout의 기본 검사는 합성 fixture로 계속 실행할 수 있다.

```powershell
npm.cmd run test:observations
```

운영 전처리와의 수치 일치, 실제 백엔드·DB·인증 연동, 분류·행성 판정과 운영 성능 벤치마크는 이 검증에 포함하지 않는다.
