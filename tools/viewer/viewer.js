import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

const MAP = 256;
// A terrain tile is 2^20 game units and a height byte is 2^16, so a full
// byte is 1/16 of a tile. The relief slider multiplies that.
const HEIGHT_PER_BYTE = 1 / 16;

const frameEl = document.getElementById("frame");
const modeEl = document.getElementById("mode");
const pickEl = document.getElementById("pick");
const reliefEl = document.getElementById("relief");
const heightLabel = document.getElementById("heightLabel");
const flyBtn = document.getElementById("fly");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const hudEl = document.getElementById("hud");
const hudText = document.getElementById("hudText");
const hudCtx = hudText.getContext("2d");
const navtar = new Image();
navtar.src = "screens/navtar01.png";
const crosshairEl = document.getElementById("crosshair");

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x1a1814);
const MODEL_BACKDROP = new THREE.Color(0x1a1814);
const GROUND_HAZE = new THREE.Color(0x000172);
// Under the clouds the ground drains into mid gray (128), not white.
// The same gray is the horizon band against the peach sky.
const UNDER_HAZE = new THREE.Color(0xC0C0C0);
const HORIZON_HAZE = new THREE.Color(0xC0C0C0);
const backdrop = new THREE.Color();
const skyPeach = new THREE.Color(0xd6b7a6);
frameEl.insertBefore(renderer.domElement, frameEl.firstChild);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8a8172, 40, 220);
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 800);
const ORBIT_FOV = 60;
// Fly sits just above the ground. A tighter view keeps a one-tile bunker
// from shrinking to a speck the way the orbit camera's 60° does.
const FLY_FOV = 42;
const FLY_CLEARANCE = 0.05;
// 65536 is one tile per second. The slow scout cruises at that. The Razor
// tops out at 128000. Shift is twice that top speed, the afterburner.
const SPEED_MIN = 65536;
const SPEED_MAX = 128000;
// Cloud deck in pre-relief terrain units, above the tallest height byte (255/16).
// The relief slider moves it with the ground.
const SKY_LEVEL = 20;
const ORBIT_FOG = { near: 36, far: 200, cameraFar: 800 };
const FLY_FOG = { near: 3, far: 18, cameraFar: 72 };
// Drawn at 800x600 and shown in a centered 4:3 frame, so the window
// letterboxes instead of stretching the picture.
const FRAME_W = 800;
const FRAME_H = 600;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.15;

scene.add(new THREE.HemisphereLight(0xc8d0d8, 0x3a3228, 1.1));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
sun.position.set(80, 120, 40);
scene.add(sun);

const clock = new THREE.Clock();
const keys = new Set();
let manifest = null;
let current = null;
let props = null;
let terrainClones = [];
let propClones = [];
let sky = null;
let heightGrid = null;
let flying = false;
let paused = false;
let yaw = 0;
let pitch = -0.35;
let throttle = 0;
let activeLevel = null;
let navCursor = -1;
let loadGen = 0;
const textureCache = new Map();
const liveTextures = new Set();
const modelCache = new Map();
// BIN vertices are stored as int/scale in the OBJ. Terminal Recall scales
// those by 4096 into a world where one tile is 65536, so the mesh units
// (one tile = 1) need another 1/16.
const MODEL_SCALE = 1 / 16;

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

function resize() {
  camera.aspect = FRAME_W / FRAME_H;
  camera.updateProjectionMatrix();
  renderer.setSize(FRAME_W, FRAME_H, false);
}
window.addEventListener("resize", resize);
resize();

function setStatus(text) {
  statusEl.textContent = text;
}
function setError(text) {
  errorEl.textContent = text || "";
}

function clearClones(bucket) {
  for (const copy of bucket) scene.remove(copy);
  bucket.length = 0;
}

function addWrapCopies(object, bucket) {
  clearClones(bucket);
  for (const dz of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      if (dx === 0 && dz === 0) continue;
      const copy = object.clone();
      copy.position.set(object.position.x + dx * MAP, object.position.y, object.position.z + dz * MAP);
      copy.scale.copy(object.scale);
      scene.add(copy);
      bucket.push(copy);
    }
  }
}

function clearProps() {
  clearClones(propClones);
  if (!props) return;
  scene.remove(props);
  props = null;
}

function textureBright(texture) {
  const image = texture.image;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, image.width, image.height);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  const lumas = [];
  for (let i = 0; i < data.length; i += 16) {
    lumas.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  const sorted = [...lumas].sort((a, b) => a - b);
  const cutoff = sorted[Math.floor(sorted.length * 0.7)] ?? 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0, k = 0; i < data.length; i += 16, k += 1) {
    if (lumas[k] < cutoff) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  if (!n) return GROUND_HAZE.clone();
  return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

function setBackdrop(color) {
  backdrop.copy(color);
  scene.background = backdrop;
  renderer.setClearColor(backdrop);
}

// Chroma goes first, then the surface fades into the haze color.
const DRAIN_FOG = `
#ifdef USE_FOG
  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  float luma = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  vec3 drained = mix( gl_FragColor.rgb, vec3( luma ), smoothstep( 0.2, 0.65, fogFactor ) );
  gl_FragColor.rgb = mix( drained, fogColor, smoothstep( 0.62, 1.0, fogFactor ) );
#endif
`;

// The sky sheet is not in the terrain fog. Its texture is a narrow peach band;
// stretch that into gray cloud bodies with peach along the brighter streaks.
const SKY_CLOUDS = `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec4 broad = texture2D( map, vMapUv * 0.41 + vec2( skyTime * 0.012, -skyTime * 0.009 ) );
  float skyLuma = dot( mix( sampledDiffuseColor.rgb, broad.rgb, 0.55 ), vec3( 0.299, 0.587, 0.114 ) );
  float cloud = smoothstep( 0.49, 0.57, skyLuma );
  vec3 skyGray = vec3( 0.55, 0.56, 0.58 );
  vec3 skyWarm = vec3( 0.91, 0.70, 0.58 );
  diffuseColor *= vec4( mix( skyGray, skyWarm, cloud ), sampledDiffuseColor.a );
#endif
`;

function drainFog(material) {
  material.fog = true;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <fog_fragment>", DRAIN_FOG);
  };
}

// Level file: x,y,z,speed with 65536 = 1. The third component is vertical, so
// the drift lies in x/y. Speed is a fraction of a 64px sky tile per 18.2 Hz tick.
function skyDrift(scroll) {
  if (!scroll || !scroll[3]) return null;
  const dx = scroll[0] / 65536;
  const dz = scroll[1] / 65536;
  const uvPerSec = (scroll[3] / 65536) * 18.2 / 64;
  return { dx, dz, uvPerSec };
}

function clearSky() {
  if (!sky) return;
  scene.remove(sky);
  sky.geometry.dispose();
  sky.material.dispose?.();
  sky = null;
}

function clearCurrent() {
  clearProps();
  clearSky();
  clearPortals();
  clearClones(terrainClones);
  scene.background = null;
  if (!current) return;
  scene.remove(current);
  current.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = obj.material ? [].concat(obj.material) : [];
    for (const mat of mats) {
      if (mat.map && !liveTextures.has(mat.map)) mat.map.dispose();
      mat.dispose?.();
    }
  });
  current = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImageOnce(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

async function loadImage(url, gen) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (gen !== loadGen) throw new Cancelled();
    try {
      return await loadImageOnce(url);
    } catch (err) {
      last = err;
      await sleep(150 * (attempt + 1));
    }
  }
  throw last;
}

function configureTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = true;
  texture.needsUpdate = true;
  liveTextures.add(texture);
  return texture;
}

function makeTexture(url) {
  const cached = textureCache.get(url);
  if (cached) return cached;
  const pending = (async () => {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const texture = await new Promise((resolve, reject) => {
          new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`failed to load ${url}`)));
        });
        return configureTexture(texture);
      } catch (err) {
        last = err;
        await sleep(150 * (attempt + 1));
      }
    }
    throw last;
  })();
  textureCache.set(url, pending);
  pending.catch(() => {
    if (textureCache.get(url) === pending) textureCache.delete(url);
  });
  return pending;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

async function fetchText(url, gen) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (gen !== loadGen) throw new Cancelled();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} ${response.status}`);
      return await response.text();
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      last = err;
      await sleep(150 * (attempt + 1));
    }
  }
  throw last;
}

function readGray(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = pixels[i * 4];
  return out;
}

function groundAt(height, x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const h00 = heightAt(height, x0, z0);
  const h10 = heightAt(height, x0 + 1, z0);
  const h01 = heightAt(height, x0, z0 + 1);
  const h11 = heightAt(height, x0 + 1, z0 + 1);
  return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
}

async function loadModelTemplate(name) {
  if (modelCache.has(name)) return modelCache.get(name);
  const pending = (async () => {
    const mtlResponse = await fetch(`models/${name}.mtl`);
    if (!mtlResponse.ok) return null;
    const objResponse = await fetch(`models/${name}.obj`);
    if (!objResponse.ok) return null;
    const mtl = new MTLLoader().setResourcePath("models/").parse(await mtlResponse.text(), "models/");
    mtl.preload();
    const obj = new OBJLoader().setMaterials(mtl).parse(await objResponse.text());
    obj.scale.setScalar(MODEL_SCALE);
    obj.traverse((child) => {
      if (!child.isMesh) return;
      for (const mat of [].concat(child.material)) {
        mat.side = THREE.DoubleSide;
        drainFog(mat);
        if (mat.map) {
          mat.map.magFilter = THREE.NearestFilter;
          mat.map.minFilter = THREE.LinearMipmapLinearFilter;
          mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.alphaTest = 0.4;
          mat.transparent = false;
        }
      }
    });
    return obj;
  })().catch(() => null);
  modelCache.set(name, pending);
  return pending;
}

// Tunnel file units: 4096 is one terrain tile. Each segment steps one tile
// down the shaft. The mouth sits on the ground tile and the tube hangs in from that face.
// Centerline: 4096 file units = 1 tile. The cross-section is the radius in that
// unit, and the shaft is drawn at twice that so a fighter on the centerline
// can be flown around. The mouth itself stays inside the atlas tile.
const TUNNEL_UNIT = 1 / 4096;
const TUNNEL_GIRTH = 1 / 1024;
const TUNNEL_SIDES = 8;
const MOUTH_LIMIT = 0.46;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let portalRoot = null;
let portalClones = [];
let tunnelMouths = [];
let tunnelFlight = null;
let tunnelLock = 0;

function clearPortals() {
  clearClones(portalClones);
  tunnelMouths = [];
  tunnelFlight = null;
  if (!portalRoot) return;
  scene.remove(portalRoot);
  portalRoot = null;
}

function girth(value) {
  return value * TUNNEL_GIRTH * 0.5;
}

function radiiAt(segments, travel) {
  const index = Math.min(segments.length - 1, Math.max(0, Math.floor(Math.max(0, travel))));
  const span = travel <= 0 ? 0 : Math.min(1, travel - index);
  const seg = segments[index];
  let rx = girth(seg[4] + (seg[6] - seg[4]) * span);
  let ry = girth(seg[5] + (seg[7] - seg[5]) * span);
  if (travel < 1 && segments.length) {
    const mouth = segments[0];
    const capX = Math.min(girth(mouth[4]), MOUTH_LIMIT);
    const capY = Math.min(girth(mouth[5]), MOUTH_LIMIT);
    const endX = girth(mouth[6]);
    const endY = girth(mouth[7]);
    const t = Math.max(0, Math.min(1, travel));
    rx = capX + (endX - capX) * t;
    ry = capY + (endY - capY) * t;
  }
  return [Math.max(rx, 0.15), Math.max(ry, 0.15)];
}

function orientSegments(segments, fromEnd) {
  if (!fromEnd) return segments;
  return segments.map((seg) => [seg[2], seg[3], seg[0], seg[1], seg[6], seg[7], seg[4], seg[5]]).reverse();
}

function buildTube(segments, faceLists, wallTextures) {
  const originX = segments[0][0] * TUNNEL_UNIT;
  const originY = segments[0][1] * TUNNEL_UNIT;
  const rings = [];
  for (let station = 0; station <= segments.length; station++) {
    const seg = station === 0 ? segments[0] : segments[station - 1];
    const cx = station === 0 ? seg[0] : seg[2];
    const cy = station === 0 ? seg[1] : seg[3];
    const [rx, ry] = radiiAt(segments, station);
    const ring = [];
    for (let side = 0; side < TUNNEL_SIDES; side++) {
      const angle = (side / TUNNEL_SIDES) * Math.PI * 2;
      ring.push([
        cx * TUNNEL_UNIT - originX + Math.cos(angle) * rx,
        cy * TUNNEL_UNIT - originY + Math.sin(angle) * ry,
        station,
      ]);
    }
    rings.push(ring);
  }
  const buckets = new Map();
  for (let i = 0; i < rings.length - 1; i++) {
    const faces = faceLists[i] || [];
    for (let side = 0; side < TUNNEL_SIDES; side++) {
      const slot = faces.length
        ? faces[Math.min(side, faces.length - 1)]
        : 0;
      let entry = buckets.get(slot);
      if (!entry) {
        entry = { positions: [], uvs: [] };
        buckets.set(slot, entry);
      }
      const next = (side + 1) % TUNNEL_SIDES;
      const a = rings[i][side];
      const b = rings[i][next];
      const c = rings[i + 1][next];
      const d = rings[i + 1][side];
      entry.positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      entry.uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
  }
  const group = new THREE.Group();
  group.rotation.x = Math.PI / 2;
  for (const [slot, entry] of buckets) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(entry.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(entry.uvs, 2));
    geometry.computeVertexNormals();
    const map = wallTextures[slot] || wallTextures[0] || null;
    const material = new THREE.MeshLambertMaterial({
      map,
      color: map ? 0xffffff : 0x6e7c88,
      side: THREE.DoubleSide,
    });
    drainFog(material);
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}

function mouthCover(texture) {
  // The 61st arctic atlas cell is the whole ground tile: snow, the octagonal
  // hatch, and a small black opening. Only that opening is see-through.
  let map = texture || null;
  const image = texture?.image;
  if (image && image.width) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = frame.data;
    for (let i = 0; i < px.length; i += 4) {
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 <= 12) px[i + 3] = 0;
    }
    ctx.putImageData(frame, 0, 0);
    map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.flipY = true;
    map.needsUpdate = true;
    liveTextures.add(map);
  }
  const material = new THREE.MeshLambertMaterial({
    map,
    color: map ? 0xffffff : 0x9aa7b2,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  drainFog(material);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03;
  return mesh;
}

function tileFace(tx, tz, relief) {
  const y00 = heightAt(heightGrid, tx, tz) * relief;
  const y10 = heightAt(heightGrid, tx + 1, tz) * relief;
  const y01 = heightAt(heightGrid, tx, tz + 1) * relief;
  const y11 = heightAt(heightGrid, tx + 1, tz + 1) * relief;
  const p00 = new THREE.Vector3(tx, y00, tz);
  const p10 = new THREE.Vector3(tx + 1, y10, tz);
  const p01 = new THREE.Vector3(tx, y01, tz + 1);
  const p11 = new THREE.Vector3(tx + 1, y11, tz + 1);
  const normal = new THREE.Vector3().crossVectors(p01.clone().sub(p00), p10.clone().sub(p00));
  normal.add(new THREE.Vector3().crossVectors(p11.clone().sub(p10), p01.clone().sub(p10)));
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  else normal.normalize();
  if (normal.y < 0) normal.negate();
  const center = p00.add(p10).add(p01).add(p11).multiplyScalar(0.25);
  return { normal, center };
}

function layoutMouth(mouth) {
  const face = tileFace(mouth.tx, mouth.tz, Number(reliefEl.value));
  mouth.outward.copy(face.normal);
  mouth.origin.copy(face.center);
  mouth.group.position.copy(face.center);
  mouth.group.quaternion.setFromUnitVectors(WORLD_UP, face.normal);
  mouth.tangent.set(1, 0, 0).applyQuaternion(mouth.group.quaternion);
  mouth.bitangent.set(0, 0, 1).applyQuaternion(mouth.group.quaternion);
}

function layoutPortals() {
  for (const mouth of tunnelMouths) layoutMouth(mouth);
  if (portalRoot) addWrapCopies(portalRoot, portalClones);
}

async function placeTunnels(level, gen) {
  clearPortals();
  const tunnels = (level.tunnels || []).filter((tunnel) => tunnel.segments?.length && tunnel.entrance && tunnel.exit);
  if (!tunnels.length || !heightGrid) return;
  portalRoot = new THREE.Group();
  for (const tunnel of tunnels) {
    const wallUrls = tunnel.walls?.length ? tunnel.walls : (tunnel.wall ? [tunnel.wall] : []);
    const wallTextures = [];
    for (const url of wallUrls) {
      const tex = (await makeTexture(url)).clone();
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      wallTextures.push(tex);
    }
    if (gen !== loadGen) throw new Cancelled();
    const coverUrl = level.textures?.length ? level.textures[level.textures.length - 1] : tunnel.mouth;
    const coverTex = coverUrl ? await makeTexture(coverUrl) : null;
    const names = new Set();
    for (const spot of tunnel.contents || []) if (spot.model) names.add(spot.model);
    if ((tunnel.walls || []).some((url) => /iris/i.test(url))) names.add("iris1");
    const templates = new Map();
    await mapLimit([...names], 3, async (name) => {
      if (gen !== loadGen) throw new Cancelled();
      templates.set(name, await loadModelTemplate(name));
    });
    if (gen !== loadGen) throw new Cancelled();
    const entrance = addTunnelMouth(tunnel, coverTex, wallTextures, templates, false);
    const exit = addTunnelMouth(tunnel, coverTex, wallTextures, templates, true);
    entrance.partner = exit;
    exit.partner = entrance;
  }
  scene.add(portalRoot);
  layoutPortals();
}

function placeTunnelProps(tube, segments, faces, tunnel, templates, fromEnd) {
  const originX = segments[0][0] * TUNNEL_UNIT;
  const originY = segments[0][1] * TUNNEL_UNIT;
  const length = segments.length;
  for (const spot of tunnel.contents || []) {
    const template = templates.get(spot.model);
    if (!template) continue;
    const clone = template.clone(true);
    // Nose (+Z) points down the shaft. The file yaw banks around that axis.
    // Applying it as a heading turned the nose up into the entrance.
    clone.rotation.set(spot.pitch || 0, 0, spot.yaw || 0);
    const travel = fromEnd ? length - spot.z : spot.z;
    const index = Math.min(segments.length - 1, Math.max(0, Math.floor(travel)));
    const span = Math.min(1, Math.max(0, travel - index));
    const seg = segments[index];
    const cx = (seg[0] + (seg[2] - seg[0]) * span) * TUNNEL_UNIT - originX;
    const cy = (seg[1] + (seg[3] - seg[1]) * span) * TUNNEL_UNIT - originY;
    clone.position.set(cx, cy, travel);
    tube.add(clone);
  }
  const doorSlots = new Set();
  (tunnel.walls || []).forEach((url, index) => {
    if (/iris/i.test(url)) doorSlots.add(index);
  });
  const door = templates.get("iris1");
  if (!door || !doorSlots.size) return;
  faces.forEach((face, index) => {
    if (!(face || []).some((slot) => doorSlots.has(slot))) return;
    const seg = segments[index];
    if (!seg) return;
    const clone = door.clone(true);
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, 1e-4);
    const [rx, ry] = radiiAt(segments, index + 0.5);
    clone.scale.multiplyScalar((Math.max(rx, ry) * 2) / span);
    const cx = ((seg[0] + seg[2]) * 0.5) * TUNNEL_UNIT - originX;
    const cy = ((seg[1] + seg[3]) * 0.5) * TUNNEL_UNIT - originY;
    clone.position.set(cx, cy, index + 0.5);
    tube.add(clone);
  });
}

function addTunnelMouth(tunnel, mouthTex, wallTextures, templates, fromEnd) {
  const spot = fromEnd ? tunnel.exit : tunnel.entrance;
  const tx = Math.floor(spot.x);
  const tz = Math.floor(spot.z);
  const oriented = orientSegments(tunnel.segments, fromEnd);
  const faces = fromEnd ? [...(tunnel.faces || [])].reverse() : (tunnel.faces || []);
  const [radiusX, radiusY] = radiiAt(oriented, 0);
  const group = new THREE.Group();
  group.add(mouthCover(mouthTex));
  const tube = buildTube(oriented, faces, wallTextures);
  placeTunnelProps(tube, oriented, faces, tunnel, templates, fromEnd);
  group.add(tube);
  portalRoot.add(group);
  const mouth = {
    group,
    tx,
    tz,
    segments: oriented,
    originLocalX: oriented[0][0] * TUNNEL_UNIT,
    originLocalY: oriented[0][1] * TUNNEL_UNIT,
    length: oriented.length,
    radius: Math.max(radiusX, radiusY, 0.2),
    outward: new THREE.Vector3(),
    origin: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    bitangent: new THREE.Vector3(),
    partner: null,
  };
  tunnelMouths.push(mouth);
  return mouth;
}

function tunnelCenter(mouth, travel) {
  const index = Math.min(mouth.segments.length - 1, Math.max(0, Math.floor(travel)));
  const span = Math.min(1, Math.max(0, travel - index));
  const seg = mouth.segments[index];
  const x = (seg[0] + (seg[2] - seg[0]) * span) * TUNNEL_UNIT - mouth.originLocalX;
  const y = (seg[1] + (seg[3] - seg[1]) * span) * TUNNEL_UNIT - mouth.originLocalY;
  return mouth.origin.clone()
    .addScaledVector(mouth.tangent, x)
    .addScaledVector(mouth.outward, -travel)
    .addScaledVector(mouth.bitangent, y);
}

function aimAlong(direction) {
  pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
  const cp = Math.cos(pitch) || 1;
  yaw = Math.atan2(-direction.x / cp, -direction.z / cp);
}

function leaveTunnel(mouth, atExit) {
  const dest = atExit && mouth.partner ? mouth.partner : mouth;
  const outward = dest.outward;
  camera.position.copy(dest.origin).addScaledVector(outward, 0.85);
  aimAlong(outward);
  tunnelFlight = null;
  tunnelLock = 0.2;
}

function considerTunnelEntry(forward) {
  if (tunnelLock > 0) return;
  for (const mouth of tunnelMouths) {
    const rel = camera.position.clone().sub(mouth.origin);
    const side = rel.dot(mouth.outward);
    const lateral = rel.clone().addScaledVector(mouth.outward, -side).length();
    const gate = mouth.radius + 0.55;
    if (side < 0.5 && side > -1.2 && lateral < gate && forward.dot(mouth.outward) < -0.05) {
      tunnelFlight = mouth;
      return;
    }
  }
}

function containInTunnel(forward) {
  const mouth = tunnelFlight;
  const travel = mouth.origin.clone().sub(camera.position).dot(mouth.outward);
  const headingOut = forward.dot(mouth.outward) > 0.25;
  const headingIn = forward.dot(mouth.outward) < -0.15;
  if (travel < -0.25 && headingOut) {
    leaveTunnel(mouth, false);
    return;
  }
  if (travel > mouth.length - 0.05 && headingIn) {
    leaveTunnel(mouth, true);
    return;
  }
  const along = Math.min(mouth.length, Math.max(0, travel));
  const center = tunnelCenter(mouth, along);
  const [rx, ry] = radiiAt(mouth.segments, along);
  const rel = camera.position.clone().sub(center);
  const limitX = Math.max(0.12, rx * 0.86);
  const limitY = Math.max(0.12, ry * 0.86);
  let u = rel.dot(mouth.tangent);
  let v = rel.dot(mouth.bitangent);
  const ell = (u * u) / (limitX * limitX) + (v * v) / (limitY * limitY);
  if (ell > 1) {
    const scale = 1 / Math.sqrt(ell);
    u *= scale;
    v *= scale;
  }
  camera.position.copy(center)
    .addScaledVector(mouth.tangent, u)
    .addScaledVector(mouth.bitangent, v);
}

async function placeObjects(level, gen, height) {
  const duns = (level.nav || []).filter((point) => point.type === 3);
  const spots = (level.objects || []).filter((spot) => !(duns.length && spot.model === "jump-pnt"));
  for (const point of duns) {
    spots.push({
      model: "jump-pnt",
      seat: "ground",
      x: point.x,
      y: 0,
      z: point.z,
      yaw: 0,
      pitch: 0,
      roll: 0,
    });
  }
  if (!spots.length) return 0;
  const names = [...new Set(spots.map((spot) => spot.model))];
  const templates = new Map();
  let ready = 0;
  await mapLimit(names, 3, async (name) => {
    if (gen !== loadGen) throw new Cancelled();
    templates.set(name, await loadModelTemplate(name));
    ready += 1;
    if (gen === loadGen) setStatus(`Loading ${level.name}… objects ${ready}/${names.length}`);
  });
  if (gen !== loadGen) throw new Cancelled();
  const group = new THREE.Group();
  const relief = Number(reliefEl.value);
  let placed = 0;
  for (const spot of spots) {
    const template = templates.get(spot.model);
    if (!template) continue;
    const clone = template.clone(true);
    clone.rotation.set(spot.pitch || 0, spot.yaw || 0, spot.roll || 0);
    clone.position.set(0, 0, 0);
    clone.updateWorldMatrix(true, true);
    const drop = new THREE.Box3().setFromObject(clone).min.y;
    const ground = groundAt(height, spot.x, spot.z);
    clone.userData.spot = spot;
    clone.userData.ground = ground;
    clone.userData.drop = drop;
    clone.position.set(spot.x, objectAltitude(spot, ground, drop, relief), spot.z);
    group.add(clone);
    placed += 1;
  }
  if (gen !== loadGen) throw new Cancelled();
  clearProps();
  props = group;
  scene.add(group);
  addWrapCopies(group, propClones);
  return placed;
}

function setViewDistance(preset) {
  scene.fog.near = preset.near;
  scene.fog.far = preset.far;
  camera.far = preset.cameraFar;
  camera.updateProjectionMatrix();
}

function objectAltitude(spot, ground, drop, relief) {
  const groundWorld = ground * relief;
  if (spot.seat === "ground") return groundWorld - drop;
  const authored = spot.y * relief;
  // Aircraft origins sit in the middle of the mesh. Keep the belly above the surface.
  return Math.max(authored, groundWorld - drop + 0.04);
}
function applyRelief() {
  const relief = Number(reliefEl.value);
  if (current && modeEl.value === "map") {
    current.scale.y = relief;
    for (const copy of terrainClones) copy.scale.y = relief;
  }
  if (sky) sky.position.y = SKY_LEVEL * relief;
  layoutPortals();
  if (!props) return;
  for (const child of props.children) {
    const spot = child.userData.spot;
    if (!spot) continue;
    child.position.y = objectAltitude(spot, child.userData.ground, child.userData.drop, relief);
  }
  for (const copy of propClones) {
    for (let i = 0; i < props.children.length; i++) {
      copy.children[i].position.y = props.children[i].position.y;
    }
  }
}

function heightAt(height, x, y) {
  const xx = (x % MAP + MAP) % MAP;
  const yy = (y % MAP + MAP) % MAP;
  return height[yy * MAP + xx] * HEIGHT_PER_BYTE;
}

async function showMap(level, gen) {
  activeLevel = level;
  setStatus(`Loading ${level.name}…`);
  const heightImg = await loadImage(level.height, gen);
  const indexImg = await loadImage(level.index, gen);
  if (gen !== loadGen) throw new Cancelled();
  const skyTex = level.sky ? await makeTexture(level.sky) : null;
  let loaded = 0;
  const tileTex = await mapLimit(level.textures, 4, async (url) => {
    if (gen !== loadGen) throw new Cancelled();
    const texture = await makeTexture(url);
    loaded += 1;
    if (gen === loadGen) setStatus(`Loading ${level.name}… ${loaded}/${level.textures.length} textures`);
    return texture;
  });
  if (gen !== loadGen) throw new Cancelled();
  const height = readGray(heightImg);
  heightGrid = height;
  const index = readGray(indexImg);
  const portals = new Set();
  for (const tunnel of level.tunnels || []) {
    for (const spot of [tunnel.entrance, tunnel.exit]) {
      if (spot) portals.add(`${Math.floor(spot.x)},${Math.floor(spot.z)}`);
    }
  }
  const buckets = new Map();

  const push = (tex, x, z, u, v) => {
    let bucket = buckets.get(tex);
    if (!bucket) {
      bucket = [];
      buckets.set(tex, bucket);
    }
    bucket.push(x, heightAt(height, x, z), z, u, v);
  };

  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      if (portals.has(`${x},${y}`)) continue;
      const tex = index[y * MAP + x];
      // Tile files need a transpose to sit on the ground: the PNG's left
      // column runs along the north edge, top of the image to the west.
      // flipY is on, so v=1 is the top of the PNG. Winding faces up.
      push(tex, x, y, 0, 1);
      push(tex, x, y + 1, 1, 1);
      push(tex, x + 1, y, 0, 0);
      push(tex, x + 1, y, 0, 0);
      push(tex, x, y + 1, 1, 1);
      push(tex, x + 1, y + 1, 1, 0);
    }
    if ((y & 15) === 15) {
      await sleep(0);
      if (gen !== loadGen) throw new Cancelled();
    }
  }

  const positions = [];
  const uvs = [];
  const groups = [];
  const materials = [];
  let vertex = 0;
  const order = [...buckets.keys()].sort((a, b) => a - b);
  for (const tex of order) {
    const bucket = buckets.get(tex);
    const start = vertex;
    for (let i = 0; i < bucket.length; i += 5) {
      positions.push(bucket[i], bucket[i + 1], bucket[i + 2]);
      uvs.push(bucket[i + 3], bucket[i + 4]);
      vertex += 1;
    }
    groups.push({ start, count: vertex - start });
    const map = tileTex[tex] || null;
    const mat = new THREE.MeshLambertMaterial({
      map,
      color: map ? 0xffffff : 0xff00aa,
      side: THREE.FrontSide,
    });
    drainFog(mat);
    materials.push(mat);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  groups.forEach((group, i) => geometry.addGroup(group.start, group.count, i));
  geometry.computeVertexNormals();
  if (gen !== loadGen) throw new Cancelled();

  clearCurrent();
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.scale.y = Number(reliefEl.value);
  await placeTunnels(level, gen);
  if (gen !== loadGen) throw new Cancelled();
  scene.add(mesh);
  current = mesh;
  addWrapCopies(mesh, terrainClones);
  skyPeach.copy(skyTex ? textureBright(skyTex) : GROUND_HAZE);
  setBackdrop(skyPeach);
  scene.fog.color.copy(UNDER_HAZE);
  if (skyTex) {
    skyTex.wrapS = THREE.MirroredRepeatWrapping;
    skyTex.wrapT = THREE.MirroredRepeatWrapping;
    skyTex.repeat.set(18, 18);
    skyTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const skyMat = new THREE.MeshBasicMaterial({
      map: skyTex,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    skyMat.onBeforeCompile = (shader) => {
      shader.uniforms.skyTime = { value: 0 };
      skyMat.userData.uniforms = shader.uniforms;
      shader.fragmentShader = `uniform float skyTime;\n${shader.fragmentShader.replace("#include <map_fragment>", SKY_CLOUDS)}`;
    };
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(MAP * 4, MAP * 4), skyMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(MAP / 2, SKY_LEVEL * mesh.scale.y, MAP / 2);
    deck.userData.scroll = skyDrift(level.skyScroll);
    deck.userData.fogged = false;
    scene.add(deck);
    sky = deck;
  }
  setViewDistance(ORBIT_FOG);
  controls.target.set(MAP / 2, 4 * mesh.scale.y, MAP / 2);
  camera.position.set(MAP / 2, 48, MAP * 0.92);
  controls.update();
  const placed = await placeObjects(level, gen, height);
  if (gen !== loadGen) throw new Cancelled();
  const objectNote = placed ? ` · ${placed} objects` : "";
  setStatus(`${level.name} · ${level.textures.length} textures${objectNote} · drag to orbit, Fly for a cockpit pass`);
}

async function showModel(entry, gen) {
  setStatus(`Loading ${entry.name}…`);
  heightGrid = null;
  const mtlText = await fetchText(`models/${entry.name}.mtl`, gen);
  if (gen !== loadGen) throw new Cancelled();
  const mtl = new MTLLoader().setResourcePath("models/").parse(mtlText, "models/");
  mtl.preload();
  const objText = await fetchText(`models/${entry.name}.obj`, gen);
  if (gen !== loadGen) throw new Cancelled();
  const obj = new OBJLoader().setMaterials(mtl).parse(objText);
  obj.traverse((child) => {
    if (!child.isMesh) return;
    for (const mat of [].concat(child.material)) {
      mat.side = THREE.DoubleSide;
      drainFog(mat);
      if (mat.map) {
        mat.map.magFilter = THREE.NearestFilter;
        mat.map.minFilter = THREE.LinearMipmapLinearFilter;
        mat.map.colorSpace = THREE.SRGBColorSpace;
        mat.alphaTest = 0.4;
        mat.transparent = false;
      }
    }
  });
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  clearCurrent();
  scene.fog.near = 1e6;
  scene.fog.far = 1e7;
  setBackdrop(MODEL_BACKDROP);
  scene.add(obj);
  current = obj;
  const radius = Math.max(size.x, size.y, size.z, 0.5);
  controls.target.set(0, 0, 0);
  camera.position.set(radius * 1.4, radius * 0.8, radius * 1.6);
  camera.near = radius / 200;
  camera.far = radius * 40;
  camera.updateProjectionMatrix();
  controls.update();
  setStatus(`${entry.name} · drag to orbit`);
}

function fillPicker() {
  const mode = modeEl.value;
  pickEl.innerHTML = "";
  const items = mode === "map" ? manifest.levels : manifest.models;
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.name;
    pickEl.appendChild(option);
  }
  heightLabel.style.display = mode === "map" ? "" : "none";
  const preferred = mode === "map" ? "artic" : "afighter";
  if ([...pickEl.options].some((opt) => opt.value === preferred)) pickEl.value = preferred;
}

async function loadSelection() {
  const gen = ++loadGen;
  setError("");
  stopFly();
  const mode = modeEl.value;
  const name = pickEl.value;
  try {
    if (mode === "map") {
      const level = manifest.levels.find((item) => item.name === name);
      if (level) await showMap(level, gen);
    } else {
      const model = manifest.models.find((item) => item.name === name);
      if (model) await showModel(model, gen);
    }
  } catch (err) {
    if (gen !== loadGen || err instanceof Cancelled) return;
    setError(String(err.message || err));
    setStatus("");
  }
}

function stopFly() {
  flying = false;
  paused = false;
  tunnelFlight = null;
  tunnelLock = 0;
  hudEl.hidden = true;
  crosshairEl.hidden = true;
  flyBtn.textContent = "Fly";
  controls.enabled = true;
  camera.fov = ORBIT_FOV;
  camera.near = 0.05;
  setViewDistance(ORBIT_FOG);
  if (document.pointerLockElement) document.exitPointerLock();
}

function startFly() {
  if (modeEl.value !== "map" || !current) return;
  flying = true;
  paused = false;
  throttle = 0;
  flyBtn.textContent = "Orbit";
  controls.enabled = false;
  const start = activeLevel?.start;
  const relief = Number(reliefEl.value);
  if (start) {
    yaw = start.yaw ?? 0;
    pitch = start.pitch ?? 0;
    const y = Math.max(start.y * relief, sampleHeight(start.x, start.z) + FLY_CLEARANCE);
    camera.position.set(start.x, y, start.z);
  } else {
    const offset = camera.position.clone().sub(controls.target);
    yaw = Math.atan2(offset.x, offset.z);
    pitch = -0.18;
    const x = controls.target.x;
    const z = controls.target.z;
    camera.position.set(x, sampleHeight(x, z) + FLY_CLEARANCE, z);
  }
  camera.fov = FLY_FOV;
  camera.near = 0.008;
  setViewDistance(FLY_FOG);
  resetNav();
  updateHud();
  hudEl.hidden = false;
  crosshairEl.hidden = false;
  setStatus(flightStatus());
  renderer.domElement.requestPointerLock();
}

// The first route point after the spawn is the target the nav computer
// tracks. Later points follow in file order, including the tunnels.
function resetNav() {
  const nav = activeLevel?.nav || [];
  const found = nav.findIndex((point, index) => index > 0 && point.type !== 6);
  navCursor = found >= 0 ? found : (nav.length > 1 ? 1 : -1);
}

function wrapDelta(from, to) {
  let delta = to - from;
  delta = ((delta % MAP) + MAP) % MAP;
  if (delta > MAP / 2) delta -= MAP;
  return delta;
}

function navName(point) {
  if (!point) return "---";
  if (point.type === 1 || point.type === 4) return "TUN";
  if (point.type === 3) return "DUN";
  return point.label || "TGT";
}

function updateHud() {
  const x = camera.position.x;
  const z = camera.position.z;
  const sect = `${Math.floor(wrapMap(x))},${Math.floor(wrapMap(z))}`;
  const nav = activeLevel?.nav || [];
  const target = nav[navCursor];
  let distText = "----";
  let navText = "---";
  if (target) {
    // One tile is 16 of the units the original dist counter shows.
    const dist = Math.hypot(wrapDelta(x, target.x), wrapDelta(z, target.z)) * 16;
    // The route is the nav file in order. The link numbers are strike
    // targets, so following them skips the tunnel and then stalls.
    if (dist < 32 && navCursor + 1 < nav.length) navCursor += 1;
    const shown = nav[navCursor] || target;
    const shownDist = Math.hypot(wrapDelta(x, shown.x), wrapDelta(z, shown.z)) * 16;
    distText = String(Math.round(shownDist));
    navText = navName(shown);
    paintHud(sect, distText, navText, shown);
    return;
  }
  paintHud(sect, distText, navText, null);
}

// Compass-up is the current target. The ship sprite is our heading
// against that bearing, so it points up only while we fly toward it.
function markerAngle(target) {
  if (!target) return 0;
  const dx = wrapDelta(camera.position.x, target.x);
  const dz = wrapDelta(camera.position.z, target.z);
  const ahead = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  const side = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  // Nose points toward the target: right means turn right.
  return Math.atan2(side, ahead);
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
  if (!navtar.complete || !navtar.naturalWidth) return;
  const cx = 282;
  const cy = 31;
  const size = 36;
  hudCtx.save();
  hudCtx.translate(cx, cy);
  hudCtx.rotate(markerAngle(target));
  hudCtx.imageSmoothingEnabled = true;
  hudCtx.drawImage(navtar, -size / 2, -size / 2, size, size);
  hudCtx.restore();
}

function hudInk(text, x, y) {
  let cursor = x;
  hudCtx.fillStyle = "#3cff45";
  for (const ch of String(text).toUpperCase()) {
    const rows = HUD_FONT[ch];
    if (!rows) {
      cursor += 6;
      continue;
    }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (rows[row] & (1 << (4 - col))) hudCtx.fillRect(cursor + col, y + row, 1, 1);
      }
    }
    cursor += 6;
  }
}

function flightStatus() {
  const cruise = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * throttle;
  const shown = (keys.has("shift") ? SPEED_MAX * 2 : cruise) / 65536;
  return `flying · ${shown.toFixed(2)} tiles/s · [ ] throttle · Shift afterburner · P pause`;
}

flyBtn.addEventListener("click", () => {
  if (flying) stopFly();
  else startFly();
});
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && flying) stopFly();
});
window.addEventListener("keydown", (event) => {
  keys.add(event.key.toLowerCase());
  if (event.key === "Escape") stopFly();
  if (!flying) return;
  if ((event.key === "p" || event.key === "P") && !event.repeat) {
    paused = !paused;
    setStatus(paused ? "paused · look around · P to fly" : flightStatus());
    return;
  }
  if (event.key === "[" || event.code === "BracketLeft") {
    throttle = Math.max(0, throttle - 0.125);
    setStatus(flightStatus());
  } else if (event.key === "]" || event.code === "BracketRight") {
    throttle = Math.min(1, throttle + 0.125);
    setStatus(flightStatus());
  }
});
window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener("mousemove", (event) => {
  if (!flying || document.pointerLockElement !== renderer.domElement) return;
  yaw -= event.movementX * 0.002;
  pitch -= event.movementY * 0.002;
});

function fly(dt) {
  camera.rotation.order = "YXZ";
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  if (!paused) {
    const cruise = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * throttle;
    const tilesPerSecond = (keys.has("shift") ? SPEED_MAX * 2 : cruise) / 65536;
    const speed = tilesPerSecond * dt;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(forward, speed);
    if (keys.has("d")) camera.position.addScaledVector(right, speed);
    if (keys.has("a")) camera.position.addScaledVector(right, -speed);
    if (keys.has("e") || keys.has(" ")) camera.position.y += speed;
    if (keys.has("q")) camera.position.y -= speed;
    tunnelLock = Math.max(0, tunnelLock - dt);
    if (tunnelFlight) {
      containInTunnel(forward);
    } else {
      considerTunnelEntry(forward);
      camera.position.x = wrapMap(camera.position.x);
      camera.position.z = wrapMap(camera.position.z);
      const ground = sampleHeight(camera.position.x, camera.position.z) + FLY_CLEARANCE;
      if (camera.position.y < ground) camera.position.y = ground;
    }
    const label = tunnelFlight ? "tunnel · fly the shaft · the other mouth lets you out" : flightStatus();
    if (statusEl.textContent !== label) setStatus(label);
  }
  updateHud();
}

function wrapMap(value) {
  return ((value % MAP) + MAP) % MAP;
}

function sampleHeight(x, z) {
  if (!heightGrid || !current) return 0;
  const col = Math.floor(wrapMap(x));
  const row = Math.floor(wrapMap(z));
  return heightGrid[row * MAP + col] * HEIGHT_PER_BYTE * current.scale.y;
}

function updateAtmosphere(dt) {
  if (!sky) return;
  const above = camera.position.y - sky.position.y;
  // The deck stays solid while you are near it, including just above the
  // clouds. It only fades once the camera is high enough to be the map overview.
  const opacity = above <= 30 ? 1 : Math.max(0, 1 - (above - 30) / 14);
  sky.material.opacity = opacity;
  sky.visible = opacity > 0.02;
  const over = THREE.MathUtils.smoothstep(above, -0.6, 1.6);
  scene.fog.color.copy(UNDER_HAZE);
  // Below the deck the empty sky is the haze, so distant things vanish into it
  // instead of sitting on the peach. Above the deck the empty sky stays peach.
  backdrop.copy(UNDER_HAZE).lerp(skyPeach, over);
  renderer.setClearColor(backdrop);
  const uniforms = sky.material.userData.uniforms;
  if (uniforms?.skyTime) uniforms.skyTime.value += dt;
  const scroll = sky.userData.scroll;
  const map = sky.material.map;
  if (scroll && map) {
    map.offset.x -= scroll.dx * scroll.uvPerSec * dt;
    map.offset.y += scroll.dz * scroll.uvPerSec * dt;
  }
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (flying) fly(dt);
  else controls.update();
  updateAtmosphere(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

modeEl.addEventListener("change", () => {
  fillPicker();
  loadSelection();
});
pickEl.addEventListener("change", loadSelection);
reliefEl.addEventListener("input", applyRelief);

try {
  const response = await fetch("view.json?v=7");
  if (!response.ok) throw new Error(`view.json ${response.status}`);
  manifest = await response.json();
  fillPicker();
  await loadSelection();
  frame();
} catch (err) {
  setError(`${err.message || err}. Serve this folder over http (python3 -m http.server) and open viewer.html.`);
}
