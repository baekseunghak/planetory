# 후보 정정 사전검사 런북

- 상태: 초안. 사전검사 명령은 구현·통합 테스트 완료, 운영 서버 실행은 미검증. **적용·복구 절차는 아직 없다**
- Jira: [S15P21C206-154](https://ssafy.atlassian.net/browse/S15P21C206-154)
- 상위 정본: [후보 병합·분리 정정 계약](../architecture/candidate-correction-contract.md), [탐사 API 9.5절](../../apps/backend/docs/exploration-api-spec.md)

후보가 병합되거나 분리될 때, 그 정정이 회원의 성과·발견한 별·공개 분석·공식 스레드에 무엇을 건드리는지 **먼저 세어 보는** 절차다. 계약 5.2절의 dry-run이며 **아무것도 바꾸지 않는다.**

## 지금 할 수 있는 것과 없는 것

계약 4장의 미확정 항목(C18-Q1~Q6)이 승인되기 전에는 실제 데이터 정정을 구현하지도 실행하지도 않는다([S15P21C206-154](https://ssafy.atlassian.net/browse/S15P21C206-154) 차단 조건). 그래서 이 런북에는 사전검사만 있다.

| | 상태 |
| --- | --- |
| 영향 사전검사 | **구현 완료.** 이 문서 |
| 후보 `status` 은퇴 전환, disposition·별칭·외부 참조 이동 | 미구현. 계약 6장 "할 수 있는 것" 2번 |
| 성과·별·공개 분석·공식 스레드·통계 변경 | **만들지 않는다.** 계약 4장 승인 전까지 |
| 복구 절차 | 미구현. 회원 쪽을 바꾸지 않으므로 아직 필요 없다 |

## 1. 대상 확인

정정 판정 자체는 데이터 담당이 한다(D05-2, D08). 운영자는 **판정 결과로 받은 후보 id**만 넣는다.

- 병합: 합칠 후보 id 둘 이상과 대표로 남길 id 하나. 대표 선택은 데이터 담당이 정한다(C18-Q1).
- 분리: 가를 후보 id 하나.
- 대상 후보는 모두 같은 별(TIC)에 있어야 한다. 다르면 명령이 거절한다.

## 2. 사전검사 실행

백엔드 jar에 명령 인자를 준다. 웹 서버를 띄우지 않고 한 번 실행한 뒤 종료하므로 서버가 떠 있는 호스트에서 실행해도 포트가 겹치지 않는다. DB 접속은 서버와 같은 환경 변수(`DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`)를 쓴다.

읽기만 하므로 서비스 접속 계정(`planetory_app`)으로 실행해도 되고, 앱 역할의 권한을 넓히지 않는다.

```powershell
java -jar app.jar --planetory.command=candidate-correction-precheck --planetory.correction.kind=merge --planetory.correction.candidates=101,102 --planetory.correction.keep=101
```

```powershell
java -jar app.jar --planetory.command=candidate-correction-precheck --planetory.correction.kind=split --planetory.correction.candidates=103
```

EC2 서비스 이미지는 진입점이 `java -jar /app/app.jar`이므로 [서비스 Compose](../../infra/service/compose.yaml)의 `backend` 서비스에 인자를 이어 붙일 수 있다. 이 형태는 아직 서버에서 실행해 보지 않았다.

```powershell
docker compose run --rm backend --planetory.command=candidate-correction-precheck --planetory.correction.kind=merge --planetory.correction.candidates=101,102 --planetory.correction.keep=101
```

읽기 전용이라 여러 번 실행해도 결과가 같다. 결과가 불확실하면 다시 실행한다.

## 3. 결과 확인

| 종료 코드 | 뜻 | 조치 |
| --- | --- | --- |
| 0 | 회원 데이터가 걸려 있지 않다 | 계약 6장의 Gold 쪽 적용만으로 끝난다. 적용 절차는 아직 구현되지 않았다 |
| 3 | 회원 데이터가 걸려 있다 | Gold 쪽은 계약 3.2의 기본값인 **보존**으로만 진행한다. 회원 쪽 정정은 계약 4장 승인이 필요하고 v1에 경로가 없다 |
| 2 | 사전 거절 | **실행하지 않는다.** 출력된 이유를 데이터 담당과 확인한다 |
| 64 | 명령 인자 오류 | 출력된 이유를 보고 2단계의 형식으로 다시 실행한다 |
| 1 | 처리 중 오류 | 아무것도 바꾸지 않았다. 원인을 고친 뒤 다시 실행한다 |

로그는 후보마다 한 줄이다.

```text
후보 101 (TIC 123456789, active): 성과 12건, 그 성과가 연 별 12개, 공개 분석 5건(유효 4), 공식 스레드 1개, 매칭 제출 31건
병합 대상 둘 이상에 성과를 가진 회원: 3명
```

마지막 줄이 0보다 크면 그 회원들의 성과는 **C18-Q2를 어떻게 정하더라도 한 후보로 모을 수 없다.** `UNIQUE(user_id, candidate_id)` 때문에 모으면 행이 줄고 등급이 내려간다(계약 S3). 대상 중 둘 이상이 공식 스레드를 가진 경우도 같다(계약 S2).

이어서 **바뀌는 것과 바뀌지 않는 것**을 출력한다. 회원 데이터는 어느 경우에도 바뀌지 않으며, 그 사실을 적는 것이 이 보고의 핵심이다.

## 4. 승인 요청

종료 코드가 3이면 사전검사 출력을 그대로 붙여 승인을 요청한다(계약 5.1). 승인자는 계약 4장의 해당 항목 담당이다. 승인 없이 회원 데이터를 고치지 않는다.

## 하지 않는 일

- 데이터 변경. 사전검사는 읽기만 하며 후보 `status`도 바꾸지 않는다.
- 병합·분리 판정. 어느 후보가 같은 신호인지는 데이터 담당이 정한다.
- 라벨 변경 처리. 외부 disposition 갱신은 배치가 자동으로 하며 성과·등급·별·통계 스냅샷을 바꾸지 않는다([탐사 API 9.5절](../../apps/backend/docs/exploration-api-spec.md)).
- 일반 DB 백업·복원. 인프라 담당의 I16 범위이며 후보 정정 검증을 백업 복구로 대체하지 않는다.
