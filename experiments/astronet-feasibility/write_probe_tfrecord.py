"""Serialize a prepared Planetory probe with TensorFlow 1.x."""

from __future__ import print_function

import argparse
import os

import numpy as np
import tensorflow as tf


def float_feature(values):
    return tf.train.Feature(float_list=tf.train.FloatList(value=values))


def int64_feature(values):
    return tf.train.Feature(int64_list=tf.train.Int64List(value=values))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    probe = np.load(args.input)
    example = tf.train.Example(features=tf.train.Features(feature={
        "global_view": float_feature(probe["global_view"]),
        "local_view": float_feature(probe["local_view"]),
        "tic_id": int64_feature([int(probe["tic_id"])]),
        "Sectors": int64_feature([int(probe["sectors"][-1])]),
    }))

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.isdir(output_dir):
        os.makedirs(output_dir)
    with tf.python_io.TFRecordWriter(args.output) as writer:
        writer.write(example.SerializeToString())
    print("Wrote: {}".format(args.output))


if __name__ == "__main__":
    main()
