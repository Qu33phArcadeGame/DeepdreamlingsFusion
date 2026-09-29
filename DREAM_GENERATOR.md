# Dream Generator

Every town has a Dream Generator building. Walk into it and press A to step inside.
Your newest card pops up (fusions first): the creature in front of its dream photo,
just like in the binder. Dream it, then zoom into it along a straight, square or triangle path, with every
number adjustable in Settings.

## Town changes

- Every slot spin fuses all three dreamlings into a Tri-being, and you always keep it.
- Rarity odds per slot are now 50% common, 35% rare, 15% holo (`RARITY_ODDS` in `index.html`).
- Bigger slot reels, and a fusion animation: the three creatures orbit, spiral together,
  flash, and the fused creature pops out.
- The binder's fuse options are unchanged.

## One-time setup: the InceptionV3 model

The generator loads `models/inceptionv3/model.json`. Build it on GitHub: open the
**Actions** tab, pick **Build DeepDream model**, press **Run workflow**. The export now
includes layers mixed2 to mixed7, about 18 MB.
If you built the model before this update, run the workflow again to unlock mixed6/mixed7.

## Settings (all saved on the device)

| Setting | What it does |
| --- | --- |
| Zoom path | Straight, square or triangle. |
| Frames per run | Frames made per press of Zoom. |
| Zoom factor | Crop size per frame. 0.9999 barely moves; 0.98 dives. |
| Steps per frame | Dream strength per frame. |
| Learning rate | How hard each step pushes. |
| Movement range | How far the zoom centre drifts (square/triangle). |
| Frames per side | Frames per side of the square/triangle. |
| Starting dream steps | Optional dream before zooming; 0 starts zooming straight from the card. |
| Inception layers | Which layers to amplify. |
| Dream size | Bigger is sharper but slower and hotter. |

Presets are quick starting points. The footer estimates seconds per frame
on your device, so you can see what a long, heavy run will cost before starting.

## Where cards are kept

Kept dream cards live in the browser's IndexedDB on that device. Export a GIF or video to share.
