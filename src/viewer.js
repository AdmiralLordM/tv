import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Archive, podOrder, looksLikePod } from "./pod.js";
import { saveFile, loadFile, forgetFiles, keepFiles } from "./store.js";
import { readLevels, isSurface, readLevel, readPalette, resolveModel } from "./formats.js";
import { parseBin, binGroups } from "./bin.js";
import { playMusic, stopMusic, toggleMusic, wakeMusic } from "./music.js";
import { Crowd, isActor } from "./ai.js";

// Engine values recovered from GAME.EXE. Section numbers point into
// docs/original-engine.md. Lengths are tiles (one tile = 2^20 game units).
const MAP = 256;
const HEIGHT_PER_BYTE = 1 / 32; // a height byte is 0x8000 units (3.3)
const TOP = 255 * HEIGHT_PER_BYTE; // tallest ground; also the sky plane and the cave mirror
const GAME_SECOND = 0.98864; // one 16.16 game second in real seconds (2.2)
const THROTTLE_MIN = 0.25; // throttle is tiles per game second (2.3)
const THROTTLE_MAX = 1;
const THROTTLE_START = 0.5;
const THROTTLE_RATE = 1; // A/Z held, per second
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

const params = new URLSearchParams(location.search);
const frameEl = document.getElementById("frame");
const modeEl = document.getElementById("mode");
const pickEl = document.getElementById("pick");
const flyBtn = document.getElementById("fly");
const forgetBtn = document.getElementById("forget");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const hudEl = document.getElementById("hud");
const hudBar = document.getElementById("hudBar");
const hudText = document.getElementById("hudText");
const hudCtx = hudText.getContext("2d");
const crosshairEl = document.getElementById("crosshair");
const setupEl = document.getElementById("setup");
const setupInput = document.getElementById("setupFiles");
const setupNote = document.getElementById("setupNote");
let navtar = null;
let radarFace = null; // 320x64 mask of the dial interior the radar shows through
let radarInk = null; // VGA palette, for the blip colours
let radarPups = []; // power-up positions for the radar
let radarPulse = 0x61;
let radarPulseStep = 1;
let radarClock = 0;
let scrapeSound = { play: () => Promise.resolve(), currentTime: 0 };

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
  gl_FragColor = vec4(texture2D(uPalette, vec2((index + 0.5) / 256.0, 0.5)).rgb, 1.0);
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
    fogColor: new THREE.Color().setRGB(look.palette[fogAt * 3] / 255, look.palette[fogAt * 3 + 1] / 255,
      look.palette[fogAt * 3 + 2] / 255, THREE.SRGBColorSpace),
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
  lastScrape: 0,
};

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

function setStatus(text) {
  if (statusEl.textContent !== text) statusEl.textContent = text;
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
    if (model.kind === "anim") {
      const first = (model.frames[0] || "").toLowerCase().replace(/\.bin$/, "");
      if (!first || !archive.has(`models/${first}.bin`)) return null;
      model = parseBin(await archive.bytes(`models/${first}.bin`), first);
      if (model.kind !== "model") return null;
    }
    const { groups } = binGroups(model);
    const parts = groups.map((g) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.position, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(g.normal, 3));
      geometry.setAttribute("ramp", new THREE.Float32BufferAttribute(g.ramp, 2));
      geometry.setAttribute("lit", new THREE.Float32BufferAttribute(g.lit, 1));
      return { geometry, texture: g.texture, alpha: g.alpha, inherit: g.inherit };
    });
    let radius = 0;
    for (const [x, y, z] of model.vertices) radius = Math.max(radius, Math.hypot(x, y, z) / model.scale);
    return { parts, radius: radius * MODEL_SCALE };
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
      const map = part.texture ? await indexTexture(`art/${part.texture}`)
        : part.inherit && inherit ? await indexTexture(inherit) : null;
      // Every .bin face is single-sided; DoubleSide covers faces whose stored
      // normal and winding disagree.
      const material = paletteMaterial(look, {
        map, alpha0: part.alpha, model: true, windowed: false,
        fogK: FOG_OBJECTS ? FOG_K : 1e12, side: THREE.DoubleSide,
      });
      object.add(new THREE.Mesh(part.geometry, material));
    }
    object.scale.setScalar(MODEL_SCALE);
    return { object, radius: built.radius };
  })();
  byLook.set(key, pending);
  return pending;
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
  portal.crowd = new Crowd({ parent: portal.props, tunnel: segments });
  const names = [...new Set((data.contents || []).map((spot) => spot.model))];
  const templates = new Map();
  await mapLimit(names, 3, async (name) => templates.set(name, await loadModel(name, look)));
  if (gen !== loadGen) throw new Cancelled();
  // Tunnel props keep their file x, y, z in tunnel space (6.2).
  for (const spot of data.contents || []) {
    const template = templates.get(spot.model);
    if (!template) continue;
    const obj = placeModel(template, spot.x, spot.y, spot.z, spot);
    portal.props.add(obj);
    if (isActor(spot)) portal.crowd.add(obj, spot, template.radius);
  }
  portal.obstacles = await buildObstacles(portal, walls);
  if (gen !== loadGen) throw new Cancelled();
  return portal;
}

// Wall collision: keep the ship WALL_MARGIN inside every face of the ring
// polygon at its depth.
function containInTube(portal, p, time) {
  const k = Math.min(portal.length - 1, Math.max(0, Math.floor(p.z)));
  const seg = portal.segments[k];
  const t = THREE.MathUtils.clamp(p.z - k, 0, 1);
  const spin = (seg.spin / 65536) * TAU * (time / GAME_SECOND);
  const s = ringPoints(seg, false, spin);
  const e = ringPoints(seg, true, spin);
  const ring = s.map(([x, y], i) => [x + (e[i][0] - x) * t, y + (e[i][1] - y) * t]);
  for (let pass = 0; pass < 2; pass++) {
    for (const edge of inwardNormals(ring)) {
      if (!edge) continue;
      const [nx, ny, ax, ay] = edge;
      const d = (p.x - ax) * nx + (p.y - ay) * ny;
      if (d < WALL_MARGIN) {
        p.x += nx * (WALL_MARGIN - d);
        p.y += ny * (WALL_MARGIN - d);
      }
    }
  }
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
      ob.parts.jaws = [await obstacleModel("jaw1", look, texPath, r, "y"), await obstacleModel("jaw2", look, texPath, r, "y")];
      for (const jaw of ob.parts.jaws) {
        if (!jaw) continue;
        if (type === 0x13) jaw.rotation.z = Math.PI / 2;
        group.add(jaw);
      }
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
      if (type === 0x13) {
        jaw1?.position.set(0, off, 0);
        jaw2?.position.set(0, -off, 0);
      } else {
        jaw1?.position.set(off, 0, 0);
        jaw2?.position.set(-off, 0, 0);
      }
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

// Collision (FUN_00038820): inside the first 1/8 tile of a segment, the
// obstacle clamps the ship's position across the shaft.
function collideObstacle(portal, p, time) {
  const k = Math.floor(p.z);
  const ob = (portal.obstacles || []).find((o) => o.k === k);
  if (!ob) return;
  const depth = (p.z - k) * 4096;
  if (!(depth > 0 && depth < OBSTACLE_DEPTH)) return;
  const { seg, type } = ob;
  const [rx, ry] = seg.r0;
  let X = p.x * 4096 - seg.start[0];
  let Y = p.y * 4096 - seg.start[1];
  const phase = obstaclePhase(ob, time);
  const doorOff = (r) => (r * 4 * triangleWave(phase)) / 65536;
  const jawOff = (r) => (r * 2 * triangleWave(phase)) / 65536;
  switch (type) {
    case 2: ob.hp -= 4 * 65536; break; // flying through a barrier wrecks it
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
    case 0x1e: { // the iris opening, up to half the radius
      const open = (triangleWave(phase) * rx) / 65536;
      const dist = Math.hypot(X, Y);
      if (dist > open && dist > 0) {
        X *= open / dist;
        Y *= open / dist;
      }
      break;
    }
    default: return;
  }
  p.x = (seg.start[0] + X) / 4096;
  p.y = (seg.start[1] + Y) / 4096;
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
  radarPups = [];
  heightGrid = null;
}

function setLighting(sun, ambient) {
  const s = sun || [-46333, -46333, 0];
  // The .lvl vector is the direction light travels, in game axes.
  shade.uSun.value.set(s[0], s[1], -s[2]).normalize();
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
  crowd = new Crowd({ parent: new THREE.Group(), groundAt });
  // Surface objects ignore the file y: ground under (x, z), plus the def's
  // offsets, plus half the radius for logics 2, 4, 7, 8 (4.3).
  for (const spot of spots) {
    const template = templates.get(spot.model);
    if (!template) continue;
    const [ox, oy, oz] = spot.offset || [0, 0, 0];
    const lift = SEAT_HALF_RADIUS.has(spot.logic) ? template.radius / 2 : 0;
    const obj = placeModel(template, spot.x + ox, groundAt(spot.x, spot.z) + oy + lift, spot.z + oz, spot);
    if (isActor(spot)) {
      crowd.parent.add(obj);
      crowd.add(obj, spot, template.radius);
      continue;
    }
    obj.userData.prop = true;
    group.add(obj);
  }
  // Power-ups float two bounding radii above the ground (4.4).
  for (const pup of pups) {
    const template = templates.get(pup.model);
    if (!template) continue;
    const obj = placeModel(template, pup.x, groundAt(pup.x, pup.z) + 2 * template.radius, pup.z, {});
    obj.userData.prop = true;
    group.add(obj);
    radarPups.push(obj.position);
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
  if (skyMesh) skyMesh.visible = !inCave;
  if (stars) stars.visible = flying && !inCave;
  shade.uWindow.value = inCave ? CAVE_WINDOW : SURFACE_WINDOW;
  if (inCave) setLighting(level.caveLight, level.caveAmbient);
  else if (level) setLighting(level.sun, level.ambient);
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

function startFly() {
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
  hudEl.hidden = false;
  crosshairEl.hidden = false;
  wakeMusic();
  playMusic(levelMusic());
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
  wakeMusic();
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

function scrape(now) {
  if (now - ship.lastScrape < 0.4) return;
  ship.lastScrape = now;
  scrapeSound.currentTime = 0;
  scrapeSound.play().catch(() => {});
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

  ship.throttle = THREE.MathUtils.clamp(ship.throttle + axis("a", "z") * THROTTLE_RATE * dt, THROTTLE_MIN, THROTTLE_MAX);
  const burner = keys.has("shift");
  ship.speed = approach(ship.speed, (burner ? AFTERBURNER : ship.throttle) / GAME_SECOND, dt);
  const forward = tmpV.set(0, 0, 1).applyQuaternion(ship.q);
  const before = ship.pos.clone();
  ship.pos.addScaledVector(forward, ship.speed * dt);

  if (ship.space === "tunnel") return stepTunnel(now);
  ship.pos.x = wrapMap(ship.pos.x);
  ship.pos.z = wrapMap(ship.pos.z);
  if (ship.space === "cave") return stepCave(before);
  stepSurface(now);
}

function setPitch(pitch) {
  tmpEuler.setFromQuaternion(ship.q, "YXZ");
  tmpEuler.x = pitch;
  ship.q.setFromEuler(tmpEuler);
}

function stepSurface(now) {
  if (tryEnterTunnel()) return;
  const floor = groundAt(ship.pos.x, ship.pos.z) + CLEARANCE;
  if (ship.pos.y < floor) {
    ship.pos.y = floor;
    // Ground bounce (2.4): nose-down is reflected; level or nose-up doubles.
    tmpEuler.setFromQuaternion(ship.q, "YXZ");
    const pitch = tmpEuler.x;
    setPitch(pitch > 0 ? -pitch : Math.max(pitch * 2, -BOUNCE_LIMIT));
    scrape(now);
  }
  if (ship.pos.y > CEILING) ship.pos.y = CEILING;
}

// Cave mode (5): floor below, mirrored ceiling above, and solid 255 rock that
// turns the ship around.
function stepCave(before) {
  const ground = groundAt(ship.pos.x, ship.pos.z);
  const floor = ground + CLEARANCE;
  const roof = 2 * TOP - ground - CLEARANCE;
  if (ground >= TOP - 1e-6 || roof <= floor) {
    ship.pos.copy(before);
    tmpEuler.setFromQuaternion(ship.q, "YXZ");
    tmpEuler.y += Math.PI;
    ship.q.setFromEuler(tmpEuler);
    return;
  }
  ship.pos.y = THREE.MathUtils.clamp(ship.pos.y, floor, roof);
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
    if (!cave) ship.pos.y = Math.max(ship.pos.y, groundAt(ship.pos.x, ship.pos.z) + CLEARANCE);
    return;
  }
  containInTube(portal, ship.pos, now);
  collideObstacle(portal, ship.pos, now);
  surface.visible = ship.pos.z > portal.length - TUBE_STUB;
}

// Where the ship is in surface coordinates, for the HUD and the draw window.
function surfacePosition(out) {
  if (ship.space !== "tunnel") return out.copy(ship.pos);
  const portal = ship.portal;
  return out.copy(ship.pos).sub(portal.end).applyQuaternion(portal.exit.q).add(portal.exit.pos);
}

// The camera sits exactly at the ship (3.4). Mirroring z flips the sign of
// the yaw and pitch parts of the rotation.
function syncCamera() {
  camera.position.set(ship.pos.x, ship.pos.y, -ship.pos.z);
  camera.quaternion.set(-ship.q.x, -ship.q.y, ship.q.z, ship.q.w);
  if (stars) stars.position.copy(camera.position);
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
  const view = { flying, reach: shade.uWindow.value, camTile: [tile.x, tile.y] };
  crowd?.sync(flying ? surfaceCam : null, view);
  if (ship.space === "tunnel") ship.portal.crowd.sync(null, view);
}

// ---------------------------------------------------------------- input

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  keys.add(key);
  if (key === "escape") stopFly();
  if (!flying) return;
  if (key.startsWith("arrow") || key === " ") event.preventDefault();
  if (key === "p" && !event.repeat) {
    paused = !paused;
    setStatus(paused ? "paused · P to fly" : flightStatus());
  }
  if (key === "m" && !event.repeat) setStatus(toggleMusic() ? "music on" : "music off");
});
window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && flying) stopFly();
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
  return `${where}${tiles} tiles/s · arrows/mouse steer · Q/E roll · A/Z throttle · Shift burner · M music · P pause`;
}

// ---------------------------------------------------------------- HUD

// The route is the nav file in order, starting at the first point after the spawn.
function resetNav() {
  const nav = level?.nav || [];
  const found = nav.findIndex((point, index) => index > 0 && point.type !== 6);
  navCursor = found >= 0 ? found : (nav.length > 1 ? 1 : -1);
}

function navName(point) {
  if (!point) return "---";
  if (point.type === 1 || point.type === 4) return "TUN";
  if (point.type === 3) return "DUN";
  return point.label || "TGT";
}

function updateHud() {
  const { x, z } = surfacePosition(surfaceCam);
  const sect = `${Math.floor(wrapMap(x))},${Math.floor(wrapMap(z))}`;
  const nav = level?.nav || [];
  let target = nav[navCursor];
  if (!target || ship.space === "tunnel") {
    paintHud(sect, "----", ship.space === "tunnel" ? "TUN" : "---", null);
    return;
  }
  // One tile is 16 of the units the original distance counter shows.
  const dist = () => Math.hypot(wrapDelta(x, target.x), wrapDelta(z, target.z)) * 16;
  if (dist() < 32 && navCursor + 1 < nav.length) target = nav[++navCursor];
  paintHud(sect, String(Math.round(dist())), navName(target), target);
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
  hudInk(sect, 40, 5);
  hudInk(dist, 40, 17);
  hudInk(nav, 40, 27);
  if (paused) hudInk("PAUSE", 134, 5);
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
  if (!radarFace || !radarInk) return;
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
  const now = performance.now();
  for (; radarClock + 50 <= now; radarClock += 50) {
    radarPulse += radarPulseStep;
    if (radarPulse > 0x7f) [radarPulse, radarPulseStep] = [0x7e, -1];
    if (radarPulse < 0x60) [radarPulse, radarPulseStep] = [0x61, 1];
  }
  if (now - radarClock > 1000) radarClock = now;
  if (ship.space !== "tunnel") for (const pos of radarPups) plot(pos, radarPulse);
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

function hudInk(text, x, y) {
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

// The status bar and nav marker, drawn from the game's own art (VGA palette).
// The compass interior is palette 0; it gets an opaque dark face so the ship
// icon sits on a solid dial. The marker's flat backing plate is transparent.
const NAVTAR_FIELD = new Set([0, 8, 9, 10, 12]);
async function loadHud() {
  const vga = await readPalette(archive, "vga");
  radarInk = vga;
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
  const scrape = objectUrl("sound/ground.wav", "audio/wav");
  if (scrape) scrapeSound = new Audio(scrape);
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

let elapsed = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (flying) {
    if (!paused) {
      elapsed += dt;
      stepFlight(dt, elapsed);
      stepCrowds(dt);
      setStatus(flightStatus());
    }
    syncCamera();
    updateHud();
  } else {
    controls.update();
  }
  updateSpinners(elapsed);
  if (ship.space === "tunnel" && ship.portal) updateObstacles(ship.portal, elapsed);
  updateWindow();
  syncCrowds();
  world.updateMatrixWorld(true);
  shade.uGameFrame.value.copy(surface.matrixWorld).invert();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ?debug exposes the flight state for poking at from the console.
if (params.has("debug")) {
  window.tv = { ship, keys, portals: () => portals, setSpace, startFly, groundAt, THREE, archive: () => archive, crowd: () => crowd };
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
  if (params.get("mode") === "model") modeEl.value = "model";
  fillPicker();
  await loadSelection();
} catch (err) {
  console.error(err);
  setError(`${err.message || err}. Serve the repo root over http (python3 -m http.server) and open index.html.`);
}
