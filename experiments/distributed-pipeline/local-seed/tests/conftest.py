import pytest

from local_seed.payload import build_all


@pytest.fixture(scope="session")
def payloads():
    """전체 생성은 BLS 때문에 수 초가 걸려 세션에서 한 번만 만든다."""
    return build_all()
