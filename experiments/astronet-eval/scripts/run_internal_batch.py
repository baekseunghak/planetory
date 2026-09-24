"""Launch 126 internal-only CPU regression; never publish AI results."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

from prepare_model import COMMIT, IMAGE
from predict_candidates import digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--conversion-manifest', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, help='Converted directory override after moving PCs')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = args.conversion_manifest.resolve()
    payload = json.loads(manifest.read_text(encoding='utf-8'))
    entries = [e for e in payload['outputs'] if e.get('kind') == 'conversions']
    if len(entries) != 1:
        parser.error('Expected one conversions entry')
    run_dir = (args.run_dir or Path(entries[0]['path']).parent).resolve()
    manifest_rel = manifest.relative_to(root)
    run_rel = run_dir.relative_to(root)
    model_rel = Path('results/runtime/astronet-' + COMMIT)
    if not (root / model_rel / 'assets.json').is_file():
        parser.error('Fixed 118 model assets missing; prepare_model.py must be run explicitly')
    docker = shutil.which('docker')
    if docker is None and os.name == 'nt':
        path = Path(os.environ['LOCALAPPDATA']) / 'Programs/DockerDesktop/resources/bin/docker.exe'
        if path.is_file():
            docker = str(path)
    if docker is None:
        parser.error('Docker CLI not found')
    # --pull never avoids changing the runtime implicitly.
    image_id = subprocess.check_output([docker, 'image', 'inspect', IMAGE,
        '--format', '{{.Id}}'], text=True).strip()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    output = root / 'results/internal-126' / stamp
    output.mkdir(parents=True, exist_ok=False)
    command = [docker, 'run', '--rm', '--network', 'none', '--pull', 'never',
        '--mount', 'type=bind,source={},target=/work,readonly'.format(root),
        '--mount', 'type=bind,source={},target=/out'.format(output),
        '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'CUDA_VISIBLE_DEVICES=-1',
        '-w', '/work', IMAGE, 'python', 'scripts/internal_batch.py',
        '--model-root', '/work/' + model_rel.as_posix(),
        '--run-dir', '/work/' + run_rel.as_posix(),
        '--conversion-manifest', '/work/' + manifest_rel.as_posix(), '--output-dir', '/out/run']
    launch = dict(task='S15P21C206-126', image=IMAGE, image_id=image_id,
                  launcher_sha256=digest(__file__), command=command, internal_only=True)
    (output / 'launch.json').write_text(json.dumps(launch, indent=2) + '\n', encoding='utf-8')
    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as exc:
        (output / 'launch-failure.json').write_text(json.dumps(dict(returncode=exc.returncode)) + '\n')
        raise
    finally:
        print('Host results: {}'.format(output))


if __name__ == '__main__':
    main()
