# Terminal Velocity engine notes (from GAME.EXE)

Recovered statically from `_oracle/GAME.EXE` (Watcom C32, DOS/4GW LE) with headless Ghidra on a
flattened image (`tools/re/le2flat.py`). Addresses are virtual addresses in that image
(code object at 0x10000, data at 0x60000). Decompiled output: `_re/c/<entry>.c`, `_re/all.c`.

Tags: **[O]** read from code/data, **[I]** inferred, **[U]** unknown. Nothing here was checked by
running the game; a DOSBox side-by-side is the next step for anything marked [I].

Units: **1 tile = 2^20 world units**. **1 height byte = 0x8000 units = 1/32 tile.** Angles are
65536 per turn. "dt-unit" = 16.16 game seconds = 0.98864 real seconds.

---

## 1. The big ones (why it doesn't look or feel right)

| # | Problem in the old viewer.js | Original | Fix (applied in `src/viewer.js`) |
|---|---|---|---|
| 1 | World is **mirrored** | Engine is left-handed: +X right, +Y up, +Z forward; yaw +0x4000 faces +X (clockwise from above) | Root group `scale.z = -1` (or map z → −z and flip winding); three.js yaw = −yaw, pitch = −pitch, roll = +roll, Euler order `YXZ`; drop the `+π` yaw hack in `parse_nav_start` |
| 2 | `FLY_FOV = 42` | **90.6° vertical, ~100.9° horizontal** (320x200, default aspect flag) | `camera.fov = 90.6`; `camera.aspect = 1.2` to match the stretched VGA picture (4/3 for SVGA look); `near ≈ 0.002` |
| 3 | `SPEED_MIN/MAX = 65536/128000` | **0.25–1.0 tile/s**, starts at **0.5**; afterburner **3.0 tile/s** | `SPEED_MIN = 16384`, `SPEED_MAX = 65536`, start = 32768, boost = 196608 (all ×1.0115 for real seconds) |
| 4 | `HEIGHT_PER_BYTE = 1/16` × relief 0.4 | **1/32 tile per byte** | `HEIGHT_PER_BYTE = 1/32`, relief 1 (or keep 1/16 with relief 0.5) |
| 5 | Fixed tile diagonal (1,0)–(0,1) | **Checkerboard**: if `(x&1)==(z&1)` split (0,0)–(1,1), else (1,0)–(0,1) | Alternate in `tileFace`; same planes for ground sampling |
| 6 | Lambert/hemi/directional lighting on terrain | **Terrain is unlit**: texture × stepped depth fog only | `MeshBasicMaterial` for terrain |
| 7 | Linear filtering, mipmaps, anisotropy | **Nearest texel**, no mipmaps, one 64x64 texture stretched once per tile | `NearestFilter` min+mag, `generateMipmaps = false` |
| 8 | `FLY_FOG {near 3, far 18}`, far 72 | **11x11 tile window** (radius 5), fog in **16 hard steps**, none below ~2.06 tiles depth, full at ~3.76 tiles | See §3.2 |
| 9 | Mouse sets absolute yaw/pitch | **Rate control** in body frame, ramps, auto-bank, auto-level | See §2.3 |
| 10 | Boss "blob" visible | Region is a **cave** (all-255 tiles around a pocket), drawn only in cave mode | See §5 |

---

## 2. Flight model

Call chain [O]: main loop `FUN_0002cdd0` → `FUN_000110e0` → `FUN_00012740` (flight) → `FUN_00011cc0` (dynamics).
(`FUN_000108f0` is a debug free-fly camera, not the player.)

### 2.1 State [O]
- Player position `0x7cb04/08/0c` (X, Y up, Z), int32 world units, wrapped with `(v<<4)>>4` (256 tiles).
- Angles pitch `0x7cb10`, roll `0x7cb14`, yaw `0x7cb18`. 16.16 matrix `0x7cb20..`, float master matrix `0x81d1c`.
- Body velocity `0x64f10/14/18` (right/up/forward), body rates `0x64f1c/20/24` (pitch/roll/yaw).
- Throttle `0x64d00`, dt `0x7cfb0`, shields `0x7cf64` (0xffff full).

### 2.2 Timing [O]
- No fixed tick. `dt = ΔPIT_counts / 18`, capped at 0x4000 (~0.247 s). `pos += dt·vel >> 16`.
- Velocity and rate damping (halving) happen **per frame** → frame-rate dependent. Steady state is reached in a few frames, so in practice: speed ≈ 2·T, rate ≈ 2·input.
- `-turbo` = dt×1.5, `-hyper` = dt×2.

### 2.3 Speed and steering [O]
- Every frame: `vel_f >>= 1; vel_f += T`, `T = throttle·0x80000 >> 16` → speed = throttle tiles per dt-unit.
- Throttle clamped `[0x4000, 0xffff]`, reset to 0x8000. Keys **A/Z hold** change it ±1.0/s. No reverse, no strafing, **no sideslip** (side/up velocity always 0: you move exactly along the nose).
- Afterburner (Alt, while fuel `0xa7ac0` > 0): `T = 3·0x80000`, ignores throttle. Fuel −6/s, pickup +120.
- Turn keys ramp 0→1 in 0.5 s (rise 2/s), fall in 0.25 s (4/s). Input × 0x2492 (1/7).
- Rates: `rate >>= 1` per frame, then `+= input`. Max pitch/yaw/roll ≈ **103°/s**.
- **Bank coupling**: roll rate gets `−0.732 × yaw input` → ship banks into turns (~75°/s).
- **Auto-level** (on by default): `rollRate −= cos²(pitch)·clamp(roll/7/dt, ±0xc30)` → levels to wings-level, or inverted if |roll| > 90°, max ~34°/s.
- Orientation integrated in the body frame: `M = M · R(dt·rates)`; Euler re-extracted (`FUN_00011920`).
- **No pitch limit in normal flight** (loops OK). In tunnels pitch/yaw are clamped to ±10000 (~55°).

### 2.4 Ground, ceiling, gravity [O]
- **No gravity.**
- Floor: `Y ≥ ground + 0x1000` (1/256 tile). On contact: clamp, `ground.wav`, 0x800 damage (unless in 1 s grace), and pitch bounce: nose-down → pitch = −pitch; level/nose-up → pitch×2 clamped to −0x3fff. Speed unchanged.
- Damage (`FUN_000131d0`) plays a random `exp1`–`exp5.wav` at the ship (`FUN_000197f0`), sets the 1 s grace (`[0x7cf4c]` = 0x10000), adds `((2·rand − 0x8000) << 13) / (frameTime + 1)` to each turn rate (`[0x64f1c..24]`, which `FUN_00011cc0` halves every frame, so the ship turns `(2·rand − 0x8000) / 4` in all: up to 45° per axis, half of it in the first frame), and starts a 1/8 s flash (`FUN_0002edf0(0)`, `[0x682f4]` = 0x2000). The flash (`FUN_0002f700`, before the HUD is drawn) remaps every pixel to `tint · min(255, |rgb|) >> 12` per channel through the 32-level inverse table (level k = 8k), tint = palette[`[0x682e4 + 4·type]`]: type 0 (damage) = 144, 1 = 127, 2 = 31.
- Enemy shots (`FUN_00019330`/`0001a190`/`0001bee0` → `FUN_000133b0`): a shot within 0x10000 (1/16 tile) of the ship on every axis, outside the grace, does its def's damage (projectile +0) and is used up; during the grace shots pass through.
- Cave mode: 255 rock reverses yaw (+0x8000) and always does damage; the mirrored ceiling clamps to `roof − 1`, damages, and bounces (nose-up → −pitch, else pitch×2 clamped to 0x3fff).
- Ceiling: `Y ≤ 2·[0x67888] = 0xff0000` → **15.94 tiles**.
- Viewer: `FLY_CLEARANCE` 0.05 → 1/256.

### 2.5 Exact ground height (`FUN_0003c940(z, x)`) [O]
Port of `tools/re/ground.py` (inputs in world units; divide result by 2^20 for tiles):
```js
function groundAt(H, x, z) {               // H = Uint8Array(65536), index [row(z)*256 + col(x)]
  const tx = (x >> 20) & 255, tz = (z >> 20) & 255;
  const u = (x & 0xfffff) >> 4, v = (z & 0xfffff) >> 4;   // 16-bit fractions
  const h = (r, c) => H[(r & 255) * 256 + (c & 255)] * 0x8000;
  const h00 = h(tz, tx), h01 = h(tz, tx + 1), h10 = h(tz + 1, tx), h11 = h(tz + 1, tx + 1);
  if ((tx & 1) === (tz & 1)) {
    if (u <= v) return h00 + (v * (h10 - h00) / 65536) + (u * (h11 - h10) / 65536);
    return h00 + (u * (h01 - h00) / 65536) + (v * (h11 - h01) / 65536);
  }
  if (v < 0x10000 - u) return h01 + ((0x10000 - u) * (h00 - h01) / 65536) + (v * (h10 - h00) / 65536);
  return h01 + ((0x10000 - u) * (h10 - h11) / 65536) + (v * (h11 - h01) / 65536);
}
```

### 2.6 Conventions [O]
- Forward = `(sin yaw·cos pitch, −sin pitch, cos yaw·cos pitch)`. **Positive pitch = nose down**; Up-arrow pitches the nose down (stick convention). Positive roll lifts the right wing.
- Matrix R = Ry(yaw)·Rx(pitch)·Rz(roll).

---

## 3. Rendering

### 3.1 Projection [O] (`FUN_00014910`, `FUN_0001cd00`, `FUN_0001d080`)
- 320x200 default; SVGA option is 640x**240** [I: line-doubled].
- `sx = 160 + 0.8302·159·x/z`, `sy = 100 − 99·y/z`. Horizon exactly at screen centre at pitch 0.
- Clipping `|k·x| < z`, `|y| < z` → 90.6° vertical, 100.9° horizontal (106.9° with aspectRatio=1 or SVGA).
- No near plane; zoom `0x64cd0` = 1.0.

### 3.2 Terrain draw, view distance, fog [O]
- `FUN_0003c5b0`: **11x11 tiles** around the camera tile, drawn in rings from radius 5 to 0 (back to front). No far plane, **no LOD** (distance only picks perspective vs affine texture mapper).
- Fog: per span `fogLevel = clamp(floor(32 − 64 / z_tiles), 0, 15)` where `z_tiles` is view-space depth; colour = `fog[fogLevel][texel]`, which equals `mix(texel, pal[fogIndex], fogLevel/15)` (16 hard bands, linear in 1/z).
  - No fog under ~2.06 tiles depth, solid fog colour from ~3.76 tiles. [I] This is short; verify against a screenshot before committing to it.
- Clear colour = `pal[fogIndex]` (`.lvl` line 22; 255 normally, 0 on star-sky levels).
- Objects (models) are **not fogged**.
- Shader sketch: `float lvl = clamp(floor(32.0 - 64.0/viewDepthTiles), 0.0, 15.0); col = mix(tex, fogColor, lvl/15.0);`

### 3.3 Terrain mesh and textures [O]
- Vertices at tile corners, `y = byte/32` tiles. Checkerboard diagonals (§1 #5).
- `.clr` byte = plain index into `.tex`. **No rotation/flip bits.**
- One texture per tile, stretched once; 64x64 textures with UVs 0.5..63.5. Texture row follows +x, column follows +z (the viewer's current transpose is correct; keep it while fixing the mirror).
- Unlit. The sun vector/ambient (`.lvl` 18/19) and `.lte` are only for models and tunnel-mouth tiles.
- Option `0x64e0c` scales all heights by 7/8 [U which menu setting].

### 3.4 Camera [O] (`FUN_00017980`)
- Cockpit: exactly the ship position/angles, **no eye offset**.
- Chase (`FUN_00017650`): `ship − 0x20000·forward + 0x10000·(0, cos pitch·cos roll, 0)` → 1/8 tile back, ≤1/16 tile up; rigid, no lag.
- All modes stay ≥ 1/256 tile above the ground.

### 3.5 Sky (`FUN_00018a90`, `FUN_00018b60`) [O]
- Surface levels: textured plane **fixed in the world** at y = 0x7f8000 (**7.97 tiles** = 15.94 pre-relief), ±512 tiles, **no scroll**.
- sky.raw 64x64 repeats every **16 tiles**, RepeatWrapping, nearest; column → +x, row → +z (not transposed).
- Fogged with the same formula at 1/256 scale: fades out between ~128 and ~241 tiles.
- Camera height decides what is drawn (`FUN_00018a90`, deck at `[0x67888]` = 0x7f8000, band 0x20000): below the deck → the sky plane; within ±1/8 tile → clear to 255 only; above → `FUN_00018610`: the deck from above, a flat quad at 4× the sky height in colour ramp 12 (palette 240, the first sky-band entry, e.g. sunset peach on artic), and a horizon wall (untextured, unfogged span routine 0x492f1): 4096 tiles ahead of the camera, turned by its yaw, ±8192 wide, from the deck up 512 tiles, palette index interpolated 255 (bottom) → 240 (top); then objects above the deck (`FUN_00018ce0`). The viewer draws the wall at 1/8 scale to stay inside the far plane.
- The terrain (`FUN_0003c5b0`, which also draws the objects tile by tile) is only drawn while the camera is **below** the deck (`camY < [0x67888]`, or cave mode). Height-255 plateaus sit exactly at the deck and the floor keeps you 1/256 tile above them, so over a plateau you are always above the deck and see only clouds: the boss pocket on artic can't be seen from above, and descending anywhere but over the pocket hits the plateau.
- `stars.vox` sky → 1000-star field on black, palette 240..255 black.
- Viewer: `SKY_LEVEL` 20 → 15.94; repeat 64 across the plane; remove `skyDrift`, cloud shader and tint.

---

## 4. Levels, spawn, objects

### 4.1 `.lvl` (`FUN_00032d20` → struct 0xe3544) [O]
Lines 1–17 match `LEVEL_FIELDS`. Then:

| line | meaning |
|---|---|
| 18 `x,y,z` | sun direction, 16.16 (models/tunnel mouths) |
| 19 | ambient 0..65535 |
| 20 `x,y,z` | cave-mode light direction |
| 21 | cave-mode ambient |
| 22 | **fog colour palette index** |
| after `;` | five story names (`.tvi`, `.mic`, or `null`) |

**Bug in tvextract**: `sky_scroll`/`sky_speed` (lines 20/21) are the cave light values. There is no sky drift.

### 4.2 Spawn (`FUN_0003eac0`) [O]
- If the first `.nav` record is type 6: x, z from the file, **y = ground(x, z) + 0x80000 (½ tile)**; the file y is ignored (it is just an editor-baked ground value). Pitch/roll/yaw used as-is.
- Otherwise: spawn at (0, ground(0,0)+½ tile, 0), angles 0.
- After the mirror fix use three yaw = −yaw (no +π), pitch = −pitch.
- `.nav` records: type, `x,y,z`, description, then per type — 0: count + target object indices (position taken from the first object); 1: tunnel `.lvl` + one line; 4: two lines; 5: int, music, line, optional `!` list (boss); 6: `pitch,roll,yaw`. Waypoint y = max(file y, ground). Type 1's line after the description is the tunnel `.lvl`; type 5's int is the boss slot, then the music, then optionally `!NewH`, a count and that many part slots. [port] Fixed in `parseNav`; the Python extractor reads the boss block as the next point's type.
- Route (`FUN_0003f350`, every frame on the surface; `FUN_0003f230` advances): type 0 aims at the first of its slots with strength > 0 and state ≠ 301 and moves on when there is none ("Target Destroyed", or "Mission Complete" if a type 3 is next). Type 2 passes within 2.5 tiles (`_DAT_00063b24` = 2621440, "Checkpoint"). Type 3 within 0.9375 tile (`_DAT_00063b20`) ends the level, as does running past the last point. Type 5: while any part has strength > 0 the boss's strength is reset to slot [9] and the marker follows the last live part; when the boss has strength < 1 or is in 301, "Boss Destroyed" and a big explosion (`FUN_0001cb00`). Advancing onto a type 5 plays `warning.wav` with "Mission Goal Ahead!". Distances are level (x, z) except for type 1, which is 3D. The marker colour is 0x1f within 3.75 tiles (`_DAT_00063b1c`), 0x10 beyond. Entering a tunnel (`FUN_0003f9f0`) puts the cursor just past the type 1 point naming it; leaving it (`FUN_0003f9c0`) passes a type 4. Port: all of this except the level end, the boss explosion and the marker colour.

### 4.3 `.def` objects (`FUN_000230a0`, `FUN_00022f20`) [O]
- Def header `logic,?,radius,dx,dy,dz,"a.bin,b.bin"`: a = model, b = second model [I: destroyed]; dx/dy/dz are offsets; radius is overwritten by the model's bounding radius.
- Placement row: def index, strength, x, y, z, pitch, roll, yaw.
- **Surface levels: y := ground(x, z)** (triangle planes), then + dx/dy/dz, and **+ radius/2 for logic 2, 4, 7, 8**. Model origin at that point, no bounding-box drop.
- Tunnel levels: file x, y, z used directly.
- Fix: drop the ground/air seat logic and the `drop` term in `objectAltitude`; export logic + dx/dy/dz per def.

### 4.4 `.pup` [O]
Only `count` rows are read. Surface: y = ground + 2 × model bounding radius.

---

## 5. The boss "blob" [O]

- Example artic.raw: rows 113–141 × cols 113–142 are all **255**, except a pocket (rows 126–131, cols 124–129, heights 220/230). The boss (arcani.bin) sits in the pocket.
- **Surface mode has no special case**: those tiles are drawn as a flat plateau 7.97 tiles high. The original hides it only by the 5-tile draw radius, fog, and distance (~128 tiles from spawn). Fly there in the original and you'd see a plateau, not a blob over the whole map — your full-map mesh + long fog is what exposes it.
- **Cave mode** (`0x64d8c`): set from the `.tdf` record's caveFlag when entering a tunnel (`0x425d5`), reset on level load. Renderer `FUN_0003d5e0`:
  - radius **7** tiles (15x15),
  - floor `y = h/32`, ceiling `y = (510 − h)/32` tiles (mirror about 7.97),
  - quads with all four corners = 255 are skipped (solid rock),
  - black clear if the radius-7 ring isn't all 255; no sky.
  - Physics: touching ground == 255 is a wall → yaw += 0x8000 (180°). Ceiling = 0xff0000 − ground − 1.
- While the current nav target is the boss (type 5), tunnel mouths are hidden and can't be entered.
- **Fix**: for each `.tdf` record with caveFlag = 1, flood-fill from its exit tile over h < 255 plus the surrounding 255 block; cut that region out of the surface mesh; render it as a cave mesh (floor + mirrored ceiling) only after exiting a caveFlag tunnel.

---

## 6. Tunnels

### 6.1 `.tnl` segment (`FUN_00034770`, ≤ 90 segments, 0x244 bytes each) [O]
1. `x0,y0,x1,y1,N` — centreline start/end, N wall faces (4, 5, 6 or 8 in the data)
2. `a0,a1,rot` — start-ring angle range, rotation speed (65536 = 1 turn/s)
3. `rx0,ry0` — start-ring radii
4. `b0,b1` — end-ring angle range
5. `rx1,ry1` — end-ring radii
6. `hp` — obstacle hit points
7. `lightFace` (−1 = none)
8. `missing` — vertices replaced by the centre point
9. `obstacle` type: 0 none, 2 destructible barrier (also stops drawing), 4–15 / 0x12–0x15 doors/fans/slots, 0x19 flicker
10. `obstacleTex`
11. N face texture indices (tunnel level's own `.tex`)
12. `lightMode, lightIntensity, ambient`

**tvextract bugs**: faces must be `tail[5:5+N]` (current `tail[4:]` takes obstacleTex as face 0 and lightMode as an extra face); "fitting" is the obstacle type, not a model slot. `tools/re/tnl.py` parses every shipped `.tnl` to EOF.

### 6.2 Geometry (`FUN_00033f00`) [O]
- 1 file unit = 256 game units = **1/4096 tile**. Segment k spans z = k..k+1 tiles.
- Start ring vertex i: `θ = a0 + i·(a1−a0)/(N−missing)`, `(x0 + rx0·cos θ, y0 + ry0·sin θ)`; end ring the same with b0/b1, x1/y1, rx1/ry1.
- Face i = quad `s_i, s_(i+1 mod N), e_(i+1), e_i` (two triangles if not planar). Straight sides between rings; segments join because each start equals the previous end.
- Textures: one whole texture per face per segment, u around, v along (pixels 1..255). Light face uses a quarter: u 1..127 lit / 129..255 off, v 1..127.
- Brightness = segment ambient + directional term along the light face normal.
- Draws 5 segments ahead to 1 behind; near the end draws the surface through the exit hole.
- Collision: 8 corners of a ±0x8000 cube pushed out of the wall planes.
- Props sit at their file (x, y, z) in tunnel space (not snapped to the centreline).

**viewer.js fixes**: radius = r/4096 (`TUNNEL_GIRTH/2 = 1/2048` makes tunnels **2× too wide**); per-segment N and a0/b0 offsets instead of fixed 8 sides from 0°; faces[i] per face; remove `MOUTH_LIMIT` and radius blending; real prop x/y.

### 6.3 `.tdf` and portals (`FUN_00039d50`, `FUN_00042160`) [O]
- Record: tunnel `.lvl`, entrance xyz, exit xyz (y recomputed as ground), entranceMode, two textures (second = mouth tile), exitMode, two exit textures, **caveFlag**.
- Mouth drawn only if mode ≠ 0 and within 5 tiles; entrance shows the first 5 segments, exit the last 5 reversed.
- Entrance frame: n = normal of the exact terrain triangle under (x, z); `yaw = atan2(−nx, −nz)`, `pitch = atan2(ny, √(nx²+nz²))`, roll 0; tunnel +Z = −n (into the ground).
- Entry when within 1/16 tile, |x| < 0.707·rx0, |y| < 0.707·ry0, facing in → player at segment 0 start-ring centroid + sideways offset, angles reset; cave flag set.
- Exit when z ≥ N tiles: `yaw = atan2(nx, nz)`, `pitch = −atan2(ny, h)`, `world = exit + R·(p − (x1_last·256, y1_last·256, N·2^20))`; frame yaw/pitch added to the player's.
- Use these exact frames instead of `setFromUnitVectors` at the tile centre. (On flat ground tunnel +Y maps to world −Z; the viewer currently maps it to +Z.)

---

## 7. File formats

### 7.1 `fog/*.mix` — 50 % translucency table [O]
- Full table is 256x256 (`vga.mix`, 65536 bytes): `mix[a*256+b]` = nearest palette colour to `(pal[a]+pal[b])/2`; if either is black, the other colour passes through.
- A level `.mix` (7936 bytes) patches only the sky-band entries: bytes 0..3839 = rows 0..239 × columns 240..255; bytes 3840..7935 = rows 240..255 × all 256 columns. Name derived from the level `.act` name.
- Used only by model face type 0x21 (none shipped) and UI tint rectangles. **Not used by terrain, fog or sky.**
- WebGL: alpha 0.5 blend, discard palette-black texels. You can ignore `.mix`.

### 7.2 `.fog` / `.lte` [O]
- `.fog`: 16x256, row k = colour moved k/15 toward `pal[lvl line 22]`. Generator `FUN_00014d90`.
- `.lte`: same toward black, but **only colours 0..95 darken**. Row = `(0xffff − I) >> 12`, `I = amb + max(0, −n·sun)·(1 − amb)`. Models only (plus tunnel mouths).

### 7.3 `fog/*.map` [O]
15-bit RGB → nearest palette index over 0..0xF0. Matches tvextract.

### 7.4 `models/*.bin` — command stream [O]
Drawer `FUN_00017270` dispatches block types 1..0x22 through the table at 0x67774; sizes from `FUN_00040a10`. All 208 static models walk exactly to EOF.

- The "header" is two blocks: **0x14** (scale at +4) and **0x02** vertex list (first slot, count, xyz…). So `_u1` = block type 2, `index_bias` = first vertex slot → always `local = idx − first_slot`.
- Model units: 1 file unit = 1/(16·scale) tile (MODEL_SCALE 1/16 ✓).
- Face plane at +8..+0x14 = 16.16 normal + d (the extractor's `_magic` is d). **All faces single-sided.**
- UVs: 16.16 in 0..256 texel space → `uv = value / (65536·256)` (not /255).

| type | meaning | in data |
|---|---|---|
| 0x00 | end | ✓ |
| 0x01 | set origin | |
| 0x02 | vertex list | header |
| 0x03 | per-vertex normals (handler reads 12n) | |
| 0x04 | per-slot UVs | sprites |
| 0x05 | flat-lit, colour ramp | ✓ |
| 0x06 | Gouraud via 0x1F per-vertex palette index, unlit | lasers |
| 0x07 | lit textured, slot UVs | |
| 0x08 | invisible | |
| 0x09 | rotate+translate sub-list | |
| 0x0A | set **colour ramp id** | ✓ |
| 0x0B | draw sub-list | |
| 0x0C | BSP node (plane, offA, offB) | helicopt, missile, radar |
| 0x0D | set texture (name[16]) | ✓ |
| 0x0E | lit textured, no z-buffer | ✓ |
| 0x0F | alpha-test textured, slot UVs, unlit | sprites, power-ups |
| 0x10 | translate sub-list | |
| 0x11 | alpha-test textured, unlit | helicopt |
| 0x12 | jump (8 bytes) | helicopt, radar |
| 0x14 | scale | header |
| 0x15 | lit textured, perspective | |
| 0x16 | polyline (8+4n) | |
| 0x17 | off-screen cull of vertices | 154 |
| **0x18** | **main type: lit textured, affine, z-buffered** | 20855 |
| 0x19 | flat-lit, z-buffered | 825 |
| 0x1A | like 0x18, slot UVs | |
| 0x1B/0x1C | skipped | |
| 0x1D | animated texture (+sound on frame change) | cboss |
| 0x1E | = 0x0E | |
| 0x1F | per-vertex palette index | lasers |
| 0x20 | morph header (Catmull-Rom over keys) | 15 files |
| 0x21 | 50 % translucent textured (.mix) | |
| 0x22 | lit textured variant | |

- Colour ramps (`0x67800/0x67840`, `lo + I·(hi−lo)`): `0:(0,31) 1:(0,15) 2:(32,63) 3:(64,95) 4:(144,151) 5:(152,159) 6:(160,167) 7:(168,175) 8:(176,183) 9:(184,191) 10:(0,7) 11:(0,24) 12:240 13:255 14:0 15:216`; negative = literal palette index. tvextract uses `palette[colour]` → most untextured faces come out black.
- Corrected sets: `FACE_UV = {0x0E, 0x11, 0x18, 0x1E, 0x22}`; alpha-test `{0x0F, 0x11}`; translucent `{0x21}`; invisible `{0x08, 0x1B, 0x1C}`. Remove 0x29/0x33/0x34.
- Morph (0x20): +8 nframes (≤16), +0xC ticks/key, +0x18 16×16-byte key names; face planes recomputed after blending. `FUN_00040f70`: `t = clock mod (ticks·n)` on the global 16.16 clock `0x64e08` (so all copies move in step), `k = t / ticks`, `f = frac`; keys k−1, k, k+1, k+2 (wrapping) weighted by Catmull-Rom `(−½f³+f²−½f, 1½f³−2½f²+1, −1½f³+2f²+½f, ½f³−½f²)` (constants at 0x63eaf..0x63ecb). Keys are rescaled to the first key's scale.
- Animated texture (0x1D, `FUN_00016d50`): +8 count, +0x10 ticks/frame (16.16 s, e.g. 0x1000 = 1/16 s), then `count` × 32 bytes (texture name[16], sound name[16]). Frame = `(time / ticks) mod count`; the sound plays on a frame change (no shipped model names one). Its time accumulates per model only while drawn; `src/viewer.js` uses the global clock instead.

### 7.5 Other level files [O]
- `.qke`: never read (loader is a bare `ret`).
- `.ani`: count; per entry texture name, `nframes,rate`, frame names (all shipped files are `0`).
- `.tex`: count + names, index order = `.clr` values.
- `.dmo`: count (≤1024), level name, records `kind,time` (time in 1/65536 s). kind 0 = pose (x,y,z, pitch,roll,yaw, fire flag), kind 1 = scancode. Playback interpolates poses linearly.
- `.tvi` cutscenes: u32 frame count, u32 table, chunks (type 3 = 11025 Hz audio; others 8x8-cell video from row 40, 15 fps).
- The game regenerates and writes `.mix/.map/.fog/.lte` if missing.

---

## 8. Tooling

- `tools/re/le2flat.py GAME.EXE game.bin` — flatten LE with fixups (VA = offset + 0x10000).
- Ghidra import: `-processor x86:LE:32:default -cspec gcc -loader BinaryLoader -loader-baseAddr 0x10000`, seed functions with `SeedFns.java` (see `_re/ghidra_run.sh.example`). Calling convention is Watcom register (EAX, EDX, EBX, ECX) → shows as `in_EAX` etc.
- `tools/re/ground.py`, `tnl.py`, `unpod.py`, `mixcheck.py`, `fogcheck.py`, `binwalk.py` — verifiers used for the claims above.

---

## 9. Enemy AI (`src/ai.js`)

Loop `FUN_000241c0` → per enemy `FUN_00028610`, a switch on the def's logic. Enemy slot is 0xb4 bytes,
def 0x244 bytes. [O] unless marked.

- **Gating**: strength > 0; defs with `!NewAtakRet` third value ≠ 0 only run while the nav target is the
  boss (type 5); on the surface `FUN_0001e500` skips anything more than **5 tiles** (by tile index) from
  the camera tile: the same 11x11 window that is drawn. In tunnels everything runs.
- **Slot** `[0..2]` pos, `[3..5]` pitch/roll/yaw, `[7]` strength, `[0xd..0x12]` target pos/angles,
  `[0x19]` state, `[0x1a]` fire clock, `[0x1b]`/`[0x1c]` timers, `[0x1d]`/`[0x1e]` speed/turn bias =
  `((row << 30) >> 16)`, `[0x20]` = row & 3 (break-off heading). Row = placement row number.
- **Def line 2** `speed,turn,fireEvery,weapon,shot`: speed in units per game second; turn is a 16.16
  per-second approach factor; fireEvery in 16.16 seconds.
- **Mover** `FUN_00024c30`: `pitch += k(aimPitch − pitch)`, `yaw += k·err`, `roll = −k·err/2` (one
  frame's k: frame-rate dependent), `pos += forward·speed·dt`, `y ≥ ground + radius`. k = turn·dt.
- **Fighters** 7, 8, 0x1d, 0x26, 0x27 (`FUN_00025810`): active within 5 tiles (horizontal) of a point
  ½ tile ahead of the player; aim there (`yaw = atan2(dx,dz)`, `pitch = −atan2(dy,dh)`). States
  200 attack → 201 break off when 3D distance < near/16 tiles (25 % roll 202, 6 % loop 203); back to
  200 past far/16. Defaults 32/16 → 2 / 1 tile. Once a second a 1/16 chance to toggle 200/201. Break-off
  aim: `yaw = pitchToTarget + {90°,180°,270°,0°}[row&3]`, pitch bias `{+0x1000,+0x2000,−0x1000,−0x2000}`
  (dive reduced by 0x3000 when the ground + 4 radii is above the player). Fire only in 200, within
  2.5 tiles.
- **Others**: 1/0x16/6 turret, 3 radar (fires < 1.25), 10 yaw-only, 11 pitch-only, 2/4 straight chase
  (fire < 1.25), 5 drill spin, 0x10 tunnel runner (centreline back toward segment 0), 0x11 transport
  lifts off at ¼ tile/s and leaves above 15.94, 0x12 asteroid falls at 4 tiles/s and respawns ±2 tiles,
  0x13 C-Nome (chase > 2 tiles, scatter at double speed < ¼ tile), 0x15 factory spawns a C-Nome every
  4 s, 0x19 missile launch (1/64 per frame), 0x1a bob ±¼ radius, 0x1c mothership climbs to 4 tiles and
  rewrites its def to 0x1d, 0x20 helicopter (1/16 per frame take-off, 8 s dogfight / 8 s hover gun).
- Lost to Ghidra (FPU/register args), filled in [I]: turret turn rates (def turn used), tunnel-runner
  facing, the display pitch offset `[0xa]` (dropped), shot speed (tracers are cosmetic).

### 9.x Radar (`FUN_0002a040` → `FUN_0002a240`, `FUN_0002a090`, `FUN_00029da0`) [O]
- Box: x 254, y 7, 57×47 px in the 320×64 status bar. The status bar is drawn over it, so only the dial interior shows.
- Placement: `(dx, dz)` is rotated by the player yaw into 1/256-tile units; 2048 of those span the box width (or height). That is ±4 tiles each way, squashed vertically. Forward is up.
- Enemies: drawn only if alive, slot `+0x84` is set (the enemy ran this frame), state ≠ 301, and logic ∉ {18, 33}. Colour 0x94 (orange) for logics 2, 4, 7, 8, 16, 0x26 and 0x27; 0x3f (pale green) otherwise.
- Blip: a plus if the object is at or above the player's y, a 3-px dash if below; both have a black outline.
- Power-ups (`.pup` list, skipped once taken): colour cycles 0x61↔0x7e, one step per frame.
- A second list (stride 0x173c, colour 0x9b) is probably the network players; it is not ported.

### 9.y Status-bar text and sight [O]
- Font: only in GAME.EXE, at 0x65770. It has 128 glyphs of 64 bytes each: byte 0 is the width, then width × 8 pixels. A pixel value v is drawn as palette 0x20 + v; the remap table at 0x93574 is the identity in row 0. A glyph advances by width + 1 (`FUN_00014a30` / `FUN_00014a80`). `src/exe.js` reads it from the raw LE file.
- Layout (`FUN_0002fcb0`, via `FUN_0002fc40`, which centres text in a slot given as x, y, width):

  | Field | x | y | Width | Content |
  |---|---|---|---|---|
  | sector | 41 | 5 | 51 | `"%3d,%3d"`, or `"??,??"` in a tunnel |
  | distance | 41 | 16 | 30 | |
  | nav | 41 | 27 | 23 | the type code: TGT TUN CHK DUN XIT BOS STR |
  | weapon | 137 | 5 | 32 | |
  | ammo | 115 | 16 | 32 | `"inf"` when unlimited |
- Gauges (same function, rows drawn by `FUN_0002f870(x, y, length, c0, c1)`: palette index stepping c0→c1 in 16.16, two pixels per step, the +0.5 rounding on the even pixel of even rows and the odd pixel of odd rows, so the ramp dithers):
  - Shields `[0x7cf64]`: rows 3–5 from x 175, length `shield·73 >> 16`, colour 0xb4 → 0xb4 + 11·shield (top row 0xb4 + 8.25·shield).
  - Throttle `[0x64d00]`: rows 12–14 from x 175, fill = `(T − 0x4000) / (0x10000 − 0x4000)` clamped to [0, 0xffff], length `fill·73 >> 16` (empty at minimum, 24 px at the start throttle), colour 0x68 → 0x68 + 23·fill (top row 0x68 + 17.25·fill). It shows the throttle, not the afterburner.
  - On a 640-wide screen the x is 350 and the length doubles.
- Radar blips are skipped entirely in tunnels (`DAT_00064d48 == 1`).
- Mouse sight (`FUN_0002ab80`, only when a mouse is active, `DAT_00064e44`): a one-pixel plus, ±5 px, at the mouse position. Its colour walks palette 0x20–0x3f and back, one step per frame. The normal flight sight is a 12×7 notched plus (taken from a screen grab); its drawing routine has not been found yet.

### 9.z Logic 14 / 0x1f gun mounts (`FUN_00026c60`) [O]
- The body never moves. Slots 0x13–0x15 are eased toward 0x0d–0x0f, but both are set to the position first. The model is drawn from slot 3..5 + 10..12.
- A separate gun (slot 0x16 pitch, 0x18 yaw) eases toward the player at (turn + bias)·dt (`FUN_000262d0`).
- It fires along the gun every `fireEvery` (`FUN_00026420`), with no range check beyond the 5-tile wake window.
- `def +0x190` (non-zero) offsets the muzzle by the body matrix (`FUN_000245e0`); not ported.
- Used by bughunt's `pboat` ("Centauri Surfskimmer"): despite "patrol" in its description, it sits still and shoots.
- Logic 0x1f additionally spins slot 5 by dt/8 and snaps y to the ground.

### 9.w Spawner (`FUN_00023e20`, run at the end of `FUN_000241c0`) [O]
- The surface only (not in tunnels, not when `DAT_00064d8c` is set). `FUN_000241c0` counts the awake, alive enemies with logic 1, 2, 4, 7, 8, 10, 11, 14, 0x20, 0x23, 0x26 or 0x27 (`DAT_000db054`).
- The spawner runs while that count is at most 1 / 2 / 4 for difficulty (`DAT_00064d88`) 1 Normal / 2 Hard / 3 Terminal; Easy (0) never spawns. The menu (`FUN_0002e3d0`) offers Easy, Normal, Hard and Terminal, and defaults to Normal.
- Clock `DAT_00068160` gains dt/4 only while the spawner runs; at 1.0 it spawns one craft and subtracts 1. The level load sets it to −4 (Easy/Normal) or −2, so the first spawn takes 20 s or 12 s.
- Which def: the next one, round robin by def index (`DAT_00068164`, never reset), whose def line 3 second value (`+0xe4`) is non-zero. Line 3 is `?, spawn, drop %, drop type` (`+0xe0..0xec`).
- The new slot copies the def's first slot (0xb4 bytes), dead or alive, then `FUN_00022f20` resets it. `FUN_00022f20` sets the initial strength to the copied current strength, so once that first slot is dead every copy is born dead. Dead spawned slots (strength exactly 0) are reused; the list is capped at 0x1f2.
- Placement: 3 tiles from the player. A quarter of the time the heading is random; otherwise it is the player's yaw ± 45°. Height is ground(player) + U[0,1) · `DAT_00067888` (7.97 tiles).
- Load-time strength scaling: ×1.5 on Hard and ×2 on Terminal (`FUN_000230a0`). This port has no combat, so the scaling is not applied.
- Arctic: SnowScout (def 0) and IceRider (def 1) are both spawnable, so they alternate, IceRider first.

### 9.v Enemy shots (`FUN_00026420` → `FUN_00019070`, moved by `FUN_00019330`) [O]
- Def line 2 is `speed, turn, fireEvery, damage, shot` (+0x64, +0x68, +0x6c, +0x70, +0xdc). `damage` goes to projectile +0; `shot` goes to +0x10 and picks the model.
- Models (`FUN_00018dc0`, table at 0x678ec):
  - 0 `laser`
  - 1–7 `laser3`–`laser9`
  - 8 `bullet`
  - 9–16 `wboss1`–`wboss8`
  - 17 `missile`, which plays `missile.wav` instead of `whiz3.wav`
- Colours come from the models: `laser` 223/213 (purple, tanks and boats), `laser8` 148/138 (red, arctic fighters).
- Speed is def +0x218, the `#New2ndweapon` 4th value; it defaults to 2 × speed. A shot moves speed units per game second in 8 substeps and lives 2 game seconds (+4 = 0x20000). It dies under the ground.
- Muzzle (`FUN_00024540`): def line 4 is `count, v1..v8` (+0x190, +0x194). Each shot picks a random vertex from that list (first morph frame), turns it by the body angles and adds it to the position. Gun mounts (`FUN_00026420`) also use the body angles. A count of 0 fires from the centre; the arctic fighters have 0, the tank has 54, 55.
- Spread (`FUN_00024700` only, `#New2ndweapon` 1st value, slot 0x2b): 1 cycles 3 directions and 2 cycles 5. Offsets are [pitch, yaw] = [0,0], [−0x800,0], [0,−0x800], [+0x800,0], [0,+0x800] (tables 0x68168 / 0x6817c).
- Sound (`FUN_00029830`): 4 channels; a new sound cuts the old one on its channel. Volume is fixed (0x3f). Pan comes from the camera-space x in 1/64 tiles, clamped to ±63: left = 32 − x/2, right = 32 + x/2.
  - A shot plays the def's `%SFX` first line (+0x21c) at the shooter on channel 3. Only three bosses have one (`laser-21`, `laser-47`, `fire-83`); every other enemy fires silently.
  - `FUN_000191d0` plays `whiz3.wav` (channel 2), or `missile.wav` (channel 3) for type 17, once per shot, the first time it closes on the player inside 16/16 = 1 tile.
- In a tunnel every shot is tested against the wall before it moves (`FUN_00039820`) and dies there with a small impact; there is no ground test. Outside, a shot that ends a substep under the ground (or over the cave ceiling) dies with the same impact at where it was (`FUN_00019860(pos, 60000, 1, 2)`; an enemy missile, type 17, gets `(pos, 0x10000, 1, 1)`). The port uses the ship's wall test with no margin and has no cave-ceiling test.

### 9.u Player guns (`FUN_0001bab0` → `FUN_0001b6d0`) [O]
- Fire: Space (scancode 0x39, `DAT_00064dc8`) or button 1 (`DAT_0007cf40`). It needs shields > 0 and is blocked while typing a network message (`DAT_00068a24`, key T).
- Clock `DAT_000ad944`: while fire is held it gains dt · rate (`0x67a20`, shots per game second); above 0x10000 it fires once and loses 0x10000. While fire is up it is set to 0x10000, so a press fires on its first frame. Holding the afterburner swaps the weapon for 0x16, so the guns are silent then.
- Weapons: `DAT_000ad970`, ammo `a7a10[w·2]` (−1 = infinite), mode `a7a14[w·2]` (1, 2 or 4 bolts). A new game (`FUN_000401a0(1)`) zeroes every ammo, sets every mode to 1 and gives weapon 1 with ammo −1. Keys 1–3 pick weapons 1–3 and 4–7 pick 0x12–0x15, if they have ammo.
- Tables (int32 per weapon):

  | weapon | 0 | 1 | 2 | 3 | 4–7 | 18–20 | 21, 22 |
  |---|---|---|---|---|---|---|---|
  | rate `0x67a20` | 0 | 6 | 6 | 6 | 0 | 2 | 6 |
  | speed `0x67934` | 0x400000 | 0x200000 | 0x180000 | 0x400000 | 0x200000 | | |
  | damage `0x6797c` | 0x1000 | 0x1000 | 0x2000 | 0x1000 | 0x4000 | | |
  | model `0x678ec` | laser | laser3 | laser4 | laser5 | laser6–9 | | |
  | HUD `0x67a7c` | | PAC | ION | RTL | | MAM SAD SWT | DAM FLY |

  Long names (`0x67890`): Purple Laser, Plasma, Antimatter, Laser Beam, Fire Ball, Green, Red and Blue Laser, …, Missile, Guided Missile, Super Missile, Smart Bomb, Afterburner.
- Shot speed = |ship velocity| + the table value, in units per game second (Plasma: your speed + 2 tiles/s).
- Weapon 1 (`FUN_0001ac30`): the ship matrix columns are right, up and forward, 0x10000 = 1/16 tile. The muzzle starts one frame of travel back (the update runs next), then + F/2 − U/4 (1/32 ahead, 1/64 down). Mode 1 alternates ± R/2 (1/32 to the side), the right first (`DAT_00067af8`); mode 2 fires both; mode 4 fires from four corners. One `laser2.wav` on channel 1 at the ship per call. Weapons 0 and 3 use `FUN_0001a870`, and 2 and 4–6 use a spread fan (`FUN_0001b050`); weapon 0 plays `laser.wav`, 2–7 `laser3`–`laser8.wav`.
- The shot record (`FUN_00019070`, player pool slots 0–127) keeps the ship's angles and flies along its nose; lifetime 2 game seconds. Weapons 2, 4 and 9–16 are drawn as billboards instead. The player's shots skip the whizz sound and test enemies (`FUN_00029290`) instead of the player. No muzzle flash.
- Modes (`FUN_0001ac30` Plasma, `FUN_0001a870` Laser Beam): mode 1 alternates ± R/2, mode 2 fires both, mode 4 the four corners ± R/2 ± U/2. Plasma drops U/4 except in mode 4; Laser Beam never does. `FUN_0001a870` halves the frame of travel back when `DAT_00064ce8` is set, `FUN_0001ac30` skips it.
- Antimatter (`FUN_0001b050`): mode-many shots per call, each with the next of five [pitch, yaw] offsets (tables 0x67b14 / 0x67b00, cycled by `DAT_00067afc`): up, left, straight, right, down, 0x800 apart. From + F/2 − U/2; the sideways term multiplies R/2 by the raw −1/0/1 of 0x67b28 and comes out as 0. Its `laser4` bolts are billboards.
- Ammo (`FUN_0001b6d0`): an empty weapon falls back to 1. Each call uses one round of the weapon that was selected; at 0 a weapon in mode 2 or 4 drops to mode 1 with ammo −1, anything else switches to weapon 1.
- Pickups (`FUN_0003fe70`, by `.pup` type): 0 RTL (first: ammo −1, mode 1; later: mode ×2 up to 4, ammo +100), 1 PAC (same), 2 ION +100, 3 MAM +40, 4 SAD +20, 5 SWT +20, 6 shields full (only below 60000), 7 invisibility and 8 invincibility for 30 s (0x1e0000), 9 DAM (one, only if none), 10 afterburner fuel +120.
- Missiles (`FUN_0001b490` → `FUN_0001a0c0`): weapons 0x12/0x13/0x14 deal 0x4000/0x8000/0x10000 (the decompile shows the value as the first argument of `FUN_0001b400`; it goes to record +0). Launch point: a frame of 2 tiles/s travel back, + F/2 ± R (alternating, the right first, `DAT_00067b40`) − U; the ship's angles; speed = |ship velocity| + 1 unit. `missile.wav` on channel 2. 16 slots of 0x34 bytes; when full, slot 0 is reused. Model `bradmis.bin`.
- Lock-on (`FUN_0001b400`, 0x13 and 0x14 only): from `DAT_00067b3c` round robin through the slots, the first one that ran this frame (+0x84), isn't in state 301 and is in the draw window; the search start moves past it. −1 if none.
- Missile flight (`FUN_0001a190`, 4 substeps a frame): hit test (`FUN_00029290`), then in a tunnel the wall (`FUN_00039820`, impact `(pos, 0x10000, 1, 1)`), then a locked missile points straight at its target (`FUN_00029050`, no turn rate; the lock drops when the target dies), speed += dt · 1 tile/s per substep up to 4 tiles/s (+0x2c), move by dt/4. Under the ground or over the cave ceiling it dies with `(old pos, 0x10000, 1, 1)`. Life 3 game seconds (+4), then it just vanishes. A smoke puff (`FUN_0001c5a0(pos, 0x10000)`) every 0x4000.
- Smart bomb (`FUN_0001b600`): `FUN_00029290(centre, 0x10000)` for every slot that ran this frame, then `FUN_0002edf0(2)`: an eighth-second flash in entry 2 of the flash table 0x682e4 (palette 31; hits use entry 0, palette 144). It also sets the shields to 0xffff.
- Hit test (`FUN_00029290` → `FUN_000290d0`): the first alive slot that ran this frame and holds the point takes the damage. If def `;NewHit` count (+0x1b4) > 0 and the state isn't 100, it tests cubes of half-size +0x1d8[i] around vertex +0x1b8[i] turned by the body angles (`FUN_000245e0`); the loader's sscanf stores vertices 4–8 all in the fourth slot. Otherwise an unturned box around the position: half sizes +0x9c..+0xa4, or +0xd0..+0xd8 (the second model) in state 301. `FUN_00022df0` fills them from the model bounds (`FUN_000405b0`: min, max, …, radius, max |x|, |y|, |z|): max |x|, |y|, |z| for logics 0, 9, 0xc–0xe, 0x16–0x1a, 0x21–0x25, 0x29, 0x2a; max x, y, z for logic 6; the bounding radius on every axis for the rest.
- A hit that doesn't kill: `FUN_0001c8a0` → impact `(pos, 60000, 1, 2)`, and `FUN_00028fe0`: unless logic 0x21, with probability 0x2001/0x8000 (always on Debris: Overkill) one piece of debris, any direction for logics 2, 4, 7, upward for the rest. A kill goes to `FUN_00028e50`.
- Slots: every placed `.def` row with strength > 0 is a slot, buildings and trees included (`FUN_000230a0`); `FUN_00022f20` sets slot [9] = strength [7] and [8] = 1. The draw (`FUN_00029370`) uses def +4 (the first-named model) while [8] = 1 and def +0 (the second) when 0. `FUN_00022df0` fills +0x74.. from the def +4 model's bounds and +0xa8.. from the def +0 model's, so +0x9c is the main box and +0xd0 the wreck's. Only slots with strength > 0 run, draw or get hit.
- Kill (`FUN_00028e50`): first `FUN_00024e50`, an impact at pos + model bounds +0x8c ([I] taken as the middle of the bounds) sized the def radius: in a tunnel type 1 flag 1; logics 0, 1, 3, 9, 10, 11, 0xe, 0xf, 0x13–0x15 type 0 (ground, `bigex`) flag 1; 0x21 type 3 (`billow`) at half the radius, flag 0; the rest type 1 flag 1. Then by the state before: 100 → 101 and 300 → 301, each with [7] = [9] = 2·[9]; logic 8 splits (`FUN_00028b60`); logic 0xc plays `scream1.wav`; logic 0x13 becomes the first def with logic 0x14, state 301, [7] = 2·[9]; logics 2, 4, 7 go to state 600 with [7] = 2·[9] on `rand ≤ 0x3ffe` if they were in 201, else `rand ≤ 0x1ffe`. Last `FUN_00028d90`: unless state 301 with [7] ≤ 0, def +0xe8 percent chance (`rand·100/0x7fff ≤ %`) of power-up +0xec (−1: `rand·12/0x7fff`) via `FUN_000401f0` (at pos, on the surface at least ground + 2 model radii; 99 at most).
- Logic 9 (dispatcher): state 300 with [8] = 1 until wrecked, then 301 with [8] = 0. Logic 0x21 (trees): state 0 → 100, [0x1c] = 0; in 101 [0x1c] += dt, [7] = 0xfffff, past 0x8000 [7] = 0 (gone, no blast).
- State 600 (`FUN_00024f80`, from the logic 2, 4, 7/8 movers): pitch += dt/4 capped at 0x1fff, roll += dt/2, moves at def speed + [0x1d]; under the ground [7] = 0 and `FUN_00024e50`; [0x1a] += 2·dt, past 0x10000 a smoke puff of half the radius. Outside the window (`FUN_000241c0`) a slot in 600 just dies.
- Ramming (`FUN_00012740`): every frame `FUN_00029290(ship pos, dt·0x2000)`; if it hit and the grace (`DAT_0007cf4c`) is 0, the player takes `FUN_000131d0(0x1000)`. There is no push: the ship flies through buildings and trees.
- Power-ups (`FUN_00040040`): taken when |ship − pos| < the model's bounding radius on every axis (`FUN_0003fe70` may refuse: shields over 60000, a smart bomb already carried); drawn by `FUN_0003fd60` turned by the camera's yaw and pitch (`FUN_0001d220(DAT_0007cfe0, 0, DAT_0007cfdc)`), like the impacts. Each pickup shows its message for a game second (`FUN_0002cbe0`: `R.T.L. (3)`, `P.A.C. (1)`, `I.O.N. (2)`, `M.A.M. (4)`, `S.A.D. (5)`, `S.W.T. (6)`, `Shield Restore`, `Invisibility!`, `Invincibility!`, `D.A.M. (7)`, `Afterburner!`, `Power Core!`) and plays `power-1.wav`.
- In a tunnel the shot, missile and debris test (`FUN_00039820`) adds the wall push (`FUN_00038340`) and the obstacle push (`FUN_00038820(pos, damage)`): doors, fans and fields stop shots as they stop the ship. A destructible barrier (type 2) always pushes and loses 4·damage hp (the ship passes 0x10000); at hp < 1 it becomes type 3 (no push, not drawn) with an impact `(pos, rx << 8, 1, 1)`. `FUN_00038820` has no case for types 0, 1, 3, 0x10 and 0x11: the turning plates (`FUN_000363c0`, `FUN_00036500`, drawn only) let the ship and shots through. [port] They stop shots (0x10 the half v < 0 of the plate's frame, 0x11 all but the quarter u, v > 0); the ship still passes.
- Jaws (0x13/0x14, `FUN_00036ea0`/`FUN_00036fe0`): +0x22c += dt/4, +0x230 = r·2·tri(+0x22c) >> 16 (r = ry0 or rx0); the collision clamps to ±(+0x230) and the draw shifts the camera by ±(+0x230) around `jaw1`/`jaw2.bin`, rolled 0x4000 for 0x13. [I] The port puts each jaw's teeth edge at the opening.
- Port: all seven weapons with keys 1–7, damage, kills, wrecks, burning trees, crash dives, drops, ramming, pickups and tunnel obstacles as above. A flight starts with Plasma alone, as in the original; + and − step PAC or RTL through modes 1, 2, 4 [port]. Not done: the logic-8 split, shields, invisibility, invincibility and afterburner fuel (their pickups only show the message, on the status line). The asteroid's and logic 0x25's own hit tests aren't ported.

### 9.t Impacts, debris and smoke [O]
- Impacts (`FUN_00019860(pos, size, type, flags)`, 16 slots of 0x20 bytes; when full, slot 0 is reused): type 1 is in the air at pos; types 0 and 3 sit on the ground (size × 2) and are the big `bigex%d` / `billow%d` explosions of kills. Type 2 is type 1 with a random rate (rand + 0x4000). Flag 1 throws `rand · 8 / 0x7fff + 2` pieces of debris (double on Overkill); without flag 2 it plays `exp1`–`exp5.wav` (`FUN_000197f0`, `rand · 5 / 0x7fff`, channel 0); flag 2 doubles the rate.
- Drawn by `FUN_0001a030` → `FUN_00019a30` (type 1/2): phase += rate · dt; frame = phase >> 12, `blast1`–`blast16.raw`, on a square facing the camera (camera yaw and pitch, no roll) with corners ± size/0x100 in the model space. [I] That is taken as ± size in world units (60000 ≈ 0.057 tile), since kills pass the def radius as the size. So 1 s at rate 1 and ½ s at rate 2.
- Ground types (`FUN_00019e00` type 0, `FUN_00019c40` type 3; the type → routine pairing [I], from the names): at ground height under pos with the size doubled. `bigex%d`: frame = phase / 0x1800 (1.5 s), corners x ± size/0x200, y 0 … size/0x100. `billow%d`: frame = phase >> 12, x ± size/0x100, y −size/0x200 … 1.5·size/0x100. By their UV tables both put the image's first row at the top, while `blast` puts it at the bottom.
- Debris (`FUN_0001c0b0`, 32 slots of 0x40 bytes, reused in turn, only when Debris isn't Off, `DAT_00064e48`): heading `rand · 2`, climb `rand/4 + 0x2000` (upward) or `rand − 0x4000` (any), speed 1000000 units/s (0.95 tiles/s), gravity −0x100000 (1 tile/s²), spin `rand · 4 − 0x10000` per axis per second, life 3 game seconds, model `frag1`–`frag3` / `pipe.bin` by `rand · 4 / 0x7fff`. Moved by `FUN_0001c470`; `FUN_0001c220` bounces it off the ground (v −= 2 (v·n) n, `FUN_0003e3b0` normal), pushes it out of tunnel walls (`FUN_00038f00`) and drops it when the camera is above the cloud deck and it is below. [I] The port reverses it at tunnel walls.
- Smoke (`FUN_0001c5a0`, 8 slots, none when full): 0x8000 (½ s), frame = (0x8000 − life) >> 13 of `puff1`–`puff4.raw`, a square ± size like the impacts, drawn by `FUN_0001c610` through `FUN_00016f30` (the impacts use `FUN_00016510`; the difference isn't traced).
- Order each frame (`FUN_0001c020`): shots, impacts, missiles, `FUN_0001bee0` (another pool, 64 × 0x38, `fireball.bin` billboards that hurt the player, not ported), debris, smoke.

### 9.u Flight sounds [O]
- Flyby (`FUN_00025e40`, after the move in dispatcher cases 2, 4, 7, 8, 0x26, 0x27 only): `FUN_00025de0` stores the 3D distance to the player in slot `[0x1f]` every frame. When it crosses from over 0x200000 (2 tiles) to under it in one frame, and `(enemy yaw − player yaw) & 0xffff` is strictly between 0x6000 and 0xa000 (head on, 135–225°), it plays `flyby56/60/80/81.wav` (`rand >> 13`) on channel 3 at the enemy. The samples play at their own rate; there is no pitch change.
- The same four flybys play when a logic-8 fighter is hit and splits into two `half.bin` pieces (`FUN_00028b60`). `scream1.wav` plays when a logic-0xc unit is killed (`FUN_00028e50`); it is ported, the split isn't.
- Ambient (`FUN_00028610`): each frame, with probability `rand > 30000`, it plays the def's second `%SFX` name (+0x230) on channel 3, if the fourth `!NewAtakRet` value (+0x200) is non-zero. That value is 0 in every shipped def, so this never plays. Only the Lava Boss names a sound (`lava-bs3.wav`).
- Player: there is no engine or flight sound.
- Afterburner (`FUN_0001bab0`; weapon 0x16 in `FUN_0001b6d0`): holding the key switches to weapon 0x16 while it has fuel (`DAT_000a7ac0`). The weapon ticks at `DAT_00067a20[0x16]` = 6 per game second, and the first tick comes at once. The first tick plays `blast7.wav` on channel 3 and starts `engine4.wav` looping on channel 1 at the file's rate. Every tick adds 200 Hz to that rate, up to 0x5622 = 22050, and spends one unit of fuel. Letting go cuts the loop and plays `shut-dn7.wav` on channel 3; `FUN_0001cbc0` cuts it silently. [I] Fuel isn't modelled, and the viewer also cuts the loop on pause.
- Other sounds (`FUN_00029730` is channel 3, centred):
  - ground or cave contact: `ground.wav`;
  - a tunnel wall or obstacle push (`FUN_00038f90`): `scrape.wav`, each with 0x800 damage outside the grace;
  - drawn electric fields (`FUN_00037260`, the current segment plus 4 ahead): `electric.wav` once per game second;
  - reaching a boss nav point (`FUN_0003f230`/`FUN_0003f9c0`): `warning.wav` on channel 3, with "Mission Goal Ahead!";
  - ground missile launch (`FUN_000278a0`): `missile.wav` on channel 2;
  - powerups and cheats: `power-1.wav`;
  - menus: `laser.wav` (Sound Volume, now played: section 10);
  - mission end: `blast4.wav` (`FUN_0004a1f0`);
  - network taunts: `tri%d.wav`.
- Not ported: mission end and network taunts. Kills sound through their impact (`exp1`–`exp5.wav`); hits that don't kill, and shots ending on the ground or a wall, are silent (flag 2).

## 10. Front end (`src/menu.js`) [O]

- **Boot** (`0x1f7b0`): `title.raw` for 0x480000 timer units (4 game seconds) or a key (`FUN_0002b040`), then the menu loop `0x31d70`. The loop plays `music/sex.mod` on entry and again whenever an activity returns with other music playing.
- **Menus** are functions picked by `DAT_000e3500` through the jump table at `0x31cb8`:
  1. main `0x30980`;
  2. options `FUN_00030b20`;
  3. sound `FUN_00030d90`;
  4. graphics `FUN_00031240`;
  5. control `FUN_00031590`;
  6. quit `FUN_000317c0`;
  7. play `FUN_00031880`;
  8. mouse `FUN_00031a80`.
  `DAT_000e350c` is the cursor. Up and Down wrap, Enter chooses, and Esc goes to the parent with the cursor at 0. Esc in the main menu opens Quit.
- **Drawing** (`FUN_00030700`): every menu sits over `title.raw`.
  - A box (`FUN_00030590`) mixes the picture 50/50 with palette 8 through `vga.mix`. It has a 25-row title band in palette 100, a rule and a frame in palette 0x10.
  - Lines use the 23 px `startup/font.bin` (`FUN_00013c10`): a 3×3 black outline, then each pixel v becomes palette v>>3 for the chosen line and v>>4 for the others. Lines are 0x17 apart, centred.
  - The footer "Terminal Velocity (c) 1995 Terminal Reality, Inc." is the small font, centred at y = 190.
- **Small font**, the GAME.EXE status font at 0x65770, has three modes:
  - opaque `FUN_00013aa0`: palette v including 0, plus a black column;
  - plain `FUN_00014d40`: palette v;
  - lit `FUN_00014c90`: palette 0x20 + v.
  A glyph starting off screen, or within 8 px of the right or bottom edge, is skipped without advancing.
- **Main menu:** Play Game, Options, Instructions, Scores/Credits, Ordering Info, Quit.
  - **Play Game:** New Game, Restore Game, plus Resume Game while a game is running; Resume is preselected then.
  - **Instructions / Ordering Info** (`FUN_0002c480`): `savesc.raw` with the 256×108 `help%d.raw` / `order%d.raw` at (0x22, 0x1e), pages 1–7. PgUp/Left and PgDn/Right turn pages; Esc leaves. F1 in the menu opens the help too.
  - **Scores/Credits:** first `FUN_0002f140`, the Top Aces table on `savesc.raw` for 30 game seconds or a key. Without `score.dat` it holds the defaults from `FUN_0002ee70`. Then `FUN_0002b4c0`: the 54 lines from 0x681e4 roll over `vel2.raw` one pixel per 1/8 game second.
    - Left makes the roll faster and Right slower, in steps of 0x800.
    - Each line is 16 px. An "i" prefix means lit; "^" splits a name at x = 40 from a quoted call sign at x = 200.
    - Rows 0–7 and 192–199 keep the picture.
    - The roll ends at y < −0x360 or on Esc.
- **New Game** (`0x2e640`) runs these screens:
  1. **Select Mission** (`FUN_0002e060`): without `mission.ini`, the three hard-coded episodes from `share.vox`, `retail1.vox` and `retail2.vox`.
  2. **Select Difficulty Level** (`FUN_0002e3d0`): Easy, Normal, Hard, Terminal, with the cursor starting on Normal.
  3. **Name and call sign** (`FUN_0004b750`): on `brief.raw`, `ship.bin` turns in the window (0x50,0x16)–(0xef,99) (`FUN_0004b5e0`), pitched 0x1000 and turning 1/8 of a circle per game second.
     - Each field takes up to 9 characters; empty fields become "John Doe" / "Ice Man".
     - Name "Terminal" with call sign "Reality" starts `geiger.vox`.
  - A `.vox` file holds a count, a title, then "planet,stage,file.lvl" lines. Play starts with the first one.
- **Restore Game** (`FUN_0002dbe0`): eight slots read from `save%d.dat`.
- **Esc in flight** (`FUN_0002cdd0`) asks "Return to Menu (Y/N)" in the big font. Y keeps the game for Resume Game (`DAT_00064e14`).
- **Starting a level** shows "Loading level" in the big font at y = 88 (`FUN_0002b900`).
- **Level start** (`FUN_0002cdd0`, in `src/viewer.js` `levelIntro`). The level's music starts with the level (`FUN_00033070`). Then, only when the level's briefing file (`.lvl` line 2) differs from the last level's, so only on a planet's first stage:
  1. **Story** (Cinemas, `FUN_0004bbf0` → `FUN_0004b930`): the fourth story name (`+0x320`, e.g. `intro.mic` on artic) typed one character a frame in the plain small font from (8, 8) over `vel2.raw`. The picture is dimmed by `FUN_0004b880`: each colour's 6-bit channels shifted right 4 and matched through the 5-bit colour cube. Ends after 0x2d0000 (45 game seconds) or on Esc, Enter or fire.
  2. **Briefing** (Level Briefings, `FUN_0004a130` → `FUN_0004aef0`), unless the file is `null.txt`:
     - `brief.raw`; `data/<planet>.txt` starts with a model and a texture name (`globe.bin`, `mark32.raw`; `aliensh.bin` is swapped for `aliensh1.bin`, `null.raw` means no texture).
     - The model sits at rest in the window (0x50,0x16)–(0xef,99) over the star field (`FUN_00018420`, 2000 stars from `FUN_00017b40`). The eye circles it at its corner radius (`FUN_000405b0` field 9), 1/16 turn per game second, zoom 1. The light is (0, −0xb4fd, 0xb4fd) and **stays so for the rest of the level** until a tunnel exit (`FUN_00042b20`).
     - The text scrolls up one pixel every 0x2801 in rows 148–180, x 0x3e–0xfe (`FUN_0004ae60`). Every 8 pixels a line is read (`fgets`, 0x50) and drawn lit at (0x3e, 0xac). `$` and the rest of its line become the call sign (`FUN_0004aeb0`). A line starting "." (or running past the file size) ends the text, then 32 more pixels of scroll. Esc, F1 or Space end it.
  3. **Tactical report** (`FUN_00049cb0`), for each def with the first value of def line 3 (`+0xe0`) set, in def order, at its first placement row: `brief.raw` again. The level runs in the window (`DAT_00064d40` set: shots don't hit). The eye circles the object at twice the def radius (`+0x98`), a quarter turn per game second, one radius above the ground or the object, whichever is higher, looking down at it; zoom 0x8000. The description (`+0xf0`) is typed lit from (0x3e, 0x94), one character a frame; a word wraps when `word × 7 + x` passes `320 − 0x3e`. Next after two circles (0x20000) with the text out, or on Space; Esc or F1 end the report.
  4. **Videos** (Cinemas, `FUN_0004bb20`): the third, then the first story name (`.tvi`).
- **Fly-in** (Cinemas, surface levels, every level, `FUN_0004a690`): the eye starts over the spawn at ground + half the deck height (`0x67888 / 2`), looking straight down (pitch 0x3fff), turns a quarter circle per game second and sinks a tile per game second until it is within 1/16 tile of the ship. The level runs meanwhile; Esc, F1 or Space end it. No HUD is drawn. It runs in outside view (`DAT_00064ce8 = 2`), so `FUN_00012fe0` draws the player's model (`DAT_0007cf50`, ship.bin) at the ship, turned by its angles; the ship is not moved and casts no shadow (`FUN_00013500` and `FUN_000125e0` aren't called).
- **Shadows** (`FUN_0001edd0`, setting `DAT_00064dc0`: 0 Off, 1 486, 2 Pentium; not in tunnels; at most 0x40 a frame): from the object a ray steps along the light vector (`DAT_0007d020`, 1/16 tile a step, at most 256 steps) until it is under the ground, steps back by that depth along the vector, and `FUN_0001ea80` lays a square of side `size` there, corners at ground height, triangles 0-1-2 and 0-3-2, texture 4..251 of 256. Texel 0 is skipped, texel 1 is shadow. 486: `shadow.raw` (a disc), written as palette 1 (`LAB_00048234`). Pentium: `FUN_0001e920` first draws the model's silhouette into the texture from straight above (pitch 0x3fff, yaw 0, the eye `size` over the model, 64x64 at focal 32, so the texture spans twice the square), and texel 1 goes through the mix table 0x82974 with the screen pixel: the average of palette 1 and it, unless either is black (`LAB_000484d9`). Casters: slots that ran this frame with def logic 2, 4, 7, 8, 0x11, 0x12, 0x26 or 0x27, size the def radius (`FUN_000241c0`, also in the report); the player in the main loop, size 1/16 tile (`FUN_00013500`). Port: both modes [I: the mix is a plain half blend; none in caves]; the default is Pentium [port] (vox.ini ships `airShadowFlag` 0).
- **Projection of the 3D windows** (`FUN_00014910`, `FUN_0001cd00`): half the window height rounded down to even, less one (37), is the vertical focal length, 4/3 of it the horizontal. The zoom `0x64cd0` divides depth: 0x8000 doubles the size (name screen and tactical report), 0x10000 (briefing model).
- **Name screen** ship (`FUN_0004b5e0`): at the origin, the eye 1.5 corner radii back, over the star field, zoom 0x8000.
- **Palette**: in a level the screens use the level's palette. Art is matched from VGA to its entries 0..0xef when the two differ (`DAT_00095d24`, `DAT_00067770`).
- **Settings** default to the shipped `VOX.INI` and are kept in localStorage.
  - Wired: Sound F/X, Music, both volumes (0x4000 steps, wrapping 100 → 25 %), and Difficulty.
  - Briefings and Cinemas switch the level-start screens.
  - Kept but not used yet: Demos, Sky, Debris, control and mouse settings, Auto Leveling.
  - Left out of the menus: Music Freq, Playback, Image Quality, Texture and Resolution (one quality is always used).
- **[I] differences:**
  - The attract demos (`demo1-3.dmo` after 30 idle game seconds, then every 15) are not played.
  - Not built: Calibrate and the three Customize screens; the end-of-level screens (`FUN_0004bbb0` leave video, `FUN_0004bc30` story over `planet.raw`).
  - The `.tvi` videos are not played: they are not in the PODs.
  - The story and report type at fixed rates (70 and 24 characters per game second); the original types one per drawn frame.
  - Keys act on a press. The original polls held keys, so a key held from one screen can also end the next; here Esc in the briefing skips the report outright and Space goes on to it.
  - A click or tap ends the fly-in and takes the mouse.
  - There are no save games, so every Restore slot is empty and choosing one does nothing.
  - Quit → Yes returns to the title.
  - Without the `.vox` files, built-in copies of the shipped lists are used.
  - Without GAME.EXE, a 5×7 stand-in font is used.
  - Taps choose menu lines; anywhere else counts as Enter.
  - The Esc prompt is drawn a quarter of the way down the screen.
