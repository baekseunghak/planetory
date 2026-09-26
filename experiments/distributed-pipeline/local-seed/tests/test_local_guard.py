"""적재 대상이 이 PC 인지 가리는 판정(MR !201 리뷰). DB 없이 돈다.

libpq 는 URL 의 host 말고도 hostaddr·service 파일·PGHOST 같은 환경변수로 붙을 곳을 정한다. 그래서 접속 전에는
URL 과 환경변수를 libpq 처럼 읽어 보고, 접속 뒤에는 실제로 붙은 주소를 본다. test_load.py 는 모듈 전체가 DB 를
요구해 DB 없는 판정 테스트는 이 파일에 둔다. 실제 연결에서의 판정은 test_load.py 가 일회용 DB 로 본다.
"""
import psycopg
import pytest

from local_seed import load
from local_seed.load import SeedError, conninfo_problem, is_local_endpoint


@pytest.fixture(autouse=True)
def no_libpq_env(monkeypatch):
    """개발 PC 의 PG* 환경변수가 판정에 섞이지 않게 한다."""
    for name in ("PGHOST", "PGHOSTADDR", "PGSERVICE"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("url, env, local", [
    # 리뷰 재현 표
    ("postgresql://u:p@10.1.2.3:5432/db", {}, False),
    ("postgresql://u:p@localhost:5432/db?hostaddr=10.1.2.3", {}, False),  # TCP 는 host 가 아니라 hostaddr 로 붙는다
    ("postgresql://u:p@/db", {}, True),                                    # 비면 libpq 기본값(로컬)
    ("postgresql://u:p@/db", {"PGHOST": "10.1.2.3"}, False),
    ("service=prod", {}, False),                                           # pg_service.conf 가 정한다
    # 환경변수가 URL 에 없는 값을 채우는 경우
    ("postgresql://u:p@localhost/db", {"PGHOSTADDR": "10.1.2.3"}, False),
    ("postgresql://u:p@localhost/db", {"PGSERVICE": "prod"}, False),
    ("postgresql://u:p@localhost/db", {"PGHOST": "10.1.2.3"}, True),       # URL 의 host 가 환경변수보다 앞선다
    # 여러 host 중 하나라도 밖이면 거절
    ("postgresql://u:p@localhost,10.1.2.3/db", {}, False),
    # 로컬 형식
    ("postgresql://u:p@127.0.0.1:15432/db", {}, True),
    ("postgresql://u:p@[::1]:15432/db", {}, True),
    ("host=/var/run/postgresql dbname=db", {}, True),
    ("host=db.invalid hostaddr=127.0.0.1 dbname=db", {}, True),           # 붙는 곳은 hostaddr
])
def test_conninfo_is_read_like_libpq(monkeypatch, url, env, local):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert (conninfo_problem(url) is None) is local


@pytest.mark.parametrize("host, hostaddr, expected", [
    ("localhost", "127.0.0.1", True),
    ("db.invalid", "127.0.0.1", True),              # 이름과 관계없이 실제로 붙은 주소가 루프백이면 로컬
    ("localhost", "::1", True),
    ("localhost", "::ffff:127.0.0.1", True),
    ("localhost", "10.20.30.40", False),            # hosts 파일 등으로 localhost 가 원격으로 풀린 경우
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
    """psycopg 연결처럼 닫은 뒤에는 info 를 읽으면 오류가 난다."""

    def __init__(self, host, hostaddr):
        self._info = FakeInfo(host, hostaddr)
        self.closed = False
        self.executed = []

    @property
    def info(self):
        if self.closed:
            raise psycopg.OperationalError("the connection is closed")
        return self._info

    def close(self):
        self.closed = True

    def execute(self, query, params=None):
        self.executed.append(query)


def test_connect_does_not_contact_a_remote_it_can_see(monkeypatch):
    def must_not_connect(*args, **kwargs):
        raise AssertionError("URL·환경변수로 원격이 보이면 접속하지 않아야 한다")
    monkeypatch.setattr(load.psycopg, "connect", must_not_connect)
    with pytest.raises(SeedError) as caught:
        load.connect("postgresql://planetory@localhost/planetory_poc?hostaddr=10.20.30.40", "public")
    assert caught.value.code == "NOT_LOCAL" and "10.20.30.40" in str(caught.value)


def test_connect_closes_when_the_actual_address_is_remote(monkeypatch):
    """접속 전 판정이 못 보는 경우(hosts 파일 등)는 접속 뒤 실제 주소로 막고, 아무 쿼리도 보내지 않는다."""
    fake = FakeConnection("localhost", "10.20.30.40")
    monkeypatch.setattr(load.psycopg, "connect", lambda *args, **kwargs: fake)
    with pytest.raises(SeedError) as caught:
        load.connect("postgresql://planetory@localhost/planetory_poc", "public")
    assert caught.value.code == "NOT_LOCAL" and "10.20.30.40:5432" in str(caught.value)
    assert fake.closed and fake.executed == []


def test_remote_endpoint_needs_an_explicit_flag(monkeypatch):
    fake = FakeConnection("db.example", "203.0.113.7")
    monkeypatch.setattr(load.psycopg, "connect", lambda *args, **kwargs: fake)
    assert load.connect("postgresql://planetory@db.example/planetory_poc", "public", allow_non_local=True) is fake
    assert not fake.closed and len(fake.executed) == 1
