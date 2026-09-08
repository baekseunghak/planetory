# 데이터 출처·스키마·재현 방법

이 시제품에는 공개 TESS 관측 자료에서 추출한 **별 3개·관측 7건·광도곡선 9,800점**만 포함한다. 화면 비교에 필요한 작은 정적 표본이며 전체 분석 데이터셋이 아니다. 원본 FITS는 저장소에 포함하지 않는다.

## 원천 자료와 처리

`shared/data-provenance.json`에 7개 공식 MAST 제품의 다운로드 URL과 원본 SHA-256이 있다. [MAST TESS 자료](https://archive.stsci.edu/missions-and-data/tess)는 공개 천문 관측 데이터이며 개인 데이터가 아니다.

| 천체 | TIC | RA / Dec (도) | 섹터 |
|---|---|---|---|
| TOI-270 | 259377017 | 68.41550094 / −51.95623229 | 3, 4, 5 |
| L 98-59 | 307210830 | 124.53175629 / −68.31299987 | 2, 5, 8 |
| CM Draconis | 199574208 | 248.58470796 / +57.16232376 | 16 |

FITS primary header의 천체 정보와 확장 테이블의 TIME/PDCSAP_FLUX/QUALITY를 사용한다. QUALITY=0 및 유한한 값만 선택하고 시간순 정렬 후 회차별 중앙값으로 정규화한다. `linspace(0, n−1, 1400).astype(int)` 인덱스로 1,400점을 뽑고 시간은 소수 5자리, 밝기는 6자리로 반올림한다. 공백이 있는 실제 관측 자료이며 축약 중 짧은 신호가 빠질 수 있다. detrending/BLS/채점은 수행하지 않는다.

제안안의 `shared/sectors.js`는 [tesswcs 1.9.0](https://pypi.org/project/tesswcs/1.9.0/) wheel의 archival WCS에서 생성한 S2/3/4/5/8/16, 96개 CCD 경계다. wheel SHA-256을 코드에 고정해 검증한다. 저장된 CRPIX/CRVAL/CD/SIP를 사용하며 과학 영상 영역(FITS 1-based 열 45–2092, 행 1–2048)의 외곽을 변당 32점씩 샘플링한다. 경계 좌표는 7자리 반올림한다. 대표 WCS이며 관측 중의 자세 변화를 재현하지 않는다.

7개 실제 별 관측이 해당 sector/camera/CCD의 과학 영상 영역에 들어가는지 역변환한 결과는 `shared/sector-validation.json`에 있다. 이 파일 확인만으로 WCS 계산을 재실행한 것은 아니다. 아래 재생성 명령이 실제 역변환도 수행한다.

## 재생성

기존 `experiments/tess-bls/uv.lock`의 환경을 재사용한다. Python 3.12, uv가 필요하고 최초 다운로드에는 네트워크가 필요하다. 아래 명령은 **저장소 루트** 기준이다.

```sh
uv sync --locked --project experiments/tess-bls
uv run --project experiments/tess-bls python -B experiments/tess-bls/download_toi270.py
uv run --project experiments/tess-bls python -B experiments/tess-bls/download_l98_59.py
uv run --project experiments/tess-bls python -B experiments/tess-bls/download_cm_dra.py
uv run --project experiments/tess-bls python -B experiments/star-map-prototype/scripts/build_data.py --raw-dir experiments/tess-bls/sample_raw/tess
uv run --project experiments/tess-bls python -B experiments/star-map-prototype/scripts/build_sectors.py
```

`build_data.py`는 기존 다운로드 스크립트의 고정 제품 목록을 사용한다. 검증 당시 환경은 Python 3.12.14 / NumPy 2.5.2 / Astropy 7.2.2다. `--output-dir`로 검토용 다른 출력 디렉터리를 지정할 수 있다. `build_sectors.py --data <data.js> --output-dir <directory>` 역시 가능하다. 출력은 결정적이며 실행 시간이 데이터에 섞이지 않는다. 다운로드 도구·실행 환경은 형제 실험에 의존하므로 이 폴더만 복사하면 화면 실행은 가능하지만 FITS 재생성은 저장소 전체가 필요하다.

## 스키마

현 표본은 아래 모든 필드를 필수로 가지며 null은 허용하지 않는다. 천체 정보 누락 시 임의의 0으로 대체하지 않고 생성이 실패한다. 이후 범위를 늘릴 때 별도 nullable 정책을 정해야 한다.

| 경로 | 타입 / 단위 | 의미 / 예시 |
|---|---|---|
| `data[].tic` | string | TIC ID, `259377017` |
| `name` | string | 출처 식별용 천체명, `TOI-270` |
| `ra`, `dec` | number / 도 | ICRS 방향, RA [0,360), Dec [−90,90] |
| `tmag` | number / 등급 | TESS 대역 밝기, 10.49810028 |
| `temperature`, `radius` | number / K, 태양 반지름 | FITS TEFF와 RADIUS, 3532 / 0.374358 |
| `x`, `y`, `generation` | integer | 명세안의 시연용 배치·세대. 제안안 좌표에는 사용하지 않음 |
| `observations[]` | array | 관측별 정보, 별당 1 또는 3건 |
| `observations[].sector`, `camera`, `ccd` | integer | 회차, 카메라 1–4, CCD 1–4 |
| `rows`, `validRows` | integer | 원본 행 수와 QUALITY/finite 필터 통과 수 |
| `start`, `end` | string / YYYY-MM-DD | FITS DATE-OBS/END의 날짜 부분 |
| `file` | string | 공식 FITS 제품명, provenance 파일과 연결 |
| `curves[].sector` | integer | 해당 관측 회차 |
| `curves[].points` | number[1400][2] | `[BJD−2457000 일, 중앙값 정규화 밝기]` |
| `sectors[].sector`, `ra`, `dec`, `roll` | integer, number / 도 | 회차와 대표 자세 |
| `sectors[].ccds[]` | array[16] | 4카메라 × 4CCD |
| `ccds[].camera`, `ccd` | integer | 영역 식별자 |
| `ccds[].center` | number[2] / 도 | `[RA, Dec]` |
| `ccds[].boundary` | number[128][2] / 도 | 외곽 `[RA, Dec]`, 마지막 점과 처음 점을 연결 |

`data.js`는 `window.PLANETORY_DATA`, `sectors.js`는 `window.PLANETORY_SECTORS`에 값을 할당한다. 광도곡선과 좌표는 실제 자료지만 x/y, 해금 순서, 진행 상태는 시연용이다. 배경 점은 seed 206의 장식이며 카탈로그 대상 수에 포함하지 않는다.

## 재배포 고지

- Pretendard 글꼴: SIL Open Font License, `shared/Pretendard-LICENSE.txt` 원문 포함.
- tesswcs WCS: MIT, `shared/tesswcs-LICENSE.txt` 원문 포함.
- 단일 HTML 내보내기에도 두 고지를 포함한다. TESS 입력의 출처·제품 버전은 provenance에 보존한다.
