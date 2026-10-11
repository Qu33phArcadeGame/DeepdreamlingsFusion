"""
Export VGG16 (Keras, ImageNet) to TensorFlow.js layers-model format, so
generator.html can run it in the browser as the next Dream Generator model.

Same pattern as tools/export_inceptionv3.py: the weights download
automatically from Keras, no checkpoint needed. VGG16 has no Inception
modules, so the five classic deepdream layers are the last conv layer of
each block (block1_conv2 .. block5_conv3) — the painterly look.

Output: models/vgg16/model.json + weight shards (~60 MB, float16)

Setup (Python 3.9-3.11), once:
    pip install "tensorflow>=2.13,<2.16" "tensorflowjs>=4.13,<4.18"

Run from the repo root:
    python tools/export_vgg16.py
"""

import os
import shutil
import subprocess
import sys

# The classic DeepDream VGG layers: last conv of each block.
# These become the TF.js outputs.
LAYERS = [
    "block1_conv2",
    "block2_conv2",
    "block3_conv3",
    "block4_conv3",
    "block5_conv3",
]

OUT_DIR = os.path.join("models", "vgg16")
WORK_DIR = os.path.join("tools", ".vgg16_tmp")
KERAS_PATH = os.path.join(WORK_DIR, "vgg16_dream.h5")


def build():
    import tensorflow as tf

    os.makedirs(WORK_DIR, exist_ok=True)
    print("Loading VGG16 (weights download on first run) ...")
    base = tf.keras.applications.VGG16(
        weights="imagenet", include_top=False, input_shape=(None, None, 3)
    )
    outputs = [base.get_layer(name).output for name in LAYERS]
    dream = tf.keras.Model(inputs=base.input, outputs=outputs)
    dream.save(KERAS_PATH)
    print(f"Saved Keras model: {KERAS_PATH}")


def convert():
    converter = shutil.which("tensorflowjs_converter")
    if not converter:
        sys.exit("ERROR: tensorflowjs_converter not on PATH. pip install tensorflowjs.")
    os.makedirs(OUT_DIR, exist_ok=True)
    cmd = [
        converter,
        "--input_format=keras",
        "--output_format=tfjs_layers_model",
        "--quantization_bytes=2",  # float16 weights
        KERAS_PATH,
        OUT_DIR,
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    build()
    convert()
    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR)
    )
    print(f"Saved to {OUT_DIR}/ ({total / 1e6:.1f} MB). Commit this folder with your site.")
    print()
    print("generator.html changes needed (matches the commented vgg16 template):")
    print("  1. Uncomment the vgg16 entry in MODELS.")
    print("  2. Add a 'vgg' entry to PRE (caffe preprocessing: RGB->BGR, mean-subtract):")
    print("       vgg: { norm:t=>t.reverse(-1).sub(tf.tensor1d([103.939,116.779,123.68])),")
    print("              denorm:t=>t.add(tf.tensor1d([103.939,116.779,123.68])).reverse(-1).div(255),")
    print("              lo:-103.939, hi:151.061, noise:[-10,10] },")
    print("  3. Point an area at it, e.g. add to AREAS: the 4th area's generator")
    print("     { x:.., y:.., w:3, h:2 } and give that area ?town=<area> -> 'vgg16'.")
    print("  4. Optional: add vgg16 presets with m:\"vgg16\" (start from the block4_conv3")
    print("     default layer; early blocks give painterly textures, deep ones organic shapes).")


if __name__ == "__main__":
    main()
