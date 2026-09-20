# Model graph construction adapted from AstroNet-Triage astronet/batch_predict.py.
# Copyright 2018 The TensorFlow Authors.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Candidate-level calibration inference in isolated TensorFlow 1.15.5 (Python >=3.6)."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import platform
import sys
import time

import numpy as np
from prepare_model import COMMIT, IMAGE, CHECKPOINT


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def calibration_inputs(run_dir, manifest_path, split_name="calibration"):
    if split_name not in ("calibration", "evaluation"):
        raise ValueError("Unknown split")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    outputs = manifest["outputs"]
    csv_entries = [e for e in outputs if e.get("kind") == "conversions"]
    if len(csv_entries) != 1 or digest(run_dir / "conversions.csv") != csv_entries[0]["sha256"]:
        raise ValueError("Conversion CSV checksum mismatch")
    npz_entries = {e["candidate_id"]: e for e in outputs if e.get("kind") == "npz"}
    with (run_dir / "conversions.csv").open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    seen, splits = set(), {}
    selected = []
    for row in rows:
        cid, tic, split = row["candidate_id"], row["tic_id"], row["split"]
        if cid in seen or split not in ("calibration", "evaluation"):
            raise ValueError("Invalid or duplicate candidate: " + cid)
        seen.add(cid)
        expected = "calibration" if hashlib.sha256(tic.encode("ascii")).digest()[0] % 2 == 0 else "evaluation"
        if split != expected or (tic in splits and splits[tic] != split):
            raise ValueError("TIC split violation: " + tic)
        splits[tic] = split
        if split != split_name:
            continue
        if row["status"] != "ok":
            selected.append((row, None))
            continue
        # Reconstruct inside mounted run_dir, never use Windows absolute CSV paths in Linux.
        if not cid or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for ch in cid):
            raise ValueError("Unsafe candidate ID")
        path = run_dir / "npz" / (cid + ".npz")
        if cid not in npz_entries or digest(path) != npz_entries[cid]["sha256"]:
            raise ValueError("NPZ file checksum mismatch: " + cid)
        with np.load(str(path), allow_pickle=False) as probe:
            if str(probe["candidate_id"]) != cid or int(probe["tic_id"]) != int(tic) or str(probe["label"]) != row["label"]:
                raise ValueError("NPZ identity mismatch: " + cid)
            arrays = {}
            for key, size, hash_key in (("global_view", 201, "global_sha256"), ("local_view", 61, "local_sha256")):
                value = probe[key]
                if value.shape != (size,) or value.dtype != np.float32 or not np.isfinite(value).all():
                    raise ValueError("Invalid view: " + cid)
                if hashlib.sha256(value.tobytes()).hexdigest() != row[hash_key]:
                    raise ValueError("Array checksum mismatch: " + cid)
                arrays[key] = value.copy()
        selected.append((row, arrays))
    if not selected:
        raise ValueError("No candidates in requested split")
    return selected


def load_thresholds(path, conversion_manifest, assets_path, calibration_manifest=None):
    plan = json.loads(path.read_text(encoding="utf-8"))
    if not plan.get("threshold_version") or not (0 <= plan["lower"] < plan["upper"] <= 1):
        raise ValueError("Invalid threshold plan")
    if plan["conversion_manifest_sha256"] != digest(conversion_manifest):
        raise ValueError("Threshold input binding mismatch")
    if plan["assets_sha256"] != digest(assets_path):
        raise ValueError("Threshold model binding mismatch")
    if calibration_manifest is None or not calibration_manifest.is_file():
        raise ValueError("Calibration manifest is required")
    calibration = json.loads(calibration_manifest.read_text(encoding="utf-8"))
    if calibration.get("status") != "completed" or calibration.get("split") != "calibration":
        raise ValueError("Expected completed calibration manifest")
    predictions = calibration_manifest.parent / "predictions.csv"
    if not predictions.is_file():
        raise ValueError("Calibration predictions missing")
    actual = digest(predictions)
    if (plan.get("calibration_predictions_sha256") != actual or
            calibration.get("predictions_sha256") != actual):
        raise ValueError("Calibration predictions hash mismatch")
    for key in ("conversion_manifest_sha256", "assets_sha256"):
        if calibration.get(key) != plan[key]:
            raise ValueError("Calibration binding mismatch: " + key)
    return plan


def decision_band(score, plan):
    return "below" if score < plan["lower"] else "approved" if score >= plan["upper"] else "review"


def build_graph(tf, models, config):
    graph = tf.Graph()
    with graph.as_default():
        placeholders, features = {}, {}
        for name, spec in config.inputs.features.items():
            placeholders[name] = tf.placeholder(tf.float32, shape=[1, spec.length], name=name)
            group = "time_series_features" if spec.is_time_series else "aux_features"
            features.setdefault(group, {})[name] = placeholders[name]
        model = models.get_model_class("AstroCNNModel")(
            features=features, labels=None, hparams=config.hparams, mode=tf.estimator.ModeKeys.PREDICT)
        model.build()
        saver = tf.train.Saver()
    return graph, placeholders, model, saver


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--conversion-manifest", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--split", choices=["calibration", "evaluation"], default="calibration")
    parser.add_argument("--threshold-plan", type=Path)
    parser.add_argument("--calibration-manifest", type=Path)
    args = parser.parse_args()
    started = time.perf_counter()
    assets_path = args.model_root / "assets.json"
    if args.split == "evaluation" and args.threshold_plan is None:
        parser.error("Evaluation requires a frozen threshold plan")
    plan = load_thresholds(args.threshold_plan, args.conversion_manifest, assets_path,
                           args.calibration_manifest) if args.threshold_plan else None
    calibration_hash = digest(args.calibration_manifest) if plan else None
    selected = calibration_inputs(args.run_dir, args.conversion_manifest, args.split)
    assets = json.loads(assets_path.read_text(encoding="utf-8"))
    if (assets["repo_commit"], assets["checkpoint"], assets["image"]) != (COMMIT, CHECKPOINT, IMAGE):
        raise ValueError("Unexpected model version")
    for entry in assets["files"]:
        path = (args.model_root / entry["path"]).resolve()
        path.relative_to(args.model_root.resolve())
        if digest(path) != entry["sha256"]:
            raise ValueError("Model asset checksum mismatch: " + entry["path"])
    sys.path.insert(0, str(args.model_root.resolve()))
    import tensorflow as tf
    from astronet import models
    from astronet.util import configdict
    if tf.__version__ != "1.15.5":
        raise ValueError("Expected TensorFlow 1.15.5")
    config = configdict.ConfigDict(models.get_model_config("AstroCNNModel", "local_global"))
    graph, placeholders, model, saver = build_graph(tf, models, config)
    if set(placeholders) != {"global_view", "local_view"}:
        raise ValueError("Unexpected model inputs")
    # Fresh output directory prevents silently replacing a previous result.
    args.output_dir.mkdir(parents=True, exist_ok=False)
    rows = []
    with tf.Session(graph=graph, config=tf.ConfigProto(device_count={"GPU": 0},
                    intra_op_parallelism_threads=2, inter_op_parallelism_threads=2)) as session:
        saver.restore(session, str(args.model_root / CHECKPOINT))
        for metadata, arrays in selected:
            row = {key: metadata[key] for key in ("candidate_id", "tic_id", "label", "in_truth", "split", "status", "reason")}
            row["score"] = ""
            if plan:
                row["decision_band"] = ""
            if arrays is not None:
                score = float(session.run(model.predictions, {placeholders[k]: arrays[k][None, :] for k in placeholders})[0][0])
                if not np.isfinite(score) or not 0 <= score <= 1:
                    raise ValueError("Invalid prediction: " + row["candidate_id"])
                row["score"] = repr(score)
                if plan:
                    row["decision_band"] = decision_band(score, plan)
            rows.append(row)
    output = args.output_dir / "predictions.csv"
    with output.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    report = {
        "task": "S15P21C206-118", "split": args.split, "status": "completed",
        "n_candidates": len(rows), "n_scored": sum(r["status"] == "ok" for r in rows),
        "wall_seconds": time.perf_counter() - started, "python": platform.python_version(),
        "tensorflow": tf.__version__, "numpy": np.__version__, "device": "CPU", "threads": 2,
        "repo_commit": COMMIT, "checkpoint": CHECKPOINT, "expected_image": IMAGE,
        "assets_sha256": digest(assets_path), "conversion_manifest_sha256": digest(args.conversion_manifest),
        "conversions_sha256": digest(args.run_dir / "conversions.csv"), "predictions_sha256": digest(output),
        "runner_sha256": digest(__file__), "command": sys.argv,
        "score_meaning": "PC/EB versus junk; not planet probability",
    }
    if plan:
        # Refuse a completed report if provenance changed during inference.
        if (load_thresholds(args.threshold_plan, args.conversion_manifest, assets_path,
                            args.calibration_manifest) != plan or
                digest(args.calibration_manifest) != calibration_hash):
            raise ValueError("Calibration provenance changed during inference")
        report["calibration_manifest_sha256"] = calibration_hash
        report["threshold_version"] = plan["threshold_version"]
        report["threshold_plan_sha256"] = digest(args.threshold_plan)
        report["threshold_plan"] = plan
        (args.output_dir / "threshold_plan.json").write_bytes(args.threshold_plan.read_bytes())
    (args.output_dir / "manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Scored {}/{} {} candidates".format(report["n_scored"], len(rows), args.split))
    print("Predictions: {}\nManifest: {}".format(output, args.output_dir / "manifest.json"))


if __name__ == "__main__":
    main()
