"""Download the fixed official source and model_1 only; never execute Git."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

COMMIT = "5675a57dd41dd0321df480453451096dc5a4a6b0"
IMAGE = "tensorflow/tensorflow@sha256:181ff142e73ed8efe350f49288c7b0f5681fde66534a76d8de4fc75d4e30d571"
CHECKPOINT = "astronet/models_final/model_1/model.ckpt-14000"


def fetch(url):
    with urlopen(Request(url, headers={"User-Agent": "Planetory-118"}), timeout=120) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("results/runtime/astronet-" + COMMIT))
    args = parser.parse_args()
    tree = json.loads(fetch("https://api.github.com/repos/yuliang419/Astronet-Triage/git/trees/" + COMMIT + "?recursive=1"))
    if tree.get("truncated"):
        raise ValueError("Incomplete official source tree")
    entries = []
    for item in tree["tree"]:
        name = item["path"]
        wanted = (name in ("LICENSE", "README.md", CHECKPOINT + ".index", CHECKPOINT + ".data-00000-of-00001")
                  or (name.startswith("astronet/") and name.endswith(".py") and not name.endswith("_test.py")))
        if item["type"] != "blob" or not wanted:
            continue
        path = (args.output / name).resolve()
        path.relative_to(args.output.resolve())
        data = path.read_bytes() if path.exists() else fetch(
            "https://raw.githubusercontent.com/yuliang419/Astronet-Triage/" + COMMIT + "/" + name)
        blob = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        if blob != item["sha"]:
            raise ValueError("Official blob checksum mismatch: " + name)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(data)
        entries.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "git_blob": blob})
    required = {"LICENSE", CHECKPOINT + ".index", CHECKPOINT + ".data-00000-of-00001", "astronet/models.py"}
    if not required.issubset({e["path"] for e in entries}):
        raise ValueError("Required model files missing")
    manifest = {"repo_commit": COMMIT, "image": IMAGE, "checkpoint": CHECKPOINT, "files": entries}
    (args.output / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Verified {} official files: {}".format(len(entries), args.output))


if __name__ == "__main__":
    main()
