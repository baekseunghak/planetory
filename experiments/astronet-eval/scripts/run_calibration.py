"""Launch calibration-only inference in the pinned, offline CPU container."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

from prepare_model import COMMIT, IMAGE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conversion-manifest", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, help="Override converted run location after moving PCs")
    parser.add_argument("--split", choices=["calibration", "evaluation"], default="calibration")
    parser.add_argument("--threshold-plan", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.split == "evaluation" and args.threshold_plan is None:
        parser.error("Evaluation requires --threshold-plan")
    plan_relative = args.threshold_plan.resolve().relative_to(root) if args.threshold_plan else None
    manifest = args.conversion_manifest.resolve()
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    conversion = next(e for e in payload["outputs"] if e.get("kind") == "conversions")
    run_dir = (args.run_dir or Path(conversion["path"]).parent).resolve()
    manifest_relative, run_relative = manifest.relative_to(root), run_dir.relative_to(root)
    model_relative = Path("results/runtime/astronet-" + COMMIT)
    if not (root / model_relative / "assets.json").is_file():
        parser.error("Run python scripts/prepare_model.py first")
    docker = shutil.which("docker")
    if docker is None and os.name == "nt":
        candidate = Path(os.environ["LOCALAPPDATA"]) / "Programs/DockerDesktop/resources/bin/docker.exe"
        if candidate.is_file():
            docker = str(candidate)
    if docker is None:
        parser.error("Docker CLI not found; open Docker Desktop and restart the terminal")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    output = root / "results/predictions" / (args.split + "-" + stamp)
    output.mkdir(parents=True, exist_ok=False)
    command = [docker, "run", "--rm", "--network", "none", "--pull", "never",
               "--mount", "type=bind,source={},target=/work,readonly".format(root),
               "--mount", "type=bind,source={},target=/out".format(output),
               "-e", "PYTHONDONTWRITEBYTECODE=1", "-w", "/work", IMAGE,
               "python", "scripts/predict_candidates.py",
               "--run-dir", "/work/" + run_relative.as_posix(),
               "--conversion-manifest", "/work/" + manifest_relative.as_posix(),
               "--model-root", "/work/" + model_relative.as_posix(), "--output-dir", "/out/run"]
    command += ["--split", args.split]
    if plan_relative:
        command += ["--threshold-plan", "/work/" + plan_relative.as_posix()]
    subprocess.run(command, check=True)
    print("Host results: {}".format(output / "run"))


if __name__ == "__main__":
    main()
