"""
Export InceptionV2 (the TF-Slim checkpoint inception_v2_2016_08_28) to
TensorFlow.js graph-model format, so generator.html can run it in the browser.

This is the Dream Generator model for Waking Woods (town 2).

Unlike InceptionV1 (frozen .pb from Google's deepdream release) and
InceptionV3 (Keras), InceptionV2 only exists as a TF-Slim checkpoint, so we
rebuild the slim graph, restore the weights, freeze it, and convert.

Output: models/inceptionv2/model.json + weight shards (~45-50 MB, float16)

Setup (Python 3.9-3.11), once:
    pip install "tensorflow>=2.13,<2.16" "tensorflowjs>=4.13,<4.18" tf-slim

Run from the repo root:
    python tools/export_inceptionv2.py
"""

import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request

# TF-Slim InceptionV2 checkpoint (ImageNet, 2016-08-28). Verified live 2026-10-06.
CHECKPOINT_URL = (
    "https://storage.googleapis.com/download.tensorflow.org/models/"
    "inception_v2_2016_08_28.tar.gz"
)

# Deepdream layers, low -> high: the 10 Inception module outputs (Concat ops).
# These become the TF.js outputs.
LAYERS = [
    "Mixed_3b",
    "Mixed_3c",
    "Mixed_4a",
    "Mixed_4b",
    "Mixed_4c",
    "Mixed_4d",
    "Mixed_4e",
    "Mixed_5a",
    "Mixed_5b",
    "Mixed_5c",
]

OUT_DIR = os.path.join("models", "inceptionv2")
WORK_DIR = os.path.join("tools", ".inceptionv2_tmp")
FROZEN_PB = os.path.join(WORK_DIR, "inception_v2_frozen.pb")


def find_checkpoint(work_dir):
    """Find an extracted checkpoint, new (*.index) or old single-file (*.ckpt) format."""
    for root, _dirs, files in os.walk(work_dir):
        for f in files:
            if f.endswith(".index"):
                return os.path.join(root, f[: -len(".index")])
    # TF 1.x-era single-file checkpoints (e.g. inception_v2_2016_08_28.tar.gz
    # contains just "inception_v2.ckpt"): the full path is the restore prefix.
    for root, _dirs, files in os.walk(work_dir):
        for f in files:
            if f.endswith(".ckpt"):
                return os.path.join(root, f)
    return None


def download_checkpoint():
    os.makedirs(WORK_DIR, exist_ok=True)
    # Find an already-extracted checkpoint first (lets re-runs skip the download).
    prefix = find_checkpoint(WORK_DIR)
    if prefix:
        print(f"Checkpoint already extracted: {prefix}")
        return prefix
    tar_path = os.path.join(WORK_DIR, "inception_v2.tar.gz")
    if not os.path.exists(tar_path):
        print(f"Downloading {CHECKPOINT_URL} ... (~41 MB)")
        urllib.request.urlretrieve(CHECKPOINT_URL, tar_path)
    print("Extracting ...")
    with tarfile.open(tar_path, "r:gz") as t:
        t.extractall(WORK_DIR)
    os.remove(tar_path)
    print("Extracted files:")
    for root, _dirs, files in os.walk(WORK_DIR):
        for f in files:
            print("  " + os.path.relpath(os.path.join(root, f), WORK_DIR))
    prefix = find_checkpoint(WORK_DIR)
    if prefix:
        print(f"Checkpoint ready: {prefix}")
        return prefix
    sys.exit("ERROR: no checkpoint found in the tarball.")


def detect_num_classes(ckpt_prefix):
    """Read the logits weight shape from the checkpoint (1000 vs 1001)."""
    import tensorflow.compat.v1 as tf

    reader = tf.train.NewCheckpointReader(ckpt_prefix)
    shape_map = reader.get_variable_to_shape_map()
    for name, shape in shape_map.items():
        if name.endswith("Logits/Conv2d_1c_1x1/weights"):
            n = shape[3]
            print(f"Checkpoint logits: {name} shape {shape} -> num_classes={n}")
            return n
    sys.exit("ERROR: logits weights not found in checkpoint.")


def build_and_freeze(ckpt_prefix, num_classes):
    import tensorflow.compat.v1 as tf

    tf.disable_v2_behavior()
    import tf_slim as slim
    from tf_slim.nets import inception_v2

    tf.reset_default_graph()
    inp = tf.placeholder(tf.float32, shape=[None, None, None, 3], name="input")
    # The 2016 checkpoint was trained with batch norm via
    # inception_v2_arg_scope(). Without it the graph has no BatchNorm
    # variables at all (and gains 'biases' the checkpoint never had), so the
    # arg_scope is required for an exact restore. is_training=False makes BN
    # use the trained moving stats and dropout an identity.
    # NOTE: inception_v2_arg_scope() returns a params dict, not a context
    # manager, so it must be wrapped in slim.arg_scope().
    with slim.arg_scope(inception_v2.inception_v2_arg_scope()):
        _logits, endpoints = inception_v2.inception_v2(
            inp, num_classes=num_classes, is_training=False
        )
    missing = [k for k in LAYERS if k not in endpoints]
    if missing:
        sys.exit(f"ERROR: endpoints missing from graph: {missing}")
    output_names = [endpoints[k].op.name for k in LAYERS]
    print("Dream layer nodes:")
    for k, n in zip(LAYERS, output_names):
        print(f"  {k:10s} -> {n}")

    # With the arg_scope above, graph and checkpoint should match exactly:
    # slim creates no 'biases' when a normalizer is set, and scale=False
    # creates no BatchNorm 'gamma' — same as the 2016 training. Restore the
    # intersection; anything missing whose initializer is not a provable
    # no-op (biases=0, gamma=1) fails loudly instead of baking a silently
    # wrong model.
    reader = tf.train.NewCheckpointReader(ckpt_prefix)
    ckpt_vars = set(reader.get_variable_to_shape_map().keys())
    # Batch-norm moving stats live in the 'moving_vars' collection, not
    # GLOBAL_VARIABLES (see inception_v2_arg_scope's variables_collections),
    # so collect both.
    graph_vars = {}
    for v in tf.global_variables() + tf.get_collection("moving_vars"):
        graph_vars[v.op.name] = v
    graph_vars = list(graph_vars.values())
    graph_names = {v.op.name for v in graph_vars}
    restore_vars = [v for v in graph_vars if v.op.name in ckpt_vars]
    skipped = sorted(n for n in graph_names if n not in ckpt_vars)
    orphaned = sorted(n for n in ckpt_vars if n not in graph_names)
    print(f"Restoring {len(restore_vars)}/{len(graph_vars)} graph variables.")
    if skipped:
        bad = [
            n
            for n in skipped
            if not (n.endswith("/biases") or n.endswith("/gamma"))
        ]
        if bad:
            sys.exit(
                "ERROR: checkpoint is missing variables with no safe default "
                "(not biases/gamma) — variable-name mismatch:\n  "
                + "\n  ".join(bad)
            )
        print(
            f"Skipped {len(skipped)} (init defaults are exact no-ops: biases=0, gamma=1)."
        )
    if orphaned:
        print(f"NOTE: {len(orphaned)} checkpoint variables have no graph variable (left unrestored):")
        for n in orphaned[:10]:
            print(f"  {n}")
        if len(orphaned) > 10:
            print(f"  ... and {len(orphaned) - 10} more")

    saver = tf.train.Saver(var_list=restore_vars)
    with tf.Session() as sess:
        print("Restoring checkpoint ...")
        sess.run(tf.variables_initializer(graph_vars))
        saver.restore(sess, ckpt_prefix)
        print("Freezing graph ...")
        frozen = tf.graph_util.convert_variables_to_constants(
            sess, sess.graph_def, output_names
        )
    with open(FROZEN_PB, "wb") as f:
        f.write(frozen.SerializeToString())
    print(f"Wrote frozen graph: {FROZEN_PB} ({os.path.getsize(FROZEN_PB)/1e6:.1f} MB)")
    return output_names


def convert(output_names):
    converter = shutil.which("tensorflowjs_converter")
    if not converter:
        sys.exit("ERROR: tensorflowjs_converter not on PATH. pip install tensorflowjs.")
    os.makedirs(OUT_DIR, exist_ok=True)
    cmd = [
        converter,
        "--input_format=tf_frozen_model",
        "--output_format=tfjs_graph_model",
        "--output_node_names=" + ",".join(output_names),
        "--quantization_bytes=2",  # float16 weights
        FROZEN_PB,
        OUT_DIR,
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    ckpt_prefix = download_checkpoint()
    num_classes = detect_num_classes(ckpt_prefix)
    output_names = build_and_freeze(ckpt_prefix, num_classes)
    convert(output_names)
    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR)
    )
    print(f"Saved to {OUT_DIR}/ ({total / 1e6:.1f} MB). Commit this folder with your site.")
    print()
    print("generator.html changes needed:")
    print("  - MODELS registry: add v2 -> { kind:'graph', url:'models/inceptionv2/model.json' }")
    print("  - v2 layer names (exact, from above):")
    for n in output_names:
        print(f"      '{n}',")
    print("  - Preprocessing: slim v2 was trained on [-1,1] (same as v3):")
    print("      canvasToTensor: fromPixels(cv).toFloat().div(127.5).sub(1).expandDims(0)")
    print("      tensorToCanvas: img.squeeze([0]).add(1).div(2).clipByValue(0,1)")
    print("  - Clips of (-1,1): dreamStep, zoomCrop sharpen, startDream noise +-0.04,")
    print("    warmup randomUniform(-1,1).")


if __name__ == "__main__":
    main()
