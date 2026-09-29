# Dream Generator

Every town has a Dream Generator building. Walk into it and press A to step inside.
Your newest card pops up (fusions first): the creature in front of its dream photo,
just like in the binder. Dream it, then zoom into it with the same maths as the Colab
notebook: straight, square or triangle paths, with every number adjustable in Settings.

## Town changes

- Every slot spin fuses all three dreamlings into a Tri-being, and you always keep it.
- Rarity odds per slot are now 50% common, 35% rare, 15% holo (`RARITY_ODDS` in `index.html`).
- Bigger slot reels, and a fusion animation: the three creatures orbit, spiral together,
  flash, and the fused creature pops out.
- The binder's fuse options are unchanged.

## One-time setup: the InceptionV3 model

The generator loads `models/inceptionv3/model.json`. Build it on GitHub: open the
**Actions** tab, pick **Build DeepDream model**, press **Run workflow**. The export now
includes layers mixed2 to mixed7 (your Colab uses mixed6 + mixed7), about 18 MB.
If you built the model before this update, run the workflow again to unlock mixed6/mixed7.

## Settings (all saved on the device)

| Setting | Colab name | What it does |
| --- | --- | --- |
| Zoom path | `zoom_type` | Straight, square or triangle. |
| Frames per run | `num_frames` | Frames made per press of Zoom. |
| Zoom factor | `zoom_factor` | Crop size per frame. 0.9999 barely moves; 0.98 dives. |
| Steps per frame | `steps_per_frame` | Dream strength per frame. |
| Learning rate | `learning_rate` | How hard each step pushes. |
| Movement range | `*_movement_range_factor` | How far the zoom centre drifts (square/triangle). |
| Frames per side | `*_pattern_segment_frames` | Frames per side of the square/triangle. |
| Starting dream steps | (none) | Optional dream before zooming; 0 matches the Colab. |
| Inception layers | `names` | Which layers to amplify. |
| Dream size | `target_size` | Much smaller than Colab's 1080×1920 so phones can keep up. |

Presets copy the values from your Colab cells. The footer estimates seconds per frame
on your device, so you can see what a 330-frame, 37-step run will cost before starting.

## Where cards are kept

Kept dream cards live in the browser's IndexedDB on that device. Export a GIF or video to share.
