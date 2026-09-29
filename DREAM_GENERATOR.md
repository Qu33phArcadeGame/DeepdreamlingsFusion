# Dream Generator

Every town has a Dream Generator building. Walk into it and press A to step inside.
It dreams a DeepDream trading card from one of that town's dreamlings, and you can
keep zooming into the card forever. Each zoom frame is saved, so the card plays as
an animation, and you can export it as a GIF or a video.

## What's new

- `index.html`: draws the generator building in each town and opens `generator.html`.
- `generator.html`: the generator itself (DeepDream, zoom, gallery, GIF/video export).
- `tools/export_inceptionv3.py`: makes the model files the generator needs.
- `.github/workflows/build-dream-model.yml`: runs that script on GitHub for you.

## One-time setup: the InceptionV3 model

The generator loads `models/inceptionv3/model.json` from your site. Make it one of two ways.

**On GitHub (no Python needed):** push these files, open the **Actions** tab, pick
**Build DeepDream model**, and press **Run workflow**. After about five minutes the
`models/inceptionv3/` folder is committed to your repo and GitHub Pages serves it.

**On your computer:**

```bash
pip install "tensorflow>=2.13,<2.16" "tensorflowjs>=4.13,<4.18"
python tools/export_inceptionv3.py
```

Then commit the `models/inceptionv3/` folder. It's about 10 MB (float16), well under
GitHub's file limits. Only InceptionV3 up to layer `mixed5` is exported, because
that's all DeepDream uses.

## GPU or CPU

On first visit the generator benchmarks WebGPU, WebGL and WebAssembly on the device
and uses the fastest, falling back to plain JavaScript if nothing else works. If an
engine fails mid-dream it switches to the next one automatically. The choice is
remembered; tap **Engine** at the bottom of the generator to re-test.

## Tuning

All knobs are at the top of the script in `generator.html`:

| Setting | What it does |
| --- | --- |
| `QUALITY` | Dream size per quality level (Fast 192×240, Normal 256×320, High 320×400). |
| `OCTAVES`, `STEP_SIZE` | How hard the first dream pushes. Step counts per rarity live in `RARITY`. |
| `ZOOM`, `ZOOM_STEPS` | How far each frame zooms (1.05 = 5%) and how much it re-dreams. |
| `MAX_FRAMES`, `PLAY_FPS` | Longest zoom a card can hold, and playback speed. |
| `STYLES` | How each style weights layers mixed2 to mixed5. |
| `AREAS` | Town names and dreamling ranges; keep in sync with `index.html`. |

Building positions are in `GENERATORS` in `index.html`. For a new town, add an entry,
or put `"generator": {"x": 8, "y": 20, "w": 3, "h": 2}` in that map's `.json`.
To use your own building art, add a `generator.png` next to `index.html`.

## Where cards are kept

Kept cards are stored in the browser's IndexedDB on that device (they're too big for
localStorage). They don't sync between devices, so export a GIF or video to share one.
