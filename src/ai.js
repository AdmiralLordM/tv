// Enemy and NPC behaviour, ported from GAME.EXE's enemy loop (FUN_000241c0)
// and its per-logic dispatcher (FUN_00028610). docs/original-engine.md §9
// lists the routines. Everything here is in tiles, radians and real seconds,
// in the game's left-handed frame: yaw 0 faces +Z and turns toward +X,
// positive pitch is nose down, forward = (sin yaw cos pitch, -sin pitch,
// cos yaw cos pitch).
//
// Every .def object is a slot here, buildings and trees too. The player's
// shots, missiles (launch), smart bomb (bomb) and ship (ram) wear down a
// slot's strength; at 0 it dies (kill). Enemy shots hit the player through
// hitPlayer. Power-ups (addPickup) are picked up by flying into them.
import * as THREE from "three";

const TILE = 1048576;
const TURN = 65536; // angle units per turn, also 16.16 one
const TAU = Math.PI * 2;
const GAME_SECOND = 0.98864;
const MAP = 256;
const TOP = 255 / 32; // DAT_00067888, half the flight ceiling
const WINDOW = 5; // FUN_0001e500: enemies further than 5 tiles are frozen
const LEAD = 0.5; // fighters aim 8 x the 16.16 forward ahead of you
const NEAR_FIRE = 1.25; // _DAT_000614f3/_0006150b/_00061555
const FAR_FIRE = 2.5; // _DAT_0006153d/_000615f8
const ENGAGE = 5; // _DAT_000614df/_00061529/_000615dc/_000615fc
const MAX_ENEMIES = 500;
// [I] Per-frame dice rolls (helicopter take-off, missile launch) are scaled as
// if the original ran at this many frames per second.
const ORIGINAL_FPS = 20;
// [I] The bank is set from one frame's yaw step, so it depends on frame time.
const BANK_FRAME = 1 / ORIGINAL_FPS;
// FUN_00018dc0 loads these projectile models; a def's `shot` indexes them.
export const SHOT_MODELS = [
  "laser", "laser3", "laser4", "laser5", "laser6", "laser7", "laser8", "laser9", "bullet",
  "wboss1", "wboss2", "wboss3", "wboss4", "wboss5", "wboss6", "wboss7", "wboss8", "missile",
];
const SHOT_LIFE = 2; // FUN_00019070: 0x20000 game seconds
// FUN_00024700 spread: [pitch, yaw] added per shot, cycled (tables at 0x68168, 0x6817c).
const SPREAD = [[0, 0], [-0x800, 0], [0, -0x800], [0x800, 0], [0, 0x800]];
const SPREAD_CYCLE = [1, 3, 5]; // by def spread 0, 1, 2
// FUN_000191d0: a shot whizzes once, the first time it closes inside 1 tile (16/16).
const WHIZ = 1;
const SHOT_HIT = 1 / 16; // FUN_000133b0: within 0x10000 on every axis
const SHOT_STEPS = 8; // FUN_00019330 moves and tests a shot in 8 substeps
// FUN_000191d0 draws these models facing the camera instead of along the shot.
const BILLBOARD_SHOTS = new Set([2, 4, 9, 10, 11, 12, 13, 14, 15, 16]);
const ENEMY_MISSILE = 17;

// Hit boxes (FUN_00022df0, tested by FUN_000290d0): an unturned box around
// the actor. These logics use the model's largest |x|, |y|, |z|; logic 6 its
// largest x, y, z; the rest a cube of the bounding radius.
const EXTENT_LOGICS = new Set([0, 9, 0xc, 0xd, 0xe, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x21, 0x22, 0x23, 0x24, 0x25, 0x29, 0x2a]);
const WRECK = 301; // a wreck: missiles don't lock on (its hit box is the wreck model's)
const HIT_POINT_OFF = 100; // state in which ;NewHit points are ignored
const STANDING = 300; // logic 9 before it is wrecked
const BURNING = 101; // a tree after its kill (state 100 -> 101)
const CRASH = 600; // a flier going down in smoke (FUN_00024f80)

// Kills (FUN_00028e50 -> FUN_00024e50). The blast goes off at the model's
// centre, as big as its bounding radius: these logics on the ground
// (bigex), trees in flames (billow, half the radius, no debris), the rest
// in the air (blast); in a tunnel always in the air.
const GROUND_KILLS = new Set([0, 1, 3, 9, 10, 11, 0xe, 0xf, 0x13, 0x14, 0x15]);
const TREE = 0x21;
// These may go down burning instead: half the time when killed breaking
// off (201), a quarter otherwise. They fall nose down, rolling, smoking,
// and blow up on the ground.
const CRASHERS = new Set([2, 4, 7]);
const BURN_TIME = 0.5; // a burning tree stands for 0x8000
const RAM = 0x2000; // FUN_00012740: damage per game second to what the ship is inside
const PICKUP_SLOTS = 99; // FUN_000401f0

// Impacts (FUN_00019860, drawn by FUN_00019a30): blast1-16.raw on a square
// facing the camera, half as wide as `size`, one frame per 1/16 of the phase.
// The phase grows 1 per game second, 2 with flag 2. Flag 1 throws debris,
// flag 2 is silent (otherwise exp1-5.wav). 16 slots; when all are busy the
// first is reused (here the oldest).
const IMPACT_SLOTS = 16;
const IMPACT_FRAMES = 16;
const IMPACT_SHOT = 60000 / TILE; // a shot ending on the ground, a wall or an enemy
const IMPACT_MISSILE = 0x10000 / TILE; // a missile on the ground or a wall
const IMPACT_DEBRIS = 1;
const IMPACT_QUICK = 2;
// Impact types: 1 in the air (blast), 0 on the ground (bigex, frames
// phase / 0x1800 so it lasts 1.5 game seconds), 3 on the ground (billow).
// Ground ones sit at ground height and are twice the size given.
const IMPACT_AIR = 1;
const IMPACT_GROUND = 0;
const IMPACT_FIRE = 3;
const IMPACT_KINDS = { [IMPACT_AIR]: "blast", [IMPACT_GROUND]: "bigex", [IMPACT_FIRE]: "billow" };
const IMPACT_PACE = { [IMPACT_AIR]: 16, [IMPACT_GROUND]: 0x10000 / 0x1800, [IMPACT_FIRE]: 16 }; // frames per unit of phase
const EXPLOSIONS = ["exp1.wav", "exp2.wav", "exp3.wav", "exp4.wav", "exp5.wav"]; // FUN_000197f0, (rand * 5) / 0x7fff

// Debris (FUN_0001c0b0, moved by FUN_0001c470): one of frag1-3.bin or
// pipe.bin thrown at 1000000 units per second (0.95 tiles/s), falling at
// 1 tile/s^2, spinning up to a turn a second per axis, for 3 game seconds.
// It bounces off the ground. 32 slots, reused in turn.
const DEBRIS_SLOTS = 32;
const DEBRIS_SPEED = 1000000 / TILE;
const DEBRIS_FALL = 1;
const DEBRIS_LIFE = 3;
export const DEBRIS_MODELS = ["frag1", "frag2", "frag3", "pipe"];

// The player's missiles (FUN_0001a0c0, moved by FUN_0001a190): bradmis.bin,
// from the ship's speed up to 4 tiles/s, gaining 1 tile/s every substep
// (4 a frame), for 3 game seconds, smoking every quarter second. 16 slots.
const MISSILE_SLOTS = 16;
const MISSILE_STEPS = 4;
const MISSILE_TOP = 4;
const MISSILE_ACCEL = 1;
const MISSILE_LIFE = 3;
const SMOKE_EVERY = 0.25;
// Smoke (FUN_0001c5a0, drawn by FUN_0001c610): puff1-4.raw over half a
// second, 1/8 tile wide. 8 slots; when full, no puff.
const PUFF_SLOTS = 8;
const PUFF_LIFE = 0.5;
const PUFF_SIZE = 0x10000 / TILE;
// FUN_00025e40: one of these screams on channel 3 when a fighter closes
// inside 2 tiles (3D) on a heading 135..225 degrees from yours, i.e. head on.
// Only the dispatcher cases that call it: 2, 4, 7, 8, 0x26, 0x27.
const FLYBY_LOGICS = new Set([2, 4, 7, 8, 0x26, 0x27]);
const FLYBY_RANGE = 2; // 0x200000
const FLYBYS = ["flyby56.wav", "flyby60.wav", "flyby80.wav", "flyby81.wav"]; // rand >> 13

const ATTACK = 200; // fighter states (FUN_00025810)
const BREAK = 201;
const ROLL = 202;
const LOOP = 203;
const CLIMB = 400; // take-off (transport, mothership, helicopter)
const FALL = 500; // asteroid
const LAUNCH = 700; // ground missile
const HOVER = 900; // helicopter gun platform

// Break-off headings per slot & 3: [yaw added to the pitch-to-target, pitch bias].
const BREAK_HEADINGS = [[0x4000, 0x1000], [0x8000, 0x2000], [0xc000, -0x1000], [0, -0x2000]];
const SCATTER_HEADINGS = [0x4000, 0x8000, 0xc000, 0x2000]; // C-Nomes (FUN_00027250)

const FIGHTERS = new Set([7, 8, 0x1d, 0x26, 0x27]);
// FUN_000241c0 counts awake enemies with these logics; the spawner reads it.
const HOSTILES = new Set([1, 2, 4, 7, 8, 10, 11, 14, 0x20, 0x23, 0x26, 0x27]);
// FUN_00023e20: spawn while at most this many hostiles are awake, by
// difficulty (0 Easy, 1 Normal, 2 Hard, 3 Terminal); Easy never spawns.
const SPAWN_LIMITS = [-1, 1, 2, 4];
const SPAWN_RING = 3; // tiles from the player
const TURRETS = new Set([1, 6, 0x16]);

// Every placed .def object is a slot (FUN_000230a0), whether it moves or not.
export const isActor = (spot) => !!spot.def;

const angle = (units) => (units / TURN) * TAU;
const rand = () => Math.floor(Math.random() * 0x8000); // FUN_00050cd3
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const wrapMap = (v) => ((v % MAP) + MAP) % MAP;
const perFrame = (p, dt) => Math.random() < 1 - (1 - p) ** (dt * ORIGINAL_FPS);

function forward(pitch, yaw, out) {
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c, -Math.sin(pitch), Math.cos(yaw) * c);
}

// Half sizes [x, y, z] in tiles of an actor's hit box (EXTENT_LOGICS). A
// wreck's box is always its model's largest |x|, |y|, |z| (+0xd0).
function hitBox(logic, radius, vertices) {
  if (!vertices?.length || !(logic === 6 || EXTENT_LOGICS.has(logic))) return [radius, radius, radius];
  const box = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let i = 0; i < 3; i++) box[i] = Math.max(box[i], logic === 6 ? v[i] : Math.abs(v[i]));
  }
  return box;
}

const tmpDir = new THREE.Vector3();
const tmpPoint = new THREE.Vector3();
const tmpHit = new THREE.Vector3();
const tmpEuler = new THREE.Euler(0, 0, 0, "YXZ");

// [I] The middle of a model's bounds (FUN_000405b0 +0x8c, where kills go off).
function middle(vertices) {
  if (!vertices?.length) return [0, 0, 0];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], v[i]);
      hi[i] = Math.max(hi[i], v[i]);
    }
  }
  return lo.map((l, i) => (l + hi[i]) / 2);
}

// One group of actors in one space: the surface (wraps at 256 tiles, has
// ground) or a tunnel (no wrap, no ground, everything always awake).
export class Crowd {
  // shotModel(type): a fresh Object3D for SHOT_MODELS[type], or null.
  // sound(name, channel, pos): play a .wav from sound/ at a point in this space.
  // groundNormal(x, z): unit Vector3, for debris bounces.
  // fx: { sprite(kind) -> Mesh, frame(mesh, i), model(name) -> Object3D,
  // pickup(type) -> { mesh, radius } } for impacts ("blast", "bigex",
  // "billow"), smoke ("puff"), debris, missiles and dropped power-ups; set
  // by the viewer. pickUp(type) -> true if the player took it (FUN_0003fe70).
  constructor({ parent, tunnel = null, groundAt = null, groundNormal = null, difficulty = 1, shotModel = null, sound = null }) {
    this.shotModel = shotModel;
    this.sound = sound;
    this.fx = null;
    this.parent = parent; // THREE.Group the meshes live in
    this.tunnel = tunnel; // .tnl segments when this is a tunnel
    this.groundAt = groundAt;
    this.groundNormal = groundNormal;
    this.difficulty = difficulty;
    this.resetSpawner();
    this.actors = [];
    this.slots = new Map(); // placement row -> actor, for nav targets
    this.tracers = [];
    this.missiles = [];
    this.impacts = [];
    this.puffs = [];
    this.debris = [];
    this.pickups = [];
    this.awake = []; // the slots that ran this frame, in slot order (DAT_000bd7ac)
    this.pickUp = null;
    this.debrisNext = 0; // DAT_00067b44
    this.lockNext = 0; // DAT_00067b3c: where the next missile lock search starts
    this.spares = new Map(); // sprite meshes by kind, for reuse
    // hitPlayer(damage) -> true if the shot landed (FUN_000133b0 is skipped
    // during the grace after a hit), set by the viewer.
    this.hitPlayer = null;
    // inWall(pos, damage) -> true if a point is outside the tunnel or in an
    // obstacle, which takes the damage (FUN_00039820),
    // set by the viewer for tunnel crowds.
    this.inWall = null;
    this.tracerGeometry = new THREE.BoxGeometry(0.004, 0.004, 0.08);
    this.tracerMaterial = new THREE.MeshBasicMaterial({ color: 0xffd060, fog: false });
  }

  // mesh: a placed model (position/rotation already set). radius: model
  // bounding radius in tiles. vertices: model vertices in tiles (muzzles).
  // wreck: { mesh, vertices } shown from state 301 (the def's second model,
  // or for a C-Nome the model of its def.remains).
  add(mesh, spot, radius, vertices = null, wreck = null) {
    const def = spot.def;
    def.homeLogic ??= def.logic; // the mothership rewrites its def's logic
    // FUN_00022f20: speed and turn bias from the placement row, phase timers random.
    const bias = ((spot.slot << 30) | 0) >> 16;
    const actor = {
      mesh, def, radius, vertices, slot: spot.slot,
      home: { pos: mesh.position.clone(), pitch: spot.pitch || 0, roll: spot.roll || 0, yaw: spot.yaw || 0 },
      bias,
      homeDef: def,
      homeMesh: mesh,
      homeBox: hitBox(def.homeLogic, radius, vertices),
      homeStrength: spot.strength ?? 1, // placement row strength, slot [7]
      middle: middle(vertices),
      wreck: wreck && { ...wreck, box: hitBox(9, 0, wreck.vertices) },
    };
    if (actor.wreck) {
      actor.wreck.mesh.visible = false;
      if (!actor.wreck.mesh.parent) this.parent.add(actor.wreck.mesh);
    }
    this.reset(actor);
    this.actors.push(actor);
    if (!this.slots.has(spot.slot)) this.slots.set(spot.slot, actor);
    return actor;
  }

  reset(actor) {
    actor.def = actor.homeDef;
    if (actor.mesh !== actor.homeMesh) actor.mesh.visible = false;
    actor.mesh = actor.homeMesh;
    actor.box = actor.homeBox;
    actor.strength = actor.homeStrength;
    actor.full = actor.strength; // slot [9]: what a state change doubles
    actor.smoke = 0; // slot 0x1a while crashing
    actor.pos = actor.home.pos.clone();
    actor.pitch = actor.home.pitch;
    actor.roll = actor.home.roll;
    actor.yaw = actor.home.yaw;
    actor.aimPitch = actor.pitch;
    actor.aimYaw = actor.yaw;
    actor.gunPitch = actor.pitch; // slot 0x16/0x18: a gun aimed apart from the body
    actor.gunYaw = actor.yaw;
    actor.state = 0;
    actor.alive = true;
    actor.fireClock = rand() / TURN;
    actor.dice = rand() / TURN;
    actor.timer = rand() / TURN;
    actor.spin = angle(rand()); // drill roll rate per second
    actor.base = actor.pos.y;
    actor.child = null;
    actor.spreadStep = 0; // slot 0x2b
    actor.range = 0; // slot 0x1f: distance to the player last frame
    actor.mesh.visible = true;
  }

  resetAll() {
    this.actors = this.actors.filter((a) => !a.spawned);
    for (const child of [...this.parent.children]) {
      if (child.userData.spawned || child.userData.tracer) this.parent.remove(child);
    }
    this.tracers = [];
    this.pickups = this.pickups.filter((p) => !p.dropped || this.drop(p));
    for (const p of this.pickups) p.taken = false;
    this.awake = [];
    for (const list of [this.missiles, this.impacts, this.puffs, this.debris]) {
      for (const item of list) this.drop(item);
    }
    this.missiles = [];
    this.impacts = [];
    this.puffs = [];
    this.debris = [];
    this.resetSpawner();
    for (const actor of this.actors) {
      actor.homeDef.logic = actor.homeDef.homeLogic;
      this.reset(actor);
    }
  }

  // FUN_000230a0: the first spawn waits 5 x 4 s on Easy/Normal, 3 x 4 s above.
  // DAT_00068164 (whose turn) is never reset in the original; here per level.
  resetSpawner() {
    this.spawnClock = this.difficulty < 2 ? -4 : -2;
    this.spawnTurn = 0;
  }

  // ---------------------------------------------------------------- geometry

  delta(from, to) {
    if (this.tunnel) return to - from;
    let d = wrapMap(to - from);
    if (d > MAP / 2) d -= MAP;
    return d;
  }

  ground(x, z) {
    return this.groundAt && !this.tunnel ? this.groundAt(x, z) : -Infinity;
  }

  // Aim from the actor at a point: yaw = atan2(dx, dz), pitch = -atan2(dy, dh).
  aimAt(a, p) {
    const dx = this.delta(a.pos.x, p.x);
    const dz = this.delta(a.pos.z, p.z);
    const dh = Math.hypot(dx, dz);
    return { yaw: Math.atan2(dx, dz), pitch: -Math.atan2(p.y - a.pos.y, dh), dh, dx, dz };
  }

  distance(a, p) {
    return Math.hypot(this.delta(a.pos.x, p.x), p.y - a.pos.y, this.delta(a.pos.z, p.z));
  }

  // ---------------------------------------------------------------- frame

  // dt real seconds. player: { pos, forward } in this crowd's space.
  // camTile: [x, z] of the camera (surface only). bossActive: the current nav
  // target is the boss (type 5).
  update(dt, player, { camTile = null, bossActive = false } = {}) {
    const g = dt / GAME_SECOND;
    const lead = player.pos.clone().addScaledVector(player.forward, LEAD);
    const playerYaw = Math.atan2(player.forward.x, player.forward.z);
    const ctx = { g, dt, player: player.pos, playerYaw, lead };
    let hostiles = 0;
    this.awake = [];
    for (const a of [...this.actors]) {
      a.awake = false; // slot +0x84: ran this frame, so the radar shows it
      if (!a.alive) continue;
      // FUN_000241c0: bossOnly enemies wait for the boss nav point;
      // FUN_0001e500: outside the 11x11 window nothing moves, and a flier
      // going down out there is just gone.
      if (a.def.ai.bossOnly && !bossActive) continue;
      if (camTile && !this.tunnel) {
        const tx = Math.floor(wrapMap(a.pos.x));
        const tz = Math.floor(wrapMap(a.pos.z));
        const dx = Math.abs(this.delta(camTile[0], tx));
        const dz = Math.abs(this.delta(camTile[1], tz));
        if (Math.max(dx, dz) > WINDOW) {
          if (a.state === CRASH) this.remove(a);
          continue;
        }
      }
      a.awake = true;
      this.awake.push(a);
      if (HOSTILES.has(a.def.logic)) hostiles += 1;
      this.think(a, ctx);
      if (FLYBY_LOGICS.has(a.def.logic)) this.flyby(a, ctx);
      if (!this.tunnel) {
        a.pos.x = wrapMap(a.pos.x);
        a.pos.z = wrapMap(a.pos.z);
      }
    }
    if (!this.tunnel) this.spawner(ctx, hostiles, player.forward);
    this.moveTracers(g, player.pos);
    this.moveMissiles(g);
    this.stepEffects(g, player.pos);
  }

  // FUN_00023e20: while at most SPAWN_LIMITS[difficulty] hostiles are awake,
  // every 4 s the next def flagged spawnable (round robin by def index) is
  // copied from its first slot and dropped 3 tiles from the player: 1 in 4
  // in any direction, otherwise within 45 degrees of the nose, between the
  // ground under the player and TOP above it. The copy takes the first
  // slot's current strength, so once that one is dead its copies are too.
  spawner(ctx, hostiles, nose) {
    if (hostiles > SPAWN_LIMITS[this.difficulty]) return;
    this.spawnClock += ctx.g / 4;
    if (this.spawnClock < 1) return;
    this.spawnClock -= 1;
    const defs = [...new Set(this.actors.filter((a) => a.def.ai.spawn).map((a) => a.def))].sort((p, q) => p.index - q.index);
    if (!defs.length) return;
    const def = defs.find((d) => d.index > this.spawnTurn) || defs[0];
    this.spawnTurn = def.index;
    const proto = this.actors.find((a) => a.def === def);
    if (!proto.alive) return;
    // A dead spawned slot is reused before the list grows.
    const old = this.actors.findIndex((a) => a.spawned && !a.alive);
    let slot;
    if (old >= 0) {
      slot = this.actors[old].slot;
      this.parent.remove(this.actors[old].mesh);
      this.actors.splice(old, 1);
    } else {
      if (this.actors.length >= MAX_ENEMIES) return;
      slot = Math.max(...this.actors.map((a) => a.slot)) + 1;
    }
    const p = ctx.player;
    const heading = rand() <= 0x2000 ? angle(rand() * 2) : Math.atan2(nose.x, nose.z) + angle((rand() - 0x4000) / 2);
    const mesh = proto.homeMesh.clone(true);
    mesh.userData.spawned = true;
    mesh.position.set(
      wrapMap(p.x + Math.sin(heading) * SPAWN_RING),
      this.ground(p.x, p.z) + ((rand() * 2) / TURN) * TOP,
      wrapMap(p.z + Math.cos(heading) * SPAWN_RING),
    );
    this.parent.add(mesh);
    const child = this.add(mesh, { def, slot, strength: proto.strength, pitch: proto.pitch, roll: proto.roll, yaw: proto.yaw }, proto.radius, proto.vertices);
    child.spawned = true;
  }

  // FUN_00025e40, after the move: crossing inside FLYBY_RANGE this frame while
  // flying the other way plays a random flyby at the fighter.
  flyby(a, ctx) {
    const before = a.range;
    a.range = this.distance(a, ctx.player);
    if (!(before > FLYBY_RANGE && a.range < FLYBY_RANGE)) return;
    const rel = (((a.yaw - ctx.playerYaw) / TAU) * TURN) & 0xffff;
    if (rel <= 0x6000 || rel >= 0xa000) return;
    this.sound?.(FLYBYS[rand() >> 13], 3, a.pos);
  }

  think(a, ctx) {
    const logic = a.def.logic;
    if (a.state === CRASH) return this.crash(a, ctx);
    if (FIGHTERS.has(logic)) return this.fighter(a, ctx);
    if (TURRETS.has(logic)) return this.turret(a, ctx, { pitch: true, yaw: true, range: Infinity });
    switch (logic) {
      case 2: return this.chaser(a, ctx);
      case 3: return this.turret(a, ctx, { pitch: true, yaw: true, range: NEAR_FIRE });
      case 4: return this.chaser(a, ctx);
      case 5: a.roll += a.spin * ctx.g; return; // drill
      case 9: if (a.state !== WRECK) a.state = STANDING; return; // can be wrecked
      case TREE: return this.tree(a, ctx);
      case 10: return this.turret(a, ctx, { pitch: false, yaw: true, range: Infinity });
      case 11: return this.turret(a, ctx, { pitch: true, yaw: false, range: Infinity });
      case 14: return this.gunMount(a, ctx); // surfskimmer boats
      case 0x10: return this.tunnelRunner(a, ctx);
      case 0x11: return this.transport(a, ctx);
      case 0x12: return this.asteroid(a, ctx);
      case 0x13: return this.crawler(a, ctx);
      case 0x15: return this.factory(a, ctx);
      case 0x17: return this.gunner(a, ctx); // volcano lobs at you
      case 0x19: return this.missile(a, ctx);
      case 0x1a: return this.bobber(a, ctx);
      case 0x1c: return this.mothership(a, ctx);
      case 0x1e: return this.turret(a, ctx, { pitch: false, yaw: true, range: Infinity, rate: a.def.ai.speed });
      case 0x1f: a.yaw += angle(TURN / 8) * ctx.g; return this.gunMount(a, ctx);
      case 0x23: a.yaw += angle(TURN / 8) * ctx.g; return this.gunner(a, ctx);
      case 0x20: return this.helicopter(a, ctx);
      default: return undefined;
    }
  }

  // FUN_00024c30: turn toward aimPitch/aimYaw, bank with the turn, fly
  // forward, stay a radius above the ground.
  steer(a, ctx, turn, speed) {
    const k = Math.min(1, (turn / TURN) * ctx.g);
    if (a.state !== LOOP) a.pitch += k * (a.aimPitch - a.pitch);
    const err = wrapAngle(a.aimYaw - a.yaw);
    if (a.state !== ROLL) a.roll = -(Math.min(1, (turn / TURN) * BANK_FRAME) * err) / 2;
    a.yaw = wrapAngle(a.yaw + k * err);
    const f = forward(a.pitch, a.yaw, new THREE.Vector3());
    a.pos.addScaledVector(f, (speed / TILE) * ctx.g);
    const floor = this.ground(a.pos.x, a.pos.z) + a.radius;
    if (a.pos.y < floor) a.pos.y = floor;
  }

  // FUN_000243f0 for a body that stays put: angles approach the aim.
  turnToward(a, ctx, rate, { pitch = true, yaw = true } = {}) {
    const k = Math.min(1, (rate / TURN) * ctx.g);
    if (pitch) a.pitch += k * (a.aimPitch - a.pitch);
    else a.pitch += k * (0 - a.pitch);
    if (yaw) a.yaw = wrapAngle(a.yaw + k * wrapAngle(a.aimYaw - a.yaw));
    a.roll += k * (0 - a.roll);
  }

  // Fire timer shared by every gun: fireEvery is 16.16 game seconds.
  trigger(a, ctx) {
    const every = Math.max(a.def.ai.fireEvery / TURN, 0.05);
    a.fireClock += ctx.g;
    if (a.fireClock <= every) return false;
    a.fireClock -= every;
    return true;
  }

  // ---------------------------------------------------------------- logics

  // 7, 8, 0x1d, 0x26, 0x27 (FUN_00025810): attack runs at a point half a tile
  // ahead of you, break off when close, sometimes with a roll or a loop,
  // come back from further out.
  fighter(a, ctx) {
    const ai = a.def.ai;
    if (a.state === 0) a.state = ATTACK;
    const aim = this.aimAt(a, ctx.lead);
    if (aim.dh >= ENGAGE) return;
    const d3 = this.distance(a, ctx.player);
    if (a.state === BREAK && d3 > ai.far / 16) a.state = ATTACK;
    if (a.state === ATTACK && d3 < ai.near / 16) {
      a.state = BREAK;
      const r = rand();
      if (r > 0x6000) a.state = ROLL;
      if (r > 0x7800) a.state = LOOP;
    }
    if (a.state === ROLL) {
      a.roll += Math.PI * ctx.g;
      if (a.roll > TAU) {
        a.roll = 0;
        a.state = BREAK;
      }
    }
    const turn = ai.turn + a.bias;
    if (a.state === LOOP) {
      a.pitch -= angle(turn / 4) * ctx.g;
      if (a.pitch < -TAU) {
        a.pitch = 0;
        a.state = BREAK;
      }
    }
    // Once a second, a 1-in-16 chance to switch between attacking and breaking off.
    a.dice += ctx.g;
    if (a.dice >= 1) {
      a.dice %= 1;
      if (rand() < 0x800) {
        if (a.state === ATTACK) a.state = BREAK;
        else if (a.state === BREAK) a.state = ATTACK;
      }
    }
    a.aimYaw = aim.yaw;
    a.aimPitch = aim.pitch;
    if (a.state !== ATTACK) {
      // As in the original, the break-off heading is built on the pitch angle.
      const [yawOff, pitchOff] = BREAK_HEADINGS[a.slot & 3];
      let dive = pitchOff;
      if (this.ground(a.pos.x, a.pos.z) + 4 * a.radius > ctx.player.y && dive > 0) dive -= 0x3000;
      a.aimYaw = aim.pitch + angle(yawOff);
      a.aimPitch = aim.pitch + angle(dive);
    }
    this.steer(a, ctx, turn, ai.speed + a.bias);
    if (a.def.logic === 0x26) a.pos.y = Math.min(a.pos.y, TOP - a.radius);
    if (a.def.logic === 0x27) a.pos.y = Math.max(a.pos.y, TOP + a.radius);
    if (a.state === ATTACK && this.trigger(a, ctx) && aim.dh < FAR_FIRE) this.shoot(a, forward(a.pitch, a.yaw, new THREE.Vector3()));
  }

  // 2, 4 (FUN_00025110, FUN_000252d0): fly straight at you inside 5 tiles.
  chaser(a, ctx) {
    const ai = a.def.ai;
    const aim = this.aimAt(a, ctx.player);
    if (aim.dh >= ENGAGE) return;
    a.aimYaw = aim.yaw;
    a.aimPitch = aim.pitch;
    this.steer(a, ctx, ai.turn + a.bias, ai.speed + a.bias);
    if (this.trigger(a, ctx) && aim.dh < NEAR_FIRE) this.shoot(a, forward(a.pitch, a.yaw, new THREE.Vector3()));
  }

  // 1, 3, 6, 10, 11, 0x16, 0x1e: the body turns to face you and fires.
  // [I] The turn rate is passed in registers Ghidra lost; the def's turn is used.
  turret(a, ctx, { pitch, yaw, range, rate = a.def.ai.turn }) {
    const aim = this.aimAt(a, ctx.player);
    a.aimYaw = aim.yaw;
    a.aimPitch = aim.pitch;
    this.turnToward(a, ctx, rate, { pitch, yaw });
    if (this.trigger(a, ctx) && aim.dh < Math.min(range, WINDOW)) this.shootAt(a, ctx.player);
  }

  // 14, 0x1f (FUN_00026c60): the body never moves or turns (the model is
  // drawn from slot 3..5); a separate gun turns toward you at the def's turn
  // rate (FUN_000262d0) and fires along itself every fireEvery, with no range
  // check (FUN_00026420). [I] The gun mount offset (def +0x190) is not used.
  gunMount(a, ctx) {
    const aim = this.aimAt(a, ctx.player);
    const k = Math.min(1, ((a.def.ai.turn + a.bias) / TURN) * ctx.g);
    a.gunPitch += k * (aim.pitch - a.gunPitch);
    a.gunYaw = wrapAngle(a.gunYaw + k * wrapAngle(aim.yaw - a.gunYaw));
    if (this.trigger(a, ctx)) this.shoot(a, forward(a.gunPitch, a.gunYaw, new THREE.Vector3()), { spread: false });
  }

  // 0x17, 0x23: a gun on a body that does its own thing.
  gunner(a, ctx) {
    if (this.trigger(a, ctx) && this.aimAt(a, ctx.player).dh < WINDOW) this.shootAt(a, ctx.player);
  }

  // 0x10 (FUN_00026e60): tunnel gulls fly back down the centreline toward
  // the entrance and vanish at segment 0.
  tunnelRunner(a, ctx) {
    const segs = this.tunnel;
    if (!segs?.length) return;
    const dh = Math.hypot(ctx.player.x - a.pos.x, ctx.player.z - a.pos.z);
    if (dh >= ENGAGE) return;
    const k = THREE.MathUtils.clamp(Math.floor(a.pos.z), 0, segs.length - 1);
    const unit = 1 / 4096;
    const from = segs[k].start;
    const to = k + 1 < segs.length ? segs[k + 1].start : segs[k].end;
    const t = a.pos.z - k;
    const before = a.pos.clone();
    a.pos.x = (from[0] + (to[0] - from[0]) * t) * unit;
    a.pos.y = (from[1] + (to[1] - from[1]) * t) * unit;
    a.pos.z -= ((a.def.ai.speed + a.bias) / TILE) * ctx.g;
    // [I] Facing: along the flight path.
    const step = a.pos.clone().sub(before);
    if (step.lengthSq() > 1e-12) {
      a.yaw = Math.atan2(step.x, step.z);
      a.pitch = -Math.atan2(step.y, Math.hypot(step.x, step.z));
    }
    a.roll = 0;
    if (a.pos.z < 0) return this.remove(a);
    if (this.trigger(a, ctx) && dh < FAR_FIRE) this.shootAt(a, ctx.player);
  }

  // 0x11 (FUN_00027070): lifts off spinning and leaves through the ceiling.
  transport(a, ctx) {
    if (a.state === 0) a.state = CLIMB;
    a.pos.y += 0.25 * ctx.g;
    a.yaw += angle(0x1000) * ctx.g;
    if (a.pos.y > 2 * TOP) this.remove(a);
  }

  // 0x1c (FUN_00027d10): rises to half the ceiling, then the def turns into a fighter (0x1d).
  mothership(a, ctx) {
    if (a.state === 0) a.state = CLIMB;
    if (a.state !== CLIMB) return;
    a.pos.y += 0.25 * ctx.g;
    a.yaw += angle(0x1000) * ctx.g;
    if (a.pos.y > TOP / 2 + this.ground(a.pos.x, a.pos.z)) {
      a.def.logic = 0x1d;
      a.state = 0;
    }
  }

  // 0x20 (FUN_00027df0): sits until a 1-in-16 roll, climbs a tile, then
  // alternates 8 s of fighter runs with 8 s of hovering gunnery.
  helicopter(a, ctx) {
    if (a.state === 0) {
      if (!perFrame(1 / 16, ctx.dt)) return;
      a.state = CLIMB;
    }
    if (a.state === CLIMB) {
      a.pos.y += 0.25 * ctx.g;
      a.yaw += angle(0x1000) * ctx.g;
      if (a.pos.y > TOP / 8 + this.ground(a.pos.x, a.pos.z)) {
        a.state = ATTACK;
        a.timer = (rand() * 32) / TURN;
      }
      return;
    }
    a.timer += ctx.g;
    if (a.state === HOVER) {
      this.turret(a, ctx, { pitch: true, yaw: true, range: Infinity });
      if (a.timer > 16) {
        a.state = ATTACK;
        a.timer = 0;
      }
      return;
    }
    this.fighter(a, ctx);
    if (a.state !== ATTACK) a.state = BREAK;
    if (a.timer > 8) {
      a.state = HOVER;
      a.roll = 0;
    }
  }

  // 0x12 (FUN_000270e0): drops from half the ceiling at 4 tiles/s, tumbling,
  // bursts on the ground and starts again up to 2 tiles away.
  asteroid(a, ctx) {
    if (a.state === 0) {
      a.state = FALL;
      a.pos.x += ((rand() - 0x4000) * 0x80) / TILE;
      a.pos.z += ((rand() - 0x4000) * 0x80) / TILE;
      a.pos.y = this.ground(a.pos.x, a.pos.z) + a.radius + TOP / 2;
    }
    a.pos.y -= 4 * ctx.g;
    a.pitch += TAU * ctx.g;
    a.yaw += (TAU / 4) * ctx.g;
    a.roll += (TAU / 4) * ctx.g;
    if (a.pos.y <= this.ground(a.pos.x, a.pos.z) + a.radius) a.state = 0;
  }

  // 0x13 (FUN_00027250): C-Nomes and rovers run at you along the ground and
  // scatter (at double speed) when they get within a quarter tile.
  crawler(a, ctx) {
    const ai = a.def.ai;
    const aim = this.aimAt(a, ctx.lead);
    if (aim.dh >= ENGAGE) return;
    const d3 = this.distance(a, ctx.player);
    if (d3 > 2) a.state = ATTACK;
    if (d3 < 0.25) a.state = BREAK;
    a.dice += ctx.g;
    if (a.dice >= 1) {
      a.dice %= 1;
      if (rand() < 0x800) a.state = a.state === ATTACK ? BREAK : ATTACK;
    }
    a.aimPitch = 0;
    a.aimYaw = a.state === BREAK ? angle(SCATTER_HEADINGS[a.slot & 3]) : aim.yaw;
    const speed = (ai.speed + a.bias) * (a.state === BREAK ? 2 : 1);
    this.steer(a, ctx, ai.turn + a.bias, speed);
    a.pos.y = this.ground(a.pos.x, a.pos.z);
    a.pitch = 0;
    a.roll = 0;
  }

  // 0x15 (FUN_00027470): every 4 s, if its last C-Nome has walked off, the
  // factory builds another one on its doorstep.
  factory(a, ctx) {
    a.timer += ctx.g / 4;
    if (a.timer <= 1) return;
    a.timer %= 1;
    if (a.child && a.child.alive && a.child.pos.distanceToSquared(a.pos) < 1e-9) return;
    const proto = this.actors.find((b) => b.def.logic === 0x13 && !b.spawned);
    if (!proto || this.actors.length >= MAX_ENEMIES) return;
    const mesh = proto.homeMesh.clone(true);
    mesh.userData.spawned = true;
    mesh.position.copy(a.pos);
    mesh.rotation.set(0, 0, 0, "YXZ");
    this.parent.add(mesh);
    const child = this.add(mesh, { def: proto.homeDef, slot: this.actors.length, strength: proto.homeStrength, pitch: 0, roll: 0, yaw: 0 }, proto.radius, proto.vertices);
    child.spawned = true;
    a.child = child;
  }

  // 0x19 (FUN_000278a0): a 1-in-64 roll each frame launches it straight up
  // at 4 tiles/s; past the ceiling it is back on its pad.
  missile(a, ctx) {
    if (a.state === 0) {
      if (!perFrame(0x1ff / 0x8000, ctx.dt)) return;
      a.state = LAUNCH;
      this.sound?.("missile.wav", 2, a.pos); // FUN_000278a0, at launch
    }
    a.pos.y += 4 * ctx.g;
    if (a.pos.y > 2 * TOP) {
      a.state = 0;
      a.pos.y = a.home.pos.y;
    }
  }

  // 0x1a (FUN_00027980): bobs a quarter radius up and down and turns slowly.
  bobber(a, ctx) {
    a.timer += ctx.g / 8;
    a.pos.y = a.base + (a.radius / 4) * Math.sin(a.timer * TAU);
    a.yaw += (TAU / 8) * ctx.g;
  }

  remove(a) {
    a.alive = false;
    a.mesh.visible = false;
  }

  // 0x21 (FUN_00028610): a tree stands in state 100 until its kill; then it
  // burns for half a second with strength 0xfffff and is gone.
  tree(a, ctx) {
    if (a.state === 0) {
      a.state = HIT_POINT_OFF;
      a.timer = 0;
    }
    if (a.state !== BURNING) return;
    a.timer += ctx.g;
    a.strength = 0xfffff;
    if (a.timer > BURN_TIME) {
      a.strength = 0;
      this.remove(a);
    }
  }

  // FUN_00024f80 (state 600): the nose drops a quarter turn per game second
  // to 45 degrees down, it rolls half a turn per second, flies on at its
  // speed and puffs smoke half its radius wide every half second; under the
  // ground it blows up.
  crash(a, ctx) {
    a.pitch = Math.min(a.pitch + angle(0x4000) * ctx.g, angle(0x1fff));
    a.roll += angle(0x8000) * ctx.g;
    a.pos.addScaledVector(forward(a.pitch, a.yaw, tmpDir), ((a.def.ai.speed + a.bias) / TILE) * ctx.g);
    if (a.pos.y < this.ground(a.pos.x, a.pos.z)) {
      a.strength = 0;
      this.explode(a);
      this.remove(a);
      return;
    }
    a.smoke += 2 * ctx.g;
    if (a.smoke > 1) {
      a.smoke -= 1;
      this.puff(a.pos, a.radius / 2);
    }
  }
  // ---------------------------------------------------------------- shots

  // FUN_00024700 / FUN_00026420 -> FUN_00019070: the shot leaves from a
  // random firing vertex turned by the body angles (FUN_00024540), the
  // def's sfx plays at the shooter, and the def's shot model flies straight
  // at shotSpeed for 2 game seconds or until it is under the ground
  // (FUN_00019330). Gun mounts (FUN_00026420) have no spread.
  shoot(a, dir, { spread = true } = {}) {
    const ai = a.def.ai;
    dir = dir.clone().normalize();
    const cycle = spread ? SPREAD_CYCLE[ai.spread] || 1 : 1;
    const [dp, dy] = SPREAD[a.spreadStep % cycle];
    a.spreadStep = (a.spreadStep + 1) % cycle;
    if (dp || dy) {
      const pitch = -Math.asin(Math.max(-1, Math.min(1, dir.y))) + angle(dp);
      forward(pitch, Math.atan2(dir.x, dir.z) + angle(dy), dir);
    }
    const pos = a.pos.clone();
    const muzzle = ai.muzzles?.length && a.vertices?.[ai.muzzles[(rand() * ai.muzzles.length) >> 15]];
    if (muzzle) pos.add(new THREE.Vector3(...muzzle).applyEuler(new THREE.Euler(a.pitch, a.yaw, a.roll, "YXZ")));
    if (ai.sfx) this.sound?.(ai.sfx, 3, pos);
    const mesh = this.shotModel?.(ai.shot) || new THREE.Mesh(this.tracerGeometry, this.tracerMaterial);
    mesh.userData.tracer = true;
    mesh.frustumCulled = false;
    this.parent.add(mesh);
    this.tracers.push({
      mesh, pos, dir,
      type: ai.shot,
      damage: ai.weapon,
      speed: ai.shotSpeed / TILE,
      life: SHOT_LIFE,
      near: Infinity,
      whizzed: false,
    });
  }

  // The player's shots (FUN_0001b6d0 -> FUN_00019070): same record, flying
  // along dir with the given orientation (q). They hit enemies instead of
  // the player and never whiz.
  fire({ pos, dir, q, type, speed, damage }) {
    const mesh = this.shotModel?.(type) || new THREE.Mesh(this.tracerGeometry, this.tracerMaterial);
    mesh.userData.tracer = true;
    mesh.frustumCulled = false;
    this.parent.add(mesh);
    this.tracers.push({ mesh, pos, dir, q, type, damage, speed, life: SHOT_LIFE, player: true });
  }

  shootAt(a, target) {
    const dir = new THREE.Vector3(this.delta(a.pos.x, target.x), target.y - a.pos.y, this.delta(a.pos.z, target.z));
    if (dir.lengthSq() > 0) this.shoot(a, dir);
  }

  // g: game seconds. FUN_00019330 runs each shot in 8 substeps, testing
  // before it moves: a player's shot against the enemies (hit), an enemy's
  // against the player (used up if hitPlayer takes it); in a tunnel against
  // the wall. On the surface a shot that ends a substep under the ground
  // dies where it was. Wall and ground leave an impact (a big one for enemy
  // missiles). A shot closing on the player whizzes past once
  // (FUN_000191d0): missile.wav for missiles, whiz3.wav otherwise.
  moveTracers(g, player) {
    const h = g / SHOT_STEPS;
    this.tracers = this.tracers.filter((t) => {
      for (let i = 0; i < SHOT_STEPS; i++) {
        if (this.stepShot(t, h, player)) continue;
        this.parent.remove(t.mesh);
        return false;
      }
      t.life -= g;
      if (t.life < 0) {
        this.parent.remove(t.mesh);
        return false;
      }
      if (t.player) return true;
      const d = this.distance(t, player);
      if (!t.whizzed && d < t.near && d < WHIZ) {
        t.whizzed = true;
        const missile = t.type === ENEMY_MISSILE;
        this.sound?.(missile ? "missile.wav" : "whiz3.wav", missile ? 3 : 2, t.pos);
      }
      t.near = d;
      return true;
    });
  }

  // One substep; false when the shot is gone.
  stepShot(t, h, player) {
    if (t.player ? this.hit(t.pos, t.damage) : this.onPlayer(t.pos, player) && this.hitPlayer?.(t.damage)) return false;
    const end = (at) => (t.type === ENEMY_MISSILE
      ? this.impact(at, IMPACT_MISSILE, IMPACT_DEBRIS)
      : this.impact(at, IMPACT_SHOT, IMPACT_QUICK));
    if (this.inWall?.(t.pos, t.damage)) {
      end(t.pos);
      return false;
    }
    tmpPoint.copy(t.pos);
    t.pos.addScaledVector(t.dir, t.speed * h);
    if (!this.tunnel && t.pos.y < this.ground(t.pos.x, t.pos.z)) {
      end(tmpPoint);
      return false;
    }
    return true;
  }

  onPlayer(p, player) {
    return this.within(player, p, SHOT_HIT, SHOT_HIT, SHOT_HIT);
  }

  // p is inside the box of half sizes hx, hy, hz around c (strictly).
  within(c, p, hx, hy, hz) {
    return Math.abs(this.delta(c.x, p.x)) < hx && Math.abs(p.y - c.y) < hy && Math.abs(this.delta(c.z, p.z)) < hz;
  }

  // FUN_000290d0: ;NewHit cubes around turned model vertices (unless the
  // state is 100), otherwise the unturned hit box.
  holds(a, p) {
    const points = a.def.ai.hitPoints;
    if (points?.length && a.state !== HIT_POINT_OFF && a.vertices) {
      tmpEuler.set(a.pitch, a.yaw, a.roll);
      return points.some(([vertex, size]) => {
        const v = a.vertices[vertex];
        return v && this.within(tmpHit.set(v[0], v[1], v[2]).applyEuler(tmpEuler).add(a.pos), p, size, size, size);
      });
    }
    return this.within(a.pos, p, a.box[0], a.box[1], a.box[2]);
  }

  // FUN_00029050: where an actor is aimed at, its first ;NewHit point if any.
  centre(a) {
    const point = a.def.ai.hitPoints?.[0];
    const v = point && a.vertices?.[point[0]];
    if (!v) return a.pos;
    return new THREE.Vector3(v[0], v[1], v[2]).applyEuler(tmpEuler.set(a.pitch, a.yaw, a.roll)).add(a.pos);
  }

  // FUN_00029290: the first awake, living actor that holds the point loses
  // `damage` of its strength. At 0 or below it dies (kill); otherwise the
  // hit leaves a small silent impact at the point and, 1 time in 4, one
  // piece of debris (FUN_00028fe0, not for logic 0x21), thrown upward
  // unless the actor flies (logics 2, 4, 7).
  hit(p, damage) {
    for (const a of this.awake) {
      if (!a.alive || !this.holds(a, p)) continue;
      a.strength -= damage;
      if (a.strength <= 0) {
        this.kill(a);
        return true;
      }
      this.impact(p, IMPACT_SHOT, IMPACT_QUICK);
      const logic = a.def.logic;
      if (logic !== TREE && rand() <= 0x2000) this.throwDebris(p, !CRASHERS.has(logic));
      return true;
    }
    return false;
  }

  // FUN_00012740: the ship inside a slot's box wears it down by RAM per
  // game second; true if it is inside one (the player takes 0x1000).
  ram(p, g) {
    return this.hit(p, RAM * g);
  }

  // FUN_00028e50: the blast, then what the slot turns into. State 100 (a
  // tree) burns, 300 (logic 9) is wrecked, both with twice the strength it
  // had; a C-Nome becomes its remains; a flier may go down burning. Anyone
  // else stays dead. Then it may drop a power-up (FUN_00028d90).
  // [port] A logic-8 fighter splitting into two half.bin pieces (FUN_00028b60)
  // isn't done; it just dies.
  kill(a) {
    this.explode(a);
    const was = a.state;
    const logic = a.def.logic;
    if (was === HIT_POINT_OFF) {
      a.state = BURNING;
      a.strength = a.full = a.full * 2;
    }
    if (was === STANDING) {
      a.state = WRECK;
      a.strength = a.full = a.full * 2;
      this.wreck(a);
    }
    if (logic === 0xc) this.sound?.("scream1.wav", 3, a.pos);
    if (logic === 0x13 && a.def.remains) {
      a.def = a.def.remains;
      a.state = WRECK;
      a.strength = a.full * 2;
      this.wreck(a);
    }
    if (CRASHERS.has(logic) && rand() <= (was === BREAK ? 0x3ffe : 0x1ffe)) {
      a.state = CRASH;
      a.strength = a.full * 2;
    }
    this.dropPickup(a);
    if (a.strength <= 0) this.remove(a);
  }

  // Swap in the wreck model and its box, if there is one.
  wreck(a) {
    if (!a.wreck) return;
    a.mesh.visible = false;
    a.mesh = a.wreck.mesh;
    a.box = a.wreck.box;
  }

  // FUN_00024e50: the kill blast at the model's middle, by logic.
  explode(a) {
    const at = a.pos.clone().add(tmpPoint.fromArray(a.middle));
    const logic = a.def.logic;
    if (this.tunnel) this.impact(at, a.radius, IMPACT_DEBRIS);
    else if (GROUND_KILLS.has(logic)) this.impact(at, a.radius, IMPACT_DEBRIS, IMPACT_GROUND);
    else if (logic === TREE) this.impact(at, a.radius / 2, 0, IMPACT_FIRE);
    else this.impact(at, a.radius, IMPACT_DEBRIS);
  }

  // FUN_0001b600 (smart bomb): every awake slot is hit at its centre with
  // 0x10000 (the point may fall in someone else's box first).
  bomb() {
    for (const a of [...this.awake]) {
      if (a.alive) this.hit(this.centre(a), 0x10000);
    }
  }

  // ---------------------------------------------------------------- power-ups

  // A .pup power-up (FUN_00040040): picked up when the ship is within its
  // model's bounding radius on every axis, drawn facing the camera.
  addPickup(mesh, type, radius, dropped = false) {
    if (this.pickups.length >= PICKUP_SLOTS) return null;
    if (!mesh.parent) this.parent.add(mesh);
    const item = { mesh, type, radius, pos: mesh.position.clone(), taken: false, dropped };
    this.pickups.push(item);
    return item;
  }

  // FUN_00040040: pickUp decides (FUN_0003fe70 can refuse: full shields,
  // a smart bomb already carried).
  collect(p) {
    for (const item of this.pickups) {
      if (item.taken || !this.within(item.pos, p, item.radius, item.radius, item.radius)) continue;
      if (!this.pickUp?.(item.type)) continue;
      item.taken = true;
      if (item.mesh) item.mesh.visible = false;
    }
  }

  // FUN_00028d90 -> FUN_000401f0: unless it is a dead wreck, a def's drop
  // chance in percent (third line) leaves its power-up type (-1: any of 12)
  // where the slot was, on the surface at least two radii above the ground.
  dropPickup(a) {
    const { drop, dropType } = a.def.ai;
    if ((a.state === WRECK && a.strength <= 0) || !drop) return;
    if (Math.floor((rand() * 100) / 0x7fff) > drop) return;
    const type = dropType === -1 ? Math.floor((rand() * 12) / 0x7fff) : dropType;
    const made = this.fx?.pickup(type);
    if (!made) return;
    made.mesh.position.copy(a.pos);
    if (!this.tunnel) made.mesh.position.y = Math.max(a.pos.y, this.ground(a.pos.x, a.pos.z) + made.radius * 2);
    this.addPickup(made.mesh, type, made.radius, true);
  }

  // ---------------------------------------------------------------- missiles

  // FUN_0001b490 -> FUN_0001a0c0: a missile at pos with the ship's angles
  // and speed (tiles per game second). Guided ones lock on first
  // (FUN_0001b400). missile.wav on channel 2.
  launch({ pos, pitch, yaw, roll, speed, damage, guided }) {
    if (this.missiles.length >= MISSILE_SLOTS) this.drop(this.missiles.shift());
    const target = guided ? this.lockOn() : null;
    this.missiles.push({
      pos: pos.clone(), pitch, yaw, roll, speed, damage, target,
      life: MISSILE_LIFE, smoke: SMOKE_EVERY, mesh: this.model("bradmis"),
    });
    this.sound?.("missile.wav", 2, pos);
  }

  // FUN_0001b400: the next awake actor in slot order, round robin from
  // after the last search, that isn't a wreck; none if nobody is awake.
  lockOn() {
    const n = this.actors.length;
    if (!n) return null;
    let i = this.lockNext % n;
    let found = null;
    for (let k = 0; k < n; k++, i = (i + 1) % n) {
      const a = this.actors[i];
      if (a.alive && a.awake && a.state !== WRECK) {
        found = a;
        break;
      }
    }
    this.lockNext = (i + 1) % n;
    return found;
  }

  // FUN_0001a190, four substeps a frame: hit test, tunnel wall, then a
  // guided missile turns straight at its target (no turn rate), speeds up
  // and moves; under the ground it blows up where it was. Then it ages and
  // smokes.
  moveMissiles(g) {
    const h = g / MISSILE_STEPS;
    this.missiles = this.missiles.filter((m) => {
      for (let i = 0; i < MISSILE_STEPS; i++) {
        if (this.hit(m.pos, m.damage)) return this.drop(m);
        if (this.inWall?.(m.pos, m.damage)) {
          this.impact(m.pos, IMPACT_MISSILE, IMPACT_DEBRIS);
          return this.drop(m);
        }
        if (m.target && !m.target.alive) m.target = null;
        if (m.target) {
          const aim = this.aimAt(m, this.centre(m.target));
          m.pitch = aim.pitch;
          m.yaw = aim.yaw;
        }
        m.roll = 0;
        m.speed = Math.min(MISSILE_TOP, m.speed + MISSILE_ACCEL * g);
        tmpPoint.copy(m.pos);
        m.pos.addScaledVector(forward(m.pitch, m.yaw, tmpDir), m.speed * h);
        if (!this.tunnel && m.pos.y < this.ground(m.pos.x, m.pos.z)) {
          this.impact(tmpPoint, IMPACT_MISSILE, IMPACT_DEBRIS);
          return this.drop(m);
        }
      }
      m.life -= g;
      if (m.life < 0) return this.drop(m);
      m.smoke -= g;
      if (m.smoke < 0) {
        m.smoke += SMOKE_EVERY;
        this.puff(m.pos);
      }
      return true;
    });
  }

  // ---------------------------------------------------------------- effects

  // FUN_00019860. Ground types sit at ground height under pos, twice the
  // size, and throw their debris upward.
  impact(pos, size, flags = 0, type = IMPACT_AIR) {
    if (this.impacts.length >= IMPACT_SLOTS) this.drop(this.impacts.shift());
    const ground = type !== IMPACT_AIR;
    const at = pos.clone();
    if (ground) at.y = this.ground(at.x, at.z);
    this.impacts.push({
      pos: at, size: ground ? size * 2 : size, phase: 0, rate: flags & IMPACT_QUICK ? 2 : 1,
      pace: IMPACT_PACE[type], frame: 0, mesh: this.sprite(IMPACT_KINDS[type]),
    });
    if (flags & IMPACT_DEBRIS) {
      const count = Math.floor((rand() * 8) / 0x7fff) + 2;
      for (let i = 0; i < count; i++) this.throwDebris(pos, ground);
    }
    const sound = EXPLOSIONS[Math.floor((rand() * 5) / 0x7fff)];
    if (!(flags & IMPACT_QUICK) && sound) this.sound?.(sound, 0, pos);
  }

  // FUN_0001c0b0: heading any way round; climbing 45-90 degrees if upward,
  // otherwise anywhere from straight down to straight up.
  throwDebris(pos, upward) {
    const slot = this.debrisNext;
    this.debrisNext = (slot + 1) % DEBRIS_SLOTS;
    this.drop(this.debris[slot]);
    const heading = angle(rand() * 2);
    const climb = angle(upward ? (rand() >> 2) + 0x2000 : rand() - 0x4000);
    const across = Math.cos(climb) * DEBRIS_SPEED;
    const spin = () => angle(rand() * 4 - 0x10000);
    const model = DEBRIS_MODELS[Math.min(3, Math.floor((rand() * 4) / 0x7fff))];
    this.debris[slot] = {
      pos: pos.clone(),
      vel: new THREE.Vector3(Math.cos(heading) * across, Math.sin(climb) * DEBRIS_SPEED, Math.sin(heading) * across),
      turn: new THREE.Vector3(), // pitch, roll, yaw
      spin: new THREE.Vector3(spin(), spin(), spin()),
      life: DEBRIS_LIFE,
      mesh: this.model(model),
    };
  }

  // FUN_0001c5a0: no puff when all slots are busy.
  puff(pos, size = PUFF_SIZE) {
    if (this.puffs.length >= PUFF_SLOTS) return;
    this.puffs.push({ pos: pos.clone(), size, life: PUFF_LIFE, frame: 0, mesh: this.sprite("puff") });
  }

  // FUN_0001a030, FUN_0001c470, FUN_0001c830.
  stepEffects(g, player) {
    this.impacts = this.impacts.filter((m) => {
      m.phase += m.rate * g;
      m.frame = Math.floor(m.phase * m.pace);
      return m.frame < IMPACT_FRAMES || this.drop(m);
    });
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      if (!d) continue;
      d.vel.y -= DEBRIS_FALL * g;
      tmpPoint.copy(d.pos);
      d.pos.addScaledVector(d.vel, g);
      d.turn.addScaledVector(d.spin, g);
      d.life -= g;
      let gone = d.life < 0;
      if (this.tunnel) {
        // [I] FUN_00038f00 pushes it out along the wall and reflects it;
        // here it steps back and reverses.
        if (this.inWall?.(d.pos)) {
          d.pos.copy(tmpPoint);
          d.vel.negate();
        }
      } else if (player.y > TOP && d.pos.y < TOP) {
        gone = true; // under the cloud deck while you are above it
      } else {
        const floor = this.ground(d.pos.x, d.pos.z);
        const n = d.pos.y < floor && this.groundNormal?.(d.pos.x, d.pos.z);
        if (n) {
          d.pos.y = floor;
          d.vel.addScaledVector(n, -2 * d.vel.dot(n));
        }
      }
      if (gone) {
        this.drop(d);
        this.debris[i] = null;
      }
    }
    this.puffs = this.puffs.filter((p) => {
      p.frame = Math.floor(((PUFF_LIFE - p.life) / PUFF_LIFE) * 4);
      p.life -= g;
      return (p.frame < 4 && p.life >= 0) || this.drop(p);
    });
  }

  // A camera-facing square from fx, reused once dropped.
  sprite(kind) {
    const mesh = this.spares.get(kind)?.pop() || this.fx?.sprite(kind) || null;
    if (!mesh) return null;
    mesh.userData.kind = kind;
    mesh.frustumCulled = false;
    this.parent.add(mesh);
    return mesh;
  }

  model(name) {
    const mesh = this.fx?.model(name) || null;
    if (mesh) this.parent.add(mesh);
    return mesh;
  }

  // Takes an effect's mesh out of the scene; false, for filters.
  drop(item) {
    const mesh = item?.mesh;
    if (!mesh) return false;
    this.parent.remove(mesh);
    item.mesh = null;
    const kind = mesh.userData.kind;
    if (kind) {
      if (!this.spares.has(kind)) this.spares.set(kind, []);
      this.spares.get(kind).push(mesh);
    }
    return false;
  }

  // ---------------------------------------------------------------- drawing

  // Put meshes where the actors are. On the surface each one is drawn at the
  // wrap copy nearest the viewer and only inside the draw window. facing:
  // the camera's game { pitch, yaw }, which billboards copy (with no roll).
  sync(viewer, { flying = false, reach = WINDOW, camTile = null, facing = null } = {}) {
    const place = (mesh, pos) => {
      mesh.position.copy(pos);
      if (!this.tunnel && viewer) {
        mesh.position.x = viewer.x + this.delta(viewer.x, pos.x);
        mesh.position.z = viewer.z + this.delta(viewer.z, pos.z);
      }
    };
    const face = (mesh) => facing && mesh.rotation.set(facing.pitch, facing.yaw, 0, "YXZ");
    for (const a of this.actors) {
      if (!a.alive) continue;
      place(a.mesh, a.pos);
      a.mesh.rotation.set(a.pitch, a.yaw, a.roll, "YXZ");
      let visible = true;
      if (flying && camTile && !this.tunnel) {
        const dx = Math.abs(Math.floor(a.mesh.position.x) - camTile[0]);
        const dz = Math.abs(Math.floor(a.mesh.position.z) - camTile[1]);
        visible = Math.max(dx, dz) <= reach;
      }
      a.mesh.visible = visible;
    }
    for (const t of this.tracers) {
      place(t.mesh, t.pos);
      if (BILLBOARD_SHOTS.has(t.type)) face(t.mesh);
      else if (t.q) t.mesh.quaternion.copy(t.q);
      // Game angles, like the models (lookAt would see the mirrored world).
      else t.mesh.rotation.set(-Math.atan2(t.dir.y, Math.hypot(t.dir.x, t.dir.z)), Math.atan2(t.dir.x, t.dir.z), 0, "YXZ");
    }
    for (const m of this.missiles) {
      if (!m.mesh) continue;
      place(m.mesh, m.pos);
      m.mesh.rotation.set(m.pitch, m.yaw, m.roll, "YXZ");
    }
    for (const d of this.debris) {
      if (!d?.mesh) continue;
      place(d.mesh, d.pos);
      d.mesh.rotation.set(d.turn.x, d.turn.z, d.turn.y, "YXZ");
    }
    for (const list of [this.impacts, this.puffs]) {
      for (const m of list) {
        if (!m.mesh) continue;
        place(m.mesh, m.pos);
        face(m.mesh);
        m.mesh.scale.setScalar(m.size);
        this.fx?.frame(m.mesh, m.frame);
      }
    }
    // FUN_0003fd60: power-ups turn with the camera's yaw and pitch, as the
    // impacts do, and show in the draw window.
    for (const p of this.pickups) {
      if (p.taken || !p.mesh) continue;
      place(p.mesh, p.pos);
      face(p.mesh);
      let visible = true;
      if (flying && camTile && !this.tunnel) {
        const dx = Math.abs(Math.floor(p.mesh.position.x) - camTile[0]);
        const dz = Math.abs(Math.floor(p.mesh.position.z) - camTile[1]);
        visible = Math.max(dx, dz) <= reach;
      }
      p.mesh.visible = visible;
    }
  }
}
