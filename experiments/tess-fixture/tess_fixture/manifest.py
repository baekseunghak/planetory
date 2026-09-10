# -*- coding: utf-8 -*-
"""실행 manifest: 어떤 입력·설정·환경·명령으로 어떤 산출물을 만들었는지 한 JSON 에 남긴다.

스키마는 schemas/run_manifest.schema.json. 외부 검증 라이브러리 없이 필수 키만 검사한다.
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_ID = "planetory.run-manifest.v1"
REQUIRED_TOP = ("schema", "run_id", "created_at", "task", "command", "code", "environment", "inputs", "config", "outputs")


def _git(args: list[str], cwd: Path) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def code_info(repo_dir: Path) -> dict:
    commit = _git(["rev-parse", "HEAD"], repo_dir)
    dirty = _git(["status", "--porcelain", "--untracked-files=no"], repo_dir)
    return {
        "git_commit": commit,
        "git_branch": _git(["rev-parse", "--abbrev-ref", "HEAD"], repo_dir),
        "git_dirty": None if dirty is None else bool(dirty),
    }


def environment_info(packages: tuple[str, ...] = ("numpy", "astropy")) -> dict:
    versions = {}
    for name in packages:
        try:
            module = __import__(name)
            versions[name] = getattr(module, "__version__", "unknown")
        except ImportError:
            versions[name] = None
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": versions,
    }


def file_entry(path: Path, **extra) -> dict:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    entry = {"path": str(path), "size_bytes": path.stat().st_size, "sha256": digest}
    entry.update(extra)
    return entry


def new_run_id() -> str:
    return str(uuid.uuid4())


def build_manifest(task: str, command: str, repo_dir: Path, inputs: list[dict], config: dict,
                   outputs: list[dict], notes: str = "", run_id: str | None = None) -> dict:
    """run_id 를 미리 만들어 넘기면 산출물 디렉터리 이름과 manifest 가 같은 id 를 공유한다."""
    return {
        "schema": SCHEMA_ID,
        "run_id": run_id or new_run_id(),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "task": task,
        "command": command,
        "code": code_info(repo_dir),
        "environment": environment_info(),
        "inputs": inputs,
        "config": config,
        "outputs": outputs,
        "notes": notes,
    }


def validate_manifest(manifest: dict) -> None:
    missing = [k for k in REQUIRED_TOP if k not in manifest]
    if missing:
        raise ValueError(f"manifest lacks keys: {missing}")
    if manifest["schema"] != SCHEMA_ID:
        raise ValueError(f"unexpected schema {manifest['schema']}")
    for i, entry in enumerate(manifest["inputs"]):
        for key in ("path", "sha256"):
            if key not in entry:
                raise ValueError(f"inputs[{i}] lacks '{key}'")
    for key in ("name", "version", "sha256"):
        if key not in manifest["config"]:
            raise ValueError(f"config lacks '{key}'")


def write_manifest(manifest: dict, path: Path) -> Path:
    validate_manifest(manifest)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
