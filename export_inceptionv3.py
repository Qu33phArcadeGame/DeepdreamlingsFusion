"""
Export the part of InceptionV3 that DeepDream needs (input -> mixed7) to
TensorFlow.js format, so generator.html can run it in the browser.

Output: models/inceptionv3/model.json + weight shards (~18 MB, float16)

Setup (Python 3.9-3.11), once:
    python -m venv venv
    source venv/bin/activate            # Windows: venv\\Scripts\\activate
    pip install "tensorflow>=2.13,<2.16" "tensorflowjs>=4.13,<4.18"

Run from the repo root:
    python tools/export_inceptionv3.py

TensorFlow is pinned below 2.16 on purpose: 2.16+ ships Keras 3, which the
TensorFlow.js layers converter can't read.
"""
import os
import tensorflow as tf
import tensorflowjs as tfjs

# Layers the generator can amplify (Settings -> Inception layers).
LAYERS = ["mixed2", "mixed3", "mixed4", "mixed5", "mixed6", "mixed7"]
OUT_DIR = os.path.join("models", "inceptionv3")

base = tf.keras.applications.InceptionV3(
    include_top=False, weights="imagenet", input_shape=(None, None, 3)
)
dream = tf.keras.Model(
    inputs=base.input,
    outputs=[base.get_layer(n).output for n in LAYERS],
    name="inceptionv3_dream",
)
print(f"Dream model: {len(dream.layers)} layers, {dream.count_params():,} params")

os.makedirs(OUT_DIR, exist_ok=True)
tfjs.converters.save_keras_model(
    dream, OUT_DIR, quantization_dtype_map={"float16": "*"}
)

total = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR))
print(f"Saved to {OUT_DIR}/ ({total / 1e6:.1f} MB). Commit this folder with your site.")
