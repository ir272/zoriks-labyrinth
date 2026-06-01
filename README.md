# ZORIK'S LABYRINTH

A first-person browser survival-horror built with **static Three.js — no build step**.
Find **3 clues** scattered through a dark, decaying labyrinth and reach the exit, while an
**unkillable stalker — Zorik —** hunts you by **sight** (your flashlight) and **sound** (your sprint).
You cannot fight it. Hide, break line-of-sight, run. Caught = jump-scare + game over.

> Inspired by RE2 Remake's Mr. X and RE7's first-person dread. The two-beat target:
> **DREAD** (you spot it peeking at you across a hall) → **PANIC** (it breaks into a run).

## Play

No install, no toolchain. Either:

```bash
# option A — any static server
cd dim-halls && python3 -m http.server 8080
# then open http://localhost:8080
```

Or just open `index.html` in a browser (Chrome/Edge/Firefox). Pointer-lock needs a click,
so press **ENTER**, then click the screen to capture the mouse.

### Controls
| Key | Action |
|---|---|
| **WASD** | Move |
| **Mouse** | Look |
| **Shift** | Sprint — *faster, but the stalker hears you* |
| **F** | Toggle flashlight — *reveals the world, but the stalker sees the light* |
| **Esc** | Release mouse (click to re-capture) |

## How it works
- **Engine:** Three.js (r128, vendored in `vendor/`), `PointerLockControls`, one camera-parented
  `SpotLight` = the flashlight, heavy `FogExp2` for real darkness, very low ambient.
- **Map:** a recursive-backtracker maze on a fixed seed (`CFG.seed`), so the labyrinth is
  **identical every run** (learnable, not roguelike-random) yet guaranteed connected/solvable.
  Extra walls are knocked out to create loops you can use to break line-of-sight.
- **Collision:** axis-separated grid collision (no physics engine).
- **Stalker AI** (`game.js` §8): a fair, readable 4-state machine —
  `PATROL → NOTICE (dread) → CHASE (panic) → CATCH`. Detection is **sight** (grid line-of-sight +
  range, doubled while your flashlight is on) **or sound** (walking/sprinting noise radius). It
  pathfinds on the grid (BFS) toward your last-known cell — **no teleporting, no wall-clipping**.
  Safe rooms exist that it will not enter.
- **Audio** (`audio.js`): fully synthesized WebAudio — drone + air bed, a proximity-driven
  heartbeat, footsteps, a "peek" tell, a chase stinger, and the jump-scare sting. No audio files.

## Asset pipeline (the point of this build)
Every visual is **GPT-image-2-generated** via Codex CLI subagents, then wired into the Three.js
scene. All share one art-direction preamble for cohesion:

> *Abandoned, decaying institutional building — survival horror. Desaturated cold greys, sickly
> greens, rust browns, deep black shadow. Peeling paint, water stains, mold, exposed cracked
> concrete, dead flickering fluorescents. Heavy film grain, high contrast, oppressive darkness,
> photographic grimy analog-horror realism.*

| Asset | File | Wired as |
|---|---|---|
| Wall textures (×2) | `assets/tex/wall_a.png`, `wall_b.png` | `MeshStandardMaterial.map` on instanced wall cubes |
| Floor / ceiling | `assets/tex/floor.png`, `ceiling.png` | tiled plane materials (`RepeatWrapping`) |
| Stalker | `assets/sprites/stalker.png` | billboarded `Sprite`, transparent |
| Clues (×3) | `assets/sprites/clue1‑3.png` | world pickup sprites |
| Battery | `assets/sprites/battery.png` | world pickup sprite |
| Hands + flashlight | `assets/sprites/hands.png` | DOM foreground overlay, sways with movement |
| Title / Win / Jump-scare | `assets/ui/title.png`, `win.png`, `jumpscare.png` | full-screen state art |

Generated with `codex exec` + the gpt-image tool (model: gpt-image-2). Re-generate any asset by
re-running its prompt; the shared preamble keeps the set cohesive.

## Project layout
```
dim-halls/
├── index.html      # canvas, HUD, title/death/win screens
├── style.css       # HUD, vignette, screens
├── game.js         # engine, maze, collision, stalker AI, systems, game-state machine
├── audio.js        # procedural WebAudio
├── assets/         # gpt-image-2-generated art
└── vendor/         # three.min.js + PointerLockControls.js (pinned r128)
```
