"""판 전환 알림(탐사 API 10장) [S15P21C206-262]. 표준 라이브러리만 쓴다.

로컬 시드(local_seed/load.py)의 notify_backend와 같은 동작이다. DB 드라이버 없이 부를 수 있게 load.py와 나눴다.
"""

from __future__ import annotations

import http.client
import urllib.error
import urllib.request

TOKEN_HEADER = "X-Planetory-Service-Token"


def notify_backend(base_url: str, token: str, bundle_ids: list[int]) -> list[tuple[int, bool, str]]:
    """커밋 뒤 판 전환 후처리를 부른다. 실패해도 DB 전환은 되돌리지 않고 결과로 알린다.

    응답을 기다리다 난 시간 초과·연결 끊김은 URLError로 감싸지지 않는다. 이것도 그 판의 실패로 남기고 다음 판으로 간다.
    """
    outcomes = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 내부 호출은 시스템 프록시를 타지 않는다
    for bundle_id in bundle_ids:
        request = urllib.request.Request(f"{base_url.rstrip('/')}/internal/bundles/b-{bundle_id}/activated",
                                         method="POST", headers={TOKEN_HEADER: token})
        try:
            with opener.open(request, timeout=15) as response:
                outcomes.append((bundle_id, 200 <= response.status < 300, f"HTTP {response.status}"))
        except urllib.error.HTTPError as e:
            outcomes.append((bundle_id, False, f"HTTP {e.code}"))
        except urllib.error.URLError as e:
            outcomes.append((bundle_id, False, f"연결 실패: {e.reason}"))
        except (OSError, http.client.HTTPException) as e:
            outcomes.append((bundle_id, False, f"응답 실패: {type(e).__name__}: {e}"))
    return outcomes
