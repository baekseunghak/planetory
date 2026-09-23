"""적재 대상이 이 PC 인지는 URL 문자열이 아니라 실제 접속 주소로 가린다(MR !201 리뷰).

URL 의 host 만 보면 libpq 가 hostaddr·service 파일·PGHOST 환경변수로 다른 곳에 붙는 경우를 놓친다. DB 없이 돈다.
libpq 가 실제 주소를 알려 주는지는 test_load.py 가 일회용 DB 로 본다.
"""
import pytest

from local_seed import load
from local_seed.load import SeedError, is_local_endpoint


@pytest.mark.parametrize("host, hostaddr, expected", [
    ("localhost", "127.0.0.1", True),
    ("db.invalid", "127.0.0.1", True),              # 이름과 관계없이 실제로 붙은 주소가 루프백이면 로컬
    ("localhost", "::1", True),
    ("localhost", "::ffff:127.0.0.1", True),
    ("localhost", "10.20.30.40", False),            # host=localhost 여도 hostaddr 로 원격에 붙은 경우
    ("app.planetory.space", "203.0.113.7", False),
    ("/var/run/postgresql", "", True),              # Unix 소켓
    ("remote-host", "", False),
    ("localhost", "not-an-address", False),
])
def test_endpoint_is_judged_by_the_actual_address(host, hostaddr, expected):
    assert is_local_endpoint(host, hostaddr) is expected


class FakeInfo:
    def __init__(self, host, hostaddr):
        self.host, self.hostaddr, self.port, self.dbname = host, hostaddr, 5432, "planetory_poc"


class FakeConnection:
    def __init__(self, host, hostaddr):
        self.info = FakeInfo(host, hostaddr)
        self.closed = False
        self.executed = []

    def close(self):
        self.closed = True

    def execute(self, query, params=None):
        self.executed.append(query)


def test_connect_refuses_a_remote_endpoint_before_any_query(monkeypatch):
    fake = FakeConnection("localhost", "10.20.30.40")
    monkeypatch.setattr(load.psycopg, "connect", lambda *args, **kwargs: fake)
    with pytest.raises(SeedError) as caught:
        load.connect("postgresql://planetory@localhost/planetory_poc?hostaddr=10.20.30.40", "public")
    assert caught.value.code == "NOT_LOCAL"
    assert fake.closed and fake.executed == []


def test_remote_endpoint_needs_an_explicit_flag(monkeypatch):
    fake = FakeConnection("db.example", "203.0.113.7")
    monkeypatch.setattr(load.psycopg, "connect", lambda *args, **kwargs: fake)
    assert load.connect("postgresql://planetory@db.example/planetory_poc", "public", allow_non_local=True) is fake
    assert not fake.closed and len(fake.executed) == 1
