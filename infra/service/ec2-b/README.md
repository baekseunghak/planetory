# EC2-B 설정

EC2-B에 **서비스 역할을 두지 않는다**([시스템 아키텍처](../../../docs/architecture/system-architecture.md) 8장 D4). 앱·복제·백업과 서비스 관측 스택은 EC2-A에만 둔다.

사용자 요청 경로 밖의 역할만 맡는다.

| 역할 | 정본 |
| --- | --- |
| CI 빌드 Runner·이미지 레지스트리 | [CI/CD](../../../docs/operations/cicd.md) |
| 알림 전용 외부 관찰 | [EC2 서비스 진입·장애 전환 경계](../../../docs/architecture/ec2-service-entry-failover.md) 4장, 인계 100 |

## 알림 컨벤션

```text
<이모지> [심각도] <무슨 일> — <근거>. <확인할 것>.
```

| 표기 | 의미 | 대응 |
| --- | --- | --- |
| 🚨 `[긴급]` | 사용자가 지금 영향받는다 | 즉시 |
| ⚠️ `[경고]` | 지금은 멀쩡하나 방치하면 터진다 | 며칠 안에 |
| ✅ `[복구]` | 직전 사건이 끝났다 | 없음 |

규칙은 넷이다.

- **한 사건에 한 번만** 보낸다. 상황이 이어져도 반복하지 않는다.
- **복구로 사건을 닫고** 그때 상태를 초기화한다. 복구 알림이 없으면 이미 끝난 장애를 계속 쫓게 된다.
- **정상일 때는 아무것도 보내지 않는다.** 로그에도 남기지 않는다.
- **확인할 행동이 없는 알림은 만들지 않는다.** 그래서 모든 문구가 "무엇을 확인한다"로 끝난다.

상태 파일은 점검마다 분리한다. 한 사건의 중복 억제가 다른 점검을 가리면 안 된다.

### 보내는 알림

| 알림 | 심각도 | 트리거 | 주기 |
| --- | --- | --- | --- |
| 서비스 무응답 | 🚨 | 공개 URL 연속 3회 실패 | 2분 |
| 서비스 정상 | ✅ | 위 알림 뒤 첫 성공 | 2분 |
| 레지스트리 무응답 | 🚨 | `/v2/` 연속 3회 실패 | 2분 |
| 레지스트리 정상 | ✅ | 위 알림 뒤 첫 성공 | 2분 |
| 레지스트리 디스크 | ⚠️ | 사용률 85% 초과 | 하루 |
| 인증서 갱신 실패 | ⚠️ | `tailscale cert` 실패 | 하루 |

### 일부러 만들지 않은 알림

- **파이프라인 실패** — GitLab에 Mattermost 연동이 내장돼 있다. 직접 구현하면 관리 지점만 는다.
- **응답 지연** — 임계를 정할 근거가 없어 오탐만 난다. 실제로 느려진 사례가 생기면 그때 정한다.
- **EC2-A 리소스·GCP 노드** — Prometheus·Grafana와 Hadoop 운영 영역이다.
- **인증서 만료 임박** — 알리는 대신 **매일 갱신한다**(아래). 사람이 할 일이 자동으로 되는 일이면 알림을 만들지 않는다.

## 구성

| 파일 | 하는 일 |
| --- | --- |
| `notify.sh` | 알림 공용 함수. 심각도별 이모지와 Webhook 전송. 실행 파일이 아니라 점(`.`)으로 읽어 쓴다 |
| `uptime-watch.sh` | 공개 URL 관찰 |
| `registry-watch.sh` | 레지스트리 무응답·디스크·인증서 갱신. `health`·`daily`·`disk`·`cert` 모드 |

외부 관찰은 **사람에게 알리기만 한다.** 진입 전환이나 DNS 편집에 개입하지 않으며, 그렇게 쓰는 것은 기각된 안이다(진입·장애 전환 경계 문서의 기각 목록).

EC2-A와 **같은 가용 영역**에서 돌기 때문에 인스턴스·애플리케이션·터널 장애만 잡는다. 가용 영역이나 리전 단위 장애는 관찰자도 함께 멈춰 감지하지 못한다. 이 한계를 전제로 수용한 구성이다.

### 인증서를 알리지 않고 갱신하는 이유

레지스트리 TLS 인증서는 `tailscale cert`로 받는다. 만료되면 **빌드와 배포가 함께 멈춘다.** `tailscale cert`는 갱신 시점이 아니면 같은 인증서를 그대로 쓰므로 매일 돌려도 안전하다. 파일이 실제로 바뀌었을 때만 레지스트리를 재시작한다. 레지스트리는 기동할 때만 인증서를 읽기 때문이다. 갱신에 **실패했을 때만** 알린다.

## 설치

```bash
sudo install -d -m 755 /opt/planetory /var/lib/planetory-watch
sudo install -d -m 750 /etc/planetory
sudo install -m 755 notify.sh uptime-watch.sh registry-watch.sh /opt/planetory/
```

Webhook URL은 자격 증명이므로 저장소에 넣지 않고 서버 파일에만 둔다. 환경변수로 두지 않는 이유는 cron 파일이 644라 평문으로 남고 프로세스 환경에서도 보이기 때문이다.

```bash
sudo install -m 600 /dev/null /etc/planetory/mattermost-webhook
sudo tee /etc/planetory/mattermost-webhook >/dev/null   # 값을 붙여넣고 Ctrl-D
```

Mattermost 시스템 콘솔에서 **통합 기능의 사용자 이름·아이콘 덮어쓰기**가 꺼져 있으면 `username`·`icon_emoji`가 조용히 무시된다. 알림은 정상 전송된다.

cron은 root로 실행한다. `WATCH_URL`은 **실제 서비스가 응답하는 공개 URL**이어야 한다. 기본값을 두지 않으므로 지정하지 않으면 즉시 실패한다. 잘못된 URL은 감시하고 있다는 착각만 만들고 정작 장애는 잡지 못한다.

```bash
sudo tee /etc/cron.d/planetory-watch >/dev/null <<'EOF'
WATCH_URL=https://<공개-URL>/
REGISTRY_URL=https://<레지스트리-호스트>:5000
REGISTRY_CERT_NAME=<레지스트리-호스트>
*/2 * * * * root /opt/planetory/uptime-watch.sh >> /var/log/planetory-watch.log 2>&1
*/2 * * * * root /opt/planetory/registry-watch.sh health >> /var/log/planetory-watch.log 2>&1
17 4 * * * root /opt/planetory/registry-watch.sh daily >> /var/log/planetory-watch.log 2>&1
EOF
```

## 조정할 수 있는 값

| 변수 | 기본값 |
| --- | --- |
| `WATCH_THRESHOLD` | 3회 |
| `WATCH_TIMEOUT` | 10초 |
| `REGISTRY_DISK_WARN_PCT` | 85 |
| `REGISTRY_CERT_DIR` | `/srv/registry/certs` |
| `REGISTRY_DATA_DIR` | `/srv/registry/data` |
| `REGISTRY_CONTAINER` | `registry` |
| `WATCH_BOT_NAME` | `CI 감시 알림` |
| `WATCH_BOT_ICON` | `:ssafy_emergency:` |

상태 파일은 `/var/lib/planetory-watch/{uptime,registry-health,registry-disk,registry-cert}`이며 각각 `<연속실패> <알림여부>` 한 줄이다. 로그에는 실패와 복구만 남으므로 따로 회전시키지 않는다.

## 검증

```bash
sh uptime-watch-test.sh
sh registry-watch-test.sh
```

프로브 결과·디스크 사용률·인증서 갱신 결과를 주입해 임계 도달 시 알림 1건, 중복 억제, 복구 알림, 정상 시 무알림을 확인한다. 네트워크·Webhook·docker를 타지 않는다.
