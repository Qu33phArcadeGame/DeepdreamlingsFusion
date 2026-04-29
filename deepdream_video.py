import tensorflow as tf
import numpy as np
import PIL.Image
import cv2
import os

# ---- SETTINGS ----
INPUT_IMAGE = "input.jpg"
OUTPUT_VIDEO = "deepdream.mp4"
FRAMES = 120

# ---- LOAD IMAGE ----
def load_img(path):
    img = PIL.Image.open(path)
    return np.array(img)

# ---- LOAD MODEL ----
model = tf.keras.applications.InceptionV3(include_top=False, weights='imagenet')
layer_names = ['mixed5', 'mixed7']
layers = [model.get_layer(name).output for name in layer_names]
dream_model = tf.keras.Model(inputs=model.input, outputs=layers)

# ---- DEEPDREAM ----
def deepdream(image, steps=80, step_size=0.01):
    img = tf.convert_to_tensor(image)
    img = tf.expand_dims(img, axis=0)

    for step in range(steps):
        with tf.GradientTape() as tape:
            tape.watch(img)
            outputs = dream_model(img)
            loss = tf.reduce_sum([tf.reduce_mean(o) for o in outputs])

        grads = tape.gradient(loss, img)
        grads /= tf.math.reduce_std(grads) + 1e-8
        img = img + grads * step_size

    return img[0].numpy()

# ---- GENERATE FRAMES ----
os.makedirs("frames", exist_ok=True)

current = load_img(INPUT_IMAGE)

for i in range(FRAMES):
    print("Frame:", i)

    dreamed = deepdream(current)

    h, w, _ = dreamed.shape
    crop = dreamed[int(h*0.06):int(h*0.94), int(w*0.06):int(w*0.94)]
    current = cv2.resize(crop, (w, h))

    frame = np.uint8(np.clip(current, 0, 255))
    cv2.imwrite(f"frames/frame_{i:04d}.jpg", frame)

# ---- MAKE VIDEO ----
images = sorted(os.listdir("frames"))
frame = cv2.imread(f"frames/{images[0]}")
h, w, _ = frame.shape

video = cv2.VideoWriter(OUTPUT_VIDEO, cv2.VideoWriter_fourcc(*'mp4v'), 30, (w, h))

for img_name in images:
    img = cv2.imread(f"frames/{img_name}")
    video.write(img)

video.release()

print("Done! Saved as", OUTPUT_VIDEO)
