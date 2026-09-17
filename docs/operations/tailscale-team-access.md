# Tailscale 팀 서버 접근 가이드

> 대표 Jira: `S15P21C206-71`
>
> 상태: 운영 절차
>
> 범위: 팀원 tailnet 등록과 프로젝트 서버 접근

이 문서는 팀원이 Tailscale을 통해 프로젝트 서버에 접속하는 절차와 허용 범위를 설명한다. 실제 멤버·장비·ACL 상태의 정본은 Tailscale Admin Console이며, 이 문서의 접근 범위는 2026-09-16에 사용자가 제공한 ACL을 기준으로 한다. GCP 노드의 사설망·DNS·방화벽 점검은 [GCP 노드 운영 런북](gcp-node-runbook.md)을 따른다.

## 1. 팀원과 장비 등록

1. 팀원은 [공식 Tailscale Windows 클라이언트](https://tailscale.com/download/windows)를 설치하고 프로젝트에 사용할 본인 계정으로 로그인한다.
2. 관리자에게 최신 tailnet 초대 링크를 요청해 가입을 신청한다. 초대 링크는 저장소, Jira와 메신저 공개 채널에 기록하지 않는다.
3. 관리자가 Tailscale Admin Console에서 사용자 가입을 승인한다.
4. 팀원은 접속에 사용할 노트북을 tailnet에 등록한다.
5. 관리자가 등록 요청의 사용자와 장비를 확인하고 장비를 승인한다.
6. 팀원은 PowerShell에서 연결 상태와 서버 이름 해석을 확인한다.

```powershell
tailscale status
tailscale ping node-1
```

사용자 승인과 장비 승인을 모두 받아야 한다. 승인되지 않은 다른 계정이나 장비에서 접속하지 않으며, 장비를 분실하거나 프로젝트에서 이탈하면 관리자에게 즉시 사용자·장비 제거를 요청한다.

## 2. 팀원 접근 범위

현재 `autogroup:member`는 `tag:hadoop` 서버의 모든 포트에 네트워크로 접근할 수 있다. 실제 작업에서는 승인받은 SSH와 프로젝트 서비스만 사용한다. Tailscale SSH는 연결 시 재인증을 요구하며, 대상 서버에 실제로 존재하고 ACL에서 허용한 로컬 계정만 사용할 수 있다.

| 서버 | 역할·태그 | 팀원 접근 | 접속 방법 |
| --- | --- | --- | --- |
| `donh-vnic` | CI/CD 컨테이너 , `tag:registry` | 22 port 접근·Tailscale SSH 허용 | `ssh claude@donh-vnic` |
| `ec2-a` | 프로젝트 서비스 단일 노드, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh ubuntu@ec2-a` |
| `ec2-b` | 서비스 역할 없음(tailnet 등록만 유지), `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh ubuntu@ec2-b` |
| `node-1` | GCP master, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh SSAFY@node-1` |
| `node-2` | GCP worker, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh planetory-admin@node-2` |
| `node-3` | GCP worker, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh planetory-admin@node-3` |
| `node-4` | GCP worker, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh planetory-admin@node-4` |
| `node-5` | GCP worker, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh planetory-admin@node-5` |
| `node-6` | GCP worker, `tag:hadoop` | 네트워크 접근·Tailscale SSH 허용 | `ssh planetory-admin@node-6` |

EC2 계정은 추정하지 않는다. 관리자가 해당 서버에 실제 존재하는 계정을 확인해 별도로 안내한 뒤 사용한다.

프로젝트 서비스는 `ec2-a` 한 노드에서만 실행한다. `ec2-b`에는 앱·복제·백업·관측 역할이 없고 tailnet 등록만 남아 있다. 근거는 [EC2 서비스 진입·장애 전환 경계](../architecture/ec2-service-entry-failover.md)를 따른다.

## 3. 접속 확인과 주의사항

접속 전에 서버 이름이 Tailscale 경로로 응답하는지 확인한다.

```powershell
tailscale ping ec2-a
tailscale ping ec2-b
tailscale ping node-1
```

첫 SSH 접속에서 호스트 키 확인이 나오면 관리자에게 fingerprint를 확인하고 승인한다. `StrictHostKeyChecking=no`로 검증을 우회하거나 개인 키 내용을 공유하지 않는다.

Tailscale은 관리 접속 경로다. `node-*` 접속 성공을 GCP `10.20.x.10` 사설망, VPC Peering 또는 Hadoop 서비스 통신 검증으로 대신하지 않는다.

접속이 실패하면 다음 순서로 확인한다.

1. Tailscale 클라이언트가 로그인·연결 상태인지 확인한다.
2. 사용자와 현재 노트북이 Admin Console에서 승인됐는지 관리자에게 확인한다.
3. 대상 서버가 `Connected` 상태인지 확인한다.
4. 정확한 MagicDNS 이름과 서버별 로컬 계정을 사용했는지 확인한다.
5. 계속 실패하면 관리자에게 사용자, 장비 이름, 대상 서버와 실패 시각만 전달한다. 비밀번호·토큰·개인 키는 전달하지 않는다.
