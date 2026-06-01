/* ============================================================================
   DIM HALLS — first-person survival-horror (static Three.js, no build step)
   Find 3 clues in a dark labyrinth and escape while an unkillable stalker hunts
   you by sight (your flashlight) and sound (your sprint). Caught = game over.

   Architecture: ONE persistent camera + PointerLockControls + flashlight.
   Each run's geometry/entities live in a disposable `levelGroup` swapped on reset.
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------------------
   0 · CONFIG
   ------------------------------------------------------------------------- */
const CFG = {
  seed: 1337,                 // fixed → identical, learnable labyrinth every run
  cellsX: 11, cellsY: 11,     // logical maze cells → grid is (2n+1) = 23x23
  tile: 4,                    // world units per grid cell
  wallH: 4.2,
  playerH: 1.7,
  playerR: 0.42,
  walkSpeed: 3.4,
  sprintSpeed: 6.0,
  fogDensity: 0.055,

  flashlight: { angle: 0.58, penumbra: 0.45, intensity: 3.4, distance: 30, drainPerSec: 1.4, regenPerSec: 10.0 },

  stalker: {
    patrolSpeed: 4.3,         // it HUNTS you; faster than your walk (3.4) so it closes in (sprint 6.0 escapes)
    chaseSpeed: 5.2,          // faster than your walk, just under your sprint → sprinting barely escapes
    huntInterval: 1.5,        // re-targets toward the player this often (Mr. X style pursuit)
    huntBias: 0.75,           // chance a re-target heads for the player vs a random cell
    senseRange: 11,           // it notices you when this close (≈2.75 tiles) with line-of-sight, even from behind
    // Mutual-sight detection: it only notices you when YOU can see IT.
    viewHalfAngle: 1.05,      // rad (~60°): the player's visual cone for "seeing" the stalker
    sightLit: 28,             // it's inside your flashlight beam → seen far
    sightDim: 14,             // in view but outside the beam (ambient) → medium
    sightDark: 8,             // flashlight OFF → only a close silhouette
    grabRange: 2.6,           // adjacent grab regardless of facing (heartbeat + peek sound warn you)
    soundLure: 14,            // sprinting draws the stalker toward you (cells)
    noticeTime: 1.1,          // sustained sight before it commits to a chase (the DREAD beat)
    loseTime: 4.0,            // time without detection before it gives up
    catchDist: 1.6,
  },
};

/* ---------------------------------------------------------------------------
   1 · DETERMINISTIC RNG (mulberry32)
   ------------------------------------------------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------------
   2 · MAZE (recursive backtracker → guaranteed-connected) + loop carving
   grid[y][x]: 1 = wall, 0 = floor.
   ------------------------------------------------------------------------- */
function buildMaze(rng) {
  const W = CFG.cellsX, H = CFG.cellsY;
  const gw = W * 2 + 1, gh = H * 2 + 1;
  const grid = Array.from({ length: gh }, () => new Array(gw).fill(1));
  const visited = Array.from({ length: H }, () => new Array(W).fill(false));
  const stack = [[0, 0]];
  visited[0][0] = true; grid[1][1] = 0;
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const opts = [];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && !visited[ny][nx]) opts.push([nx, ny, dx, dy]);
    }
    if (!opts.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = opts[(rng() * opts.length) | 0];
    visited[ny][nx] = true;
    grid[cy * 2 + 1 + dy][cx * 2 + 1 + dx] = 0;
    grid[ny * 2 + 1][nx * 2 + 1] = 0;
    stack.push([nx, ny]);
  }

  const extra = Math.floor((W * H) * 0.12);   // loops → you can break line-of-sight
  for (let i = 0; i < extra; i++) {
    const x = 1 + ((rng() * (gw - 2)) | 0);
    const y = 1 + ((rng() * (gh - 2)) | 0);
    if (grid[y][x] === 1 &&
        ((grid[y - 1][x] === 0 && grid[y + 1][x] === 0) ||
         (grid[y][x - 1] === 0 && grid[y][x + 1] === 0))) grid[y][x] = 0;
  }
  return grid;
}

/* ---------------------------------------------------------------------------
   3 · GRID HELPERS — BFS field, pathfinding step, line-of-sight
   ------------------------------------------------------------------------- */
function neighbors(grid, x, y) {
  const out = [];
  if (grid[y - 1] && grid[y - 1][x] === 0) out.push([x, y - 1]);
  if (grid[y + 1] && grid[y + 1][x] === 0) out.push([x, y + 1]);
  if (grid[y][x - 1] === 0) out.push([x - 1, y]);
  if (grid[y][x + 1] === 0) out.push([x + 1, y]);
  return out;
}
function bfsField(grid, sx, sy) {
  const gh = grid.length, gw = grid[0].length;
  const dist = Array.from({ length: gh }, () => new Array(gw).fill(-1));
  const q = [[sx, sy]]; dist[sy][sx] = 0;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [nx, ny] of neighbors(grid, x, y))
      if (dist[ny][nx] === -1) { dist[ny][nx] = dist[y][x] + 1; q.push([nx, ny]); }
  }
  return dist;
}
function stepToward(grid, sx, sy, tx, ty, blocked) {
  const gh = grid.length, gw = grid[0].length;
  const prev = Array.from({ length: gh }, () => new Array(gw).fill(null));
  const seen = Array.from({ length: gh }, () => new Array(gw).fill(false));
  const q = [[sx, sy]]; seen[sy][sx] = true; let found = false;
  for (let i = 0; i < q.length && !found; i++) {
    const [x, y] = q[i];
    for (const [nx, ny] of neighbors(grid, x, y)) {
      if (seen[ny][nx]) continue;
      if (blocked && blocked.has(nx + ',' + ny) && !(nx === tx && ny === ty)) continue;
      seen[ny][nx] = true; prev[ny][nx] = [x, y];
      if (nx === tx && ny === ty) { found = true; break; }
      q.push([nx, ny]);
    }
  }
  if (!found) return null;
  let cx = tx, cy = ty;
  while (prev[cy][cx] && !(prev[cy][cx][0] === sx && prev[cy][cx][1] === sy)) [cx, cy] = prev[cy][cx];
  return [cx, cy];
}
function hasLoS(grid, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (true) {
    if (grid[y][x] === 1) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

/* ---------------------------------------------------------------------------
   4 · STATE
   ------------------------------------------------------------------------- */
let renderer, scene, camera, controls, clock;
let ambient, hemi, flashlight;
let levelGroup = null;
let grid, gw, gh;
let flashlightOn = true, battery = 100;
let player = { gx: 1, gy: 1, vbob: 0, moving: false, sprinting: false };
let stalker = null;
let clues = [], batteries = [], safeCells = new Set(), exitCell = null;
let exitGate = null, exitLight = null;
let tele = { minCells: Infinity, sightings: 0, chases: 0, moved: 0 };   // run telemetry (verification + stats)
let cluesFound = 0, startTime = 0;
let sprintHinted = false, flashlightHinted = false;
let gameState = 'title';
let textures = {};
const keys = {};

const cellToWorld = (gx, gy) => new THREE.Vector3((gx + 0.5) * CFG.tile, 0, (gy + 0.5) * CFG.tile);
const worldToCell = (v) => [Math.floor(v.x / CFG.tile), Math.floor(v.z / CFG.tile)];

/* ---------------------------------------------------------------------------
   5 · TEXTURE / SPRITE LOADING (graceful fallback to flat colour)
   ------------------------------------------------------------------------- */
function makeMat(path, fallbackHex, opts = {}) {
  const { repeat, ...matOpts } = opts;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, ...matOpts });
  new THREE.TextureLoader().load(
    path,
    (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; if (repeat) t.repeat.set(repeat[0], repeat[1]); m.map = t; m.needsUpdate = true; },
    undefined,
    () => { m.map = null; m.color.setHex(fallbackHex); m.needsUpdate = true; }
  );
  m.color.setHex(fallbackHex); // until the image loads
  return m;
}
function spriteMat(path, fallbackHex) {
  const m = new THREE.SpriteMaterial({ color: fallbackHex, transparent: true, depthWrite: false, fog: true });
  new THREE.TextureLoader().load(path, (t) => { m.map = t; m.color.setHex(0xffffff); m.needsUpdate = true; },
    undefined, () => { /* keep fallback colour blob */ });
  return m;
}

/* ---------------------------------------------------------------------------
   6 · RENDERER / PERSISTENT SCENE
   ------------------------------------------------------------------------- */
function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, CFG.fogDensity);

  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, CFG.playerH, 0);
  scene.add(camera);

  ambient = new THREE.AmbientLight(0x2a3a40, 0.22); scene.add(ambient);
  hemi = new THREE.HemisphereLight(0x2c3a2c, 0x0a0a0a, 0.16); scene.add(hemi);

  flashlight = new THREE.SpotLight(0xfff0d0, 0, CFG.flashlight.distance, CFG.flashlight.angle, CFG.flashlight.penumbra, 1.2);
  flashlight.position.set(0, 0, 0.2);
  camera.add(flashlight);
  flashlight.target.position.set(0, 0, -1);
  camera.add(flashlight.target);

  clock = new THREE.Clock();
  window.addEventListener('resize', onResize);
}

/* ---------------------------------------------------------------------------
   7 · LEVEL BUILD / CLEAR
   ------------------------------------------------------------------------- */
function clearLevel() {
  if (!levelGroup) return;
  scene.remove(levelGroup);
  levelGroup.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }
  });
  levelGroup = null; stalker = null; clues = []; batteries = []; exitGate = null; exitLight = null;
}

function buildLevel() {
  clearLevel();
  levelGroup = new THREE.Group(); scene.add(levelGroup);

  const rng = mulberry32(CFG.seed);
  grid = buildMaze(rng); gh = grid.length; gw = grid[0].length;

  // walls via InstancedMesh, split across two wall materials
  const matA = makeMat('assets/tex/wall_a.png', 0x3a3d3a);
  const matB = makeMat('assets/tex/wall_b.png', 0x33352f);
  const wallCells = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (grid[y][x] === 1) wallCells.push([x, y]);
  const box = new THREE.BoxGeometry(CFG.tile, CFG.wallH, CFG.tile);
  const halfA = Math.ceil(wallCells.length / 2);
  addInstanced(box, matA, wallCells.slice(0, halfA));
  addInstanced(box, matB, wallCells.slice(halfA));

  // floor + ceiling (tiled)
  const fw = gw * CFG.tile, fd = gh * CFG.tile;
  const floorMat = makeMat('assets/tex/floor.png', 0x2a2a26, { repeat: [gw, gh] });
  const ceilMat = makeMat('assets/tex/ceiling.png', 0x1c1e1c, { repeat: [gw, gh] });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.set(fw / 2, 0, fd / 2); levelGroup.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), ceilMat);
  ceil.rotation.x = Math.PI / 2; ceil.position.set(fw / 2, CFG.wallH, fd / 2); levelGroup.add(ceil);

  placeEntities(rng);

  // reset run state
  battery = 100; flashlightOn = false; cluesFound = 0; sprintHinted = false; flashlightHinted = false;
  flashlight.intensity = 0;               // spawn in darkness — the player presses F to light up
  tele = { minCells: Infinity, sightings: 0, chases: 0, moved: 0 };
  const p = cellToWorld(1, 1); camera.position.set(p.x, CFG.playerH, p.z);
  player.gx = 1; player.gy = 1;
  const startNb = neighbors(grid, 1, 1)[0];           // face into the maze, not a wall
  if (startNb) { const t = cellToWorld(startNb[0], startNb[1]); camera.lookAt(t.x, CFG.playerH, t.z); }
  updateClueHUD(); updateBatteryHUD();
}

function addInstanced(geo, mat, cells) {
  if (!cells.length) return;
  const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
  const m = new THREE.Matrix4();
  cells.forEach(([x, y], i) => { m.makeTranslation((x + 0.5) * CFG.tile, CFG.wallH / 2, (y + 0.5) * CFG.tile); mesh.setMatrixAt(i, m); });
  mesh.instanceMatrix.needsUpdate = true;
  levelGroup.add(mesh);
}

function placeEntities(rng) {
  const dist = bfsField(grid, 1, 1);
  const open = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++)
    if (grid[y][x] === 0 && dist[y][x] > 0) open.push([x, y, dist[y][x]]);
  open.sort((a, b) => b[2] - a[2]);

  exitCell = [open[0][0], open[0][1]];

  const far = open.slice(0, Math.floor(open.length * 0.7));
  const picks = []; const used = new Set([exitCell.join(',')]);
  function pickAway(minSep) {
    for (let t = 0; t < 400; t++) {
      const c = far[(rng() * far.length) | 0]; const key = c[0] + ',' + c[1];
      if (used.has(key)) continue;
      if (picks.every(p => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) >= minSep)) { used.add(key); picks.push([c[0], c[1]]); return; }
    }
    const c = far[(rng() * far.length) | 0]; used.add(c[0] + ',' + c[1]); picks.push([c[0], c[1]]);
  }
  pickAway(7); pickAway(7); pickAway(7);

  clues = picks.map((c, i) => makePickup('assets/sprites/clue' + (i + 1) + '.png', c, 1.2, 0xd8d4c8));
  cluesFound = 0;

  const mid = open.slice(Math.floor(open.length * 0.3), Math.floor(open.length * 0.7));
  batteries = [];
  for (let i = 0; i < 2; i++) { const c = mid[(rng() * mid.length) | 0]; batteries.push(makePickup('assets/sprites/battery.png', [c[0], c[1]], 0.85, 0x8aa06a)); }

  safeCells = new Set();
  const anchor = open[Math.floor(open.length * 0.5)];
  safeCells.add(anchor.slice(0, 2).join(','));
  for (const [nx, ny] of neighbors(grid, anchor[0], anchor[1])) safeCells.add(nx + ',' + ny);

  const spawn = open[Math.floor(open.length * 0.45)];
  spawnStalker(spawn[0], spawn[1]);

  // Escape gateway at the exit — dormant/dark until all 3 clues are found, then it ignites.
  exitGate = new THREE.Sprite(spriteMat('assets/sprites/exit_gate.png', 0x2c3a44));
  exitGate.scale.set(3.4, 4.2, 1);
  const ew = cellToWorld(exitCell[0], exitCell[1]);
  exitGate.position.set(ew.x, 2.0, ew.z);
  levelGroup.add(exitGate);
  exitLight = new THREE.PointLight(0xcfe6ff, 0, 22);
  exitLight.position.set(ew.x, 2.2, ew.z);
  levelGroup.add(exitLight);
}

/* Dark while locked; ignites into a glowing beacon once all 3 clues are collected. */
function updateExitGate() {
  if (!exitGate) return;
  const lit = cluesFound >= 3;
  exitLight.intensity += ((lit ? 2.6 : 0) - exitLight.intensity) * 0.04;
  exitGate.material.color.setHex(lit ? 0xffffff : 0x394952);   // dark/dormant → bright when lit
  exitGate.material.opacity = lit ? (0.88 + 0.12 * Math.sin(clock.elapsedTime * 2)) : 0.6;
}

function makePickup(path, cell, size, glowColor) {
  const s = new THREE.Sprite(spriteMat(path, glowColor));
  const w = cellToWorld(cell[0], cell[1]);
  s.position.set(w.x, 1.1, w.z); s.scale.set(size, size, 1);
  s.userData = { cell, baseY: 1.1, collected: false };
  levelGroup.add(s);
  const light = new THREE.PointLight(glowColor, 0.7, 5); light.position.set(w.x, 1.1, w.z);
  levelGroup.add(light); s.userData.light = light;
  return s;
}

/* ---------------------------------------------------------------------------
   8 · STALKER
   ------------------------------------------------------------------------- */
function spawnStalker(gx, gy) {
  const spr = new THREE.Sprite(spriteMat('assets/sprites/stalker.png', 0x885566));
  spr.material.fog = false;                 // NOT fog-shaded → a pale figure you can actually see in the dark
  spr.material.needsUpdate = true;
  spr.scale.set(2.4, 3.0, 1);
  const w = cellToWorld(gx, gy); spr.position.set(w.x, 1.5, w.z);
  levelGroup.add(spr);
  stalker = { sprite: spr, gx, gy, pos: new THREE.Vector3(w.x, 1.5, w.z),
    state: 'PATROL', target: null, lastKnown: null, noticeT: 0, loseT: 0, huntT: 0, speed: CFG.stalker.patrolSpeed };
  pickPatrolTarget();
}
/* The cell the PLAYER is heading to — nearest uncollected clue (by their path), or the exit.
   Zorik targets this to intercept the player where they must go, instead of tailing them. */
function objectiveCell() {
  if (cluesFound >= 3) return exitCell;
  const field = bfsField(grid, player.gx, player.gy);
  let best = Infinity, cell = null;
  for (const c of clues) {
    if (c.userData.collected) continue;
    const [cx, cy] = c.userData.cell;
    const d = field[cy][cx];
    if (d >= 0 && d < best) { best = d; cell = c.userData.cell; }
  }
  return cell;
}
function pickPatrolTarget() {
  for (let i = 0; i < 60; i++) {
    const x = 1 + ((Math.random() * (gw - 2)) | 0), y = 1 + ((Math.random() * (gh - 2)) | 0);
    if (grid[y][x] === 0 && !safeCells.has(x + ',' + y)) { stalker.target = [x, y]; return; }
  }
}
/* Can the PLAYER currently see the stalker? Detection is symmetric: if you can
   see it, it sees you. Visibility depends on your view cone + light. */
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();
function playerCanSeeStalker() {
  const S = CFG.stalker;
  if (!hasLoS(grid, stalker.gx, stalker.gy, player.gx, player.gy)) return false;  // wall between
  _to.copy(stalker.pos).sub(camera.position);
  const d = _to.length(); if (d < 0.0001) return true;
  _to.multiplyScalar(1 / d);
  camera.getWorldDirection(_fwd);
  const cosAng = _fwd.dot(_to);
  // inside the flashlight beam → seen far
  if (flashlightOn && cosAng >= Math.cos(CFG.flashlight.angle) && d <= S.sightLit) return true;
  // peripheral / ambient vision (shorter; even shorter with the light off)
  if (cosAng >= Math.cos(S.viewHalfAngle) && d <= (flashlightOn ? S.sightDim : S.sightDark)) return true;
  return false;
}
function detectsPlayer() {
  if (safeCells.has(player.gx + ',' + player.gy)) return false;
  if (playerCanSeeStalker()) return true;                                   // mutual sight (facing + lit)
  const d = stalker.pos.distanceTo(camera.position);
  if (d <= CFG.stalker.grabRange) return true;                             // right on top of you
  if (d <= CFG.stalker.senseRange && hasLoS(grid, stalker.gx, stalker.gy, player.gx, player.gy))
    return true;                                                            // it's near you with a clear line — you sense it
  return false;
}
function updateStalker(dt) {
  if (!stalker) return;
  const S = CFG.stalker, detected = detectsPlayer();

  switch (stalker.state) {
    case 'PATROL': // really a HUNT — it works its way toward you, only escalating once you SEE it
      stalker.speed = S.patrolSpeed;
      if (detected) { stalker.state = 'NOTICE'; stalker.noticeT = 0; audio.peek(); tele.sightings++; }
      else {
        const playerSafe = safeCells.has(player.gx + ',' + player.gy);
        const cellD = Math.hypot(player.gx - stalker.gx, player.gy - stalker.gy);
        stalker.huntT += dt;
        const reached = stalker.target && stalker.gx === stalker.target[0] && stalker.gy === stalker.target[1];
        if (player.sprinting && !playerSafe && cellD <= S.soundLure) {
          stalker.target = [player.gx, player.gy];                  // sound lure: beeline to the noise
        } else if (stalker.huntT >= S.huntInterval || reached || !stalker.target) {
          stalker.huntT = 0;
          const obj = objectiveCell();                              // where the PLAYER is headed (next clue / exit)
          if (obj && Math.random() < 0.5) stalker.target = obj;     // INTERCEPT: lie in wait where you must go
          else if (!playerSafe) stalker.target = [player.gx, player.gy]; // or come straight at you
          else pickPatrolTarget();
        }
      }
      break;
    case 'NOTICE': // DREAD — it creeps toward you, winding up; break its sight to defuse
      stalker.speed = S.patrolSpeed * 0.55;
      stalker.lastKnown = [player.gx, player.gy]; stalker.target = stalker.lastKnown;
      if (detected) { stalker.noticeT += dt; if (stalker.noticeT >= S.noticeTime) { stalker.state = 'CHASE'; audio.chaseStart(); tele.chases++; } }
      else { stalker.noticeT -= dt * 1.5; if (stalker.noticeT <= 0) { stalker.state = 'PATROL'; pickPatrolTarget(); } }
      break;
    case 'CHASE': // PANIC
      stalker.speed = S.chaseSpeed;
      if (detected) { stalker.lastKnown = [player.gx, player.gy]; stalker.loseT = 0; }
      else { stalker.loseT += dt; if (stalker.loseT >= S.loseTime) { stalker.state = 'NOTICE'; stalker.noticeT = 0; } }
      stalker.target = stalker.lastKnown;
      if (!safeCells.has(player.gx + ',' + player.gy) && stalker.pos.distanceTo(camera.position) <= S.catchDist) { caught(); return; }
      break;
  }

  const step = stalker.speed * dt;
  // Final approach: when he's right on you with a clear line, home on your ACTUAL position (not the
  // cell center) so he closes the last sub-cell gap and the catch fires. Gated by line-of-sight so he
  // can't clip through a wall — if blocked, he falls back to pathfinding and comes around.
  const homing = (stalker.state === 'CHASE' || stalker.state === 'NOTICE')
    && stalker.pos.distanceTo(camera.position) < CFG.tile * 1.6
    && hasLoS(grid, stalker.gx, stalker.gy, player.gx, player.gy);
  if (homing) {
    const dir = new THREE.Vector3(camera.position.x, 1.5, camera.position.z).sub(stalker.pos);
    if (dir.length() > 0.0001) { dir.normalize(); stalker.pos.addScaledVector(dir, step); }
    [stalker.gx, stalker.gy] = worldToCell(stalker.pos);
  } else if (stalker.target) {
    // Path freely — do NOT block safe cells here, or a safe cluster can wall the stalker into a
    // pocket and freeze it (the bug). Safe rooms still protect you: detection + catch are disabled
    // while you're inside one, so he can't grab you there even if he walks through.
    const next = stepToward(grid, stalker.gx, stalker.gy, stalker.target[0], stalker.target[1], null);
    if (next) {
      const w = cellToWorld(next[0], next[1]); w.y = 1.5;
      const dir = w.clone().sub(stalker.pos);
      if (dir.length() <= step) { stalker.pos.copy(w); stalker.gx = next[0]; stalker.gy = next[1]; tele.moved++; }
      else { dir.normalize(); stalker.pos.addScaledVector(dir, step); }
    }
  }
  tele.minCells = Math.min(tele.minCells, stalker.pos.distanceTo(camera.position) / CFG.tile);
  stalker.sprite.position.copy(stalker.pos);
  stalker.sprite.material.color.setHex(stalker.state === 'CHASE' ? 0xffbbbb : (stalker.sprite.material.map ? 0xffffff : 0x885566));
  audio.setTension(stalker.state, stalker.pos.distanceTo(camera.position));
}

/* ---------------------------------------------------------------------------
   9 · PLAYER MOVEMENT + COLLISION
   ------------------------------------------------------------------------- */
function isWallAt(wx, wz) {
  const gx = Math.floor(wx / CFG.tile), gy = Math.floor(wz / CFG.tile);
  if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return true;
  return grid[gy][gx] === 1;
}
function blockedAt(wx, wz) {
  const r = CFG.playerR;
  return isWallAt(wx + r, wz) || isWallAt(wx - r, wz) || isWallAt(wx, wz + r) || isWallAt(wx, wz - r);
}
function updatePlayer(dt) {
  const sprint = !!keys['shiftleft'] || !!keys['shiftright'];
  const speed = sprint ? CFG.sprintSpeed : CFG.walkSpeed;
  const fwd = (keys['keyw'] ? 1 : 0) - (keys['keys'] ? 1 : 0);
  const strafe = (keys['keyd'] ? 1 : 0) - (keys['keya'] ? 1 : 0);
  const moving = (fwd !== 0 || strafe !== 0);
  player.moving = moving; player.sprinting = moving && sprint;
  if (player.sprinting && !sprintHinted) {
    sprintHinted = true;
    enqueueHint('IT HEARS YOU', "Sprinting makes noise — the stalker is drawn to the sound. Move quietly when it's close.", 5500);
  }

  if (moving) {
    const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize();
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const dir = new THREE.Vector3().addScaledVector(f, fwd).addScaledVector(right, strafe);
    if (dir.lengthSq() > 0) dir.normalize();
    const pos = camera.position;
    const nx = pos.x + dir.x * speed * dt, nz = pos.z + dir.z * speed * dt;
    if (!blockedAt(nx, pos.z)) pos.x = nx;
    if (!blockedAt(pos.x, nz)) pos.z = nz;
    player.vbob += dt * (sprint ? 13 : 9);
    const bob = Math.sin(player.vbob) * (sprint ? 0.09 : 0.05);
    pos.y = CFG.playerH + bob; swayHands(bob, strafe); audio.footstep(sprint);
  } else {
    camera.position.y += (CFG.playerH - camera.position.y) * 0.1;
  }
  [player.gx, player.gy] = worldToCell(camera.position);

  updateFlashlight(dt); checkPickups(); checkExit(); updateSafeIndicator(); updateClueSense(); updateExitGate(); updateTimer(); updateDebug();
}

function fmtTime(t) { return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }
function updateTimer() {
  const el = document.getElementById('timer'); if (!el) return;
  el.textContent = fmtTime(clock.getElapsedTime() - startTime);
}

/* ---------------------------------------------------------------------------
   10 · FLASHLIGHT + BATTERY
   ------------------------------------------------------------------------- */
function updateFlashlight(dt) {
  if (flashlightOn && battery > 0) { battery = Math.max(0, battery - CFG.flashlight.drainPerSec * dt); if (battery === 0) { flashlightOn = false; flashToast('BATTERY DEAD'); } }
  else if (!flashlightOn && battery < 100) { battery = Math.min(100, battery + CFG.flashlight.regenPerSec * dt); } // slow recharge while off
  const targetI = (flashlightOn && battery > 0) ? CFG.flashlight.intensity * (0.55 + 0.45 * (battery / 100)) * flicker() : 0;
  flashlight.intensity += (targetI - flashlight.intensity) * 0.4;
  updateBatteryHUD();
}
function flicker() { return battery > 25 ? 1 : 0.6 + Math.random() * 0.4; }
function toggleFlashlight() {
  if (battery <= 0) { flashToast('BATTERY DEAD'); return; }
  flashlightOn = !flashlightOn; audio.click();
  if (flashlightOn && !flashlightHinted) {
    flashlightHinted = true;
    enqueueHint('YOUR FLASHLIGHT',
      "It lights the way — but Zorik sees the light and the battery drains. Switch it OFF (F) to recharge it and move unseen.",
      6000);
  }
}

/* ---------------------------------------------------------------------------
   11 · PICKUPS / EXIT / SAFE ROOM
   ------------------------------------------------------------------------- */
function checkPickups() {
  const pc = camera.position;
  for (const c of clues) {
    if (c.userData.collected) continue;
    c.position.y = c.userData.baseY + Math.sin(clock.elapsedTime * 2 + c.position.x) * 0.12;
    c.material.rotation += 0.005;
    if (c.position.distanceTo(pc) < 1.5) {
      c.userData.collected = true; c.visible = false; if (c.userData.light) c.userData.light.visible = false;
      cluesFound++; updateClueHUD(); audio.pickup();
      flashToast(cluesFound < 3 ? `CLUE ${cluesFound} OF 3` : 'THE WAY OUT HAS OPENED — FOLLOW THE LIGHT', 2200);
    }
  }
  for (const b of batteries) {
    if (b.userData.collected) continue;
    b.position.y = b.userData.baseY + Math.sin(clock.elapsedTime * 3 + b.position.z) * 0.1;
    if (b.position.distanceTo(pc) < 1.5) {
      b.userData.collected = true; b.visible = false; if (b.userData.light) b.userData.light.visible = false;
      battery = Math.min(100, battery + 55); flashToast('+ BATTERY'); audio.pickup(); updateBatteryHUD();
    }
  }
}
function checkExit() {
  if (!exitCell) return;
  if (player.gx === exitCell[0] && player.gy === exitCell[1]) {
    if (cluesFound >= 3) win(); else flashToast('LOCKED — FIND ALL 3 CLUES', 900);
  }
}
function updateSafeIndicator() {
  document.getElementById('safe-indicator').classList.toggle('show', safeCells.has(player.gx + ',' + player.gy));
}

/* Subtle clue sense: a faint chevron points toward the nearest uncollected clue
   (or the exit once all 3 are found), brightening as you face it. */
const _cs = new THREE.Vector3();
function updateClueSense() {
  const el = document.getElementById('clue-sense'); if (!el) return;
  const arrow = document.getElementById('clue-arrow');

  // Pick a target CELL: the exit (once all clues found), else the uncollected clue
  // nearest by *walking* distance through the maze.
  let targetCell = null;
  if (cluesFound >= 3 && exitCell) {
    targetCell = exitCell;
  } else {
    const field = bfsField(grid, player.gx, player.gy);
    let best = Infinity;
    for (const c of clues) {
      if (c.userData.collected) continue;
      const [cx, cy] = c.userData.cell;
      const d = field[cy][cx];
      if (d >= 0 && d < best) { best = d; targetCell = c.userData.cell; }
    }
  }
  if (!targetCell) { el.style.opacity = 0; return; }

  // Point toward the NEXT step on the shortest walkable path (turn-by-turn), not
  // the straight-line bearing — so it follows corridors instead of pointing through walls.
  let ang = 0;
  const next = stepToward(grid, player.gx, player.gy, targetCell[0], targetCell[1], null);
  if (next) {
    _cs.copy(cellToWorld(next[0], next[1])).sub(camera.position); _cs.y = 0; _cs.normalize();
    camera.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
    const cross = _fwd.x * _cs.z - _fwd.z * _cs.x;          // + = path is to your right
    const dot = THREE.MathUtils.clamp(_fwd.dot(_cs), -1, 1);
    ang = Math.atan2(cross, dot);                            // 0 = down the corridor ahead (arrow up)
  }
  if (arrow) arrow.style.transform = `rotate(${ang}rad)`;
  const facing = Math.max(0, Math.cos(ang));                 // brighten as you face the way to go
  el.style.opacity = (0.5 + 0.5 * facing).toFixed(2);
  el.classList.toggle('exit', cluesFound >= 3);              // arrow turns white when pointing to the exit
}

let dbgOn = false;
function updateDebug() {
  const el = document.getElementById('dbg'); if (!el || !dbgOn) return;
  if (!stalker) { el.textContent = '(no stalker)'; return; }
  const cells = (stalker.pos.distanceTo(camera.position) / CFG.tile).toFixed(1);
  const tgt = stalker.target ? `${stalker.target[0]},${stalker.target[1]}` : '-';
  el.textContent = `state ${stalker.state} | dist ${cells} cells | tgt ${tgt} | player ${player.gx},${player.gy} | canSee ${playerCanSeeStalker()} | detected ${detectsPlayer()}`;
}

/* ---------------------------------------------------------------------------
   12 · HUD
   ------------------------------------------------------------------------- */
function updateClueHUD() { document.getElementById('clue-count').textContent = cluesFound; }
function updateBatteryHUD() { const f = document.getElementById('battery-fill'); f.style.width = battery + '%'; f.classList.toggle('low', battery < 30); }
let toastTimer = null;
function flashToast(msg, ms = 1500) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
/* Sequential hint panels. variant: '' (small), 'big' (centered, larger), 'danger' (bloody red).
   Panels queue so they don't stomp each other. */
let hintQueue = [], hintActive = false, hintTimer = null;
function resetHints() {
  hintQueue = []; hintActive = false; clearTimeout(hintTimer);
  const el = document.getElementById('hint'); if (el) { el.className = 'hidden'; }
}
// ms <= 0 → persistent (waits for the X / X-key; used for the self-paced tutorial panels).
function enqueueHint(title, body, ms, variant = '') {
  hintQueue.push({ title, body, ms, variant, persist: !ms || ms <= 0 });
  if (!hintActive) nextHint();
}
function dismissHint() {
  if (!hintActive) return;
  clearTimeout(hintTimer);
  document.getElementById('hint').classList.remove('show');
  setTimeout(nextHint, 350);
}
function nextHint() {
  const el = document.getElementById('hint'); if (!el) return;
  if (!hintQueue.length) {
    hintActive = false; el.classList.remove('show');
    if (gameState === 'tutorial') beginPlay();        // tutorial finished → the run begins
    return;
  }
  hintActive = true;
  const h = hintQueue.shift();
  document.getElementById('hint-title').textContent = h.title;
  document.getElementById('hint-body').textContent = h.body;
  el.className = h.variant + (h.persist ? ' persist' : '');   // 'persist' shows the "press X to continue" footer
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(hintTimer);
  if (!h.persist) hintTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(nextHint, 550); }, h.ms);
}
function swayHands(bob, strafe) {
  const h = document.getElementById('hands'); if (!h) return;
  h.style.transform = `translateX(calc(-50% + ${strafe * -8}px)) translateY(${bob * -60}px)`;
}

/* ---------------------------------------------------------------------------
   13 · GAME-STATE MACHINE
   ------------------------------------------------------------------------- */
const show = (id) => document.getElementById(id).classList.remove('hidden');
const hide = (id) => document.getElementById(id).classList.add('hidden');

function startGame() {
  hide('screen-title'); hide('screen-dead'); hide('screen-win'); show('hud');
  buildLevel();
  gameState = 'tutorial';                 // frozen world + no timer until the player reads the 3 panels
  audio.menuStop();                       // cut the title theme
  audio.start();
  controls.lock();                        // they can look around the spawn while reading
  resetHints();
  // Self-paced tutorial: three persistent panels (ms = 0), advance with the X / X-key.
  enqueueHint('FIND YOUR WAY OUT',
    'Collect all three clues hidden in the labyrinth, then reach the exit to escape.\n\nThe glowing arrow above your crosshair points the way — follow it to the nearest clue, and once you have all three it points to the exit.',
    0, 'big');
  enqueueHint('CONTROLS',
    "WASD — move\nMouse — look around\nShift — sprint (fast, but loud)\nF — flashlight on / off\n\nYour flashlight starts OFF. Press F to light your way when you're ready.",
    0, 'big');
  enqueueHint('ZORIK',
    "Zorik hunts these halls. You cannot kill him.\n\n• Don't hold his gaze — eye contact enrages him.\n• You're faster than him — run, then break his line of sight.\n• Sprinting is loud; he's drawn to the noise.\n• Cut your flashlight to vanish — but you'll be blind.",
    0, 'big danger');
}
// Called once the player dismisses the last tutorial panel — the labyrinth comes alive.
function beginPlay() {
  gameState = 'playing';
  startTime = clock.getElapsedTime();     // the timer starts NOW
  flashToast('FIND THE CLUES…', 2200);
}
function teleSummary() {
  const closest = tele.minCells === Infinity ? '—' : tele.minCells.toFixed(1);
  const s = `Zorik — sightings: ${tele.sightings} · chases: ${tele.chases} · closest: ${closest} tiles · he travelled ${tele.moved} tiles`;
  console.log('[run telemetry] ' + s);
  return s;
}
function caught() {
  if (gameState !== 'playing') return;
  gameState = 'dead'; controls.unlock(); audio.jumpscare();
  const df = document.getElementById('damage-flash'); df.classList.add('hit'); setTimeout(() => df.classList.remove('hit'), 250);
  teleSummary();                                       // log stats to console only
  document.getElementById('dead-sub').textContent = ''; // death screen stays clean: just YOU DIED + TRY AGAIN
  hide('hud'); show('screen-dead');
  const sd = document.getElementById('screen-dead');
  sd.classList.remove('scare'); void sd.offsetWidth;   // restart the animation each death
  sd.classList.add('scare');
}
function win() {
  if (gameState !== 'playing') return;
  gameState = 'win'; controls.unlock(); audio.stop();
  document.getElementById('win-sub').textContent = `Escaped in ${fmtTime(clock.getElapsedTime() - startTime)}.  ${teleSummary()}`;
  hide('hud'); show('screen-win');
}

/* ---------------------------------------------------------------------------
   14 · INPUT
   ------------------------------------------------------------------------- */
function initInput() {
  controls = new THREE.PointerLockControls(camera, renderer.domElement);
  document.addEventListener('keydown', (e) => {
    keys[e.code.toLowerCase()] = true;
    if (e.code === 'KeyF' && gameState === 'playing') toggleFlashlight();
    if (e.code === 'KeyX') dismissHint();
    if (e.code === 'Backquote') { dbgOn = !dbgOn; document.getElementById('dbg').classList.toggle('hidden', !dbgOn); }
  });
  document.getElementById('hint-close').addEventListener('pointerdown', dismissHint);
  // "CLICK TO BEGIN" splash: the first interaction satisfies the browser's audio-gesture rule,
  // starts the title music, then fades the prompt out and reveals the menu.
  function kickMenu() {
    if (gameState !== 'title') return;       // in-game keys/clicks must NEVER (re)start the menu music
    audio.menuStart();
    const cb = document.getElementById('click-begin'); if (cb) cb.classList.add('gone');
    const tm = document.getElementById('title-menu');
    if (tm) { tm.classList.remove('hidden'); requestAnimationFrame(() => tm.classList.add('show')); }
    document.removeEventListener('pointerdown', kickMenu);   // drop BOTH so the unused one can't fire mid-game
    document.removeEventListener('keydown', kickMenu);
  }
  document.addEventListener('pointerdown', kickMenu);
  document.addEventListener('keydown', kickMenu);
  audio.menuStart();                         // best-effort autoplay for trusted/returning visitors
  document.addEventListener('keyup', (e) => { keys[e.code.toLowerCase()] = false; });
  renderer.domElement.addEventListener('click', () => { if (gameState === 'playing' && !controls.isLocked) controls.lock(); });
  document.getElementById('btn-start').onclick = startGame;
  document.getElementById('btn-retry').onclick = startGame;
  document.getElementById('btn-again').onclick = startGame;
}

/* ---------------------------------------------------------------------------
   15 · MAIN LOOP (fixed-timestep sim, decoupled render)
   ------------------------------------------------------------------------- */
let acc = 0; const STEP = 1 / 60;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (gameState === 'playing') { acc += dt; while (acc >= STEP) { updatePlayer(STEP); updateStalker(STEP); acc -= STEP; } }
  renderer.render(scene, camera);
}
function onResize() { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }

/* ---------------------------------------------------------------------------
   16 · BOOT
   ------------------------------------------------------------------------- */
function boot() {
  initRenderer();
  initInput();
  audio.init();
  document.getElementById('loading').classList.add('hidden');
  animate();
}
window.addEventListener('load', boot);
