# TOI-270 관측 자료

이 분석실은 기존 `experiments/analysis-ui/public/observations/toi270.json`의 실제 TESS 관측 자료를 사용한다. 대상은 **TOI-270 / TIC 259377017**, 관측 섹터는 **3·4·5**다. 새 파일은 화면에서 읽기 쉽게 필드 이름과 출처 구조만 바꾼 자료이며 추가 정리, 표본 추출, 반올림, BLS 재계산을 수행하지 않았다.

## 화면용 스키마

공개 경로: `/observations/toi270.json`

```ts
type Observation = {
  schemaVersion: 'analysis-lab-observations-v1';
  id: 'toi270';
  label: 'TOI-270';
  tic: string;
  pointCount: number;
  sectors: number[];
  time: number[]; // BTJD: BJD_TDB - 2457000, 일
  flux: number[]; // 같은 인덱스의 정규화 상대 광도
  referenceTime: number; // 원본 export에서 한 번 고정한 위상 접기 기준
  seedPeriod: number; // 관측 BLS의 1위 피크, 일
  periodogram: { periods: number[]; powers: number[] };
  source: object; // 입력 JSON 해시, FITS별 출처·해시·개수, 처리 규칙
};
```

`time[i]`와 `flux[i]`, `periodogram.periods[i]`와 `periodogram.powers[i]`가 각각 대응한다. 초기 주기 `seedPeriod`는 **5.660332541567696일**이며 저장된 BLS power의 최댓값 위치와 일치한다. 행성의 정답 주기나 확정 여부를 의미하지 않는다. 후보 행성 이름, 사전 정답표, 정답 epoch·지속시간·판정은 포함하지 않는다.

위상은 `((time[i] - referenceTime) / period % 1 + 1) % 1`로 계산할 수 있다. `referenceTime`은 **1429.1169200902307 BTJD**이며, 주기를 바꿔도 유지한다. 이 값은 통과 중심 시각이 아니다.

## 보존 범위와 처리 이력

| 항목 | 값 |
| --- | --- |
| 원본 FITS 행 수 | 57,320 |
| 품질·유한값·양의 광도 조건을 통과한 행 수 | 44,553 |
| 기존 정리 후 관측점 수 | 44,551 — 새 JSON에 전부 보존 |
| 제외 이력 | QUALITY 비영 10,805 / 비유한값 1,962 / 비양수 광도 0 / 상단 이상점 2 |
| 시간 범위 | 1385.9498273281822–1463.673501341899 BTJD |
| 정규화 광도 범위 | 0.9932254422559673–1.0067173492634753 |
| BLS 표본 | 8,000개, 0.5–40일 |
| BLS power 범위 | 0.000006231352268631394–0.002550673835016898 |
| 새 JSON 크기 | 2,005,792 bytes |

기존 export의 처리 기록은 `PDCSAP_FLUX`, 섹터별 중앙값 정규화, 구간별 Savitzky–Golay 2차 추세 제거(2일 창), 상단 5-MAD 이상점 제거다. 접기 기준은 정리 전 `QUALITY=0`, 유한 TIME·PDCSAP_FLUX, 양의 PDCSAP_FLUX를 만족하는 원본 시간의 float64 중앙값이다. 기존 자료에는 점별 FITS 행 번호와 제외 행 목록도 있으나, 화면용 파일에서는 관측값을 유지하면서 이 상세 감사 자료만 생략했다.

원본 FITS는 워크스페이스의 `archive/TESS_BLS_semi_auto/sample_raw/tess/toi270/`에 저장됐다고 기존 provenance에 기록되어 있다. 이 작업은 아래 출처 기록을 승계했으며 **FITS를 다시 읽거나 다운로드하지 않았다**.

| 섹터 | 원본 FITS 파일 | 보존 점 수 | 기록된 SHA-256 |
| --- | --- | ---: | --- |
| 3 | `tess2018263035959-s0003-0000000259377017-0123-s_lc.fits` | 12,974 | `edaa0de029f6fde3d045352887ef1a2950bb9b38fc18075066c81d7638feb695` |
| 4 | `tess2018292075959-s0004-0000000259377017-0124-s_lc.fits` | 14,443 | `09f1e69d89dce001e447fbc509b9453f033b2428d183add334b43b93dbc8c93b` |
| 5 | `tess2018319095959-s0005-0000000259377017-0125-s_lc.fits` | 17,134 | `739250df0d1ccda4304e01213f1f0f53c24603e3e223ff646157b6721665a9d5` |

## 재생성과 검증

원본 FITS와 생성 관측 JSON은 Git에 포함하지 않는다. 새 checkout에서는 먼저 기존 export의 `toi270.json`과 그 파일의 해시·크기가 기록된 `manifest.json`을 `experiments/analysis-ui/public/observations/`에 준비한다. 두 파일을 팀에서 제공받거나 [FITS export 절차](../analysis-ui/scripts/README-observations.md)를 따라 생성할 수 있다. 원본 FITS가 제공되지 않았다면 먼저 자료를 확보해야 하며 이 스크립트가 다운로드하지 않는다.

프로젝트 Git 루트 `Planetory`에서 실행한다. Node.js 외 추가 패키지가 필요 없다.

```powershell
node experiments/analysis-lab/scripts/prepare-observations.mjs
node experiments/analysis-lab/scripts/prepare-observations.mjs --check
```

입력 두 파일을 다른 폴더에 보관했다면 두 명령에 `--source-dir "<관측 JSON 폴더>"`를 추가한다. 상대 경로는 현재 실행 폴더 기준이며, 입력 JSON·manifest를 수정하지 않는다. 입력이 달라지면 아래의 기록된 export 시각·해시와 달라질 수 있으므로 검증 명령이 출력하는 값을 기준으로 삼는다. `--help`로 옵션을 확인할 수 있다.

기본 실행은 새 분석실 JSON만 쓴다. `--check`는 파일을 쓰지 않고 현재 파일을 예상 변환 결과와 대조한다. 두 명령 모두 다음을 검증한다.

- 입력 JSON의 SHA-256과 크기가 기존 manifest와 일치한다.
- 전체 관측점·주기도표 길이, 유한값, 시간 순서가 유효하다.
- JSON 직렬화 전후에 모든 관측값과 BLS 값, 접기 기준, 초기 주기가 정확히 같다.
- 초기 주기가 저장된 BLS power 최댓값의 주기와 일치한다.
- 실행 전후에 기존 JSON과 manifest가 변경되지 않았다.

입력 JSON SHA-256: `3f183b6b97f5ab1c838f56186527e1e155bd02f7b7f4026ae7cdb9f867fac811`

출력 JSON SHA-256: `f00010f63937ff920ec39b8f772fae843b0ac9a4923071bf5a9c77dd2d95a7d3`

검증 범위는 **기존 export의 손실 없는 화면용 변환**이다. 원본 FITS 재검증, BLS 재계산, 브라우저 렌더링·모션 검증은 이 스크립트의 범위에 포함하지 않는다.
