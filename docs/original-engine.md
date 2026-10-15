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
- `.nav` records: type, `x,y,z`, description, then per type — 0: count + target object indices (position taken from the first object); 1: tunnel `.lvl` + one line; 4: two lines; 5: int, music, line, optional `!` list (boss); 6: `pitch,roll,yaw`. Waypoint y = max(file y, ground).

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
- Morph (0x20): +8 nframes (≤16), +0xC ticks/key, +0x18 16×16-byte key names; Catmull-Rom; face planes recomputed.

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
