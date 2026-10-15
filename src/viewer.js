import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Archive, podOrder, looksLikePod } from "./pod.js";
import { saveFile, loadFile, forgetFiles, keepFiles } from "./store.js";
import { readLevels, isSurface, readLevel, readPalette, resolveModel, POWERUP_MODELS } from "./formats.js";
import { parseBin, binGroups } from "./bin.js";
import { playMusic, stopMusic, toggleMusic, wakeMusic, setMusicLevel } from "./music.js";
import { Crowd, isActor, SHOT_MODELS, DEBRIS_MODELS } from "./ai.js";
import { readHudFont } from "./exe.js";
import { Menu, DEFAULT_SETTINGS } from "./menu.js";

// Engine values recovered from GAME.EXE. Section numbers point into
// docs/original-engine.md. Lengths are tiles (one tile = 2^20 game units).
const MAP = 256;
const HEIGHT_PER_BYTE = 1 / 32; // a height byte is 0x8000 units (3.3)
const TOP = 255 * HEIGHT_PER_BYTE; // tallest ground; also the sky plane and the cave mirror
const GAME_SECOND = 0.98864; // one 16.16 game second in real seconds (2.2)
const THROTTLE_MIN = 0.25; // throttle is tiles per game second (2.3)
const THROTTLE_MAX = 1;
const THROTTLE_START = 0.5;
const THROTTLE_RATE = 1 / GAME_SECOND; // A/Z held: 0x10000 per game second
const AFTERBURNER = 3;
const TURN_RATE = THREE.MathUtils.degToRad(103);
const BANK_COUPLING = 0.732; // yaw input also rolls you into the turn
const AUTO_LEVEL = THREE.MathUtils.degToRad(34);
const KEY_RISE = 2; // turn keys reach full deflection in 0.5 s
const KEY_FALL = 4;
// The game halves rates and speed every frame and adds the input, so they
// settle within a few frames. This is the frame-rate independent version.
const RESPONSE = 20;
const CLEARANCE = 1 / 256; // 2.4
const CEILING = 2 * TOP;
const SPAWN_LIFT = 0.5; // 4.2
const BOUNCE_LIMIT = (0x3fff / 65536) * Math.PI * 2;
const TUNNEL_CLAMP = (10000 / 65536) * Math.PI * 2;
const FLY_FOV = 90.6; // 3.1: 90.6 deg vertical, 100.9 deg across the 4:3 picture
const FLY_ASPECT = 1.2; // 320x200 shown on a 4:3 screen
const FLY_NEAR = 0.002;
const SURFACE_WINDOW = 5; // 11x11 tiles around the camera (3.2)
const CAVE_WINDOW = 7; // 15x15 in cave mode (5)
const FOG_K = 64; // fog step = clamp(floor(32 - K / depth), 0, 15)
const SKY_FOG_K = 4096;
const MODEL_SCALE = 1 / 16; // .bin units (7.4)
const TUNNEL_UNIT = 1 / 4096; // .tnl lengths (6.2)
const WALL_MARGIN = 1 / 32; // the ship's collision cube is +-0x8000
const SEAT_HALF_RADIUS = new Set([2, 4, 7, 8]); // logics seated at ground + radius/2 (4.3)
// [I] The game's model mappers appear to skip the fog table, which leaves
// objects floating unfogged over solid fog near the window edge. Fogging them
// like the terrain looks right; set false for the unfogged reading.
const FOG_OBJECTS = true;
const TUBE_STUB = 5; // a mouth shows 5 segments of its tunnel (6.3)
const MOUSE_GAIN = 0.012;
const MOUSE_SETTLE = 6;
const ORBIT_FOV = 60;
// Drawn at 800x600 into a 4:3 frame that letterboxes in the window.
const FRAME_W = 800;
const FRAME_H = 600;
const TAU = Math.PI * 2;
const PODS_KEY = "__pods";
const EXE_KEY = "game.exe";
const VOX_FILES = ["share.vox", "retail1.vox", "retail2.vox", "geiger.vox"];
const SETTINGS_KEY = "tv.settings";

const params = new URLSearchParams(location.search);
// The original's difficulty menu: Easy, Normal (its default), Hard, Terminal.
// It sets how many hostiles the spawner keeps around (src/ai.js).
const DIFFICULTIES = ["easy", "normal", "hard", "terminal"];
const difficultyAsked = DIFFICULTIES.indexOf((params.get("difficulty") || "").toLowerCase());
let difficulty = difficultyAsked < 0 ? 1 : difficultyAsked;
// Game mode: the title and menus first, Esc in flight asks to return to them.
// Any of ?level, ?mode or ?fly opens the bare viewer instead (tools, debugging);
// ?play=<level> flies a level in game mode with the menus skipped.
const gameMode = !params.has("level") && !params.has("mode") && !params.has("fly");
const menuEl = document.getElementById("menu");
let menu = null;
let gameStarted = false; // a game is running: Play Game offers Resume Game
// A scripted camera (tactical report, fly-in) in game axes; the ship stays
// at the spawn and the flight is not stepped (DAT_00064d40).
let cut = null;
// FUN_0004aef0 leaves the model light at (0, -0xb4fd, 0xb4fd) for the rest
// of the level, until a tunnel exit restores the level's (FUN_00042b20).
let briefSun = null;
// The light vector as set (game axes, 0x10000 long), for the shadows.
let shadowSun = [0, -0x10000, 0];
let smallFont = null; // GAME.EXE status-bar font bytes (src/exe.js)
const settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Sound F/X, Music and their volumes (0x4000..0x10000) from Sound Options.
function applySettings() {
  setMusicLevel(!!settings.music, settings.musicVolume / 0x10000);
}
const frameEl = document.getElementById("frame");
const modeEl = document.getElementById("mode");
const pickEl = document.getElementById("pick");
const flyBtn = document.getElementById("fly");
const forgetBtn = document.getElementById("forget");
const errorEl = document.getElementById("error");
const hudEl = document.getElementById("hud");
const hudBar = document.getElementById("hudBar");
const hudText = document.getElementById("hudText");
const hudCtx = hudText.getContext("2d");
const crosshairEl = document.getElementById("crosshair");
const crosshairCtx = crosshairEl.getContext("2d");
let crosshairShade = 0x20;
let crosshairStep = 1;
const setupEl = document.getElementById("setup");
const setupInput = document.getElementById("setupFiles");
const setupNote = document.getElementById("setupNote");
let navtar = null;
let hudGlyphs = null; // GAME.EXE status-bar font, one canvas per character
let radarFace = null; // 320x64 mask of the dial interior the radar shows through
let radarInk = null; // VGA palette, for the blip colours
let radarPulse = 0x61;
let radarPulseStep = 1;
let radarClock = 0;

// ---------------------------------------------------------------- sound effects

// FUN_00029830: four channels, one sound each (a new one cuts the old), at
// full volume, panned by the source's camera-space x: x / (1/64 tile)
// clamped to +-63, left = 32 - x/2, right = 32 + x/2. No distance falloff.
const SFX_VOLUME = 0.6;
let sfxContext = null;
const sfxBuffers = new Map();
const sfxChannels = [null, null, null, null];

function sfxAudio() {
  if (!sfxContext) {
    try {
      sfxContext = new AudioContext();
    } catch {
      return null;
    }
  }
  return sfxContext;
}

// Call from a user gesture: browsers start audio only after one.
function wakeSfx() {
  sfxAudio()?.resume?.().catch(() => {});
}

function sfxBuffer(name) {
  const path = `sound/${name}`;
  if (!sfxBuffers.has(path)) {
    sfxBuffers.set(path, (async () => {
      if (!archive?.has(path)) return null;
      const bytes = await archive.bytes(path);
      return sfxAudio()?.decodeAudioData(bytes.slice().buffer) ?? null;
    })().catch((err) => {
      console.warn(`sound ${name}:`, err);
      return null;
    }));
  }
  return sfxBuffers.get(path);
}

// FUN_00029730 is the same on channel 3, centred. loop: the channel's loop
// flag (only the afterburner sets it). Resolves to the playing source.
async function playSfx(name, channel, pan, { loop = false } = {}) {
  const ctx = sfxContext; // made by wakeSfx, from a gesture
  if (!ctx || ctx.state !== "running") return null;
  const buffer = await sfxBuffer(name);
  if (!buffer) return null;
  sfxChannels[channel]?.stop();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = loop;
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  const gain = ctx.createGain();
  gain.gain.value = settings.sound ? SFX_VOLUME * (settings.soundVolume / 0x10000) : 0;
  source.connect(panner).connect(gain).connect(ctx.destination);
  source.onended = () => {
    if (sfxChannels[channel] === source) sfxChannels[channel] = null;
  };
  sfxChannels[channel] = source;
  source.start();
  return source;
}

function stopSfx(channel) {
  sfxChannels[channel]?.stop();
  sfxChannels[channel] = null;
}

// Afterburner (FUN_0001bab0, weapon 0x16 in FUN_0001b6d0). While it is held
// the weapon ticks 6 times per game second, the first tick at once. The first
// plays blast7.wav (channel 3) and loops engine4.wav on channel 1 at its own
// rate; every tick raises that rate by 200 Hz, up to 22050. Letting go cuts
// the loop and plays shut-dn7.wav (channel 3). Leaving the flight
// (FUN_0001cbc0) cuts it silently. Each tick also spends one unit of burner
// fuel; fuel is not modelled here, so the burner never runs dry.
const BURNER_TICKS = 6; // DAT_00067a20[0x16]
const BURNER_STEP = 200; // Hz per tick
const BURNER_MAX = 22050; // 0x5622
const burnerSound = { on: false, clock: 1, rate: 0, source: null };

function stepBurnerSound(held, dt) {
  const b = burnerSound;
  if (!held) {
    b.clock = 1; // DAT_000ad944 = 0x10000: the next press ticks at once
    if (b.on) {
      b.on = false;
      b.source = null;
      stopSfx(1);
      playSfx("shut-dn7.wav", 3, 0);
    }
    return;
  }
  b.clock += (dt / GAME_SECOND) * BURNER_TICKS;
  while (b.clock > 1) {
    b.clock -= 1;
    if (!b.on) {
      b.on = true;
      b.rate = 0;
      playSfx("blast7.wav", 3, 0);
      sfxBuffer("engine4.wav").then((buffer) => {
        if (!b.on || !buffer) return;
        b.rate ||= buffer.sampleRate;
        playSfx("engine4.wav", 1, 0, { loop: true }).then((source) => {
          if (!source) return;
          if (!b.on) return source.stop();
          b.source = source;
          source.playbackRate.value = b.rate / buffer.sampleRate;
        });
      });
    } else if (b.rate) {
      b.rate = Math.min(b.rate + BURNER_STEP, BURNER_MAX);
      if (b.source) b.source.playbackRate.value = b.rate / b.source.buffer.sampleRate;
    }
  }
}

function cutBurnerSound() {
  if (burnerSound.on) stopSfx(1);
  burnerSound.on = false;
  burnerSound.source = null;
  burnerSound.clock = 1;
}

// A Crowd's sound callback: pos is in the crowd's space, where the ship is too.
function crowdSound(crowdOf) {
  const at = new THREE.Vector3();
  return (name, channel, pos) => {
    const c = crowdOf();
    at.copy(pos);
    if (!c.tunnel) {
      at.x = ship.pos.x + c.delta(ship.pos.x, at.x);
      at.z = ship.pos.z + c.delta(ship.pos.z, at.z);
    }
    c.parent.localToWorld(at).applyMatrix4(camera.matrixWorldInverse);
    playSfx(name, channel, THREE.MathUtils.clamp(at.x * 64, -63, 63) / 63);
  };
}

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
frameEl.insertBefore(renderer.domElement, frameEl.firstChild);

const scene = new THREE.Scene();
const BACKDROP = new THREE.Color(0x1a1814);
scene.background = BACKDROP.clone();
const camera = new THREE.PerspectiveCamera(ORBIT_FOV, FRAME_W / FRAME_H, 0.05, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// The engine is left-handed: +X right, +Y up, +Z forward, and yaw turns
// clockwise seen from above. Everything inside `world` is placed with raw game
// numbers; the mirror on z turns that into three.js's right-handed space.
// Without it every map comes out mirrored.
const world = new THREE.Group();
world.scale.z = -1;
scene.add(world);
// The surface: terrain, objects and tunnel mouths, plus its wrap copies.
const surface = new THREE.Group();
world.add(surface);
// Inside a tunnel the ship flies in tunnel coordinates and the surface is
// moved so the exit hole lines up with the end of the tube.
const tunnelSpace = new THREE.Group();
tunnelSpace.visible = false;
world.add(tunnelSpace);
const modelStage = new THREE.Group();
world.add(modelStage);

// ---------------------------------------------------------------- palette shading

// Everything is drawn the way the game draws it: 8-bit texture indices, the
// level's .lte light table and .fog table remap the index, and the palette
// gives the color. Terrain is unlit; models and tunnel walls pick a light
// row. Fog (16 hard steps, none closer than ~2 tiles, solid at ~3.8) and the
// 11x11 draw window apply only while flying.
const shade = {
  uFly: { value: 0 },
  uWindow: { value: SURFACE_WINDOW },
  uCamTile: { value: new THREE.Vector2() },
  uGameFrame: { value: new THREE.Matrix4() },
  uSun: { value: new THREE.Vector3(0.7, -0.7, 0).normalize() }, // direction light travels, three.js space
  uAmbient: { value: 0.5 },
  // Damage flash (FUN_0002f700): every pixel becomes the flash color scaled
  // by its own brightness, in 16 steps (flashTint).
  uFlash: { value: 0 },
  uFlashColor: { value: new THREE.Vector3() },
};

const VERTEX = `
uniform mat4 uGameFrame;
uniform vec3 uSun;
uniform float uAmbient;
varying vec2 vUv;
varying vec3 vGame;
varying float vDepth;
varying float vLight;
varying vec2 vRamp;
varying float vLit;
#ifdef MODEL
attribute vec2 ramp;
attribute float lit;
#endif
#ifdef SHADED
attribute float shade;
#endif
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vGame = (uGameFrame * world).xyz;
  vec4 view = viewMatrix * world;
  vDepth = -view.z;
  vLight = 1.0;
  vRamp = vec2(0.0);
  vLit = 0.0;
#ifdef MODEL
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vLight = clamp(uAmbient + max(0.0, dot(n, -uSun)) * (1.0 - uAmbient), 0.0, 1.0);
  vRamp = ramp;
  vLit = lit;
#endif
#ifdef SHADED
  vLight = shade;
  vLit = 1.0;
#endif
  gl_Position = projectionMatrix * view;
}`;

const FRAGMENT = `
uniform sampler2D uMap;
uniform sampler2D uPalette;
uniform sampler2D uFogTable;
uniform sampler2D uLightTable;
uniform float uHasMap;
uniform float uAlpha0;
uniform float uUseLight;
uniform float uFly;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uWindow;
uniform float uWindowed;
uniform float uFogK;
uniform vec2 uCamTile;
varying vec2 vUv;
varying vec3 vGame;
varying float vDepth;
varying float vLight;
varying vec2 vRamp;
varying float vLit;
// FUN_0002f700 per color byte: (tint * min(255, |rgb|) >> 8) >> 4, looked up
// in the 32-level inverse table (FUN_00015340, level k = 8k): about half the
// tint at full brightness.
vec3 flashTint(vec3 rgb) {
  float len = min(255.0, floor(length(rgb * 255.0)));
  return floor(floor(uFlashColor * 255.0 + 0.5) * len / 4096.0) * 8.0 / 255.0;
}
float remap(sampler2D table, float index, float row) {
  return floor(texture2D(table, vec2((index + 0.5) / 256.0, (row + 0.5) / 16.0)).r * 255.0 + 0.5);
}
void main() {
  if (uFly > 0.5 && uWindowed > 0.5) {
    vec2 d = floor(vGame.xz) - uCamTile;
    if (max(abs(d.x), abs(d.y)) > uWindow) discard;
  }
  float index;
  if (uHasMap > 0.5) {
    index = floor(texture2D(uMap, vUv).r * 255.0 + 0.5);
    if (uAlpha0 > 0.5 && index < 0.5) discard;
    if (uUseLight > 0.5 && vLit > 0.5) {
      index = remap(uLightTable, index, clamp(floor((1.0 - vLight) * 15.0 + 0.5), 0.0, 15.0));
    }
  } else {
    index = floor(vRamp.x + vLight * (vRamp.y - vRamp.x) + 0.5);
  }
  if (uFly > 0.5) {
    index = remap(uFogTable, index, clamp(floor(32.0 - uFogK / max(vDepth, 1e-4)), 0.0, 15.0));
  }
  vec3 rgb = texture2D(uPalette, vec2((index + 0.5) / 256.0, 0.5)).rgb;
  if (uFlash > 0.5) rgb = flashTint(rgb);
  gl_FragColor = vec4(rgb, 1.0);
}`;

function dataTexture(bytes, width, height, format = THREE.RedFormat) {
  const texture = new THREE.DataTexture(bytes, width, height, format, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const IDENTITY_TABLE = (() => {
  const table = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) table[i] = i & 255;
  return table;
})();

// A look is one palette with its fog and light tables (from formats.readLevel).
// Uniforms are built once per look and shared by every material using it.
function paletteColor(palette, index) {
  return new THREE.Color().setRGB(palette[index * 3] / 255, palette[index * 3 + 1] / 255,
    palette[index * 3 + 2] / 255, THREE.SRGBColorSpace);
}

const lookCache = new WeakMap();
function lookUniforms(look) {
  let found = lookCache.get(look);
  if (found) return found;
  const rgba = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) rgba.set([look.palette[i * 3], look.palette[i * 3 + 1], look.palette[i * 3 + 2], 255], i * 4);
  const fogAt = look.fogIndex ?? 255;
  found = {
    uPalette: { value: dataTexture(rgba, 256, 1, THREE.RGBAFormat) },
    uFogTable: { value: dataTexture(look.fog || IDENTITY_TABLE, 256, 16) },
    uLightTable: { value: dataTexture(look.light || IDENTITY_TABLE, 256, 16) },
    uUseLight: { value: look.light ? 1 : 0 },
    // The palette is shown as stored, so the clear color is set as sRGB bytes.
    fogColor: paletteColor(look.palette, fogAt),
    // Above the cloud deck the game draws a flat ceiling in color ramp 12,
    // the first sky-band entry (3.5).
    ceilingColor: paletteColor(look.palette, 240),
    // The flash table at 0x682e4: hits use entry 0 (palette 144), the smart
    // bomb entry 2 (palette 31).
    flashColors: [144, 127, 31].map((i) => new THREE.Vector3(look.palette[i * 3], look.palette[i * 3 + 1], look.palette[i * 3 + 2]).divideScalar(255)),
  };
  lookCache.set(look, found);
  return found;
}

function paletteMaterial(look, {
  map = null, alpha0 = false, fogK = FOG_K, windowed = true, model = false, shaded = false,
  side = THREE.FrontSide, depthWrite = true,
} = {}) {
  const lu = lookUniforms(look);
  const defines = {};
  if (model) defines.MODEL = "";
  if (shaded) defines.SHADED = "";
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shade,
      uPalette: lu.uPalette,
      uFogTable: lu.uFogTable,
      uLightTable: lu.uLightTable,
      uUseLight: lu.uUseLight,
      uMap: { value: map },
      uHasMap: { value: map ? 1 : 0 },
      uAlpha0: { value: alpha0 ? 1 : 0 },
      uFogK: { value: fogK },
      uWindowed: { value: windowed ? 1 : 0 },
    },
    defines,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side,
    depthWrite,
  });
}

const clock = new THREE.Clock();
const keys = new Set();
const textureCache = new Map();
const geometryCache = new Map();
const templateCache = new Map();
let archive = null;
let levelList = [];
let level = null;
let heightGrid = null;
let loadGen = 0;
let flying = false;
let paused = false;
let navCursor = -1;
let terrainMeshes = [];
let caveMeshes = null;
let skyMesh = null;
let stars = null;
let props = [];
let portals = [];
let tubeInstances = [];
let spinning = [];
let surfaceCopies = [];
let crowd = null; // surface enemies and NPCs (src/ai.js); tunnels keep their own
const objectUrls = new Map();

const ship = {
  pos: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  rates: new THREE.Vector3(), // body pitch, yaw, roll rates, rad/s
  axes: { pitch: 0, yaw: 0, roll: 0 }, // ramped key input
  stick: new THREE.Vector2(), // mouse as a self-centering stick
  speed: 0,
  throttle: THROTTLE_START,
  space: "surface", // surface | tunnel | cave
  portal: null,
  grace: 0, // seconds left of the 1 s after a hit with no ground or shot damage
  flash: 0, // seconds left of the damage flash
  jolt: new THREE.Vector3(), // body pitch, yaw, roll still to turn from hits, rad
  flashColor: 0, // entry of the flash table (0x682e4): 0 hits, 2 the smart bomb
  // Guns (resetArsenal): weapon DAT_000ad970, ammo and mode by weapon
  // (a7a10/a7a14), the fire clock DAT_000ad944 in shots, and which
  // gun, missile rail and Antimatter offset is next.
  weapon: 1,
  ammo: {},
  mode: {},
  fireClock: 1,
  gunSide: 0,
  missileSide: 0,
  fanStep: 0,
  notice: "", // the last message (pickups, gun modes) and its seconds left
  noticeTime: 0,
};

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

function setStatus(text) {
  //console.log(text);
}
function setError(text) {
  errorEl.textContent = text || "";
}

function resize() {
  camera.aspect = flying ? FLY_ASPECT : FRAME_W / FRAME_H;
  camera.updateProjectionMatrix();
  renderer.setSize(FRAME_W, FRAME_H, false);
}
window.addEventListener("resize", resize);
resize();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

// An art/*.raw image as an index texture. Square sizes only (64x64, 256x256).
function indexTexture(path) {
  if (textureCache.has(path)) return textureCache.get(path);
  const pending = (async () => {
    if (!path || !archive.has(path)) return null;
    const bytes = await archive.bytes(path);
    const side = Math.floor(Math.sqrt(bytes.length));
    if (side * side !== bytes.length) return null;
    return dataTexture(bytes, side, side);
  })();
  textureCache.set(path, pending);
  return pending;
}

function objectUrl(path, type) {
  if (!objectUrls.has(path)) {
    const blob = archive.blob(path, type);
    objectUrls.set(path, blob ? URL.createObjectURL(blob) : null);
  }
  return objectUrls.get(path);
}

function wrapMap(value) {
  return ((value % MAP) + MAP) % MAP;
}

function wrapDelta(from, to) {
  let delta = wrapMap(to - from);
  if (delta > MAP / 2) delta -= MAP;
  return delta;
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function heightByte(x, z) {
  return heightGrid[((z & 255) << 8) | (x & 255)];
}

// Ground height and slope on the exact triangle under (x, z) (FUN_0003c940).
// Tiles where x and z have the same parity are cut (0,0)-(1,1), the others
// (1,0)-(0,1). The mesh uses the same split.
function groundPlane(x, z) {
  if (!heightGrid) return { h: 0, gx: 0, gz: 0 };
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const u = x - fx;
  const v = z - fz;
  const tx = fx & 255;
  const tz = fz & 255;
  const h00 = heightByte(tx, tz) * HEIGHT_PER_BYTE;
  const h01 = heightByte(tx + 1, tz) * HEIGHT_PER_BYTE; // x + 1
  const h10 = heightByte(tx, tz + 1) * HEIGHT_PER_BYTE; // z + 1
  const h11 = heightByte(tx + 1, tz + 1) * HEIGHT_PER_BYTE;
  if ((tx & 1) === (tz & 1)) {
    if (u <= v) return { h: h00 + v * (h10 - h00) + u * (h11 - h10), gx: h11 - h10, gz: h10 - h00 };
    return { h: h00 + u * (h01 - h00) + v * (h11 - h01), gx: h01 - h00, gz: h11 - h01 };
  }
  if (v < 1 - u) return { h: h01 + (1 - u) * (h00 - h01) + v * (h10 - h00), gx: h01 - h00, gz: h10 - h00 };
  return { h: h01 + (1 - u) * (h10 - h11) + v * (h11 - h01), gx: h11 - h10, gz: h11 - h01 };
}

function groundAt(x, z) {
  return groundPlane(x, z).h;
}

function groundNormal(x, z) {
  const { gx, gz } = groundPlane(x, z);
  return new THREE.Vector3(-gx, 1, -gz).normalize();
}

// ---------------------------------------------------------------- terrain

// Two triangles per tile as [dx, dz] corners, wound to face up.
function tileTriangles(x, z) {
  return (x & 1) === (z & 1)
    ? [[0, 0], [0, 1], [1, 1], [0, 0], [1, 1], [1, 0]]
    : [[0, 0], [0, 1], [1, 0], [1, 0], [0, 1], [1, 1]];
}

// One 64x64 texture stretched once over a tile, sampled 0.5..63.5. Texture
// rows run along +x and columns along +z (3.3). Row 0 is v = 0.
function tileUV(dx, dz) {
  return [(dz ? 63.5 : 0.5) / 64, (dx ? 63.5 : 0.5) / 64];
}

// tiles: [x, z, textureSlot]. heightOf(x, z) gives the corner height in tiles.
function groundGeometry(tiles, heightOf, flip = false) {
  const buckets = new Map();
  for (const [x, z, slot] of tiles) {
    let bucket = buckets.get(slot);
    if (!bucket) buckets.set(slot, (bucket = { pos: [], uv: [] }));
    const tri = tileTriangles(x, z);
    for (let t = 0; t < 6; t += 3) {
      const order = flip ? [0, 2, 1] : [0, 1, 2];
      for (const k of order) {
        const [dx, dz] = tri[t + k];
        bucket.pos.push(x + dx, heightOf(x + dx, z + dz), z + dz);
        bucket.uv.push(...tileUV(dx, dz));
      }
    }
  }
  let total = 0;
  for (const bucket of buckets.values()) total += bucket.pos.length / 3;
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const groups = [];
  let start = 0;
  for (const slot of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(slot);
    const count = bucket.pos.length / 3;
    groups.push({ start, count, slot });
    pos.set(bucket.pos, start * 3);
    uv.set(bucket.uv, start * 2);
    start += count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return { geometry, groups };
}

function groundMesh(tiles, heightOf, textures, look, flip = false) {
  const { geometry, groups } = groundGeometry(tiles, heightOf, flip);
  const materials = groups.map((group, i) => {
    geometry.addGroup(group.start, group.count, i);
    return paletteMaterial(look, { map: textures[group.slot] || null });
  });
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.userData.own = true;
  return mesh;
}

// Cave mode (5): floor at h/32, ceiling mirrored about the top at (510-h)/32.
// Quads whose four corners are all 255 are solid rock and are skipped.
function buildCave(textures, index, look) {
  const tiles = [];
  for (let z = 0; z < MAP; z++) {
    for (let x = 0; x < MAP; x++) {
      if (heightByte(x, z) === 255 && heightByte(x + 1, z) === 255
        && heightByte(x, z + 1) === 255 && heightByte(x + 1, z + 1) === 255) continue;
      tiles.push([x, z, index[z * MAP + x]]);
    }
  }
  const floor = (x, z) => heightByte(x, z) * HEIGHT_PER_BYTE;
  const roof = (x, z) => 2 * TOP - heightByte(x, z) * HEIGHT_PER_BYTE;
  const group = new THREE.Group();
  group.add(groundMesh(tiles, floor, textures, look), groundMesh(tiles, roof, textures, look, true));
  group.visible = false;
  return group;
}

// The sky is a flat textured plane fixed in the world at the top height. The
// 64x64 image repeats every 16 tiles, column along +x and row along +z, and
// fades by the same fog at 1/64 the rate (3.5).
function buildSky(texture, look) {
  const map = texture.clone();
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.needsUpdate = true;
  const lo = MAP / 2 - 512;
  const hi = MAP / 2 + 512;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    lo, TOP, lo, hi, TOP, lo, hi, TOP, hi, lo, TOP, lo, hi, TOP, hi, lo, TOP, hi,
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([
    lo / 16, lo / 16, hi / 16, lo / 16, hi / 16, hi / 16, lo / 16, lo / 16, hi / 16, hi / 16, lo / 16, hi / 16,
  ], 2));
  const material = paletteMaterial(look, { map, fogK: SKY_FOG_K, windowed: false, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.add(buildHorizon(look));
  return mesh;
}

// Above the deck FUN_00018610 also draws a wall 4096 tiles ahead of the
// camera, turned with its yaw, from the deck up 512 tiles and +-8192 wide,
// shaded from palette 255 at the bottom to 240 at the top with no texture and
// no fog. It closes the gap between the deck's horizon and the ceiling. Drawn
// here at 1/8 the size and distance, which looks the same, to stay inside the
// far plane. updateSky places it.
const HORIZON_SCALE = 1 / 8;
function buildHorizon(look) {
  const d = 4096 * HORIZON_SCALE;
  const w = 8192 * HORIZON_SCALE;
  const h = 512 * HORIZON_SCALE;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -w, 0, d, w, 0, d, w, h, d, -w, 0, d, w, h, d, -w, h, d,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_, i) => (i % 3 === 2 ? -1 : 0)), 3));
  geometry.setAttribute("ramp", new THREE.Float32BufferAttribute([
    255, 255, 255, 255, 240, 240, 255, 255, 240, 240, 240, 240,
  ], 2));
  geometry.setAttribute("lit", new THREE.Float32BufferAttribute(new Array(6).fill(0), 1));
  const material = paletteMaterial(look, { model: true, fogK: 1e9, windowed: false, side: THREE.DoubleSide, depthWrite: false });
  material.depthTest = false;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -0.5;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

// stars.vox levels: a star field on black.
function buildStars() {
  const pos = [];
  for (let i = 0; i < 1000; i++) {
    const v = new THREE.Vector3().randomDirection();
    if (v.y < -0.1) v.y = -v.y;
    pos.push(v.x * 500, v.y * 500, v.z * 500);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffffff, size: 1, sizeAttenuation: false, fog: false }));
  points.visible = false;
  return points;
}

// ---------------------------------------------------------------- models

// Geometry per model (shared by every level), materials per look.
async function modelGeometry(name) {
  if (geometryCache.has(name)) return geometryCache.get(name);
  const pending = (async () => {
    const path = `models/${name}.bin`;
    if (!archive.has(path)) return null;
    let model = parseBin(await archive.bytes(path), name);
    let keys = null;
    let delay = 0;
    if (model.kind === "anim") {
      // A morph list: faces come from the first frame, vertices from every
      // keyframe (FUN_00040f70). Frames may repeat (claw1 2 3 4 3 2).
      const names = model.frames.map((frame) => frame.toLowerCase().replace(/\.bin$/, ""));
      delay = model.delay || 0x10000;
      const frames = await Promise.all(names.map(async (frame) => {
        const framePath = `models/${frame}.bin`;
        if (!archive.has(framePath)) return null;
        const parsed = parseBin(await archive.bytes(framePath), frame);
        return parsed.kind === "model" ? parsed : null;
      }));
      if (!frames[0]) return null;
      model = frames[0];
      if (frames.length > 1 && frames.every((f) => f && f.vertices.length === model.vertices.length)) {
        keys = frames.map((f) => Float32Array.from(f.vertices.flat(), (v) => v / f.scale));
      }
    }
    const { groups } = binGroups(model);
    const parts = groups.map((g) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.position, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(g.normal, 3));
      geometry.setAttribute("ramp", new THREE.Float32BufferAttribute(g.ramp, 2));
      geometry.setAttribute("lit", new THREE.Float32BufferAttribute(g.lit, 1));
      return {
        geometry, texture: g.texture, animation: g.animation, alpha: g.alpha, inherit: g.inherit,
        source: Int32Array.from(g.source), stored: Float32Array.from(g.normal),
      };
    });
    let radius = 0;
    for (const [x, y, z] of model.vertices) radius = Math.max(radius, Math.hypot(x, y, z) / model.scale);
    if (keys) {
      for (const key of keys) {
        for (let i = 0; i < key.length; i += 3) radius = Math.max(radius, Math.hypot(key[i], key[i + 1], key[i + 2]));
      }
      // Bounds cover every keyframe, so blended poses are never culled.
      for (const part of parts) part.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
      morphs.add({ parts, keys, delay });
    }
    // Vertices in tiles, first frame: enemy muzzles (FUN_00024540).
    const vertices = model.vertices.map((v) => v.map((c) => (c / model.scale) * MODEL_SCALE));
    return { parts, radius: radius * MODEL_SCALE, vertices };
  })().catch((err) => {
    console.warn(`model ${name}:`, err);
    return null;
  });
  geometryCache.set(name, pending);
  return pending;
}

// inherit: texture for faces that take the caller's (tunnel obstacle models).
async function loadModel(name, look, inherit = null) {
  const key = `${name}|${inherit || ""}`;
  let byLook = templateCache.get(look);
  if (!byLook) templateCache.set(look, (byLook = new Map()));
  if (byLook.has(key)) return byLook.get(key);
  const pending = (async () => {
    const built = await modelGeometry(name);
    if (!built) return null;
    const object = new THREE.Group();
    for (const part of built.parts) {
      const frames = part.animation
        ? await Promise.all(part.animation.frames.map((frame) => indexTexture(`art/${frame}`)))
        : null;
      const map = frames ? frames[0]
        : part.texture ? await indexTexture(`art/${part.texture}`)
        : part.inherit && inherit ? await indexTexture(inherit) : null;
      // Every .bin face is single-sided; DoubleSide covers faces whose stored
      // normal and winding disagree.
      const material = paletteMaterial(look, {
        map, alpha0: part.alpha, model: true, windowed: false,
        fogK: FOG_OBJECTS ? FOG_K : 1e12, side: THREE.DoubleSide,
      });
      object.add(new THREE.Mesh(part.geometry, material));
      if (frames) flipbooks.add({ material, frames, delay: part.animation.delay });
    }
    object.scale.setScalar(MODEL_SCALE);
    return { object, radius: built.radius, vertices: built.vertices };
  })();
  byLook.set(key, pending);
  return pending;
}

// ---------------------------------------------------------------- animation

// Both run on one global game clock, so every copy of a model moves in step.
// Morph lists blend four keyframes on a Catmull-Rom spline (FUN_00040f70:
// t = clock mod (delay * count), key = t / delay). Geometry is shared by
// every copy and level, so each morph is updated once per frame.
const morphs = new Set();
// Animated textures flip frames: (clock / delay) mod count (FUN_00016d50).
const flipbooks = new Set();
let animClock = 0;

function catmullRom(f) {
  const f2 = f * f;
  const f3 = f2 * f;
  return [
    -0.5 * f3 + f2 - 0.5 * f,
    1.5 * f3 - 2.5 * f2 + 1,
    -1.5 * f3 + 2 * f2 + 0.5 * f,
    0.5 * f3 - 0.5 * f2,
  ];
}

const morphA = new THREE.Vector3();
const morphB = new THREE.Vector3();
function updateMorph(morph, ticks) {
  const { keys, delay, parts } = morph;
  const n = keys.length;
  const t = ticks % (delay * n);
  const k = Math.floor(t / delay);
  const w = catmullRom((t - k * delay) / delay);
  const ks = [keys[(k + n - 1) % n], keys[k], keys[(k + 1) % n], keys[(k + 2) % n]];
  for (const part of parts) {
    const pos = part.geometry.attributes.position;
    const nrm = part.geometry.attributes.normal;
    const p = pos.array;
    for (let i = 0; i < part.source.length; i++) {
      const s = part.source[i] * 3;
      for (let c = 0; c < 3; c++) {
        p[i * 3 + c] = w[0] * ks[0][s + c] + w[1] * ks[1][s + c] + w[2] * ks[2][s + c] + w[3] * ks[3][s + c];
      }
    }
    // The game recomputes face planes after blending; keep the stored side.
    for (let i = 0; i + 8 < p.length; i += 9) {
      morphA.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]);
      morphB.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]);
      morphA.cross(morphB);
      if (morphA.lengthSq() < 1e-12) continue;
      morphA.normalize();
      const st = part.stored;
      if (morphA.x * st[i] + morphA.y * st[i + 1] + morphA.z * st[i + 2] < 0) morphA.negate();
      for (let v = 0; v < 9; v += 3) nrm.array.set([morphA.x, morphA.y, morphA.z], i + v);
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }
}

function updateAnimations(dt) {
  animClock += dt;
  const ticks = (animClock / GAME_SECOND) * 65536;
  for (const morph of morphs) updateMorph(morph, ticks);
  for (const book of flipbooks) {
    const map = book.frames[Math.floor(ticks / book.delay) % book.frames.length];
    if (map) book.material.uniforms.uMap.value = map;
  }
}

// The projectile models the level's enemies fire (SHOT_MODELS by def `shot`),
// as a factory for Crowd.
async function loadShots(spots, look) {
  const types = new Set(spots.filter(isActor).map((spot) => spot.def.ai.shot));
  for (const weapon of [1, 2, 3]) types.add(weapon); // the player's guns
  const shots = new Map();
  await Promise.all([...types].map(async (type) => {
    const template = SHOT_MODELS[type] && await loadModel(SHOT_MODELS[type], look);
    if (template) shots.set(type, template);
  }));
  return (type) => shots.get(type)?.object.clone(true) || null;
}

// Impacts, smoke, debris, the player's missiles and power-ups for
// Crowd.fx: blast1-16, bigex1-16, billow1-16 and puff1-4.raw on squares
// (FUN_00018f30 loads them), bradmis.bin, frag1-3.bin and pipe.bin
// (FUN_00018dc0), and the twelve power-up models.
const effectsCache = new WeakMap();
function loadEffects(look) {
  if (effectsCache.has(look)) return effectsCache.get(look);
  const pending = (async () => {
    const frames = (name, count) => Promise.all(Array.from({ length: count }, (_, i) => indexTexture(`art/${name}${i + 1}.raw`)));
    const names = ["bradmis", ...DEBRIS_MODELS, ...POWERUP_MODELS];
    const [blast, bigex, billow, puff, ...models] = await Promise.all([
      frames("blast", 16), frames("bigex", 16), frames("billow", 16), frames("puff", 4),
      ...names.map((name) => loadModel(name, look)),
    ]);
    const templates = new Map(names.map((name, i) => [name, models[i]]));
    const sets = { blast, bigex, billow, puff };
    // Squares in units of the impact's size, by their UV tables
    // (FUN_00019a30, FUN_00019e00, FUN_00019c40): blast +-1 with the
    // image's first row at the bottom, bigex +-1/2 across and 0..1 up,
    // billow +-1 across and -1/2..3/2 up, both with the first row at the
    // top. [I] Puffs (FUN_0001c610) +-1, first row at the top.
    const square = (x0, x1, y0, y1, topRow) => {
      const geometry = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
      geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
      const uv = geometry.getAttribute("uv");
      if (topRow) for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      return geometry;
    };
    const shapes = {
      blast: square(-1, 1, -1, 1, false),
      puff: square(-1, 1, -1, 1, true),
      bigex: square(-0.5, 0.5, 0, 1, true),
      billow: square(-1, 1, -0.5, 1.5, true),
    };
    return {
      sprite(kind) {
        const list = sets[kind];
        if (!list?.[0]) return null;
        const material = paletteMaterial(look, { map: list[0], alpha0: true, windowed: false, side: THREE.DoubleSide, depthWrite: false });
        const mesh = new THREE.Mesh(shapes[kind], material);
        mesh.userData.frames = list;
        return mesh;
      },
      frame(mesh, index) {
        const map = mesh.userData.frames?.[index];
        if (map) mesh.material.uniforms.uMap.value = map;
      },
      model: (name) => templates.get(name)?.object.clone(true) || null,
      pickup(type) {
        const template = templates.get(POWERUP_MODELS[type]);
        return template ? { mesh: template.object.clone(true), radius: template.radius } : null;
      },
    };
  })();
  effectsCache.set(look, pending);
  return pending;
}

// A def's second model, shown once the slot is wrecked (logic 9), or for a
// C-Nome the model of the def it turns into.
async function wreckFor(spot, look, position, cache) {
  const name = spot.def.logic === 0x13 ? spot.def.remains?.model : spot.def.logic === 9 ? spot.def.wreck : null;
  if (!name) return null;
  if (!cache.has(name)) cache.set(name, loadModel(name, look));
  const template = await cache.get(name);
  if (!template) return null;
  const mesh = placeModel(template, position.x, position.y, position.z, spot);
  return { mesh, vertices: template.vertices };
}

function placeModel(template, x, y, z, spot) {
  const clone = template.object.clone(true);
  clone.position.set(x, y, z);
  // Game R = Ry(yaw) Rx(pitch) Rz(roll); three's "YXZ" is the same product.
  clone.rotation.set(spot.pitch || 0, spot.yaw || 0, spot.roll || 0, "YXZ");
  clone.userData.tile = [Math.floor(x), Math.floor(z)];
  return clone;
}

// ---------------------------------------------------------------- tunnels

// Ring vertex i at angle a0 + i (a1 - a0) / (N - missing); the last `missing`
// vertices collapse to the centre (6.2). A partial arc closes with a flat face.
function ringPoints(seg, end, spin) {
  const [c, r, span] = end ? [seg.end, seg.r1, seg.b] : [seg.start, seg.r0, seg.a];
  const open = seg.sides - seg.missing;
  const pts = [];
  for (let i = 0; i < seg.sides; i++) {
    if (i >= open) {
      pts.push([c[0] * TUNNEL_UNIT, c[1] * TUNNEL_UNIT]);
      continue;
    }
    const theta = ((span[0] + (i * (span[1] - span[0])) / open) / 65536) * TAU + spin;
    pts.push([(c[0] + r[0] * Math.cos(theta)) * TUNNEL_UNIT, (c[1] + r[1] * Math.sin(theta)) * TUNNEL_UNIT]);
  }
  return pts;
}

function inwardNormals(pts) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x / pts.length;
    cy += y / pts.length;
  }
  return pts.map(([x, y], i) => {
    const [nx2, ny2] = pts[(i + 1) % pts.length];
    let nx = -(ny2 - y);
    let ny = nx2 - x;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) return null;
    nx /= len;
    ny /= len;
    if ((cx - x) * nx + (cy - y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny, x, y];
  });
}

function writeSegment(position, seg, k, slots, time) {
  const spin = (seg.spin / 65536) * TAU * (time / GAME_SECOND);
  const s = ringPoints(seg, false, spin);
  const e = ringPoints(seg, true, spin);
  for (let i = 0; i < seg.sides; i++) {
    const j = (i + 1) % seg.sides;
    const quad = [[s[i], k], [s[j], k], [e[j], k + 1], [s[i], k], [e[j], k + 1], [e[i], k + 1]];
    let o = slots[i] * 3;
    for (const [[x, y], z] of quad) {
      position[o++] = x;
      position[o++] = y;
      position[o++] = z;
    }
  }
}

// Tube segments in tunnel space: segment k runs from z = base + k to base + k + 1.
// One texture per face per segment, u around, v along (texels 1..255). The
// light face uses the lit quarter of its texture (6.2).
function buildTube(segments, wallTextures, look, base = 0) {
  const faces = [];
  segments.forEach((seg, k) => {
    const normals = inwardNormals(ringPoints(seg, false, 0));
    const lamp = seg.lightFace >= 0 && seg.lightFace < seg.sides ? normals[seg.lightFace] : null;
    for (let i = 0; i < seg.sides; i++) {
      // [I] brightness: ambient plus the light face's directional term.
      let b = seg.ambient / 65536;
      if (lamp && normals[i]) b += (seg.lightLevel / 65536) * Math.max(0, -(normals[i][0] * lamp[0] + normals[i][1] * lamp[1]));
      if (i === seg.lightFace) b = 1;
      faces.push({ k, i, tex: seg.faces[i] ?? 0, light: i === seg.lightFace, b: Math.min(1, b) });
    }
  });
  faces.sort((a, b) => a.tex - b.tex);
  const count = faces.length * 6;
  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const brightness = new Float32Array(count);
  const slotsBySegment = segments.map((seg) => new Array(seg.sides));
  const geometry = new THREE.BufferGeometry();
  const materials = [];
  let groupStart = 0;
  faces.forEach((face, n) => {
    slotsBySegment[face.k][face.i] = n * 6;
    const u1 = (face.light ? 127 : 255) / 256;
    const v1 = (face.light ? 127 : 255) / 256;
    const u0 = 1 / 256;
    const v0 = 1 / 256;
    const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]];
    corners.forEach(([u, v], c) => {
      uv[(n * 6 + c) * 2] = u;
      uv[(n * 6 + c) * 2 + 1] = v;
      brightness[n * 6 + c] = face.b;
    });
    const next = faces[n + 1];
    if (!next || next.tex !== face.tex) {
      geometry.addGroup(groupStart, (n + 1) * 6 - groupStart, materials.length);
      materials.push(paletteMaterial(look, {
        map: wallTextures[face.tex] || null, shaded: true, windowed: false, side: THREE.DoubleSide,
      }));
      groupStart = (n + 1) * 6;
    }
  });
  segments.forEach((seg, k) => writeSegment(position, seg, base + k, slotsBySegment[k], 0));
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute("shade", new THREE.BufferAttribute(brightness, 1));
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.frustumCulled = false;
  mesh.userData.own = true;
  const spins = segments.map((seg, k) => ({ seg, k })).filter(({ seg }) => seg.spin);
  if (spins.length) spinning.push({ geometry, base, slots: slotsBySegment, spins });
  return mesh;
}

function updateSpinners(time) {
  for (const tube of spinning) {
    const position = tube.geometry.attributes.position;
    for (const { seg, k } of tube.spins) writeSegment(position.array, seg, tube.base + k, tube.slots[k], time);
    position.needsUpdate = true;
  }
}

// Mouth frames (6.3): n is the normal of the exact ground triangle. The
// entrance faces into the ground (tunnel +Z = -n), the exit out of it.
function portalFrame(x, z, into) {
  const n = groundNormal(x, z);
  const h = Math.hypot(n.x, n.z);
  const yaw = into ? Math.atan2(-n.x, -n.z) : Math.atan2(n.x, n.z);
  const pitch = into ? Math.atan2(n.y, h) : -Math.atan2(n.y, h);
  return {
    pos: new THREE.Vector3(x, groundAt(x, z), z),
    q: new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ")),
  };
}

// Tunnel point p sits at frame.pos + R (p - anchor).
function placeInFrame(object, frame, anchor) {
  object.quaternion.copy(frame.q);
  object.position.copy(frame.pos).sub(anchor.clone().applyQuaternion(frame.q));
}

async function buildPortal(data, gen) {
  const segments = data.segments || [];
  if (!segments.length) return null;
  const walls = await Promise.all(data.walls.map((path) => indexTexture(path).catch(() => null)));
  if (gen !== loadGen) throw new Cancelled();
  const look = data.look;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const portal = {
    data,
    segments,
    look,
    length: segments.length,
    start: new THREE.Vector3(first.start[0] * TUNNEL_UNIT, first.start[1] * TUNNEL_UNIT, 0),
    end: new THREE.Vector3(last.end[0] * TUNNEL_UNIT, last.end[1] * TUNNEL_UNIT, segments.length),
    entrance: portalFrame(data.entrance.x, data.entrance.z, true),
    exit: portalFrame(data.exit.x, data.exit.z, false),
    tube: buildTube(segments, walls, look),
    // The surface shows only the first segments under the entrance and the
    // last ones under the exit, and only near the mouth.
    entranceStub: buildTube(segments.slice(0, TUBE_STUB), walls, look),
    exitStub: buildTube(segments.slice(-TUBE_STUB), walls, look, Math.max(0, segments.length - TUBE_STUB)),
    props: new THREE.Group(),
  };
  portal.crowd = new Crowd({ parent: portal.props, tunnel: segments, shotModel: await loadShots(data.contents || [], look) });
  portal.crowd.sound = crowdSound(() => portal.crowd);
  portal.crowd.hitPlayer = shotHit;
  portal.crowd.pickUp = pickUp;
  portal.crowd.fx = await loadEffects(look);
  // FUN_00039820: the ship's wall test with no margin, then the obstacles
  // (FUN_00038820), which a shot or missile damages as it hits.
  portal.crowd.inWall = (p, damage = 0) => containInTube(portal, tmpWall.copy(p), elapsed, 0)
    || collideObstacle(portal, tmpWall.copy(p), elapsed, damage, true);
  const names = [...new Set((data.contents || []).map((spot) => spot.model))];
  const templates = new Map();
  await mapLimit(names, 3, async (name) => templates.set(name, await loadModel(name, look)));
  if (gen !== loadGen) throw new Cancelled();
  // Tunnel props keep their file x, y, z in tunnel space (6.2).
  const wrecks = new Map();
  for (const spot of data.contents || []) {
    const template = templates.get(spot.model);
    if (!template) continue;
    const obj = placeModel(template, spot.x, spot.y, spot.z, spot);
    portal.props.add(obj);
    if (spot.powerup !== undefined) portal.crowd.addPickup(obj, spot.powerup, template.radius);
    else if (isActor(spot)) portal.crowd.add(obj, spot, template.radius, template.vertices, await wreckFor(spot, look, obj.position, wrecks));
  }
  portal.obstacles = await buildObstacles(portal, walls);
  if (gen !== loadGen) throw new Cancelled();
  return portal;
}

// Wall collision: keep the ship WALL_MARGIN inside every face of the ring
// polygon at its depth.
const tmpWall = new THREE.Vector3();
function containInTube(portal, p, time, margin = WALL_MARGIN) {
  const k = Math.min(portal.length - 1, Math.max(0, Math.floor(p.z)));
  const seg = portal.segments[k];
  const t = THREE.MathUtils.clamp(p.z - k, 0, 1);
  const spin = (seg.spin / 65536) * TAU * (time / GAME_SECOND);
  const s = ringPoints(seg, false, spin);
  const e = ringPoints(seg, true, spin);
  const ring = s.map(([x, y], i) => [x + (e[i][0] - x) * t, y + (e[i][1] - y) * t]);
  let moved = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const edge of inwardNormals(ring)) {
      if (!edge) continue;
      const [nx, ny, ax, ay] = edge;
      const d = (p.x - ax) * nx + (p.y - ay) * ny;
      if (d < margin) {
        moved = true;
        p.x += nx * (margin - d);
        p.y += ny * (margin - d);
      }
    }
  }
  return moved;
}

// ---------------------------------------------------------------- tunnel obstacles

// Each segment may carry an obstacle on its start plane (FUN_00037620 draws,
// FUN_00038820 collides). Geometry is in file units around the start-ring
// centre; 0x200 units (1/8 tile) is the depth of an obstacle and of its lip.
// Animated ones run off a per-segment phase that starts at a random value.
const OBSTACLE_DEPTH = 0x200;
const PHASE_RATE = 0x4000; // doors, jaws, fan, iris: a quarter cycle per game second
const ELECTRIC_FRAMES = ["art/electri3.raw", "art/electri2.raw", "art/electri1.raw", "art/electri0.raw"];

function plateGeometry(quads) {
  const pos = [];
  const uv = [];
  for (const q of quads) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(q.v[i][0] * TUNNEL_UNIT, q.v[i][1] * TUNNEL_UNIT, q.v[i][2] * TUNNEL_UNIT);
      uv.push(q.uv[i][0] / 256, q.uv[i][1] / 256);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

// Half plates (types 4-7 and 0xC-0xF): the far part of one axis is closed,
// from `edge` out to the wall, with a lip facing the open side.
function halfPlate(axis, sign, edge, rx, ry) {
  const T = OBSTACLE_DEPTH;
  const pt = axis === "y" ? (a, b, z) => [a, sign * b, z] : (a, b, z) => [sign * b, a, z];
  const [across, out] = axis === "y" ? [rx, ry] : [ry, rx];
  return [
    { v: [pt(across, edge, 0), pt(across, out, 0), pt(-across, out, 0), pt(-across, edge, 0)], uv: [[1, 1], [1, 128], [255, 128], [255, 1]] },
    { v: [pt(across, edge, 0), pt(-across, edge, 0), pt(-across, edge, T), pt(across, edge, T)], uv: [[1, 1], [255, 1], [255, 16], [1, 16]] },
  ];
}

function fullPlate(rx, ry, u0 = 1, u1 = 255, v0 = 1, v1 = 255) {
  return [{ v: [[rx, ry, 0], [-rx, ry, 0], [-rx, -ry, 0], [rx, -ry, 0]], uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] }];
}

function obstacleQuads(type, rx, ry) {
  const T = OBSTACLE_DEPTH;
  switch (type) {
    case 1: { // a frame around a hole half the ring's size
      const hx = rx / 2;
      const hy = ry / 2;
      const ring = [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]];
      const outer = [[rx, ry], [-rx, ry], [-rx, -ry], [rx, -ry]];
      return ring.map((p, i) => {
        const j = (i + 1) % 4;
        const v = [[...p, 0], [...ring[j], 0], [...outer[j], 0], [...outer[i], 0]];
        return { v, uv: v.map(([x, y]) => [128 + (127 * x) / rx, 128 + (127 * y) / ry]) };
      });
    }
    case 2: return fullPlate(rx, ry, 1, 127, 1, 127); // barrier, intact quarter of its texture
    case 3: return fullPlate(rx, ry, 129, 255, 1, 127); // barrier, wrecked
    case 4: return halfPlate("y", 1, ry / 8, rx, ry);
    case 5: return halfPlate("y", -1, ry / 8, rx, ry);
    case 6: return halfPlate("x", -1, rx / 8, rx, ry);
    case 7: return halfPlate("x", 1, rx / 8, rx, ry);
    case 0xc: return halfPlate("y", 1, 0, rx, ry);
    case 0xd: return halfPlate("y", -1, 0, rx, ry);
    case 0xe: return halfPlate("x", -1, 0, rx, ry);
    case 0xf: return halfPlate("x", 1, 0, rx, ry);
    case 8: case 9: case 10: case 11: return fullPlate(rx, ry); // sliding door
    case 0x19: return fullPlate(rx, ry); // force field
    case 0x10: // half plate turning with the segment (FUN_000363c0)
      return [{ v: [[rx, 0, 0], [rx, -ry, 0], [-rx, -ry, 0], [-rx, 0, 0]], uv: [[1, 1], [1, 128], [255, 128], [255, 1]] }];
    case 0x11: // three quarters closed, turning with the segment (FUN_00036500)
      return [
        { v: [[rx, 0, 0], [rx, 0, T], [0, 0, T], [0, 0, 0]], uv: [[255, 127], [255, 127], [127, 127], [127, 127]] },
        { v: [[0, 0, 0], [0, 0, T], [0, ry, T], [0, ry, 0]], uv: [[127, 127], [127, 127], [127, 255], [127, 255]] },
        { v: [[rx, 0, 0], [-rx, 0, 0], [-rx, -ry, 0], [rx, -ry, 0]], uv: [[255, 127], [1, 127], [1, 1], [255, 1]] },
        { v: [[0, 0, 0], [0, ry, 0], [-rx, ry, 0], [-rx, 0, 0]], uv: [[127, 127], [127, 255], [1, 255], [1, 127]] },
      ];
    default: return null;
  }
}

function triangleWave(phase) {
  const p = phase & 0xffff;
  return p > 0x8000 ? 0x10000 - p : p; // 0..0x8000
}

// Unit obstacle models span about +-256 on the axis given; that maps to the radius.
async function obstacleModel(name, look, inherit, radius, axis) {
  const template = await loadModel(name, look, inherit);
  if (!template) return null;
  const object = template.object.clone(true);
  const box = new THREE.Box3().setFromObject(object);
  const extent = axis === "x" ? Math.max(-box.min.x, box.max.x) : Math.max(-box.min.y, box.max.y);
  object.scale.multiplyScalar((radius * TUNNEL_UNIT) / Math.max(extent, 1e-6));
  return object;
}

async function buildObstacles(portal, walls) {
  const look = portal.look;
  const list = [];
  for (const [k, seg] of portal.segments.entries()) {
    const type = seg.obstacle;
    if (!type) continue;
    const [rx, ry] = seg.r0;
    const texPath = portal.data.walls[seg.obstacleTex] || null;
    const map = walls[seg.obstacleTex] || null;
    const group = new THREE.Group();
    group.position.set(seg.start[0] * TUNNEL_UNIT, seg.start[1] * TUNNEL_UNIT, k);
    const ob = { k, seg, type, group, phase: Math.floor(Math.random() * 0x10000), hp: seg.hp, parts: {} };
    const quads = obstacleQuads(type, rx, ry);
    if (quads) {
      const material = paletteMaterial(look, { map, windowed: false, side: THREE.DoubleSide, alpha0: type === 3 });
      ob.parts.plate = new THREE.Mesh(plateGeometry(quads), material);
      ob.parts.plate.userData.own = true;
      group.add(ob.parts.plate);
      if (type === 2) ob.parts.wreck = new THREE.Mesh(plateGeometry(obstacleQuads(3, rx, ry)),
        paletteMaterial(look, { map, windowed: false, side: THREE.DoubleSide, alpha0: true }));
      if (type === 0x19) {
        ob.parts.frames = await Promise.all(ELECTRIC_FRAMES.map((path) => indexTexture(path)));
      }
    } else if (type === 0x12) { // fan: body plus a turning blade (FUN_00036de0) [I] sizes
      ob.parts.body = await obstacleModel("fanbody", look, texPath, ry / 1.125, "y");
      ob.parts.blade = await obstacleModel("blade", look, texPath, ry / 1.125 / 1.25, "y");
      for (const part of [ob.parts.body, ob.parts.blade]) if (part) group.add(part);
    } else if (type === 0x13 || type === 0x14) { // jaws opening apart (FUN_00036ea0/FUN_00036fe0)
      const r = type === 0x13 ? ry : rx;
      const axis = type === 0x13 ? "y" : "x";
      ob.parts.jaws = [await obstacleModel("jaw1", look, texPath, r, "y"), await obstacleModel("jaw2", look, texPath, r, "y")];
      ob.parts.jaws.forEach((jaw, i) => {
        if (!jaw) return;
        if (type === 0x13) jaw.rotation.z = Math.PI / 2;
        // [I] Each jaw's teeth edge (jaw1's near side, jaw2's far side along
        // the axis) is kept at the opening the collision uses, +-0x230.
        jaw.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(jaw);
        jaw.userData.teeth = i === 0 ? box.min[axis] : box.max[axis];
        group.add(jaw);
      });
    } else if (type >= 0x15 && type <= 0x18) { // beam across one side, turned 0/180/90/270
      const beam = await obstacleModel("beam", look, texPath, type <= 0x16 ? rx : ry, "x");
      if (beam) {
        beam.rotation.z = [0, Math.PI, Math.PI / 2, -Math.PI / 2][type - 0x15];
        group.add(beam);
      }
    } else if (type === 0x1e) { // iris: morphs between iris1 and iris4
      ob.parts.iris = await buildIris(look, texPath, rx);
      if (ob.parts.iris) group.add(ob.parts.iris.object);
    }
    if (group.children.length || ob.parts.frames) {
      portal.props.add(group);
      list.push(ob);
    }
  }
  return list;
}

async function buildIris(look, texPath, rx) {
  const [a, b] = await Promise.all([modelGeometry("iris1"), modelGeometry("iris4")]);
  if (!a || !b || a.parts.length !== b.parts.length) return null;
  const object = await obstacleModel("iris1", look, texPath, rx, "x");
  if (!object) return null;
  const meshes = object.children.map((mesh) => {
    mesh.geometry = mesh.geometry.clone();
    return mesh;
  });
  const from = a.parts.map((part) => part.geometry.attributes.position.array);
  const to = b.parts.map((part) => part.geometry.attributes.position.array);
  return {
    object,
    set(f) {
      meshes.forEach((mesh, i) => {
        const pos = mesh.geometry.attributes.position;
        if (to[i].length !== pos.array.length) return;
        for (let n = 0; n < pos.array.length; n++) pos.array[n] = from[i][n] + (to[i][n] - from[i][n]) * f;
        pos.needsUpdate = true;
      });
    },
  };
}

function obstaclePhase(ob, time, rate = PHASE_RATE) {
  return Math.floor(ob.phase + (time / GAME_SECOND) * rate);
}

// Per-frame animation, on the original's timings.
function updateObstacles(portal, time) {
  for (const ob of portal.obstacles || []) {
    const { seg, type, parts } = ob;
    const [rx, ry] = seg.r0;
    const phase = obstaclePhase(ob, time);
    if (type === 0x10 || type === 0x11) {
      // The plate turns with the segment's start angle (a0 + spin).
      ob.group.rotation.z = ((seg.a[0] + seg.spin * (time / GAME_SECOND)) / 65536) * TAU;
    } else if (type >= 8 && type <= 11) {
      // Sliding doors: offset 0..2r over a 4-second cycle. The game shifts
      // the camera by the offset, so the plate moves the other way.
      const r = type <= 9 ? rx : ry;
      const off = (r * 4 * triangleWave(phase)) / 65536;
      const shift = (type === 8 || type === 10 ? -off : off) * TUNNEL_UNIT;
      parts.plate.position.set(type <= 9 ? shift : 0, type <= 9 ? 0 : shift, 0);
    } else if (type === 0x12) {
      if (parts.blade) parts.blade.rotation.z = ((phase & 0xffff) / 65536) * TAU;
    } else if (type === 0x13 || type === 0x14) {
      const off = ((type === 0x13 ? ry : rx) * 2 * triangleWave(phase)) / 65536 * TUNNEL_UNIT;
      const [jaw1, jaw2] = parts.jaws;
      const at = (jaw, edge) => {
        if (!jaw) return;
        const d = edge - jaw.userData.teeth;
        if (type === 0x13) jaw.position.set(0, d, 0);
        else jaw.position.set(d, 0, 0);
      };
      at(jaw1, off);
      at(jaw2, -off);
    } else if (type === 0x19) {
      // On for the first half of each game second, cycling four frames.
      const p = obstaclePhase(ob, time, 0x10000) & 0xffff;
      const on = p < 0x8000;
      parts.plate.visible = on;
      if (on && parts.frames) parts.plate.material.uniforms.uMap.value = parts.frames[(p >> 13) & 3];
    } else if (type === 0x1e && parts.iris) {
      parts.iris.set(triangleWave(phase) / 0x8000);
    } else if (type === 2 && ob.hp <= 0 && !ob.wrecked) {
      ob.wrecked = true;
      ob.group.remove(parts.plate);
      ob.group.add(parts.wreck);
    }
  }
}

// FUN_00037260: an electric field (0x19) that is drawn, i.e. in the segment
// you are in or the 4 ahead (FUN_00039a70), plays electric.wav (channel 3,
// centred) each time its game-second timer wraps, when it switches on.
const DRAWN_SEGMENTS = 5;
function electricSound(portal, before, now) {
  const k = Math.floor(ship.pos.z);
  for (const ob of portal.obstacles || []) {
    if (ob.type !== 0x19 || ob.k < k || ob.k >= k + DRAWN_SEGMENTS) continue;
    if (obstaclePhase(ob, now, 0x10000) >> 16 !== obstaclePhase(ob, before, 0x10000) >> 16) {
      playSfx("electric.wav", 3, 0);
    }
  }
}

// Collision (FUN_00038820): inside the first 1/8 tile of a segment, the
// obstacle clamps the ship's position across the shaft. Returns whether it did.
// damage: what a destructible barrier (2) loses, times 4 (the ship's push
// passes 0x10000, a shot its damage). Each push there counts as a hit until
// the barrier breaks; then it blows up across the tunnel (impact of the
// segment's x radius, debris) and stops blocking.
function collideObstacle(portal, p, time, damage = 0x10000, plates = false) {
  const k = Math.floor(p.z);
  const ob = (portal.obstacles || []).find((o) => o.k === k);
  if (!ob) return false;
  const depth = (p.z - k) * 4096;
  if (!(depth > 0 && depth < OBSTACLE_DEPTH)) return false;
  const { seg, type } = ob;
  const [rx, ry] = seg.r0;
  let X = p.x * 4096 - seg.start[0];
  let Y = p.y * 4096 - seg.start[1];
  const phase = obstaclePhase(ob, time);
  const doorOff = (r) => (r * 4 * triangleWave(phase)) / 65536;
  const jawOff = (r) => (r * 2 * triangleWave(phase)) / 65536;
  switch (type) {
    case 2: {
      if (ob.broken) return false;
      ob.hp -= 4 * damage;
      if (ob.hp <= 0) {
        ob.broken = true;
        portal.crowd?.impact(p.clone(), rx / 4096, 1);
      }
      return true;
    }
    case 4: case 0x15: case 0x1a: if (Y > ry / 8) Y = 0; break;
    case 5: case 0x16: case 0x1b: if (Y < -ry / 8) Y = 0; break;
    case 6: case 0x17: case 0x1c: if (X < -rx / 8) X = 0; break;
    case 7: case 0x18: case 0x1d: if (X > rx / 8) X = 0; break;
    case 8: X = Math.max(X, rx - doorOff(rx)); break;
    case 9: X = Math.min(X, doorOff(rx) - rx); break;
    case 10: Y = Math.max(Y, ry - doorOff(ry)); break;
    case 11: Y = Math.min(Y, doorOff(ry) - ry); break;
    case 0xc: if (Y > 0) Y = 0; break;
    case 0xd: if (Y < 0) Y = 0; break;
    case 0xe: if (X < 0) X = 0; break;
    case 0xf: if (X > 0) X = 0; break;
    case 0x12: { // only a slot rx/8 wide, turning with the fan, is open
      const a = ((phase & 0xffff) / 65536) * TAU;
      const u = THREE.MathUtils.clamp(X * Math.cos(-a) - Y * Math.sin(-a), -rx / 8, rx / 8);
      const v = X * Math.sin(-a) + Y * Math.cos(-a);
      X = u * Math.cos(a) - v * Math.sin(a);
      Y = u * Math.sin(a) + v * Math.cos(a);
      break;
    }
    case 0x13: Y = THREE.MathUtils.clamp(Y, -jawOff(ry), jawOff(ry)); break;
    case 0x14: X = THREE.MathUtils.clamp(X, -jawOff(rx), jawOff(rx)); break;
    case 0x19: if ((obstaclePhase(ob, time, 0x10000) & 0xffff) < 0x8000) { X = 0; Y = 0; } break;
    case 0x10: case 0x11: { // [port] turning plates stop shots (plates); the ship flies through, as in the original
      if (!plates) return false;
      const a = ((seg.a[0] + seg.spin * (time / GAME_SECOND)) / 65536) * TAU;
      const u = X * Math.cos(a) + Y * Math.sin(a);
      const v = -X * Math.sin(a) + Y * Math.cos(a);
      return type === 0x10 ? v < 0 : !(u > 0 && v > 0);
    }
    case 0x1e: { // the iris opening, up to half the radius
      const open = (triangleWave(phase) * rx) / 65536;
      const dist = Math.hypot(X, Y);
      if (dist > open && dist > 0) {
        X *= open / dist;
        Y *= open / dist;
      }
      break;
    }
    default: return false;
  }
  const x = (seg.start[0] + X) / 4096;
  const y = (seg.start[1] + Y) / 4096;
  const moved = Math.abs(x - p.x) + Math.abs(y - p.y) > 1e-9;
  p.x = x;
  p.y = y;
  return moved;
}

// ---------------------------------------------------------------- level

// Only level-built geometry is freed; model geometry and textures are cached
// across levels.
function disposeTree(root) {
  root.traverse((obj) => {
    if (obj.userData.own) obj.geometry?.dispose();
  });
}

function clearLevel() {
  for (const child of [...surface.children]) {
    surface.remove(child);
    disposeTree(child);
  }
  for (const child of [...tunnelSpace.children]) tunnelSpace.remove(child);
  for (const child of [...modelStage.children]) modelStage.remove(child);
  if (stars) scene.remove(stars);
  skyMesh = null;
  stars = null;
  caveMeshes = null;
  terrainMeshes = [];
  props = [];
  portals = [];
  tubeInstances = [];
  spinning = [];
  surfaceCopies = [];
  crowd = null;
  heightGrid = null;
}

function setLighting(sun, ambient) {
  const s = sun || [-46333, -46333, 0];
  // The .lvl vector is the direction light travels, in game axes.
  shade.uSun.value.set(s[0], s[1], -s[2]).normalize();
  shadowSun = s;
  shade.uAmbient.value = (ambient ?? 32768) / 65536;
}

async function showMap(name, gen) {
  setStatus(`Loading ${name}…`);
  const entry = await readLevel(archive, levelList, name);
  if (gen !== loadGen) throw new Cancelled();
  const look = entry.look;
  let loaded = 0;
  const textures = await mapLimit(entry.textures, 4, async (path) => {
    if (gen !== loadGen) throw new Cancelled();
    const tex = await indexTexture(path);
    loaded += 1;
    if (gen === loadGen) setStatus(`Loading ${name}… ${loaded}/${entry.textures.length} textures`);
    return tex;
  });
  const skyTex = entry.sky ? await indexTexture(entry.sky) : null;
  const heights = await archive.bytes(entry.height);
  const index = await archive.bytes(entry.index);
  if (gen !== loadGen) throw new Cancelled();

  clearLevel();
  level = entry;
  heightGrid = heights;
  setLighting(entry.sun, entry.ambient);

  const content = new THREE.Group();
  // Mouth tiles: drawn only when the .tdf mode is not 0 (6.3). They keep the
  // ground's shape and wear the mouth texture; its index 0 is the hole.
  const mouths = new Map();
  for (const data of entry.tunnels) {
    if (data.entranceMode) mouths.set(`${Math.floor(data.entrance.x)},${Math.floor(data.entrance.z)}`, data.mouth);
    if (data.exitMode) mouths.set(`${Math.floor(data.exit.x)},${Math.floor(data.exit.z)}`, data.exitMouth);
  }
  const tiles = [];
  for (let z = 0; z < MAP; z++) {
    for (let x = 0; x < MAP; x++) {
      if (!mouths.has(`${x},${z}`)) tiles.push([x, z, index[z * MAP + x]]);
    }
  }
  const corner = (x, z) => heightByte(x, z) * HEIGHT_PER_BYTE;
  content.add(groundMesh(tiles, corner, textures, look));
  for (const [key, path] of mouths) {
    const [x, z] = key.split(",").map(Number);
    const { geometry } = groundGeometry([[x, z, 0]], corner);
    const map = await indexTexture(path);
    content.add(new THREE.Mesh(geometry, paletteMaterial(look, { map, alpha0: true })));
  }

  for (const data of entry.tunnels) {
    const portal = await buildPortal(data, gen);
    if (!portal) continue;
    portals.push(portal);
    const stubs = [
      [portal.entranceStub, portal.entrance, portal.start, data.entranceMode],
      [portal.exitStub, portal.exit, portal.end, data.exitMode],
    ];
    for (const [stub, frame, anchor, mode] of stubs) {
      if (!mode) continue;
      const tube = stub.clone();
      placeInFrame(tube, frame, anchor);
      tube.userData.tube = true;
      tube.userData.tile = [Math.floor(frame.pos.x), Math.floor(frame.pos.z)];
      tube.visible = false;
      content.add(tube);
    }
  }

  setStatus(`Loading ${name}… objects`);
  const placed = await placeObjects(entry, content, gen);
  if (gen !== loadGen) throw new Cancelled();

  surface.add(content);
  // The map wraps at 256 tiles; eight copies cover the edges.
  for (const dz of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      if (!dx && !dz) continue;
      const copy = content.clone(true);
      copy.position.set(dx * MAP, 0, dz * MAP);
      surface.add(copy);
      surfaceCopies.push(copy);
    }
  }
  terrainMeshes = [content, ...surfaceCopies].map((group) => group.children[0]);
  surface.add(crowd.parent);
  surface.traverse((obj) => {
    if (obj.userData.tube) tubeInstances.push(obj);
    if (obj.userData.prop) props.push(obj);
  });

  if (skyTex) {
    skyMesh = buildSky(skyTex, look);
    surface.add(skyMesh);
  } else {
    stars = buildStars();
    scene.add(stars);
  }
  caveMeshes = { textures, index, look };

  enterOrbit();
  controls.target.set(MAP / 2, 2, -MAP / 2);
  camera.position.set(MAP / 2, 70, 40);
  controls.update();
  setStatus(`${name} · ${entry.textures.length} textures · ${placed} objects · drag to orbit, Fly to play`);
}

async function placeObjects(entry, content, gen) {
  const duns = entry.nav.filter((point) => point.type === 3);
  const spots = entry.objects.filter((spot) => !(duns.length && spot.model === "jump-pnt"));
  for (const point of duns) spots.push({ model: "jump-pnt", logic: 0, offset: [0, 0, 0], x: point.x, z: point.z });
  const pups = entry.powerups;
  const names = [...new Set([...spots, ...pups].map((spot) => spot.model))];
  const templates = new Map();
  await mapLimit(names, 3, async (name) => {
    if (gen !== loadGen) throw new Cancelled();
    templates.set(name, await loadModel(name, entry.look));
  });
  if (gen !== loadGen) throw new Cancelled();
  const group = new THREE.Group();
  // Things that move live outside `content`, so the wrap copies don't
  // duplicate them; the crowd draws each at the copy nearest the camera.
  const shotModel = await loadShots(spots, entry.look);
  if (gen !== loadGen) throw new Cancelled();
  const fx = await loadEffects(entry.look);
  if (gen !== loadGen) throw new Cancelled();
  crowd = new Crowd({ parent: new THREE.Group(), groundAt, groundNormal, difficulty, shotModel });
  crowd.fx = fx;
  const surfaceCrowd = crowd;
  crowd.sound = crowdSound(() => surfaceCrowd);
  crowd.hitPlayer = shotHit;
  crowd.pickUp = pickUp;
  // Surface objects ignore the file y: ground under (x, z), plus the def's
  // offsets, plus half the radius for logics 2, 4, 7, 8 (4.3). Every one
  // with a def is a slot; the crowd draws it at the nearest wrap copy.
  const wrecks = new Map();
  for (const spot of spots) {
    const template = templates.get(spot.model);
    if (!template) continue;
    const [ox, oy, oz] = spot.offset || [0, 0, 0];
    const lift = SEAT_HALF_RADIUS.has(spot.logic) ? template.radius / 2 : 0;
    const obj = placeModel(template, spot.x + ox, groundAt(spot.x, spot.z) + oy + lift, spot.z + oz, spot);
    if (isActor(spot)) {
      crowd.parent.add(obj);
      crowd.add(obj, spot, template.radius, template.vertices, await wreckFor(spot, entry.look, obj.position, wrecks));
      continue;
    }
    obj.userData.prop = true;
    group.add(obj);
  }
  if (gen !== loadGen) throw new Cancelled();
  // Power-ups float two bounding radii above the ground (4.4).
  for (const pup of pups) {
    const template = templates.get(pup.model);
    if (!template) continue;
    const obj = placeModel(template, pup.x, groundAt(pup.x, pup.z) + 2 * template.radius, pup.z, {});
    crowd.addPickup(obj, pup.type, template.radius);
  }
  content.add(group);
  return group.children.length + crowd.actors.length;
}

let modelLook = null;
async function showModel(name, gen) {
  setStatus(`Loading ${name}…`);
  if (!modelLook) modelLook = { palette: await readPalette(archive, "vga"), fog: null, light: null, fogIndex: 0 };
  const template = await loadModel(name, modelLook);
  if (gen !== loadGen) throw new Cancelled();
  if (!template) throw new Error(`could not load ${name}`);
  clearLevel();
  level = null;
  setLighting([-30000, -46333, 30000], 26000);
  const obj = template.object.clone(true);
  obj.scale.setScalar(1);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.sub(box.getCenter(new THREE.Vector3()));
  modelStage.add(obj);
  enterOrbit();
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.5);
  controls.target.set(0, 0, 0);
  camera.position.set(radius * 1.4, radius * 0.8, radius * 1.6);
  camera.near = radius / 200;
  camera.far = radius * 40;
  camera.updateProjectionMatrix();
  controls.update();
  setStatus(`${name} · drag to orbit`);
}

// ---------------------------------------------------------------- modes

function setSpace(space, portal = null) {
  if (ship.space === "tunnel" && space === "surface") briefSun = null;
  ship.space = space;
  ship.portal = portal;
  const inTunnel = space === "tunnel";
  const inCave = space === "cave";
  tunnelSpace.visible = inTunnel;
  for (const mesh of terrainMeshes) mesh.visible = !inCave;
  if (inCave && caveMeshes && !caveMeshes.group) {
    caveMeshes.group = buildCave(caveMeshes.textures, caveMeshes.index, caveMeshes.look);
    surface.add(caveMeshes.group);
  }
  if (caveMeshes?.group) caveMeshes.group.visible = inCave;
  if (skyMesh) {
    skyMesh.visible = !inCave;
    skyMesh.material.depthWrite = false;
    skyMesh.material.colorWrite = true;
  }
  if (stars) stars.visible = flying && !inCave;
  shade.uWindow.value = inCave ? CAVE_WINDOW : SURFACE_WINDOW;
  if (inCave) setLighting(level.caveLight, level.caveAmbient);
  else if (level) setLighting(briefSun || level.sun, level.ambient);
  const look = inTunnel ? portal.look : level?.look;
  // The screen is cleared to the fog color (palette[fogIndex]).
  scene.background = look ? lookUniforms(look).fogColor.clone() : BACKDROP.clone();
  // Inside a tunnel the game draws only the tunnel, plus the surface through
  // the exit hole near the end (stepTunnel), so any gap shows the clear color.
  surface.visible = !inTunnel;
  if (inTunnel) {
    tunnelSpace.clear();
    tunnelSpace.add(portal.tube.clone(), portal.props);
    // Surface point s shows at tunnel point R^T (s - exit) + end, so the
    // surface is in place when the tube ends at the exit hole.
    const inv = portal.exit.q.clone().invert();
    surface.quaternion.copy(inv);
    surface.position.copy(portal.end).sub(portal.exit.pos.clone().applyQuaternion(inv));
  } else {
    surface.position.set(0, 0, 0);
    surface.quaternion.identity();
  }
}

function enterOrbit() {
  flying = false;
  paused = false;
  shade.uFly.value = 0;
  hudEl.hidden = true;
  crosshairEl.hidden = true;
  flyBtn.textContent = "Fly";
  controls.enabled = true;
  if (level) setSpace("surface");
  if (skyMesh) skyMesh.visible = false;
  if (stars) stars.visible = false;
  scene.background = BACKDROP.clone();
  camera.fov = ORBIT_FOV;
  camera.near = 0.05;
  camera.far = 2000;
  resize();
  stopMusic();
}

function stopFly() {
  if (!flying) return;
  enterOrbit();
  if (document.pointerLockElement) document.exitPointerLock();
  if (level) setStatus(`${level.name} · drag to orbit, Fly to play`);
}

function levelMusic() {
  return level?.music ? objectUrl(level.music, "audio/x-mod") : null;
}

// intro: set up the flight but leave the controls, HUD and mouse for
// beginFlight once the level's start screens are done.
function startFly({ intro = false } = {}) {
  if (modeEl.value !== "map" || !level) return;
  flying = true;
  paused = false;
  flyBtn.textContent = "Orbit";
  controls.enabled = false;
  shade.uFly.value = 1;
  // Spawn (4.2): x, z from the .nav, half a tile above the ground, file angles.
  const start = level.start || { x: 0, z: 0, pitch: 0, roll: 0, yaw: 0 };
  ship.pos.set(start.x, groundAt(start.x, start.z) + SPAWN_LIFT, start.z);
  ship.q.setFromEuler(new THREE.Euler(start.pitch, start.yaw, start.roll, "YXZ"));
  ship.rates.set(0, 0, 0);
  ship.jolt.set(0, 0, 0);
  ship.grace = 0;
  ship.flash = 0;
  resetArsenal();
  mouseFire = false;
  ship.axes = { pitch: 0, yaw: 0, roll: 0 };
  ship.stick.set(0, 0);
  ship.throttle = THROTTLE_START;
  ship.speed = ship.throttle / GAME_SECOND;
  setSpace("surface");
  if (skyMesh) skyMesh.visible = true;
  camera.fov = FLY_FOV;
  camera.near = FLY_NEAR;
  camera.far = 600;
  resize();
  resetNav();
  // Every sortie starts with everyone back at their posts.
  crowd?.resetAll();
  for (const portal of portals) portal.crowd.resetAll();
  wakeMusic();
  wakeSfx();
  playMusic(levelMusic());
  if (intro) {
    hudEl.hidden = true;
    crosshairEl.hidden = true;
    return;
  }
  beginFlight();
}

function beginFlight() {
  cut = null;
  hudEl.hidden = false;
  crosshairEl.hidden = false;
  clock.getDelta();
  lockPointer();
}

// Pointer lock needs a user gesture. From ?fly=1 there is none yet, so the
// first click on the view takes the mouse (and starts the music).
function lockPointer() {
  const request = renderer.domElement.requestPointerLock();
  request?.catch?.(() => {
    if (flying) setStatus("click the view to take the controls");
  });
}

renderer.domElement.addEventListener("click", () => {
  if (!flying) return;
  // [I] A click or tap also cuts the fly-in short (and takes the mouse).
  if (cut?.skip && !menu?.active) cut.skip();
  wakeMusic();
  wakeSfx();
  playMusic(levelMusic());
  if (document.pointerLockElement !== renderer.domElement) lockPointer();
});

// ---------------------------------------------------------------- flight

function axis(plus, minus) {
  return (keys.has(plus) ? 1 : 0) - (keys.has(minus) ? 1 : 0);
}

function rampKey(value, target, dt) {
  const rate = target === 0 || Math.sign(target) !== Math.sign(value) && value !== 0 ? KEY_FALL : KEY_RISE;
  const step = rate * dt;
  return Math.abs(target - value) <= step ? target : value + Math.sign(target - value) * step;
}

function approach(value, target, dt) {
  return value + (target - value) * (1 - Math.exp(-RESPONSE * dt));
}

const tmpEuler = new THREE.Euler(0, 0, 0, "YXZ");
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

// Damage (FUN_000131d0): an eighth-second flash (0x2000), a random exp1-5.wav
// at the ship, 1 s of grace from ground and shot damage, and a jolt. Shields
// aren't modeled, so the amount is ignored.
const GRACE = GAME_SECOND;
const FLASH = GAME_SECOND / 8;
// The jolt adds (2r - 0x8000) << 13 / frame time to each turn rate, and the
// rates halve every frame (FUN_00011cc0): the ship turns r/8 - 0x1000 units
// that frame, half that the next, and so on, (2r - 0x8000) / 4 in all, up to
// 45 degrees per axis. [I] The halving is per frame; taken at ORIGINAL_FPS.
const JOLT_FPS = 20;
const EXPLOSIONS = ["exp1.wav", "exp2.wav", "exp3.wav", "exp4.wav", "exp5.wav"];
function damage() {
  ship.flash = FLASH;
  ship.flashColor = 0;
  playSfx(EXPLOSIONS[Math.floor(Math.random() * EXPLOSIONS.length)], 0, 0);
  ship.grace = GRACE;
  const kick = () => (((Math.floor(Math.random() * 0x8000) * 2 - 0x8000) / 4) / 0x10000) * Math.PI * 2;
  ship.jolt.x += kick();
  ship.jolt.y += kick();
  ship.jolt.z += kick();
}

// FUN_00012740: ground.wav on the surface and in the cave, scrape.wav on a
// tunnel wall or obstacle; channel 3, centred (FUN_00029730).
function groundSound() {
  playSfx(ship.space === "tunnel" ? "scrape.wav" : "ground.wav", 3, 0);
}

// Cave rock and the cave ceiling always hurt (FUN_00012740).
function hit() {
  groundSound();
  damage();
}

// Touching the ground only hurts, and only sounds, outside the grace.
function scrape() {
  if (ship.grace <= 0) hit();
}

// An enemy shot within 1/16 tile (FUN_000133b0): ignored during the grace.
function shotHit() {
  if (ship.grace > 0 || !flying || cut) return false;
  damage();
  return true;
}

// ---------------------------------------------------------------- guns

// The weapons by number (FUN_0001b6d0). Tables from GAME.EXE: rate 0x67a20
// (shots per game second), speed 0x67934 (tiles per game second added to
// the ship's), damage 0x6797c, model 0x678ec (SHOT_MODELS[weapon]), HUD
// name 0x67a7c. Each fire plays the sound at the ship on channel 1.
const WEAPONS = {
  1: { name: "PAC", rate: 6, speed: 2, damage: 0x1000, sound: "laser2.wav", fire: noseGuns }, // Plasma
  2: { name: "ION", rate: 6, speed: 1.5, damage: 0x2000, sound: "laser3.wav", fire: fanGun }, // Antimatter
  3: { name: "RTL", rate: 6, speed: 4, damage: 0x1000, sound: "laser4.wav", fire: wingGuns }, // Laser Beam
  0x12: { name: "MAM", rate: 2, damage: 0x4000, fire: missile }, // Missile
  0x13: { name: "SAD", rate: 2, damage: 0x8000, guided: true, fire: missile }, // Guided Missile
  0x14: { name: "SWT", rate: 2, damage: 0x10000, guided: true, fire: missile }, // Super Missile
  0x15: { name: "DAM", rate: 6, fire: smartBomb }, // Smart Bomb
};
// FUN_0001bab0: keys 1-3 pick weapons 1-3 and 4-7 pick 0x12-0x15, if they have ammo.
const WEAPON_KEYS = { 1: 1, 2: 2, 3: 3, 4: 0x12, 5: 0x13, 6: 0x14, 7: 0x15 };
// FUN_000401a0(1): every flight starts with Plasma alone, unlimited (-1);
// the rest come from power-ups (pickUp).
const START_AMMO = { 1: -1, 2: 0, 3: 0, 0x12: 0, 0x13: 0, 0x14: 0, 0x15: 0 };
// The ship's matrix columns are 16.16 units, a sixteenth of a tile long.
const AXIS = 1 / 16;
// FUN_0001b050: Antimatter cycles [pitch, yaw] offsets (tables 0x67b14, 0x67b00):
// up, left, straight, right, down, 0x800 (11.25 degrees) apart.
const FAN = [[-0x800, 0], [0, -0x800], [0, 0], [0, 0x800], [0x800, 0]];
let mouseFire = false;

function resetArsenal() {
  ship.weapon = 1;
  ship.ammo = { ...START_AMMO };
  ship.mode = Object.fromEntries(Object.keys(START_AMMO).map((w) => [w, 1])); // a7a14: 1, 2 or 4 bolts
  ship.fireClock = 1;
  ship.gunSide = 0;
  ship.missileSide = 0;
  ship.fanStep = 0;
}

function pickWeapon(key) {
  const weapon = WEAPON_KEYS[key];
  if (weapon && ship.ammo[weapon]) ship.weapon = weapon;
}

// [port] + and - step Plasma or Laser Beam through modes 1, 2 and 4, as
// repeated pickups do (FUN_0003fdd0), without the ammo that comes with them.
const MODE_WEAPONS = new Set([1, 3]);
function stepMode(key) {
  const up = key === "+" || key === "=";
  if (!up && key !== "-" && key !== "_") return;
  if (!MODE_WEAPONS.has(ship.weapon)) return;
  const mode = ship.mode[ship.weapon];
  ship.mode[ship.weapon] = up ? Math.min(4, mode * 2) : Math.max(1, mode / 2);
  notify(`${WEAPONS[ship.weapon].name} x${ship.mode[ship.weapon]}`);
}

// FUN_0003fe70: what a power-up gives, by .pup type, with its message
// (FUN_0002cbe0, one game second) and power-1.wav. False leaves it lying
// there. [port] Shields, invisibility, invincibility and afterburner fuel
// aren't modelled: those only show their message.
const PICKUPS = [
  { name: "R.T.L. (3)", give: () => morePower(3) },
  { name: "P.A.C. (1)", give: () => morePower(1) },
  { name: "I.O.N. (2)", give: () => (ship.ammo[2] += 100) },
  { name: "M.A.M. (4)", give: () => (ship.ammo[0x12] += 40) },
  { name: "S.A.D. (5)", give: () => (ship.ammo[0x13] += 20) },
  { name: "S.W.T. (6)", give: () => (ship.ammo[0x14] += 20) },
  { name: "Shield Restore" },
  { name: "Invisibility!" },
  { name: "Invincibility!" },
  { name: "D.A.M. (7)", give: () => (ship.ammo[0x15] ? false : (ship.ammo[0x15] = 1)) },
  { name: "Afterburner!" },
  { name: "Power Core!" },
];
function pickUp(type) {
  const pickup = PICKUPS[type];
  if (!pickup || pickup.give?.() === false) return false;
  notify(pickup.name);
  playSfx("power-1.wav", 3, 0);
  return true;
}

// FUN_0003fdd0: the first Plasma or Laser Beam is unlimited in mode 1;
// each one after that doubles the mode (up to 4) and adds 100 rounds.
function morePower(weapon) {
  if (!ship.ammo[weapon]) {
    ship.mode[weapon] = 1;
    ship.ammo[weapon] = -1;
    return;
  }
  ship.mode[weapon] = Math.min(4, ship.mode[weapon] * 2);
  ship.ammo[weapon] += 100;
}

// A message on the status line for one game second (FUN_0002cbe0).
function notify(text) {
  ship.notice = text;
  ship.noticeTime = GAME_SECOND;
}

// FUN_00012740: inside a slot's box the ship wears it down and takes a hit
// (0x1000) outside the grace; then the power-ups it touches (FUN_00040040).
function stepContact(dt) {
  const room = ship.space === "tunnel" ? ship.portal?.crowd : crowd;
  if (!room) return;
  if (room.ram(ship.pos, dt / GAME_SECOND) && ship.grace <= 0) damage();
  room.collect(ship.pos);
}

// FUN_0001bab0: Space or the first mouse button. While fire is up the clock
// sits at one shot, so a press fires on its first frame; held, it fires at
// most once a frame. Holding the afterburner swaps the gun out for weapon
// 0x16, so it cannot fire then.
function stepGuns(dt) {
  if (!(keys.has(" ") || mouseFire) || keys.has("shift")) {
    ship.fireClock = 1;
    return;
  }
  ship.fireClock += (dt / GAME_SECOND) * WEAPONS[ship.weapon].rate;
  if (ship.fireClock <= 1) return;
  ship.fireClock -= 1;
  shoot(dt);
}

// FUN_0001b6d0: an empty weapon falls back to Plasma. Each shot uses one
// round; when the last goes, a doubled weapon (mode 2 or 4) drops to
// mode 1 with unlimited rounds, anything else switches to Plasma.
function shoot(dt) {
  const target = ship.space === "tunnel" ? ship.portal?.crowd : crowd;
  if (!target) return;
  const used = ship.weapon;
  if (!ship.ammo[used]) ship.weapon = 1;
  const gun = WEAPONS[ship.weapon];
  gun.fire(target, gun, dt);
  if (gun.sound) playSfx(gun.sound, 1, 0);
  if (ship.ammo[used] > 0 && --ship.ammo[used] === 0) {
    if (ship.mode[used] >= 2) {
      ship.mode[used] = 1;
      ship.ammo[used] = -1;
    } else {
      ship.weapon = 1;
    }
  }
}

function shipAxes() {
  return {
    f: new THREE.Vector3(0, 0, 1).applyQuaternion(ship.q),
    u: new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q),
    r: new THREE.Vector3(1, 0, 0).applyQuaternion(ship.q),
  };
}

// Tiles per game second: the ship's speed plus the weapon's.
const shotSpeed = (gun) => ship.speed * GAME_SECOND + gun.speed;

// Bolts from `base` along the nose, with the ship's orientation. Mode 1
// alternates half an axis right and left, the right first (DAT_00067af8,
// shared by both patterns); mode 2 fires both; mode 4 the four corners
// half an axis out.
function bolts(target, gun, base, axes, speed) {
  const at = (side, lift) => base.clone().addScaledVector(axes.r, (side * AXIS) / 2).addScaledVector(axes.u, (lift * AXIS) / 2);
  const mode = ship.mode[ship.weapon];
  let spots;
  if (mode === 1) {
    ship.gunSide = 1 - ship.gunSide;
    spots = [at(ship.gunSide ? 1 : -1, 0)];
  } else if (mode === 2) {
    spots = [at(1, 0), at(-1, 0)];
  } else {
    spots = [at(1, 1), at(-1, 1), at(-1, -1), at(1, -1)];
  }
  for (const pos of spots) {
    target.fire({ pos, dir: axes.f.clone(), q: ship.q.clone(), type: ship.weapon, speed, damage: gun.damage });
  }
}

// FUN_0001ac30 (Plasma): half an axis ahead and, except in mode 4, a
// quarter below (1/32 and 1/64 tile). Every shot starts a frame of travel
// back, as the shot update runs right after it.
function noseGuns(target, gun, dt) {
  const axes = shipAxes();
  const speed = shotSpeed(gun);
  const base = ship.pos.clone().addScaledVector(axes.f, AXIS / 2 - speed * (dt / GAME_SECOND));
  if (ship.mode[ship.weapon] !== 4) base.addScaledVector(axes.u, -AXIS / 4);
  bolts(target, gun, base, axes, speed);
}

// FUN_0001a870 (Laser Beam): the same without the drop.
function wingGuns(target, gun, dt) {
  const axes = shipAxes();
  const speed = shotSpeed(gun);
  bolts(target, gun, ship.pos.clone().addScaledVector(axes.f, AXIS / 2 - speed * (dt / GAME_SECOND)), axes, speed);
}

// FUN_0001b050 (Antimatter): mode-many shots, each turned by the next FAN
// offset, from half an axis ahead and half below. Its sideways term
// multiplies by the raw -1/0/1 of table 0x67b28 and comes out as nothing.
function fanGun(target, gun, dt) {
  const axes = shipAxes();
  const speed = shotSpeed(gun);
  const { x: pitch, y: yaw, z: roll } = tmpEuler.setFromQuaternion(ship.q, "YXZ");
  const turn = (units) => (units / 65536) * Math.PI * 2;
  for (let i = 0; i < ship.mode[ship.weapon]; i++) {
    const [dp, dy] = FAN[ship.fanStep];
    ship.fanStep = (ship.fanStep + 1) % FAN.length;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch + turn(dp), yaw + turn(dy), roll, "YXZ"));
    const pos = ship.pos.clone()
      .addScaledVector(axes.f, AXIS / 2 - speed * (dt / GAME_SECOND))
      .addScaledVector(axes.u, -AXIS / 2);
    target.fire({ pos, dir: new THREE.Vector3(0, 0, 1).applyQuaternion(q), q, type: ship.weapon, speed, damage: gun.damage });
  }
}

// FUN_0001b490: alternately a whole axis right and left (the right first,
// DAT_00067b40), one below and half ahead, starting a frame of 2 tiles/s
// back, with the ship's angles and speed.
function missile(target, gun, dt) {
  const axes = shipAxes();
  ship.missileSide = 1 - ship.missileSide;
  const pos = ship.pos.clone()
    .addScaledVector(axes.f, AXIS / 2 - 2 * (dt / GAME_SECOND))
    .addScaledVector(axes.r, ship.missileSide ? AXIS : -AXIS)
    .addScaledVector(axes.u, -AXIS);
  const { x: pitch, y: yaw, z: roll } = tmpEuler.setFromQuaternion(ship.q, "YXZ");
  target.launch({ pos, pitch, yaw, roll, speed: ship.speed * GAME_SECOND, damage: gun.damage, guided: !!gun.guided });
}

// FUN_0001b600: hits everything awake, flashes the view in entry 2 of the
// flash table (palette 31) for an eighth of a second (FUN_0002edf0) and
// fills the shields, which this port doesn't model.
function smartBomb(target) {
  target.bomb();
  ship.flash = FLASH;
  ship.flashColor = 2;
}

function stepTimers(dt) {
  ship.grace = Math.max(0, ship.grace - dt);
  ship.flash = Math.max(0, ship.flash - dt);
  ship.noticeTime = Math.max(0, ship.noticeTime - dt);
}

function stepJolt(dt) {
  if (ship.jolt.lengthSq() < 1e-10) return ship.jolt.set(0, 0, 0);
  tmpV.copy(ship.jolt).multiplyScalar(1 - 0.5 ** (dt * JOLT_FPS));
  ship.jolt.sub(tmpV);
  const angle = tmpV.length();
  ship.q.multiply(tmpQ.setFromAxisAngle(tmpV.divideScalar(angle), angle)).normalize();
}

// Flight (2.3): rate control in the body frame. Up arrow pushes the stick
// forward (nose down). No strafing, no sideslip, no gravity.
function stepFlight(dt, now) {
  ship.axes.yaw = rampKey(ship.axes.yaw, axis("arrowright", "arrowleft"), dt);
  ship.axes.pitch = rampKey(ship.axes.pitch, axis("arrowup", "arrowdown"), dt);
  ship.axes.roll = rampKey(ship.axes.roll, axis("q", "e"), dt);
  ship.stick.multiplyScalar(Math.exp(-MOUSE_SETTLE * dt));
  const yawIn = THREE.MathUtils.clamp(ship.axes.yaw + ship.stick.x, -1, 1);
  const pitchIn = THREE.MathUtils.clamp(ship.axes.pitch + ship.stick.y, -1, 1);
  const rollIn = ship.axes.roll;

  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  // Auto-level: back to wings level, or to inverted past 90 deg of roll.
  const roll = tmpEuler.z;
  const rollError = wrapAngle(roll - (Math.abs(roll) > Math.PI / 2 ? Math.sign(roll) * Math.PI : 0));
  const leveling = -(Math.cos(tmpEuler.x) ** 2) * THREE.MathUtils.clamp(rollError * 8, -AUTO_LEVEL, AUTO_LEVEL);
  ship.rates.x = approach(ship.rates.x, pitchIn * TURN_RATE, dt);
  ship.rates.y = approach(ship.rates.y, yawIn * TURN_RATE, dt);
  ship.rates.z = approach(ship.rates.z, (rollIn - BANK_COUPLING * yawIn) * TURN_RATE + leveling, dt);
  tmpV.copy(ship.rates).multiplyScalar(dt);
  const angle = tmpV.length();
  if (angle > 0) ship.q.multiply(tmpQ.setFromAxisAngle(tmpV.divideScalar(angle), angle)).normalize();
  stepJolt(dt);

  ship.throttle = THREE.MathUtils.clamp(ship.throttle + axis("a", "z") * THROTTLE_RATE * dt, THROTTLE_MIN, THROTTLE_MAX);
  const burner = keys.has("shift");
  stepBurnerSound(burner, dt);
  ship.speed = approach(ship.speed, (burner ? AFTERBURNER : ship.throttle) / GAME_SECOND, dt);
  const forward = tmpV.set(0, 0, 1).applyQuaternion(ship.q);
  const before = ship.pos.clone();
  ship.pos.addScaledVector(forward, ship.speed * dt);

  if (ship.space === "tunnel") return stepTunnel(now);
  ship.pos.x = wrapMap(ship.pos.x);
  ship.pos.z = wrapMap(ship.pos.z);
  if (ship.space === "cave") return stepCave(before);
  stepSurface();
}

function setPitch(pitch) {
  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  tmpEuler.x = pitch;
  ship.q.setFromEuler(tmpEuler);
}

function stepSurface() {
  if (tryEnterTunnel()) return;
  const floor = groundAt(ship.pos.x, ship.pos.z) + CLEARANCE;
  if (ship.pos.y < floor) {
    ship.pos.y = floor;
    // Ground bounce (2.4): nose-down is reflected; level or nose-up doubles.
    tmpEuler.setFromQuaternion(ship.q, "YXZ");
    const pitch = tmpEuler.x;
    setPitch(pitch > 0 ? -pitch : Math.max(pitch * 2, -BOUNCE_LIMIT));
    scrape();
  }
  if (ship.pos.y > CEILING) ship.pos.y = CEILING;
}

// Cave mode (5, FUN_00012740): floor below, mirrored ceiling above, and solid
// 255 rock that turns the ship around. Rock and ceiling always hit; the floor
// bounces as on the surface.
function stepCave(before) {
  const ground = groundAt(ship.pos.x, ship.pos.z);
  const floor = ground + CLEARANCE;
  const roof = 2 * TOP - ground - CLEARANCE;
  if (ground >= TOP - 1e-6 || roof <= floor) {
    ship.pos.copy(before);
    tmpEuler.setFromQuaternion(ship.q, "YXZ");
    tmpEuler.y += Math.PI;
    ship.q.setFromEuler(tmpEuler);
    hit();
    return;
  }
  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  const pitch = tmpEuler.x;
  if (ship.pos.y < floor) {
    ship.pos.y = floor;
    setPitch(pitch > 0 ? -pitch : Math.max(pitch * 2, -BOUNCE_LIMIT));
    scrape();
  } else if (ship.pos.y > roof) {
    ship.pos.y = roof;
    setPitch(pitch < 0 ? -pitch : Math.min(pitch * 2, BOUNCE_LIMIT));
    hit();
  }
}

// Entry (6.3): within 1/16 tile of the mouth plane, inside 0.707 of the
// start radii, heading in.
function tryEnterTunnel() {
  for (const portal of portals) {
    if (!portal.data.entranceMode) continue;
    const rel = new THREE.Vector3(
      wrapDelta(portal.entrance.pos.x, ship.pos.x),
      ship.pos.y - portal.entrance.pos.y,
      wrapDelta(portal.entrance.pos.z, ship.pos.z),
    );
    if (rel.lengthSq() > 4) continue;
    const inv = portal.entrance.q.clone().invert();
    const p = rel.applyQuaternion(inv).add(portal.start);
    const seg = portal.segments[0];
    const heading = new THREE.Vector3(0, 0, 1).applyQuaternion(ship.q).applyQuaternion(inv);
    if (p.z < -1 / 16 || p.z > 0.25 || heading.z <= 0) continue;
    if (Math.abs(p.x - portal.start.x) >= 0.707 * seg.r0[0] * TUNNEL_UNIT) continue;
    if (Math.abs(p.y - portal.start.y) >= 0.707 * seg.r0[1] * TUNNEL_UNIT) continue;
    // Start of segment 0, keeping the sideways offset; angles reset.
    ship.pos.set(p.x, p.y, Math.max(0, p.z));
    ship.q.identity();
    ship.rates.set(0, 0, 0);
    setSpace("tunnel", portal);
    navEnterTunnel(portal);
    return true;
  }
  return false;
}

function stepTunnel(now) {
  const portal = ship.portal;
  // Tunnels clamp pitch and yaw to +-10000 (about 55 deg).
  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  const px = THREE.MathUtils.clamp(tmpEuler.x, -TUNNEL_CLAMP, TUNNEL_CLAMP);
  const py = THREE.MathUtils.clamp(tmpEuler.y, -TUNNEL_CLAMP, TUNNEL_CLAMP);
  if (px !== tmpEuler.x || py !== tmpEuler.y) {
    tmpEuler.x = px;
    tmpEuler.y = py;
    ship.q.setFromEuler(tmpEuler);
  }
  if (ship.pos.z < 0) ship.pos.z = 0;
  if (ship.pos.z >= portal.length) {
    // Exit (6.3): world = exit + R (p - end), and the frame's turn is added.
    const local = ship.pos.clone().sub(portal.end);
    ship.pos.copy(portal.exit.pos).add(local.applyQuaternion(portal.exit.q));
    ship.pos.x = wrapMap(ship.pos.x);
    ship.pos.z = wrapMap(ship.pos.z);
    ship.q.premultiply(portal.exit.q);
    ship.rates.set(0, 0, 0);
    const cave = portal.data.cave;
    setSpace(cave ? "cave" : "surface");
    navExitTunnel();
    if (!cave) ship.pos.y = Math.max(ship.pos.y, groundAt(ship.pos.x, ship.pos.z) + CLEARANCE);
    return;
  }
  // FUN_00038f90: any push by a wall or an obstacle scrapes (scrape.wav) and
  // hurts, outside the grace.
  const walled = containInTube(portal, ship.pos, now);
  if (collideObstacle(portal, ship.pos, now) || walled) scrape();
  surface.visible = ship.pos.z > portal.length - TUBE_STUB;
}

// Where the ship is in surface coordinates, for the HUD and the draw window.
function surfacePosition(out) {
  if (cut) return out.copy(cut.pos);
  if (ship.space !== "tunnel") return out.copy(ship.pos);
  const portal = ship.portal;
  return out.copy(ship.pos).sub(portal.end).applyQuaternion(portal.exit.q).add(portal.exit.pos);
}

// The camera sits exactly at the ship (3.4). Mirroring z flips the sign of
// the yaw and pitch parts of the rotation.
function syncCamera() {
  gameView(camera, cut?.pos || ship.pos, viewQ());
  if (stars) stars.position.copy(camera.position);
}

function gameView(cam, pos, q) {
  cam.position.set(pos.x, pos.y, -pos.z);
  cam.quaternion.set(-q.x, -q.y, q.z, q.w);
}

// The eye's turn: the ship's, or the scripted camera's.
function viewQ() {
  return cut?.q || ship.q;
}

// FUN_00018a90: within 1/8 tile of the deck the game only clears the screen;
// above it, it draws the deck from above under a flat ceiling (FUN_00018610).
// The terrain (and the objects drawn with it) is only drawn while the camera
// is below the deck, so the plateaus at height 255, which sit exactly at the
// deck, can't be seen from above: the deck hides them. Above the deck the sky
// plane writes depth, so only objects above it show (FUN_00018ce0).
const SKY_BAND = 1 / 8;
function updateSky() {
  if (!skyMesh || !level || !flying || ship.space !== "surface") return;
  const look = lookUniforms(level.look);
  const above = surfaceCam.y - TOP;
  const overDeck = above >= 0;
  for (const mesh of terrainMeshes) mesh.visible = !overDeck;
  skyMesh.visible = overDeck || above < -SKY_BAND;
  skyMesh.material.depthWrite = overDeck;
  skyMesh.material.colorWrite = above < -SKY_BAND || above > SKY_BAND;
  scene.background.copy(above > SKY_BAND ? look.ceilingColor : look.fogColor);
  const horizon = skyMesh.children[0];
  horizon.visible = above > SKY_BAND;
  if (horizon.visible) {
    tmpEuler.setFromQuaternion(viewQ(), "YXZ");
    horizon.position.set(surfaceCam.x, TOP, surfaceCam.z);
    horizon.rotation.set(0, tmpEuler.y, 0);
  }
}

const surfaceCam = new THREE.Vector3();
function updateWindow() {
  surfacePosition(surfaceCam);
  shade.uCamTile.value.set(Math.floor(surfaceCam.x), Math.floor(surfaceCam.z));
  // Objects are drawn tile by tile with the terrain (FUN_0003c5b0 calls
  // FUN_0003c500 per tile), so they share its window exactly.
  const reach = shade.uWindow.value;
  const inWindow = (obj, copy) => {
    const [tx, tz] = obj.userData.tile;
    const dx = Math.abs(tx + copy.x - shade.uCamTile.value.x);
    const dz = Math.abs(tz + copy.z - shade.uCamTile.value.y);
    return Math.max(dx, dz) <= reach;
  };
  for (const obj of props) obj.visible = !flying || inWindow(obj, obj.parent.parent.position);
  for (const tube of tubeInstances) {
    tube.visible = flying && ship.space === "surface" && inWindow(tube, tube.parent.position);
  }
}

// Enemies and NPCs (src/ai.js). The surface crowd runs while you are on the
// surface or in the cave; a tunnel's crowd only while you are in that tunnel
// (the game loads one .def at a time).
const crowdPlayer = { pos: new THREE.Vector3(), forward: new THREE.Vector3() };
function stepCrowds(dt) {
  crowdPlayer.pos.copy(ship.pos);
  crowdPlayer.forward.set(0, 0, 1).applyQuaternion(ship.q);
  if (ship.space === "tunnel") {
    ship.portal.crowd.update(dt, crowdPlayer);
    return;
  }
  const camTile = [Math.floor(ship.pos.x), Math.floor(ship.pos.z)];
  crowd?.update(dt, crowdPlayer, { camTile, bossActive: level?.nav[navCursor]?.type === 5 });
}

function syncCrowds() {
  const tile = shade.uCamTile.value;
  // Billboards face the camera, which is the ship (game pitch and yaw).
  const { x: pitch, y: yaw } = tmpEuler.setFromQuaternion(viewQ(), "YXZ");
  const view = { flying, reach: shade.uWindow.value, camTile: [tile.x, tile.y], facing: { pitch, yaw } };
  crowd?.sync(flying ? surfaceCam : null, view);
  if (ship.space === "tunnel") ship.portal.crowd.sync(null, view);
}

// ---------------------------------------------------------------- input

window.addEventListener("keydown", (event) => {
  if (menu?.active) {
    if (event.key !== "F5" && event.key !== "F12") event.preventDefault();
    if (!event.repeat || event.key.length === 1 || event.key.startsWith("Arrow")) menu.key(event);
    return;
  }
  const key = event.key.toLowerCase();
  if (cut?.skip) {
    if (key === "escape" || key === " " || key === "f1") {
      event.preventDefault();
      cut.skip();
    }
    return;
  }
  keys.add(key);
  if (key === "escape") {
    if (gameMode && flying) askReturn();
    else stopFly();
    return;
  }
  if (!flying) return;
  if (key.startsWith("arrow") || key === " ") event.preventDefault();
  if (key === "p" && !event.repeat) {
    paused = !paused;
    setStatus(paused ? "paused · P to fly" : flightStatus());
  }
  if (key === "m" && !event.repeat) setStatus(toggleMusic() ? "music on" : "music off");
  if (!event.repeat) pickWeapon(key);
  stepMode(event.key);
});
window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => {
  keys.clear();
  mouseFire = false;
});
// The first mouse button fires, once the view has the mouse.
window.addEventListener("mousedown", (event) => {
  if (event.button === 0 && flying && document.pointerLockElement === renderer.domElement) mouseFire = true;
});
window.addEventListener("mouseup", (event) => {
  if (event.button === 0) mouseFire = false;
});
// Esc while the mouse is held is eaten by the browser to release it, so in
// game mode losing the mouse in flight asks the same question.
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement || !flying) return;
  if (!gameMode) stopFly();
  else if (!menu?.active && !paused) askReturn();
});
// Mouse as a self-centering stick, FPS style: mouse up is nose up.
window.addEventListener("mousemove", (event) => {
  if (!flying || document.pointerLockElement !== renderer.domElement) return;
  ship.stick.x = THREE.MathUtils.clamp(ship.stick.x + event.movementX * MOUSE_GAIN, -1, 1);
  ship.stick.y = THREE.MathUtils.clamp(ship.stick.y + event.movementY * MOUSE_GAIN, -1, 1);
});
flyBtn.addEventListener("click", () => (flying ? stopFly() : startFly()));

function flightStatus() {
  const burner = keys.has("shift");
  const tiles = (burner ? AFTERBURNER : ship.speed * GAME_SECOND).toFixed(2);
  const where = ship.space === "tunnel" ? "tunnel · " : ship.space === "cave" ? "cave · " : "";
  if (ship.noticeTime > 0) return `${where}${ship.notice}`;
  return `${where}${tiles} tiles/s · arrows/mouse steer · Q/E roll · A/Z throttle · Space/click fire · 1-7 weapon · +/- gun power · Shift burner · M music · P pause`;
}

// ---------------------------------------------------------------- HUD

// The route is the nav file in order, starting at the first point after the spawn.
function resetNav() {
  const nav = level?.nav || [];
  const found = nav.findIndex((point, index) => index > 0 && point.type !== 6);
  navCursor = found >= 0 ? found : (nav.length > 1 ? 1 : -1);
}

// The status bar shows the nav point's type, not its description (FUN_0002fcb0).
const NAV_CODES = ["TGT", "TUN", "CHK", "DUN", "XIT", "BOS", "STR"];
function navName(point) {
  if (!point) return "---";
  return NAV_CODES[point.type] ?? "TGT";
}

function updateHud() {
  const { x, z } = surfacePosition(surfaceCam);
  // "%3d,%3d"; inside a tunnel the original prints "??,??".
  const pad = (v) => String(Math.floor(wrapMap(v))).padStart(3);
  const sect = ship.space === "tunnel" ? "??,??" : `${pad(x)},${pad(z)}`;
  const point = ship.space === "tunnel" ? null : navTarget();
  if (!point) {
    paintHud(sect, "----", ship.space === "tunnel" ? "TUN" : "---", null);
    return;
  }
  // One tile is 16 of the units the original distance counter shows.
  paintHud(sect, String(Math.round(navDistance(point) * 16)), navName(point), point.at);
}

// FUN_0003f350: the distance to the nav point is level (x, z) except for a
// tunnel entrance (type 1), which counts height too.
function navDistance(point) {
  const { x, y, z } = surfacePosition(surfaceCam);
  const dy = point.type === 1 ? y - point.at.y : 0;
  return Math.hypot(wrapDelta(x, point.at.x), dy, wrapDelta(z, point.at.z));
}

// FUN_0003f230: on to the next nav point. Reaching the boss sounds
// warning.wav (channel 3) as "Mission Goal Ahead!" comes up; the caller's
// own message, if any, replaces it.
function advanceNav(message = null) {
  navCursor += 1;
  if (level?.nav[navCursor]?.type === 5) {
    playSfx("warning.wav", 3, 0);
    notify("Mission Goal Ahead!");
  }
  if (message) notify(message);
}

// FUN_0003f350, every frame on the surface: the current nav point and where
// it is (`at`). A target (type 0) is the first of its slots still alive and
// not wrecked; when none is left the route moves on ("Target Destroyed", or
// "Mission Complete" when the departure point is next). A checkpoint (2)
// passes within 2.5 tiles. A boss (5) can't be hurt (its strength is kept
// full) while any of its parts lives, and the marker follows the last live
// part; when the boss dies or is wrecked, "Boss Destroyed". Tunnel points
// move on as you go through (navEnterTunnel, navExitTunnel). [port] The
// departure point (3) doesn't end the level yet, nor does running out of
// points; the boss's big explosion (FUN_0001cb00) isn't ported.
const CHECKPOINT_REACH = 2621440 / 1048576; // _DAT_00063b24
function navTarget() {
  const nav = level?.nav || [];
  for (let guard = 0; guard <= nav.length; guard++) {
    const point = nav[navCursor];
    if (!point) return null;
    const slot = (n) => crowd?.slots.get(n);
    const standing = (a) => a && a.alive && a.state !== 301;
    if (point.type === 0) {
      const live = point.links.map(slot).find(standing);
      if (live) return { ...point, at: live.pos };
      advanceNav(nav[navCursor + 1]?.type === 3 ? "Mission Complete" : "Target Destroyed");
      continue;
    }
    if (point.type === 5 && point.boss) {
      const boss = slot(point.boss.slot);
      const parts = point.boss.parts.map(slot).filter((a) => a?.alive);
      if (boss && parts.length) {
        boss.strength = boss.full;
        return { ...point, at: parts[parts.length - 1].pos };
      }
      if (standing(boss)) return { ...point, at: boss.pos };
      advanceNav("Boss Destroyed");
      continue;
    }
    const at = { x: point.x, y: point.y, z: point.z };
    if (point.type === 2 && navDistance({ ...point, at }) < CHECKPOINT_REACH) {
      advanceNav("Checkpoint");
      continue;
    }
    return { ...point, at };
  }
  return null;
}

// FUN_0003f9f0: entering a tunnel puts the route just past the entrance
// point naming it, wherever the cursor was.
function navEnterTunnel(portal) {
  const name = String(portal.data.level || "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const index = (level?.nav || []).findIndex((point) => point.type === 1 && point.tunnel === name);
  if (index < 0) return;
  navCursor = index;
  advanceNav();
}

// FUN_0003f9c0: leaving a tunnel passes its exit point (type 4).
function navExitTunnel() {
  if (level?.nav[navCursor]?.type === 4) advanceNav();
}

// Compass-up is the target; the sprite turns with our heading against it.
function markerAngle(target) {
  if (!target) return 0;
  const { x, z } = surfacePosition(surfaceCam);
  const bearing = Math.atan2(wrapDelta(x, target.x), wrapDelta(z, target.z));
  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  return wrapAngle(bearing - tmpEuler.y);
}

// 5x7 glyphs, five bits per row. Drawn into the slots of statbar.png.
const HUD_FONT = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  ",": [0, 0, 0, 0, 0b00100, 0b00100, 0b01000],
  "-": [0, 0, 0, 0b11111, 0, 0, 0],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
};

function paintHud(sect, dist, nav, target) {
  hudCtx.clearRect(0, 0, 320, 64);
  countHudTicks();
  paintCrosshair();
  // FUN_0002fc40: each value is centred in its slot (x, y, slot width).
  hudSlot(sect, 41, 5, 51);
  hudSlot(dist, 41, 16, 30);
  hudSlot(nav, 41, 27, 23);
  // The weapon and its ammo, "inf" when unlimited.
  const ammo = ship.ammo[ship.weapon];
  hudSlot(paused ? "PAUSE" : WEAPONS[ship.weapon].name, 137, 5, 32);
  hudSlot(ammo === -1 || ammo === undefined ? "inf" : String(ammo), 115, 16, 32);
  paintThrottle();
  if (!navtar) return;
  const size = 36;
  hudCtx.save();
  hudCtx.translate(282, 31);
  hudCtx.rotate(markerAngle(target));
  hudCtx.imageSmoothingEnabled = true;
  hudCtx.drawImage(navtar, -size / 2, -size / 2, size, size);
  hudCtx.restore();
  paintRadar();
}

// FUN_0002fcb0: the throttle gauge, rows 12-14 from x 175. Its fill is
// (throttle - 0x4000) / 0xc000, 73 px at full; the afterburner does not
// show. The colour runs from palette 0x68 to 0x68 + 23 * fill (the top row
// to 0x68 + 17.25 * fill).
function paintThrottle() {
  if (!radarInk) return;
  const t = Math.round(ship.throttle * 0x10000);
  const fill = Math.min(0xffff, Math.max(0, Math.trunc(((t - 0x4000) * 0x4000) / 0xc000) * 4));
  const length = Math.floor((fill * 0x49) / 0x10000);
  for (let row = 0; row < 3; row++) {
    const end = row === 0 ? Math.floor((fill * 0x45) / 4) : fill * 0x17;
    gaugeRow(175, 12 + row, length, 0x680000, 0x680000 + end);
  }
}

// FUN_0002f870: one row of a gauge, palette index stepping from c0 to c1
// (16.16) in pairs of pixels; the rounding alternates with the row parity,
// which dithers the ramp.
function gaugeRow(x, y, length, c0, c1) {
  if (!length) return;
  const step = Math.trunc((c1 - c0) / length);
  const odd = y & 1;
  for (let i = 0, c = c0; i < length; i += 2) {
    const a = c;
    const b = c + step;
    c = b + step;
    gaugePixel(x + i, y, (a + (odd ? 0 : 0x8000)) >> 16);
    gaugePixel(x + i + 1, y, (b + (odd ? 0x8000 : 0)) >> 16);
  }
}

function gaugePixel(x, y, index) {
  hudCtx.fillStyle = `rgb(${radarInk[index * 3]},${radarInk[index * 3 + 1]},${radarInk[index * 3 + 2]})`;
  hudCtx.fillRect(x, y, 1, 1);
}

// ---------------------------------------------------------------- radar

// FUN_0002a240 / FUN_0002a090. The dial is a 57x47 box at (254, 7) that
// spans +-4 tiles each way (so it is squashed vertically); forward is up.
// The status bar is drawn over it, so blips only show inside the dial.
const RADAR = { x: 254, y: 7, w: 57, h: 47 };
// Fighters, chasers, tunnel craft and ceiling/floor huggers are orange
// (0x94); everything else pale green (0x3f). Logics 18 and 33 never show.
const RADAR_ORANGE = new Set([2, 4, 7, 8, 16, 0x26, 0x27]);
const RADAR_HIDDEN = new Set([0x12, 0x21]);

function paintRadar() {
  // The original draws no blips inside tunnels (DAT_00064d48 == 1).
  if (!radarFace || !radarInk || ship.space === "tunnel") return;
  const room = ship.space === "tunnel" ? ship.portal?.crowd : crowd;
  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  const sin = Math.sin(tmpEuler.y);
  const cos = Math.cos(tmpEuler.y);
  const delta = ship.space === "tunnel" ? (from, to) => to - from : wrapDelta;
  const plot = (pos, color) => {
    const dx = delta(ship.pos.x, pos.x);
    const dz = delta(ship.pos.z, pos.z);
    // Rotated into the ship's frame, in 1/256 tile, then 2048 of those per box.
    const right = Math.trunc((cos * dx - sin * dz) * 256);
    const ahead = Math.trunc(-(sin * dx + cos * dz) * 256);
    const x = RADAR.x + Math.trunc((RADAR.w * right) / 2048) + (RADAR.w >> 1);
    const y = RADAR.y + Math.trunc((RADAR.h * ahead) / 2048) + (RADAR.h >> 1);
    if (x < RADAR.x || x > RADAR.x + RADAR.w || y < RADAR.y || y > RADAR.y + RADAR.h) return;
    blip(x, y, pos.y < ship.pos.y, color);
  };
  for (const a of room?.actors || []) {
    if (!a.awake || !a.alive || RADAR_HIDDEN.has(a.def.logic)) continue;
    plot(a.pos, RADAR_ORANGE.has(a.def.logic) ? 0x94 : 0x3f);
  }
  // Power-ups pulse through palette 0x61-0x7e, one step per original frame.
  for (let i = 0; i < hudTicks; i++) {
    radarPulse += radarPulseStep;
    if (radarPulse > 0x7f) [radarPulse, radarPulseStep] = [0x7e, -1];
    if (radarPulse < 0x60) [radarPulse, radarPulseStep] = [0x61, 1];
  }
  for (const p of room?.pickups || []) {
    if (!p.taken) plot(p.pos, radarPulse);
  }
}

// Original frames (20 per second) since the last HUD paint, for the pulses.
let hudTicks = 0;
function countHudTicks() {
  const now = performance.now();
  if (now - radarClock > 1000) radarClock = now;
  hudTicks = 0;
  for (; radarClock + 50 <= now; radarClock += 50) hudTicks += 1;
}

// The sight, as it shows in the game (taken from a screen grab). Its colour
// walks palette 0x20-0x3f and back, one step per frame, like the mouse sight
// FUN_0002ab80 draws.
const SIGHT = [
  "    ####    ",
  "    ####    ",
  "#### ## ####",
  "############",
  "#### ## ####",
  "    ####    ",
  "    ####    ",
];
function paintCrosshair() {
  if (!radarInk) return;
  for (let i = 0; i < hudTicks; i++) {
    crosshairShade += crosshairStep;
    if (crosshairShade > 0x3f) [crosshairShade, crosshairStep] = [0x3f, -1];
    if (crosshairShade < 0x20) [crosshairShade, crosshairStep] = [0x20, 1];
  }
  const at = crosshairShade * 3;
  crosshairCtx.clearRect(0, 0, 12, 7);
  crosshairCtx.fillStyle = `rgb(${radarInk[at]},${radarInk[at + 1]},${radarInk[at + 2]})`;
  SIGHT.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") crosshairCtx.fillRect(x, y, 1, 1);
  });
}

// FUN_00029da0: a plus when the thing is above us, a dash when below,
// each outlined in black.
function blip(x, y, below, color) {
  const ink = (px, py, index) => {
    if (!radarFace[py * 320 + px]) return;
    hudCtx.fillStyle = `rgb(${radarInk[index * 3]},${radarInk[index * 3 + 1]},${radarInk[index * 3 + 2]})`;
    hudCtx.fillRect(px, py, 1, 1);
  };
  if (!below) ink(x, y - 2, 0);
  ink(x - 1, y - 1, 0);
  ink(x, y - 1, below ? 0 : color);
  ink(x + 1, y - 1, 0);
  ink(x - 2, y, 0);
  ink(x - 1, y, color);
  ink(x, y, color);
  ink(x + 1, y, color);
  ink(x + 2, y, 0);
  ink(x - 1, y + 1, 0);
  ink(x, y + 1, below ? 0 : color);
  ink(x + 1, y + 1, 0);
  if (!below) ink(x, y + 2, 0);
}

function hudSlot(text, x, y, width) {
  hudInk(text, x + Math.trunc((width - hudWidth(text)) / 2), y);
}

// FUN_00014a30: each glyph advances its width plus one.
function hudWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (hudGlyphs) width += code >= 32 && code < 128 ? hudGlyphs[code].glyphWidth + 1 : 0;
    else width += 6;
  }
  return width;
}

function hudInk(text, x, y) {
  if (hudGlyphs) {
    let cursor = x;
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code >= 128) continue;
      const glyph = hudGlyphs[code];
      hudCtx.drawImage(glyph, cursor, y);
      cursor += glyph.glyphWidth + 1;
    }
    return;
  }
  // Fallback when GAME.EXE was not given: a plain 5x7 font.
  let cursor = x;
  hudCtx.fillStyle = "#3cff45";
  for (const ch of String(text).toUpperCase()) {
    const rows = HUD_FONT[ch];
    if (rows) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (rows[row] & (1 << (4 - col))) hudCtx.fillRect(cursor + col, y + row, 1, 1);
        }
      }
    }
    cursor += 6;
  }
}

// ---------------------------------------------------------------- game files

// First start: the player gives the two POD archives (STARTUP.POD and
// CDROM.POD from the game folder). They are kept in IndexedDB, so later
// visits start straight away. ?pods=<folder>/ fetches them instead (dev).
async function storedArchive() {
  const names = await loadFile(PODS_KEY).catch(() => null);
  if (!Array.isArray(names) || !names.length) return null;
  const blobs = await Promise.all(names.map((name) => loadFile(name).catch(() => null)));
  if (blobs.some((blob) => !blob)) return null;
  return Archive.open(blobs);
}

function usable(candidate) {
  return candidate.has("art/vga.act") && candidate.list("levels/", ".lvl").length > 0;
}

async function storePods(files) {
  const pods = [];
  const exe = files.find((file) => /^game\.exe$/i.test(file.name));
  if (exe) await saveFile(EXE_KEY, exe);
  // The mission lists live loose in the game folder (src/menu.js).
  for (const file of files) {
    if (VOX_FILES.includes(file.name.toLowerCase())) await saveFile(file.name, file);
  }
  for (const file of files) {
    if (!/\.pod$/i.test(file.name)) continue;
    const head = new Uint8Array(await file.slice(0, 84).arrayBuffer());
    if (looksLikePod(head)) pods.push(file);
  }
  if (!pods.length) throw new Error("No POD archives among those files.");
  const ordered = podOrder(pods.map((file) => file.name)).map((name) => pods.find((file) => file.name === name));
  const candidate = await Archive.open(ordered);
  if (!usable(candidate)) throw new Error("Those archives do not hold the game data. Pick STARTUP.POD and CDROM.POD.");
  for (const file of ordered) await saveFile(file.name, file);
  await saveFile(PODS_KEY, ordered.map((file) => file.name.toLowerCase()));
  keepFiles();
  return candidate;
}

async function fetchPods(folder) {
  const files = [];
  for (const name of ["STARTUP.POD", "CDROM.POD"]) {
    setupNote.textContent = `Downloading ${name}…`;
    const response = await fetch(`${folder}${name}`);
    if (!response.ok) throw new Error(`${folder}${name} ${response.status}`);
    files.push(new File([await response.blob()], name));
  }
  for (const name of VOX_FILES) {
    const response = await fetch(`${folder}${name.toUpperCase()}`).catch(() => null);
    if (response?.ok) files.push(new File([await response.blob()], name));
  }
  return storePods(files);
}

function askForPods() {
  setupEl.hidden = false;
  setStatus("");
  return new Promise((resolve) => {
    const take = async (files) => {
      setupNote.textContent = "Reading…";
      try {
        const result = await storePods([...files]);
        setupEl.hidden = true;
        resolve(result);
      } catch (err) {
        setupNote.textContent = String(err.message || err);
      }
    };
    setupInput.onchange = () => take(setupInput.files);
    setupEl.ondragover = (event) => event.preventDefault();
    setupEl.ondrop = (event) => {
      event.preventDefault();
      take(event.dataTransfer.files);
    };
  });
}

forgetBtn.addEventListener("click", async () => {
  if (!confirm("Remove the stored game files from this browser?")) return;
  await forgetFiles();
  location.reload();
});

// The status-bar font is only in GAME.EXE. It is optional at setup; with
// ?pods=<folder>/ it is fetched from the same folder.
async function loadHudFont(vga) {
  let blob = await loadFile(EXE_KEY).catch(() => null);
  if (!blob && params.get("pods")) {
    const response = await fetch(`${params.get("pods")}GAME.EXE`).catch(() => null);
    if (response?.ok) {
      blob = await response.blob();
      await saveFile(EXE_KEY, blob);
    }
  }
  const font = blob ? readHudFont(new Uint8Array(await blob.arrayBuffer())) : null;
  smallFont = font;
  if (!font) return null;
  const glyphs = [];
  for (let code = 0; code < 128; code++) {
    const width = font[code * 64];
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = 8;
    if (width) {
      const ctx = canvas.getContext("2d");
      const image = ctx.createImageData(width, 8);
      for (let i = 0; i < width * 8; i++) {
        const v = font[code * 64 + 1 + i];
        if (!v) continue;
        const index = 0x20 + v;
        image.data.set([vga[index * 3], vga[index * 3 + 1], vga[index * 3 + 2], 255], i * 4);
      }
      ctx.putImageData(image, 0, 0);
    }
    glyphs.push(Object.assign(canvas, { glyphWidth: width }));
  }
  return glyphs;
}

// The status bar and nav marker, drawn from the game's own art (VGA palette).
// The compass interior is palette 0; it gets an opaque dark face so the ship
// icon sits on a solid dial. The marker's flat backing plate is transparent.
const NAVTAR_FIELD = new Set([0, 8, 9, 10, 12]);
async function loadHud() {
  const vga = await readPalette(archive, "vga");
  radarInk = vga;
  hudGlyphs = await loadHudFont(vga);
  const paint = (bytes, width, height, transparent) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const idx = bytes[i];
      image.data.set([vga[idx * 3], vga[idx * 3 + 1], vga[idx * 3 + 2], transparent(idx) ? 0 : 255], i * 4);
    }
    return { canvas, ctx, image };
  };
  if (archive.has("art/statbar.raw")) {
    const bar = paint(await archive.bytes("art/statbar.raw"), 320, 64, (idx) => idx === 0);
    const px = bar.image.data;
    const stack = [282 + 31 * 320];
    radarFace = new Uint8Array(320 * 64);
    while (stack.length) {
      const i = stack.pop();
      if (px[i * 4 + 3] !== 0) continue;
      px.set([14, 14, 14, 255], i * 4);
      radarFace[i] = 1;
      const x = i % 320;
      if (x > 0) stack.push(i - 1);
      if (x < 319) stack.push(i + 1);
      if (i >= 320) stack.push(i - 320);
      if (i < 320 * 63) stack.push(i + 320);
    }
    hudBar.getContext("2d").putImageData(bar.image, 0, 0);
  }
  if (archive.has("art/navtar01.raw")) {
    const marker = paint(await archive.bytes("art/navtar01.raw"), 64, 64, (idx) => NAVTAR_FIELD.has(idx));
    marker.ctx.putImageData(marker.image, 0, 0);
    navtar = marker.canvas;
  }
}

// ---------------------------------------------------------------- main

function fillPicker() {
  const mode = modeEl.value;
  pickEl.innerHTML = "";
  const items = mode === "map"
    ? levelList.filter((lvl) => isSurface(archive, lvl)).map((lvl) => lvl.name)
    : archive.list("models/", ".bin").map((path) => path.slice(7, -4));
  for (const name of items) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    pickEl.appendChild(option);
  }
  const asked = params.get(mode === "map" ? "level" : "model");
  const preferred = asked || (mode === "map" ? "artic" : "afighter");
  if (items.includes(preferred)) pickEl.value = preferred;
}

async function loadSelection() {
  const gen = ++loadGen;
  setError("");
  stopFly();
  const name = pickEl.value;
  try {
    if (modeEl.value === "map") {
      await showMap(name, gen);
      // ?fly=1 drops straight into the cockpit at the spawn point.
      if (gen === loadGen && params.has("fly")) startFly();
    } else {
      await showModel(name, gen);
    }
  } catch (err) {
    if (gen !== loadGen || err instanceof Cancelled) return;
    console.error(err);
    setError(String(err.message || err));
    setStatus("");
  }
}

// The flash recolors the 3D view only; the HUD is drawn after it (FUN_0002cdd0).
const flashBackground = new THREE.Color();
const backgroundRgb = { r: 0, g: 0, b: 0 };
function renderFrame() {
  const flash = flying && ship.flash > 0 && level;
  shade.uFlash.value = flash ? 1 : 0;
  if (!flash) {
    renderer.render(scene, camera);
    return;
  }
  const look = ship.space === "tunnel" && ship.portal ? ship.portal.look : level.look;
  const color = lookUniforms(look).flashColors[ship.flashColor];
  shade.uFlashColor.value.copy(color);
  const background = scene.background;
  background.getRGB(backgroundRgb, THREE.SRGBColorSpace);
  const len = Math.min(255, Math.floor(255 * Math.hypot(backgroundRgb.r, backgroundRgb.g, backgroundRgb.b)));
  const tint = (c) => (Math.floor((Math.round(c * 255) * len) / 4096) * 8) / 255;
  scene.background = flashBackground.setRGB(tint(color.x), tint(color.y), tint(color.z), THREE.SRGBColorSpace);
  renderer.render(scene, camera);
  scene.background = background;
}

let elapsed = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (menu?.active) {
    menuFrame(dt);
    requestAnimationFrame(frame);
    return;
  }
  if (flying) {
    if (cut) stepCut(dt);
    else if (!paused) {
      elapsed += dt;
      stepTimers(dt);
      stepFlight(dt, elapsed);
      stepContact(dt);
      stepGuns(dt);
      stepCrowds(dt);
      if (ship.space === "tunnel" && ship.portal) electricSound(ship.portal, elapsed - dt, elapsed);
      setStatus(flightStatus());
    }
    syncCamera();
    if (!cut) updateHud();
  } else {
    controls.update();
  }
  // [I] Pausing cuts the burner loop too; the original's pause is not traced.
  if (!flying || paused || cut) cutBurnerSound();
  if (!(flying && paused)) updateAnimations(dt);
  updateSpinners(elapsed);
  if (ship.space === "tunnel" && ship.portal) updateObstacles(ship.portal, elapsed);
  updateWindow();
  updateSky();
  syncCrowds();
  updateShadows(flying);
  world.updateMatrixWorld(true);
  shade.uGameFrame.value.copy(surface.matrixWorld).invert();
  renderFrame();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- shadows

// FUN_0001edd0, with Shadows not Off, outside tunnels, at most 0x40 a
// frame: a ray leaves the object along the light vector (DAT_0007d020,
// 0x10000 long, so 1/16 tile a step) for at most 256 steps until it is under
// the ground, steps back along the vector by that depth, and there
// FUN_0001ea80 lays a square of side `size` on the ground: corners at ground
// height, triangles 0-1-2 and 0-3-2, texture 4..251 of 256 across. Texel 0
// is left alone, texel 1 is shadow:
//   486: shadow.raw (a disc), the texel written as is (palette 1);
//   Pentium: FUN_0001e920 first draws the model's silhouette over it, seen
//     from straight above (pitch 0x3fff, yaw 0) with the eye `size` over the
//     model, 64x64 at focal 32, so the texture covers twice the square; the
//     texel goes through the mix table (0x82974), palette 1 and the screen
//     half and half.
// Shadowed: slots that ran this frame whose def has logic 2, 4, 7, 8, 0x11,
// 0x12, 0x26 or 0x27, size the def radius (FUN_000241c0); the player, size
// 1/16 tile with ship.bin, in the main loop only (FUN_00013500), so not in
// the fly-in or the report.
// [I] The mix table keeps black pixels black and lands on a palette color;
// here it is a plain half blend. Not in caves.
const SHADOW_LOGICS = new Set([2, 4, 7, 8, 0x11, 0x12, 0x26, 0x27]);
const SHADOW_MAX = 0x40;
const SHADOW_GRID = 8; // atlas cells across, 64 pixels each
const SHADOW_CORNERS = [[1, 1, 251, 4], [-1, 1, 4, 4], [-1, -1, 4, 251], [1, -1, 251, 251]];
const SHADOW_ORDER = [0, 1, 2, 0, 3, 2];
const shadows = {
  atlas: new THREE.WebGLRenderTarget(64 * SHADOW_GRID, 64 * SHADOW_GRID, {
    magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, generateMipmaps: false,
  }),
  stage: new THREE.Scene(),
  root: new THREE.Group(),
  eye: new THREE.PerspectiveCamera(90, 1, 0.0005, 4),
  down: new THREE.Quaternion().setFromEuler(new THREE.Euler((0x3fff / 0x10000) * TAU, 0, 0, "YXZ")),
  standIns: new WeakMap(), // placed model -> its copy on the stage
  disc: null, // shadow.raw
  player: null, // { look, object }
  mesh: null,
};
shadows.root.scale.z = -1;
shadows.stage.add(shadows.root);
shadows.stage.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

function shadowMesh() {
  if (shadows.mesh) return shadows.mesh;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SHADOW_MAX * 18), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(SHADOW_MAX * 12), 2));
  const material = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: null }, uColor: { value: new THREE.Vector3() }, uAlpha: { value: 1 } },
    vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  if (texture2D(uMap, vUv).r < 0.5 / 255.0) discard;
  gl_FragColor = vec4(uColor, uAlpha);
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  });
  shadows.mesh = new THREE.Mesh(geometry, material);
  shadows.mesh.frustumCulled = false;
  shadows.mesh.renderOrder = 1;
  return shadows.mesh;
}

// Where the light from (x, y, z) meets the ground, or null.
function shadowSpot(x, y, z) {
  const [dx, dy, dz] = shadowSun.map((v) => v / 0x10000 / 16);
  for (let i = 0; i < 256; i++) {
    x += dx;
    y += dy;
    z += dz;
    const g = groundAt(x, z);
    if (y < g) {
      const back = (g - y) * 16;
      return [x - back * dx, y - back * dy, z - back * dz];
    }
  }
  return null;
}

function updateShadows(active) {
  const mesh = shadowMesh();
  const mode = settings.shadows;
  mesh.visible = false;
  if (!active || !mode || !level || ship.space !== "surface" || !terrainMeshes[0]?.visible) return;
  if (mesh.parent !== surface) surface.add(mesh);
  if (mode === 1 && !shadows.disc) {
    shadows.disc = indexTexture("art/shadow.raw");
    shadows.disc.then((t) => (shadows.disc = t || shadows.disc));
  }
  if (shadows.player?.look !== level.look) {
    const look = level.look;
    shadows.player = { look, object: null };
    loadModel("ship", look).then((t) => {
      if (t && shadows.player.look === look) shadows.player.object = placeModel(t, 0, 0, 0, {});
    });
  }
  const casters = [];
  for (const a of crowd?.actors || []) {
    if (casters.length >= SHADOW_MAX) break;
    if (a.alive && a.mesh?.visible && SHADOW_LOGICS.has(a.def.logic)) casters.push({ object: a.mesh, pos: a.mesh.position, q: a.mesh.quaternion, size: a.radius });
  }
  if (!cut && shadows.player.object && casters.length < SHADOW_MAX) {
    casters.push({ object: shadows.player.object, pos: ship.pos, q: ship.q, size: 1 / 16 });
  }
  const pentium = mode === 2;
  const pos = mesh.geometry.attributes.position.array;
  const uv = mesh.geometry.attributes.uv.array;
  let count = 0;
  if (pentium) {
    renderer.getClearColor(shadowClear);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(shadows.atlas);
    renderer.clear();
    shadows.atlas.scissorTest = true;
    for (const c of casters) placeShadow(c);
    shadows.atlas.scissorTest = false;
    renderer.setRenderTarget(null);
    renderer.setClearColor(shadowClear, clearAlpha);
  } else {
    for (const c of casters) placeShadow(c);
  }

  function placeShadow(c) {
    const spot = shadowSpot(c.pos.x, c.pos.y, c.pos.z);
    if (!spot) return;
    const cell = count;
    const cx = (cell % SHADOW_GRID) * 64;
    const cy = Math.floor(cell / SHADOW_GRID) * 64;
    if (pentium) {
      let standIn = shadows.standIns.get(c.object);
      if (!standIn) shadows.standIns.set(c.object, (standIn = c.object.clone(true)));
      standIn.position.set(0, 0, 0);
      standIn.quaternion.copy(c.q);
      standIn.visible = true;
      shadows.root.add(standIn);
      gameView(shadows.eye, shadowEyeAt.set(0, c.size, 0), shadows.down);
      shadows.eye.near = c.size / 64;
      shadows.eye.far = c.size * 4;
      shadows.eye.updateProjectionMatrix();
      shadows.atlas.viewport.set(cx, cy, 64, 64);
      shadows.atlas.scissor.set(cx, cy, 64, 64);
      renderer.setRenderTarget(shadows.atlas);
      renderer.render(shadows.stage, shadows.eye);
      shadows.root.remove(standIn);
    }
    const half = c.size / 2;
    SHADOW_ORDER.forEach((k, i) => {
      const [sx, sz, u, v] = SHADOW_CORNERS[k];
      const x = spot[0] + sx * half;
      const z = spot[2] + sz * half;
      pos.set([x, groundAt(x, z), z], (count * 6 + i) * 3);
      // Texture rows run down the screen, -z; the atlas has row 0 at the top
      // of its cell.
      if (pentium) uv.set([(cx + u / 4) / shadows.atlas.width, (cy + 64 - v / 4) / shadows.atlas.height], (count * 6 + i) * 2);
      else uv.set([u / 256, v / 256], (count * 6 + i) * 2);
    });
    count += 1;
  }

  const map = pentium ? shadows.atlas.texture : shadows.disc;
  if (!count || !map || map instanceof Promise) return;
  const material = mesh.material;
  material.uniforms.uMap.value = map;
  material.uniforms.uAlpha.value = pentium ? 0.5 : 1;
  const p = level.look.palette;
  material.uniforms.uColor.value.set(p[3] / 255, p[4] / 255, p[5] / 255);
  mesh.geometry.setDrawRange(0, count * 6);
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.geometry.attributes.uv.needsUpdate = true;
  mesh.visible = true;
}
const shadowClear = new THREE.Color();
const shadowEyeAt = new THREE.Vector3();

// ---------------------------------------------------------------- game mode

// The front end owns the screen: the flight is frozen underneath. The Esc
// question is drawn over the frozen view; every other screen is opaque,
// with 3D showing through the window of the name, briefing and report
// screens.
function menuFrame(dt) {
  cutBurnerSound();
  menu.tick(dt);
  if (!menu.active) return;
  if (menu.inked) {
    renderFrame();
    return;
  }
  renderer.setClearColor(0x000000, 1);
  renderer.setScissorTest(false);
  renderer.clear();
  const view = win.view;
  if (!win.rect || !view) return;
  if (view.kind === "report") renderReport(dt, view);
  else renderWindowModel(dt, view);
}

// The front end's 3D window, (0x50,0x16)-(0xef,99). FUN_00014910 projects
// a window with half its height rounded down to even, less one (37), and
// 4/3 of that across; the zoom (0x64cd0) divides depth, so 0x8000 shows
// things twice as big.
function windowProjection(cam, rect, zoom) {
  const half = ((rect.h / 2) & ~1) - 1;
  cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan((rect.h / 2 / half) * zoom));
  cam.aspect = (rect.w / rect.h) * 0.75;
  cam.updateProjectionMatrix();
}

function renderInWindow(sceneToDraw, cam, rect) {
  const sx = FRAME_W / 320;
  const sy = FRAME_H / 200;
  renderer.setViewport(rect.x * sx, (200 - rect.y - rect.h) * sy, rect.w * sx, rect.h * sy);
  renderer.setScissor(rect.x * sx, (200 - rect.y - rect.h) * sy, rect.w * sx, rect.h * sy);
  renderer.setScissorTest(true);
  renderer.render(sceneToDraw, cam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, FRAME_W, FRAME_H);
}

// A model in the window, over the star field (FUN_00018420).
//   ship (FUN_0004b5e0): ship.bin at the origin, pitched 0x1000, turning
//     1/8 of a circle per game second; the eye 1.5 radii back, zoom 0x8000.
//   brief (FUN_0004aef0): the briefing model at rest, textured with the
//     file's second name; the eye one radius out, circling it 1/16 turn per
//     game second and looking in; light (0, -0xb4fd, 0xb4fd); zoom 1.
// The radius is the model's corner radius from its origin (FUN_000405b0).
const win = { rect: null, view: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), models: new Map(), shipYaw: 0, stars: null, starPalette: null };
win.scene.add(new THREE.Group());
win.scene.children[0].scale.z = -1;

function windowView(rect, view) {
  win.rect = rect;
  win.view = view;
  if (!view) return;
  if (view.kind === "ship") win.shipYaw = 0;
  if (view.kind !== "report") windowModel(view);
}

function windowModel(view) {
  let model = view.kind === "ship" ? "ship" : view.model.replace(/\.bin$/, "");
  if (model === "aliensh") model = "aliensh1"; // swapped by FUN_0004aef0
  const texture = view.kind === "brief" && view.texture !== "null.raw" ? `art/${view.texture}` : null;
  const key = `${view.kind}|${model}|${texture}|${view.kind === "brief" ? level?.name : ""}`;
  if (!win.models.has(key)) {
    win.models.set(key, (async () => {
      let look = level?.look;
      if (view.kind === "ship") {
        if (!modelLook) modelLook = { palette: null, fog: null, light: null, fogIndex: 0 };
        if (!modelLook.palette) modelLook.palette = await readPalette(archive, "vga");
        look = modelLook;
      }
      const template = await loadModel(model, look, texture);
      if (!template) return null;
      const object = template.object.clone(true);
      return { object, radius: cornerRadius(object), palette: look.palette };
    })().catch((err) => {
      console.warn("window model:", err);
      return null;
    }));
  }
  win.models.get(key).then((built) => {
    if (win.view !== view || !built) return;
    const group = win.scene.children[0];
    for (const child of [...group.children]) if (child !== win.stars) group.remove(child);
    group.add(built.object);
    view.built = built;
  });
}

function cornerRadius(object) {
  const box = new THREE.Box3().setFromObject(object);
  return Math.hypot(...["x", "y", "z"].map((k) => Math.max(Math.abs(box.min[k]), Math.abs(box.max[k]))));
}

// FUN_00017b40: 2000 stars, x and z within ±64 units, y 0..128 for the
// first 1001 and below for the rest, each palette 0..31 (rand() >> 10).
function windowStars(palette) {
  if (!win.stars) {
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0x7fff;
    const pos = [];
    win.starIndex = [];
    for (let i = 0; i < 2000; i++) {
      const x = rand() * 256 - 0x400000;
      const y = (rand() << 8) * (i > 1000 ? -1 : 1);
      const z = rand() * 256 - 0x400000;
      pos.push(x / 0x400000, y / 0x400000, z / 0x400000);
      win.starIndex.push(rand() >> 10);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    win.stars = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: FRAME_H / 200, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, fog: false,
    }));
    win.stars.renderOrder = -1;
    win.stars.frustumCulled = false;
  }
  if (win.starPalette !== palette) {
    win.starPalette = palette;
    const colors = win.stars.geometry.getAttribute("color");
    win.starIndex.forEach((index, i) => {
      colors.setXYZ(i, palette[index * 3] / 255, palette[index * 3 + 1] / 255, palette[index * 3 + 2] / 255);
    });
    colors.needsUpdate = true;
    win.stars.material.color.set(0xffffff);
  }
  return win.stars;
}

const winEye = new THREE.Vector3();
const winQ = new THREE.Quaternion();
const winEuler = new THREE.Euler(0, 0, 0, "YXZ");
function renderWindowModel(dt, view) {
  const built = view.built;
  if (!built) return;
  const { object, radius } = built;
  const group = win.scene.children[0];
  const stars = windowStars(built.palette);
  if (stars.parent !== group) group.add(stars);
  let sun;
  let ambient;
  if (view.kind === "ship") {
    win.shipYaw += (dt / GAME_SECOND) * (TAU / 8);
    object.position.set(0, 0, 0);
    object.rotation.set(TAU / 16, win.shipYaw, 0, "YXZ");
    winEye.set(0, 0, -1.5 * radius);
    winQ.identity();
    windowProjection(win.camera, win.rect, 0.5);
    // [I] The light is the one GAME.EXE last set; before any level it is
    // not traced, so the model viewer's is used.
    sun = [-30000, -46333, 30000];
    ambient = 26000;
  } else {
    const a = view.angle * TAU;
    object.position.set(0, 0, 0);
    object.rotation.set(0, 0, 0);
    winEye.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    winQ.setFromEuler(winEuler.set(0, TAU * 0.75 - a, 0));
    windowProjection(win.camera, win.rect, 1);
    sun = BRIEF_SUN;
    ambient = level?.ambient;
  }
  // The stars turn with the eye but never come nearer (no translation).
  stars.position.copy(winEye);
  stars.scale.setScalar(radius * 8);
  win.camera.near = radius / 50;
  win.camera.far = radius * 40;
  win.camera.updateProjectionMatrix();
  gameView(win.camera, winEye, winQ);
  const fly = shade.uFly.value;
  const oldSun = shade.uSun.value.clone();
  const oldAmbient = shade.uAmbient.value;
  shade.uFly.value = 0;
  setLighting(sun, ambient);
  renderInWindow(win.scene, win.camera, win.rect);
  shade.uFly.value = fly;
  shade.uSun.value.copy(oldSun);
  shade.uAmbient.value = oldAmbient;
}

const BRIEF_SUN = [0, -0xb4fd, 0xb4fd];

// FUN_00049cb0: the level in the window, the eye circling the target at
// twice its def radius (+0x98), a quarter turn per game second, one radius
// above the ground or the target, whichever is higher, looking down at it;
// zoom 0x8000. The level runs meanwhile (DAT_00064d40 set).
function renderReport(dt, view) {
  const target = view.target;
  if (target.radius === undefined) {
    target.radius = null;
    loadModel(target.model, level.look).then((t) => {
      target.radius = t ? cornerRadius(t.object) : 0.5;
    });
  }
  if (!target.radius) return;
  const r = target.radius;
  const a = view.angle * TAU;
  const floor = groundAt(target.x, target.z);
  if (!cut) cut = { pos: new THREE.Vector3(), q: new THREE.Quaternion() };
  const x = target.x + Math.cos(a) * 2 * r;
  const z = target.z + Math.sin(a) * 2 * r;
  const y = Math.max(groundAt(x, z), floor) + r;
  cut.pos.set(x, y, z);
  cut.q.setFromEuler(winEuler.set(Math.atan2(y - floor, 2 * r), TAU * 0.75 - a, 0));
  elapsed += dt;
  stepCrowds(dt);
  updateAnimations(dt);
  updateSpinners(elapsed);
  updateWindow();
  updateSky();
  syncCamera();
  syncCrowds();
  updateShadows(true);
  world.updateMatrixWorld(true);
  shade.uGameFrame.value.copy(surface.matrixWorld).invert();
  const { fov, aspect } = camera;
  windowProjection(camera, win.rect, 0.5);
  renderInWindow(scene, camera, win.rect);
  camera.fov = fov;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

// FUN_0004a690: before the flight, the eye starts straight above the
// spawn, half the deck height over the ground, looking straight down
// (pitch 0x3fff), and turns a quarter circle per game second while it
// sinks a tile per game second, until it is within 1/16 tile of the ship.
// The level runs meanwhile. Esc, Space or F1 cut it short.
// It runs in outside view (DAT_00064ce8 = 2), so FUN_00012fe0 draws the
// player's model (DAT_0007cf50, ship.bin) at the ship, turned by its
// angles; the ship doesn't move until the flight starts.
async function flyIn() {
  const template = await loadModel("ship", level.look);
  const parked = template ? placeModel(template, 0, 0, 0, {}) : null;
  if (parked) {
    parked.position.copy(ship.pos);
    parked.quaternion.copy(ship.q);
    surface.add(parked);
  }
  return new Promise((resolve) => {
    const pos = new THREE.Vector3(ship.pos.x, groundAt(ship.pos.x, ship.pos.z) + TOP / 2, ship.pos.z);
    let yaw = 0;
    cut = {
      pos, q: new THREE.Quaternion(),
      step(g) {
        yaw += g / 4;
        pos.y -= g;
        if (pos.y < ship.pos.y + 1 / 16) return this.skip();
        this.q.setFromEuler(winEuler.set((0x3fff / 0x10000) * TAU, yaw * TAU, 0));
      },
      skip() {
        parked?.removeFromParent();
        cut = null;
        resolve();
      },
    };
    cut.step(0);
  });
}

function stepCut(dt) {
  elapsed += dt;
  cut.step?.(dt / GAME_SECOND);
  if (cut) stepCrowds(dt);
}

function askReturn() {
  keys.clear();
  mouseFire = false;
  cutBurnerSound();
  menu.askReturn((yes) => {
    if (!yes) {
      lockPointer();
      return;
    }
    hudEl.hidden = true;
    crosshairEl.hidden = true;
    setStatus("");
  });
  if (document.pointerLockElement) document.exitPointerLock();
}

// Play Game → New Game: load the mission's first level, run its start
// (FUN_0002cdd0) and fly it.
async function startGame({ level: name, difficulty: chosen, callsign = "Ice Man", intro = true }) {
  difficulty = chosen;
  gameStarted = false;
  stopMusic();
  menu.loading();
  const gen = ++loadGen;
  stopFly();
  cut = null;
  briefSun = null;
  try {
    await showMap(name, gen);
  } catch (err) {
    if (gen !== loadGen || err instanceof Cancelled) return;
    console.error(err);
    setError(String(err.message || err));
    menu.backToLoop(1, 0);
    return;
  }
  if (gen !== loadGen) return;
  gameStarted = true;
  // The level's music starts with the level (FUN_00033070).
  startFly({ intro });
  if (intro) {
    await levelIntro(callsign);
    if (gen !== loadGen) return;
  }
  menu.hide();
  beginFlight();
}

// FUN_0002cdd0, when the level's briefing file differs from the last
// level's: the story .mic (Cinemas), the briefing and tactical report
// (Level Briefings), the .tvi cinemas; then, every time, the fly-in
// (Cinemas, surface levels).
// [I] The .tvi videos are not played: they are not in the PODs.
let lastBriefing = null;
async function levelIntro(callsign) {
  const fresh = level.briefing !== lastBriefing;
  lastBriefing = level.briefing;
  menu.useLevelPalette(level.look.palette);
  const text = async (name) => (name && name !== "null" && archive.has(`data/${name}`) ? archive.text(`data/${name}`) : null);
  if (fresh && settings.cinemas) {
    const story = await text(level.stories?.[3]);
    if (story) await new Promise((done) => menu.story(story, done));
  }
  if (fresh && settings.briefings && level.briefing !== "null.txt") {
    const brief = await text(level.briefing);
    if (brief) {
      const key = await new Promise((done) => menu.briefing({ text: brief, callsign }, done));
      briefSun = BRIEF_SUN;
      setLighting(briefSun, level.ambient);
      // [I] The original polls held keys, so Esc held from the briefing
      // also ends the report; here Esc there skips it outright.
      if (key !== "Escape") {
        for (const target of level.briefTargets || []) {
          const how = await new Promise((done) => menu.report(target, done));
          if (how === "abort") break;
        }
      }
      cut = null;
    }
  }
  menu.hide();
  if (settings.cinemas && !level.isTunnel) {
    hudEl.hidden = true;
    crosshairEl.hidden = true;
    await flyIn();
  }
}

// Play Game → Resume Game: back into the flight left with Esc (0x2ed30).
function resumeGame() {
  hudEl.hidden = false;
  crosshairEl.hidden = false;
  paused = false;
  clock.getDelta();
  wakeMusic();
  wakeSfx();
  playMusic(levelMusic());
  setStatus(flightStatus());
  lockPointer();
}

async function loadVox() {
  const vox = {};
  for (const name of VOX_FILES) {
    let blob = await loadFile(name).catch(() => null);
    if (!blob && params.get("pods")) {
      const response = await fetch(`${params.get("pods")}${name.toUpperCase()}`).catch(() => null);
      if (response?.ok) {
        blob = await response.blob();
        await saveFile(name, blob);
      }
    }
    if (blob) vox[name] = await blob.text();
  }
  return vox;
}

async function startMenu() {
  document.body.classList.add("game");
  const vga = await readPalette(archive, "vga");
  const mix = archive.has("fog/vga.mix") ? await archive.bytes("fog/vga.mix") : null;
  menu = new Menu({
    archive, canvas: menuEl, palette: vga, mix, smallFont, vox: await loadVox(), settings,
    hooks: {
      musicUrl: (path) => objectUrl(path, "audio/x-mod"),
      playMusic: (url) => playMusic(url),
      stopMusic,
      sound: (name) => playSfx(name, 3, 0),
      wake: () => {
        wakeMusic();
        wakeSfx();
      },
      startGame,
      resumeGame,
      canResume: () => gameStarted && flying,
      windowView,
      settingsChanged: (next) => {
        Object.assign(settings, next);
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {}
        applySettings();
      },
      quit: () => {
        stopFly();
        gameStarted = false;
        setStatus("");
      },
    },
  });
  await menu.load();
  setStatus("");
  // ?play=<level>: straight into the flight, menus skipped (debugging).
  const play = params.get("play");
  // &intro=1 runs the level's start (story, briefing, fly-in) as New Game does.
  if (play) return startGame({ level: play, difficulty, intro: params.has("intro") });
  menu.start(params.get("menu") || "title");
}

// ?debug exposes the flight state for poking at from the console.
if (params.has("debug")) {
  window.tv = { ship, keys, portals: () => portals, nav: () => navCursor, navTarget, navEnterTunnel, setSpace, startFly, groundAt, THREE, archive: () => archive, crowd: () => crowd, menu: () => menu };
}

modeEl.addEventListener("change", () => {
  fillPicker();
  loadSelection();
});
pickEl.addEventListener("change", loadSelection);

try {
  frame();
  setStatus("Opening game files…");
  archive = await storedArchive();
  if (archive && !usable(archive)) archive = null;
  if (!archive && params.get("pods")) archive = await fetchPods(params.get("pods"));
  if (!archive) archive = await askForPods();
  forgetBtn.hidden = false;
  levelList = await readLevels(archive);
  await loadHud();
  applySettings();
  if (gameMode) {
    fillPicker();
    await startMenu();
  } else {
    if (params.get("mode") === "model") modeEl.value = "model";
    fillPicker();
    await loadSelection();
  }
} catch (err) {
  console.error(err);
  setError(`${err.message || err}. Serve the repo root over http (python3 -m http.server) and open index.html.`);
}
