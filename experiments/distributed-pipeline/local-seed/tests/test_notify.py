"""판 전환 후처리 알림(MR !201 리뷰). DB 없이 로컬 HTTP 서버로 본다.

재실행으로 복구되는 전체 흐름은 DB 가 필요해 test_load.py 가 본다.
"""
from local_seed.__main__ import main
from local_seed.load import StarResult, notify_backend, notify_targets


def test_each_bundle_reports_its_own_outcome(backend, monkeypatch):
    backend.statuses = {12: 500, 13: 204}
    # 시스템 프록시가 잡혀 있어도 서비스 토큰을 프록시로 보내지 않고 백엔드에 바로 붙는다.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("NO_PROXY", "")
    outcomes = notify_backend(backend.url, "local-test-token", [11, 12, 13])
    assert outcomes == [(11, True, "HTTP 200"), (12, False, "HTTP 500"), (13, True, "HTTP 204")]
    assert backend.requests == [(11, "local-test-token"), (12, "local-test-token"), (13, "local-test-token")]


def test_unreachable_backend_is_a_failure(down_url):
    [(bundle_id, ok, outcome)] = notify_backend(down_url, "local-test-token", [11])
    assert (bundle_id, ok) == (11, False) and outcome.startswith("연결 실패")


def test_targets_include_bundles_already_current():
    """앞선 실행에서 알림이 실패한 판은 다음 실행에서 ALREADY_PUBLISHED 가 된다. 그 판에도 다시 알린다."""
    results = [StarResult(1, "a", "PUBLISHED", 10), StarResult(2, "b", "ALREADY_PUBLISHED", 11),
               StarResult(3, "c", "BUNDLE_SUPERSEDED", 12)]
    assert notify_targets(results) == [10, 11]


def test_missing_token_stops_before_connecting(monkeypatch, capsys):
    """토큰이 없으면 DB 에 붙기 전에 멈춘다. 붙으려 했다면 1번 포트 연결 실패로 종료 코드 1 이 된다."""
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    code = main(["seed", "--database-url", "postgresql://planetory@127.0.0.1:1/planetory_poc",
                 "--notify-backend", "http://127.0.0.1:1"])
    assert code == 2
    assert "INTERNAL_SERVICE_TOKEN" in capsys.readouterr().err
