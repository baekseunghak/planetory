"""목업 입력 어댑터: 계약 예시 payload를 더미 별에 옮겨 싣는다 [S15P21C206-262].

실제 Gold가 서비스 DB에 오기 전까지 분석 화면을 열어 보기 위한 입력이다. load.publish는 이 어댑터와
운영 입력(HDFS Gold reader)을 구분하지 않는다. 교체할 때 바꾸는 것은 이 파일 하나다.

원천은 fixtures/gold-toi270-s3.json이다. experiments/gold-roundtrip(S15P21C206-117)이 실제 TESS
곡선(TOI-270, Sector 3)으로 만든 계약 예시이며 과학 기준값이 아니다(contractStatus 참고).

목업 행은 MARK로 알아본다. 판 bundle_version과 세그먼트 binning_revision 앞에 붙는다.
mock_purge.sql이 이 표식으로만 지우므로 운영 Gold와 섞이지 않는다.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Iterable, Iterator

FIXTURE = Path(__file__).parent / "fixtures" / "gold-toi270-s3.json"
MARK = "mock-"


def payloads(tics: Iterable[int]) -> Iterator[dict]:
    base = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for tic in tics:
        yield retarget(base, tic)


def retarget(base: dict, tic: int) -> dict:
    """base를 tic의 목업 판으로 바꾼다. 같은 입력이면 같은 판 버전이라 다시 돌려도 재시도로 끝난다."""
    p = copy.deepcopy(base)
    digest = hashlib.sha256(f"{base['bundle']['bundle_version']}:{tic}".encode()).hexdigest()[:16]
    p["bundle"]["tic_id"] = tic
    p["bundle"]["bundle_version"] = f"{MARK}{digest}"
    for seg in p["segments"]:
        old = f"segment:{seg['sector']}:{seg['binning_revision']}:flux"
        seg["tic_id"] = tic
        seg["binning_revision"] = MARK + seg["binning_revision"]
        p["checksums"][f"segment:{seg['sector']}:{seg['binning_revision']}:flux"] = p["checksums"].pop(old)
    # 외부 라벨·AI 결과는 싣지 않는다. 분석 진입에 필요 없고 지울 대상만 늘린다.
    p["external_statuses"], p["ai_results"] = [], []
    return p
