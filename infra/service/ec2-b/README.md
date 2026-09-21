# EC2-B 설정

EC2-B에 **서비스 역할을 두지 않는다**([시스템 아키텍처](../../../docs/architecture/system-architecture.md) 8장 D4). 앱·복제·백업과 서비스 관측 스택은 EC2-A에만 둔다.

사용자 요청 경로 밖의 역할만 맡는다.

| 역할 | 정본 |
| --- | --- |
| CI 빌드 Runner·이미지 레지스트리 | [CI/CD](../../../docs/operations/cicd.md) |
| 알림 전용 외부 관찰 | [EC2 서비스 진입·장애 전환 경계](../../../docs/architecture/ec2-service-entry-failover.md) 4장, 인계 100 |

## 외부 관찰

`uptime-watch.sh`가 공개 URL을 주기적으로 확인하고 Mattermost로 알린다. **사람에게 알리기만 한다.** 진입 전환이나 DNS 편집에 개입하지 않으며, 그렇게 쓰는 것은 기각된 안이다(같은 문서의 기각 목록).

EC2-A와 **같은 가용 영역**에서 돌기 때문에 인스턴스·애플리케이션·터널 장애만 잡는다. 가용 영역이나 리전 단위 장애는 관찰자도 함께 멈춰 감지하지 못한다. 이 한계를 전제로 수용한 구성이다.

### 설치

```bash
sudo install -d -m 755 /opt/planetory /var/lib/planetory-watch
sudo install -d -m 750 /etc/planetory
sudo install -m 755 uptime-watch.sh /opt/planetory/uptime-watch.sh
```

Webhook URL은 자격 증명이므로 저장소에 넣지 않고 서버 파일에만 둔다.

```bash
sudo install -m 600 /dev/null /etc/planetory/mattermost-webhook
sudo tee /etc/planetory/mattermost-webhook >/dev/null   # 값을 붙여넣고 Ctrl-D
```

cron은 root로 실행한다. `WATCH_URL`은 **실제 서비스가 응답하는 공개 URL**이어야 한다. 기본값을 두지 않으므로 지정하지 않으면 스크립트가 바로 실패한다. 잘못된 URL을 넣으면 감시하고 있다는 착각만 남고 정작 장애는 잡지 못한다.

```bash
sudo tee /etc/cron.d/planetory-uptime-watch >/dev/null <<'EOF'
WATCH_URL=https://<공개-URL>/
*/2 * * * * root /opt/planetory/uptime-watch.sh >> /var/log/planetory-watch.log 2>&1
EOF
```

### 동작

| 항목 | 값 |
| --- | --- |
| 주기 | 2분(cron 표현식) |
| 알림 임계 | 연속 3회 실패(약 6분). `WATCH_THRESHOLD` |
| 중복 억제 | 임계 도달 시 1회만. 장애가 이어져도 반복하지 않는다 |
| 복구 알림 | 알림을 보낸 뒤 처음 성공할 때 1회 |
| 성공 판정 | HTTP 2xx·3xx |
| 상태 파일 | `/var/lib/planetory-watch/state` — `<연속실패> <알림여부>` 한 줄 |

정상일 때는 아무것도 기록하지 않는다. 로그에는 실패와 복구만 남으므로 따로 회전시키지 않는다.

### 검증

```bash
sh uptime-watch-test.sh
```

프로브 결과를 주입해 여러 번 호출하고 임계 도달 시 알림 1건·중복 억제·복구 알림 1건·상태 초기화를 확인한다. 네트워크와 Webhook을 타지 않는다.
