# -*- coding: utf-8 -*-
"""convert 실행 디렉터리의 NPZ 들을 AstroNet-Triage 용 TFRecord 하나로 직렬화한다 (TensorFlow 1.x, Python 3.7 환경).

    <py37-env>/bin/python scripts/write_tfrecords.py --run-dir <results>/eval/<set>/convert-<UTC>-<id> \
        --output <tfrecord-dir>/test-00000-of-00001

40번 `write_probe_tfrecord.py` 의 feature 이름(global_view, local_view, tic_id, Sectors)을 그대로 쓴다.
같은 TIC 에 후보가 여럿이라 tic_id 만으로는 행을 구분할 수 없으므로, 기록 순서와 candidate_id 대응표를
`tfrecord_index.csv` 로 같은 디렉터리에 남긴다. status != ok 인 후보는 넣지 않고 index 에 skipped 로 남긴다.
"""

from __future__ import print_function

import argparse
import csv
import os

import numpy as np
import tensorflow as tf


def float_feature(values):
    return tf.train.Feature(float_list=tf.train.FloatList(value=[float(v) for v in values]))


def int64_feature(values):
    return tf.train.Feature(int64_list=tf.train.Int64List(value=[int(v) for v in values]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, help="convert 실행 디렉터리 (conversions.csv, npz/)")
    parser.add_argument("--output", required=True, help="TFRecord 경로 (예: .../test-00000-of-00001)")
    parser.add_argument("--only-in-truth", action="store_true", help="in_truth=true 후보만 기록")
    args = parser.parse_args()

    conv_path = os.path.join(args.run_dir, "conversions.csv")
    with open(conv_path, "r", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.isdir(output_dir):
        os.makedirs(output_dir)
    index_path = os.path.join(args.run_dir, "tfrecord_index.csv")
    written = 0
    with tf.python_io.TFRecordWriter(args.output) as writer, open(index_path, "w", newline="", encoding="utf-8") as idx:
        w = csv.writer(idx)
        w.writerow(["record_index", "candidate_id", "tic_id", "label", "in_truth", "split", "status", "npz_path"])
        for row in rows:
            skip = row["status"] != "ok" or (args.only_in_truth and row["in_truth"] != "true")
            if skip:
                w.writerow(["", row["candidate_id"], row["tic_id"], row["label"], row["in_truth"], row["split"], "skipped:" + (row["reason"] or "filtered"), ""])
                continue
            probe = np.load(row["npz_path"])
            g, l = probe["global_view"], probe["local_view"]
            if g.shape != (201,) or l.shape != (61,) or not (np.isfinite(g).all() and np.isfinite(l).all()):
                raise AssertionError("unexpected view for %s: %s %s" % (row["candidate_id"], g.shape, l.shape))
            example = tf.train.Example(features=tf.train.Features(feature={
                "global_view": float_feature(g),
                "local_view": float_feature(l),
                "tic_id": int64_feature([int(probe["tic_id"])]),
                "Sectors": int64_feature([int(probe["sectors"][-1])]),
            }))
            writer.write(example.SerializeToString())
            w.writerow([written, row["candidate_id"], row["tic_id"], row["label"], row["in_truth"], row["split"], "written", row["npz_path"]])
            written += 1
    print("Wrote %d examples: %s" % (written, args.output))
    print("Index: %s" % index_path)


if __name__ == "__main__":
    main()
