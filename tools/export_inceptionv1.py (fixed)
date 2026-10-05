"""
Export the ORIGINAL DeepDream model (InceptionV1 / GoogLeNet -- the
"inception5h" graph from Google's deepdream release) to TensorFlow.js
graph-model format, so generator.html can run it in the browser.

This is the model behind the classic deepdream look (dog-slugs, eyeballs,
fractal textures). Note: tf.keras.applications does NOT ship InceptionV1,
so we convert the frozen graph directly instead of going through Keras.

Output: models/inceptionv1/model.json + weight shards (~25-30 MB, float16)

Setup (Python 3.9-3.11), once:
    python -m venv venv
    source venv/bin/activate   # Windows: venv\\Scripts\\activate
    pip install "tensorflow>=2.13,<2.16" "tensorflowjs>=4.13,<4.18"

Run from the repo root:
    python tools/export_inceptionv1.py

Then point generator.html at models/inceptionv1/model.json (see notes below).
"""

import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

# The original DeepDream model (InceptionV1 / GoogLeNet), hosted by Google.
MODEL_ZIP_URL = (
    "https://storage.googleapis.com/download.tensorflow.org/models/inception5h.zip"
)
FROZEN_PB = "tensorflow_inception_graph.pb"

# Classic deepdream layers, low -> high: the 9 Inception module outputs
# (Concat ops). These become the TF.js outputs.
# NOTE: this graph names them mixed3a..mixed5b (not inception_4c/output --
# verify with: strings tensorflow_inception_graph.pb | grep -oE "mixed[0-9][a-z]? " | sort -u)
LAYERS = [
    "mixed3a",
    "mixed3b",
    "mixed4a",
    "mixed4b",
    "mixed4c",
    "mixed4d",
    "mixed4e",
    "mixed5a",
    "mixed5b",
]

OUT_DIR = os.path.join("models", "inceptionv1")
WORK_DIR = os.path.join("tools", ".inceptionv1_tmp")


def download_model():
    os.makedirs(WORK_DIR, exist_ok=True)
    pb_path = os.path.join(WORK_DIR, FROZEN_PB)
    if os.path.exists(pb_path):
        print("Frozen graph already downloaded.")
        return pb_path
    zip_path = os.path.join(WORK_DIR, "inception5h.zip")
    print(f"Downloading {MODEL_ZIP_URL} ...")
    urllib.request.urlretrieve(MODEL_ZIP_URL, zip_path)
    with zipfile.ZipFile(zip_path) as z:
        z.extract(FROZEN_PB, WORK_DIR)
    os.remove(zip_path)
    print("Downloaded and unzipped.")
    return pb_path


def check_graph(pb_path):
    """Make sure the expected input/layer nodes exist before converting."""
    import tensorflow as tf

    graph_def = tf.compat.v1.GraphDef()
    with open(pb_path, "rb") as f:
        graph_def.ParseFromString(f.read())
    names = {n.name for n in graph_def.node}
    placeholders = [n.name for n in graph_def.node if n.op == "Placeholder"]
    print(f"Graph placeholders (model inputs): {placeholders}")
    missing = [layer for layer in LAYERS if layer not in names]
    if missing:
        sys.exit(f"ERROR: layers not found in graph: {missing}")
    print(f"All {len(LAYERS)} dream layers found in graph.")


def convert(pb_path):
    converter = shutil.which("tensorflowjs_converter")
    if not converter:
        sys.exit("ERROR: tensorflowjs_converter not on PATH. pip install tensorflowjs.")
    os.makedirs(OUT_DIR, exist_ok=True)
    cmd = [
        converter,
        "--input_format=tf_frozen_model",
        "--output_format=tfjs_graph_model",
        "--output_node_names=" + ",".join(LAYERS),
        "--quantization_bytes=2",  # float16 weights
        pb_path,
        OUT_DIR,
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    pb_path = download_model()
    check_graph(pb_path)
    convert(pb_path)
    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR)
    )
    print(f"Saved to {OUT_DIR}/ ({total / 1e6:.1f} MB). Commit this folder with your site.")
    print()
    print("generator.html changes needed:")
    print("  - MODEL_URL -> 'models/inceptionv1/model.json'")
    print("  - tf.loadLayersModel -> tf.loadGraphModel (frozen graph has no Keras layers,")
    print("    so patchBatchNorm() must be removed and model.apply() -> model.execute()).")
    print("  - Layer names: mixed2..mixed7 -> mixed3a ... mixed5b")
    print("    (check exact names at runtime via model.outputs.map(o => o.name); they may")
    print("    end in ':0' -- use the exact strings for model.execute()).")
    print("  - Preprocessing: v3 used x/127.5-1 ([-1,1]); v1 expects x-117 on [0,255] pixels:")
    print("      canvasToTensor: fromPixels(cv).toFloat().sub(117).expandDims(0)")
    print("      tensorToCanvas: img.squeeze([0]).add(117).div(255).clipByValue(0,1)")
    print("  - Clips of (-1,1) -> (-117,138): dreamStep, zoomCrop sharpen, startDream noise")
    print("    (noise +-0.04 in v3 units ~= +-10 in v1 units), warmup randomUniform range.")


if __name__ == "__main__":
    main()
