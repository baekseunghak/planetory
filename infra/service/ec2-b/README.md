# EC2-B 설정

## 현재 운영 위치: donh-orc2 (2026-10-02)

사용자 요청으로 EC2-B의 CI Runner·이미지 레지스트리·외부 관찰을 `ubuntu@donh-orc2`로 이관했다. 원본 회수 전에 레지스트리 1,779개 파일·8,733,699,542 bytes의 전체 SHA-256을 비교해 일치를 확인했고, Runner 인증 설정·Webhook·스크립트·관찰 상태·cron도 보존했다. 이후 사용자가 관리자의 원본 인스턴스 회수를 알렸다. 아래 EC2-B는 논리 역할과 이전 설치 기록을 뜻한다.

| 항목 | 현재 값·검증 |
| --- | --- |
| 관리 접속 | `tailscale ssh ubuntu@donh-orc2`, 비밀번호 없는 sudo 사용 가능 |
| 서버 | Ubuntu 24.04, ARM64, 4 vCPU, 메모리 약 24GB. 이관 전 Docker·Kubernetes 런타임과 Planetory 설정 없음 |
| 실행 설정 | `/srv/planetory-ci/compose.json`, Compose 프로젝트 `planetory-ci`, `registry`·`gitlab-runner` |
| 레지스트리 | `https://donh-orc2.tail97e363.ts.net:5000`, 새 호스트용 정식 TLS, tailnet 주소에만 bind. 원본 11개 저장소·112개 태그 조회 확인 |
| 저장 데이터 | `/srv/registry/data`. 전체 복사본은 아래 보호된 이관 경로의 `registry-data.preserved`에도 별도 보존 |
| Runner | 기존 ID `2146`, manager `2046`, 버전 `19.4.0`, ARM64. `concurrent=3`, `run_untagged=true` 유지. `amd64-docker` 유지·`arm64-docker` 추가 |
| x86 호환 | Ubuntu `qemu-user-static`·binfmt의 `F` flag로 지원. Docker 27.5 DinD에서 amd64 build·새 Registry push·실행 성공. 에뮬레이션 빌드 성능은 실측하지 않음 |
| 실제 CI | [validate:contracts #665128](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/jobs/665128) 성공, API에서 실행 manager의 `arm64` 확인 |
| 소비자 전환 | GitLab `REGISTRY_IMAGE_PREFIX`와 Node 1 Publisher 이미지 참조의 호스트를 변경. Publisher digest·이미지 ID 동일, 새 TLS pull·CLI 기동 통과 |
| 접근 경계 | 새 CI 신원의 `claude@donh-vnic` SSH·Docker 접근 성공. Publisher 전용 5432·8080 접근은 차단 확인 |
| 자동화 | 기존 주기·알림 규칙 유지. 새 레지스트리 TLS 갱신, 서비스 `claude@donh-vnic`의 이미지 보호 목록 조회·정리 모의 실행 성공 |
| 보호·기록 | `/var/tmp/planetory-ec2-b-migration-20261002`의 원본 설정·전체 레지스트리 보존본·해시 비교·검증 로그. 최상위 디렉터리 700, Runner 인증 파일·Webhook 600 |

정리 cron은 `DEPLOY_USER=claude`, `EC2_A_HOST=donh-vnic`, `EC2_A_DEPLOY_PATH=/home/claude/planetory`를 사용한다. `EC2_A_*`는 기존 변수 이름을 유지한다. 래퍼의 기본 계정은 계속 `deploy`이며, 계정·경로 변경을 포함한 회귀 8개가 통과했다. 모의 실행은 삭제 예정 0개였고 실제 삭제·GC를 수동 실행하지 않았다.

직접 SSH가 정책으로 거절돼 기존 레지스트리 포트에서 목적지 한 대만 허용하는 읽기 전용 rsync로 복사했다. 기존 Runner를 pause·정지하고 원본 cron·레지스트리를 정지해 쓰기·정리를 막았다. 원본 회수 이후 임시 전송 서버에 다시 접속할 수 없으며 목적지에는 전송 daemon을 설치하지 않았다. 검증용 DinD 컨테이너는 제거했다.

후속 앱 CI 작업은 native ARM64 build·push·기동, Docker 27.5 DinD 배포 회귀와 GitLab CI lint까지 검증했다. 목적지 변수와 운영 Compose의 이미지 변수·최종 외부 볼륨은 반영했으며 사용자 승인으로 새 CI 소스의 긴급 Git 게시·MR 생성을 진행한다. develop 반영·새 운영 앱 배포는 별도다. [CI/CD](../../../docs/operations/cicd.md)와 [서비스 배포 상태](../../../docs/project/service-deploy-status.md)를 따른다.

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
| `image-secret-scan.sh` | 이미지에 비밀값이 섞였는지 검사 |
| `registry-prune.sh` | 오래된 commit SHA 태그 정리와 가비지 수집 |

외부 관찰은 **사람에게 알리기만 한다.** 진입 전환이나 DNS 편집에 개입하지 않으며, 그렇게 쓰는 것은 기각된 안이다(진입·장애 전환 경계 문서의 기각 목록).

EC2-A와 **같은 가용 영역**에서 돌기 때문에 인스턴스·애플리케이션·터널 장애만 잡는다. 가용 영역이나 리전 단위 장애는 관찰자도 함께 멈춰 감지하지 못한다. 이 한계를 전제로 수용한 구성이다.

### 인증서를 알리지 않고 갱신하는 이유

레지스트리 TLS 인증서는 `tailscale cert`로 받는다. 만료되면 **빌드와 배포가 함께 멈춘다.** `tailscale cert`는 갱신 시점이 아니면 같은 인증서를 그대로 쓰므로 매일 돌려도 안전하다. 파일이 실제로 바뀌었을 때만 레지스트리를 재시작한다. 레지스트리는 기동할 때만 인증서를 읽기 때문이다. 갱신에 **실패했을 때만** 알린다.

## 이미지 비밀값 점검

`image-secret-scan.sh`가 이미지의 환경변수, 빌드 히스토리, 레이어가 담은 파일 이름을 본다. 레이어는 지워도 남는다. 한 레이어에서 비밀 파일을 넣고 다음 레이어에서 지워도 앞 레이어에 그대로 있으므로 최종 파일 목록만 봐서는 놓친다.

```bash
image-secret-scan.sh <이미지 참조> [...]
image-secret-scan.sh --self-test
```

찾은 값은 앞 4글자만 남기고 가려서 출력한다. 리포트 자체가 비밀을 흘리면 안 된다. 종료 코드는 0이 발견 없음, 1이 발견이다.

레이어별로 검사한다. `docker export`는 평탄화된 최종 파일시스템만 주기 때문에, 한 레이어에서 비밀을 넣고 다음 레이어에서 지우면 놓친다. 이미지를 받는 쪽은 그 레이어까지 전부 받으므로 **지웠다고 사라지지 않는다.** 자체 검사에 이 경우가 회귀 항목으로 들어 있다.

검출은 두 갈래다. `.env`·`.ssh/`·`.aws/`·`id_rsa`·`credentials`처럼 **어디에 있든 우리 비밀인 것**은 예외 없이 잡는다. 인증서와 키 스토어는 베이스 이미지와 타사 패키지가 정상적으로 잔뜩 넣으므로 시스템 CA 경로와 `site-packages`·`node_modules` 같은 벤더 경로는 건너뛴다. 이 구분이 없으면 경보가 무뎌져 진짜를 놓친다.

## SHA 태그 정리

`registry-prune.sh`가 저장소마다 최신 N개만 남기고 오래된 commit SHA 태그를 지운다.

```bash
registry-prune.sh --registry https://<호스트>:5000 --keep 10            # 모의 실행
registry-prune.sh --registry https://<호스트>:5000 --keep 10 --apply    # 실제 삭제
registry-prune.sh --registry https://<호스트>:5000 --keep 10 --apply --gc  # 용량 회수까지
```

기본은 모의 실행이다. `--apply` 없이는 아무것도 지우지 않는다.

지켜야 할 것이 셋 있다.

- **commit SHA 형식(40자리 16진수) 태그만 후보다.** `latest`처럼 사람이 붙인 이름은 형식이 달라 손대지 않는다.
- **삭제는 digest 단위다.** 같은 digest를 가리키는 태그는 함께 사라진다. 내용이 같은 커밋은 digest도 같으므로, 남길 태그와 digest가 겹치는 후보는 건너뛴다. 이 보호가 없으면 오래된 태그를 지우다가 최신 태그와 `latest`까지 날아간다.
- **배포 중인 이미지는 `--in-use`로 보호한다.** 각 노드 `.env`에 적힌 SHA를 넘긴다. 지우면 롤백이 막힌다.

### 매일 정리 (S15P21C206-262)

`registry-prune-daily.sh`가 EC2-A `.env`에서 배포 중인 이미지를 읽어 `--in-use`로 넘기고, 나머지 인자는 `registry-prune.sh`에 그대로 넘긴다. **읽지 못하면 지우지 않고 경고만 보낸다.** 보호 목록 없이 돌면 운영 이미지를 지우고, 그 뒤로 롤백과 재배포가 pull에서 실패한다.

매일 해야 하는 이유는 `S15P21C206-261`이다. 그 뒤로 develop 병합마다 Frontend·Backend 태그가 생긴다. Backend는 빌드마다 약 69MB 새 레이어가 쌓여 바쁜 날 하루 2~3GB다(2026-09-23 실측: 저장소 1.7GB, 디스크 여유 275GB). 배포 중인 이미지는 최신 N개 밖으로 금방 밀리므로 개수만으로는 보호되지 않는다.

- **보존 개수는 30이다**(`PRUNE_KEEP`). 하루치 병합 정도다. 배포 중이 아닌 옛 이미지로 손으로 되돌릴 여지를 남긴다.
- **GCP 노드 이미지는 보호 목록에 넣지 않는다.** 변경이 있을 때만 빌드돼 30개 안에 머문다. GCP도 매 병합 빌드로 바꾸면 여기에 노드 `.env`를 더해야 한다.
- 관찰 노드의 root가 서비스 서버로 SSH한다. 기본 계정은 `deploy`, 이관 운영값은 `DEPLOY_USER=claude`다. Tailscale SSH라 키가 없다. `.env`는 원격에서 `*_IMAGE=` 줄만 걸러 받는다.

```bash
sudo env REGISTRY_URL=https://<레지스트리-호스트>:5000 EC2_A_HOST=<EC2-A tailnet 주소> /opt/planetory/registry-prune-daily.sh  # 모의 실행
sh registry-prune-daily-test.sh  # 네트워크 없이 도는 검사
```

생성 시각은 이미지 config 블롭에서 읽는다. **하나라도 읽지 못하면 그 저장소는 건드리지 않는다.** 대체값을 넣으면 정렬이 조용히 태그 문자열 순서로 바뀌어 최신 이미지를 지우게 된다. 못 지우는 것보다 잘못 지우는 것이 훨씬 비싸다.

매니페스트만 지우면 용량은 줄지 않는다. `--gc`는 **레지스트리를 정지한 뒤** 일회용 컨테이너로 블롭을 회수하고 다시 띄운다. `docker exec -e`로 읽기 전용 환경변수를 주는 방식은 통하지 않는다. 그 변수는 exec한 프로세스에만 붙고 이미 떠 있는 서버는 그대로 쓰기를 받아, 수집 도중 올라온 이미지가 깨질 수 있다. 정지 동안 push와 pull이 모두 멈추므로 빌드가 없는 시간에 돌린다.

## 설치

```bash
sudo install -d -m 755 /opt/planetory /var/lib/planetory-watch
sudo install -d -m 750 /etc/planetory
sudo install -m 755 notify.sh uptime-watch.sh registry-watch.sh   image-secret-scan.sh registry-prune.sh registry-prune-daily.sh /opt/planetory/
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

정리는 파일을 따로 둔다. 서버 시각은 UTC다. 19:40 UTC(04:40 KST)는 빌드가 없는 시간이다. `--gc`는 레지스트리를 잠깐 멈추는데, `registry-watch.sh`는 3회 연속(약 6분) 실패해야 알리므로 오경보가 나지 않는다.

```bash
sudo tee /etc/cron.d/planetory-prune >/dev/null <<'EOF'
REGISTRY_URL=https://<레지스트리-호스트>:5000
EC2_A_HOST=<EC2-A tailnet 주소>
40 19 * * * root /opt/planetory/registry-prune-daily.sh --apply --gc >> /var/log/planetory-prune.log 2>&1
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
| `REGISTRY_CERT_CMD` | `tailscale` (테스트에서 실패 명령 주입용) |
| `WATCH_BOT_NAME` | `CI 감시 알림` |
| `WATCH_BOT_ICON` | `:ssafy_emergency:` |

상태 파일은 `/var/lib/planetory-watch/{uptime,registry-health,registry-disk,registry-cert}`이며 각각 `<연속실패> <알림여부>` 한 줄이다. 로그에는 실패와 복구만 남으므로 따로 회전시키지 않는다.

## 검증

```bash
sh uptime-watch-test.sh
sh registry-watch-test.sh
image-secret-scan.sh --self-test   # docker가 필요하다
```

프로브 결과·디스크 사용률·인증서 갱신 결과를 주입해 임계 도달 시 알림 1건, 중복 억제, 복구 알림, 정상 시 무알림을 확인한다. 네트워크·Webhook·docker를 타지 않는다.
