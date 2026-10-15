// Enemy and NPC behaviour, ported from GAME.EXE's enemy loop (FUN_000241c0)
// and its per-logic dispatcher (FUN_00028610). docs/original-engine.md §9
// lists the routines. Everything here is in tiles, radians and real seconds,
// in the game's left-handed frame: yaw 0 faces +Z and turns toward +X,
// positive pitch is nose down, forward = (sin yaw cos pitch, -sin pitch,
// cos yaw cos pitch).
//
// Combat is not modelled: nothing takes damage and nothing dies. Shots are
// drawn as tracers so you can see who is firing at you.
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
// [I] Shot travel is not decoded; tracers fly this fast for shotRange.
const TRACER_SPEED = 4;
const TRACER_LIFE_MAX = 1.5;

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
const TURRETS = new Set([1, 6, 0x16]);
// Logics that never move or turn stay static props in the viewer.
export const ACTOR_LOGICS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17,
  0x19, 0x1a, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x23, 0x26, 0x27,
]);

export const isActor = (spot) => ACTOR_LOGICS.has(spot.logic) && !!spot.def;

const angle = (units) => (units / TURN) * TAU;
const rand = () => Math.floor(Math.random() * 0x8000); // FUN_00050cd3
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const wrapMap = (v) => ((v % MAP) + MAP) % MAP;
const perFrame = (p, dt) => Math.random() < 1 - (1 - p) ** (dt * ORIGINAL_FPS);

function forward(pitch, yaw, out) {
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c, -Math.sin(pitch), Math.cos(yaw) * c);
}

// One group of actors in one space: the surface (wraps at 256 tiles, has
// ground) or a tunnel (no wrap, no ground, everything always awake).
export class Crowd {
  constructor({ parent, tunnel = null, groundAt = null }) {
    this.parent = parent; // THREE.Group the meshes live in
    this.tunnel = tunnel; // .tnl segments when this is a tunnel
    this.groundAt = groundAt;
    this.actors = [];
    this.tracers = [];
    this.tracerGeometry = new THREE.BoxGeometry(0.004, 0.004, 0.08);
    this.tracerMaterial = new THREE.MeshBasicMaterial({ color: 0xffd060, fog: false });
  }

  // mesh: a placed model (position/rotation already set). radius: model
  // bounding radius in tiles.
  add(mesh, spot, radius) {
    const def = spot.def;
    def.homeLogic ??= def.logic; // the mothership rewrites its def's logic
    // FUN_00022f20: speed and turn bias from the placement row, phase timers random.
    const bias = ((spot.slot << 30) | 0) >> 16;
    const actor = {
      mesh, def, radius, slot: spot.slot,
      home: { pos: mesh.position.clone(), pitch: spot.pitch || 0, roll: spot.roll || 0, yaw: spot.yaw || 0 },
      bias,
    };
    this.reset(actor);
    this.actors.push(actor);
    return actor;
  }

  reset(actor) {
    actor.pos = actor.home.pos.clone();
    actor.pitch = actor.home.pitch;
    actor.roll = actor.home.roll;
    actor.yaw = actor.home.yaw;
    actor.aimPitch = actor.pitch;
    actor.aimYaw = actor.yaw;
    actor.state = 0;
    actor.alive = true;
    actor.fireClock = rand() / TURN;
    actor.dice = rand() / TURN;
    actor.timer = rand() / TURN;
    actor.spin = angle(rand()); // drill roll rate per second
    actor.base = actor.pos.y;
    actor.child = null;
    actor.mesh.visible = true;
  }

  resetAll() {
    this.actors = this.actors.filter((a) => !a.spawned);
    for (const child of [...this.parent.children]) {
      if (child.userData.spawned || child.userData.tracer) this.parent.remove(child);
    }
    this.tracers = [];
    for (const actor of this.actors) {
      actor.def.logic = actor.def.homeLogic;
      this.reset(actor);
    }
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
    const ctx = { g, dt, player: player.pos, lead };
    for (const a of [...this.actors]) {
      a.awake = false; // slot +0x84: ran this frame, so the radar shows it
      if (!a.alive) continue;
      // FUN_000241c0: bossOnly enemies wait for the boss nav point;
      // FUN_0001e500: outside the 11x11 window nothing moves.
      if (a.def.ai.bossOnly && !bossActive) continue;
      if (camTile && !this.tunnel) {
        const tx = Math.floor(wrapMap(a.pos.x));
        const tz = Math.floor(wrapMap(a.pos.z));
        const dx = Math.abs(this.delta(camTile[0], tx));
        const dz = Math.abs(this.delta(camTile[1], tz));
        if (Math.max(dx, dz) > WINDOW) continue;
      }
      a.awake = true;
      this.think(a, ctx);
      if (!this.tunnel) {
        a.pos.x = wrapMap(a.pos.x);
        a.pos.z = wrapMap(a.pos.z);
      }
    }
    this.moveTracers(dt);
  }

  think(a, ctx) {
    const logic = a.def.logic;
    if (FIGHTERS.has(logic)) return this.fighter(a, ctx);
    if (TURRETS.has(logic)) return this.turret(a, ctx, { pitch: true, yaw: true, range: Infinity });
    switch (logic) {
      case 2: return this.chaser(a, ctx);
      case 3: return this.turret(a, ctx, { pitch: true, yaw: true, range: NEAR_FIRE });
      case 4: return this.chaser(a, ctx);
      case 5: a.roll += a.spin * ctx.g; return; // drill
      case 10: return this.turret(a, ctx, { pitch: false, yaw: true, range: Infinity });
      case 11: return this.turret(a, ctx, { pitch: true, yaw: false, range: Infinity });
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
      case 0x1f: case 0x23: a.yaw += angle(TURN / 8) * ctx.g; return this.gunner(a, ctx);
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

  // 0x17, 0x1f, 0x23: a gun on a body that does its own thing.
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
    const mesh = proto.mesh.clone(true);
    mesh.userData.spawned = true;
    mesh.position.copy(a.pos);
    mesh.rotation.set(0, 0, 0, "YXZ");
    this.parent.add(mesh);
    const child = this.add(mesh, { def: proto.def, slot: this.actors.length, pitch: 0, roll: 0, yaw: 0 }, proto.radius);
    child.spawned = true;
    a.child = child;
  }

  // 0x19 (FUN_000278a0): a 1-in-64 roll each frame launches it straight up
  // at 4 tiles/s; past the ceiling it is back on its pad.
  missile(a, ctx) {
    if (a.state === 0) {
      if (!perFrame(0x1ff / 0x8000, ctx.dt)) return;
      a.state = LAUNCH;
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

  // ---------------------------------------------------------------- shots

  shoot(a, dir) {
    const range = Math.max(a.def.ai.shotRange / TILE, 0.5);
    const mesh = new THREE.Mesh(this.tracerGeometry, this.tracerMaterial);
    mesh.userData.tracer = true;
    mesh.frustumCulled = false;
    this.parent.add(mesh);
    this.tracers.push({
      mesh,
      pos: a.pos.clone(),
      dir: dir.clone().normalize(),
      life: Math.min(range / TRACER_SPEED, TRACER_LIFE_MAX),
    });
  }

  shootAt(a, target) {
    const dir = new THREE.Vector3(this.delta(a.pos.x, target.x), target.y - a.pos.y, this.delta(a.pos.z, target.z));
    if (dir.lengthSq() > 0) this.shoot(a, dir);
  }

  moveTracers(dt) {
    this.tracers = this.tracers.filter((t) => {
      t.life -= dt;
      if (t.life <= 0) {
        this.parent.remove(t.mesh);
        return false;
      }
      t.pos.addScaledVector(t.dir, TRACER_SPEED * dt);
      return true;
    });
  }

  // ---------------------------------------------------------------- drawing

  // Put meshes where the actors are. On the surface each one is drawn at the
  // wrap copy nearest the viewer and only inside the draw window.
  sync(viewer, { flying = false, reach = WINDOW, camTile = null } = {}) {
    const place = (mesh, pos) => {
      mesh.position.copy(pos);
      if (!this.tunnel && viewer) {
        mesh.position.x = viewer.x + this.delta(viewer.x, pos.x);
        mesh.position.z = viewer.z + this.delta(viewer.z, pos.z);
      }
    };
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
      // Game angles, like the models (lookAt would see the mirrored world).
      t.mesh.rotation.set(-Math.atan2(t.dir.y, Math.hypot(t.dir.x, t.dir.z)), Math.atan2(t.dir.x, t.dir.z), 0, "YXZ");
    }
  }
}
