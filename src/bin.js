// models/*.bin: a command stream of blocks (docs/original-engine.md 7.4).
// Block 0x14 (scale) and 0x02 (vertex list) come first, then textures,
// colors and faces. Ported from tools/tvextract.py parse_bin.

// Face blocks whose corners carry their own u,v.
const FACE_UV = new Set([0x0e, 0x11, 0x15, 0x18, 0x1e, 0x22]);
// Face blocks with bare vertex indices (0x0F takes UVs from the 0x04 slot list).
const FACE_PLAIN = new Set([0x05, 0x06, 0x0f, 0x19]);
// Palette index 0 is transparent on these.
const ALPHA_FACES = new Set([0x0f, 0x11]);
// Unlit faces: alpha-tested sprites and per-vertex palette colors.
const UNLIT_FACES = new Set([0x06, 0x0f, 0x11]);
const FLAT_FACES = new Set([0x05, 0x06, 0x19]);

// Untextured faces shade along a color ramp set by block 0x0A:
// index = lo + light * (hi - lo). A negative value is a literal palette index.
const COLOR_RAMPS = [
  [0, 31], [0, 15], [32, 63], [64, 95], [144, 151], [152, 159], [160, 167], [168, 175],
  [176, 183], [184, 191], [0, 7], [0, 24], [240, 240], [255, 255], [0, 0], [216, 216],
];

export function rampOf(value) {
  if (value < 0) return [(-value) & 255, (-value) & 255];
  return COLOR_RAMPS[value % COLOR_RAMPS.length];
}

const decoder = new TextDecoder("latin1");
function cstr(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
}

// Returns { kind: "anim", frames } for morph lists (id 0x20), or
// { kind: "model", scale, vertices: [[x,y,z]...], faces: [...] }.
export function parseBin(data, name = "") {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (o) => view.getUint32(o, true);
  const i32 = (o) => view.getInt32(o, true);
  if (data.length < 24) throw new Error(`${name}: too small`);
  const ident = u32(0);
  if (ident === 0x20) {
    const frames = [];
    for (let i = 0, off = 24; i < u32(8); i++, off += 16) {
      const frame = cstr(data.subarray(off, off + 16));
      if (frame) frames.push(frame);
    }
    return { kind: "anim", frames, delay: u32(12) };
  }
  if (ident !== 0x14) throw new Error(`${name}: unknown id ${ident}`);
  const scale = i32(4) || 1;
  const firstSlot = i32(12);
  const count = i32(16);
  if (count < 0 || 20 + count * 12 > data.length) throw new Error(`${name}: bad vertex count ${count}`);
  const vertices = [];
  for (let i = 0; i < count; i++) vertices.push([i32(20 + i * 12), i32(24 + i * 12), i32(28 + i * 12)]);

  let off = 20 + count * 12;
  let texture = null;
  let spriteUVs = null;
  let ramp = null;
  let vertexColors = null;
  let skipEnds = 0;
  const faces = [];
  const textures = new Set();
  while (off + 4 <= data.length) {
    const block = u32(off);
    off += 4;
    if (block === 0) {
      if (skipEnds > 0) {
        skipEnds -= 1;
        continue;
      }
      break;
    }
    if (block === 0x0d) {
      texture = cstr(data.subarray(off + 4, off + 20)).toLowerCase() || null;
      off += 20;
      if (texture) textures.add(texture);
      continue;
    }
    if (block === 0x1d) {
      // Animated texture: count frames of (texture, sound). The first frame is used.
      const frames = u32(off + 4);
      off += 24;
      let first = null;
      for (let i = 0; i < frames; i++, off += 32) {
        const frame = cstr(data.subarray(off, off + 16)).toLowerCase();
        if (frame && !first) first = frame;
      }
      if (first) {
        texture = first;
        textures.add(first);
      }
      continue;
    }
    if (FACE_UV.has(block) || FACE_PLAIN.has(block)) {
      const n = i32(off);
      const normal = [i32(off + 4) / 65536, i32(off + 8) / 65536, i32(off + 12) / 65536];
      off += 20;
      if (n < 1 || n > 8) throw new Error(`${name}: bad face size ${n} in block ${block.toString(16)}`);
      const corners = [];
      for (let i = 0; i < n; i++) {
        let vi;
        let u = 0;
        let v = 0;
        if (FACE_UV.has(block)) {
          vi = i32(off);
          u = i32(off + 4);
          v = i32(off + 8);
          off += 12;
        } else {
          vi = i32(off);
          off += 4;
          if (block === 0x0f && spriteUVs && i < spriteUVs.length) [u, v] = spriteUVs[i];
        }
        // Corners index vertex slots; the list starts at firstSlot.
        corners.push({ vi: vi - firstSlot, u: u / (65536 * 256), v: v / (65536 * 256) });
      }
      const flat = FLAT_FACES.has(block);
      let color = null;
      if (block === 0x06 && vertexColors) {
        const c = vertexColors[corners[0].vi];
        if (c !== undefined) color = [c & 255, c & 255];
      } else if (flat && ramp) {
        color = ramp;
      }
      faces.push({
        type: block,
        normal,
        corners,
        flat,
        texture: flat ? null : texture,
        alpha: ALPHA_FACES.has(block),
        lit: !UNLIT_FACES.has(block),
        color: color || [0, 0],
      });
      continue;
    }
    if (block === 0x0a) {
      ramp = rampOf(i32(off));
      off += 4;
      continue;
    }
    if (block === 0x04) {
      const n = u32(off + 4);
      off += 8;
      spriteUVs = [];
      for (let i = 0; i < n; i++, off += 8) spriteUVs.push([i32(off), i32(off + 4)]);
      continue;
    }
    if (block === 0x1f) {
      const n = u32(off + 4);
      off += 8;
      vertexColors = [];
      for (let i = 0; i < n; i++, off += 4) vertexColors.push(u32(off));
      continue;
    }
    if (block === 0x03) {
      off += 8 + u32(off + 4) * 12;
      continue;
    }
    if (block === 0x17) {
      off += 8;
      continue;
    }
    if (block === 0x16) {
      off += 16;
      continue;
    }
    if (block === 0x0c) {
      off += 24;
      skipEnds += 1;
      continue;
    }
    if (block === 0x12) {
      off += 4;
      continue;
    }
    if (block === 0x02) {
      off += 136;
      continue;
    }
    throw new Error(`${name}: unknown block ${block.toString(16)} at ${off - 4}`);
  }
  return { kind: "model", scale, vertices, faces, textures: [...textures] };
}

// Triangle soup grouped by material key: a texture (with its alpha flag),
// "flat", or "inherit" (a textured face with no texture block before it: the
// game draws it with whatever texture the caller set, as the tunnel obstacle
// models do). Positions are file units / scale; the caller applies 1/16.
// Per vertex: position, uv, normal (the stored face plane), ramp (lo, hi), lit.
export function binGroups(model) {
  const groups = new Map();
  const verts = model.vertices.map(([x, y, z]) => [x / model.scale, y / model.scale, z / model.scale]);
  let dropped = 0;
  for (const face of model.faces) {
    if (face.corners.some((c) => c.vi < 0 || c.vi >= verts.length)) {
      dropped += 1;
      continue;
    }
    const inherit = !face.texture && !face.flat;
    const key = face.texture ? `${face.texture}|${face.alpha ? 1 : 0}` : inherit ? "inherit" : "flat";
    let g = groups.get(key);
    if (!g) {
      g = { texture: face.texture, alpha: face.alpha, inherit, position: [], uv: [], normal: [], ramp: [], lit: [] };
      groups.set(key, g);
    }
    const c = face.corners;
    for (let i = 1; i + 1 < c.length; i++) {
      for (const corner of [c[0], c[i], c[i + 1]]) {
        g.position.push(...verts[corner.vi]);
        g.uv.push(corner.u, corner.v);
        g.normal.push(...face.normal);
        // Without a caller texture, an inheriting face falls back to the grey ramp.
        const ramp = inherit ? COLOR_RAMPS[0] : face.color;
        g.ramp.push(ramp[0], ramp[1]);
        g.lit.push(face.lit ? 1 : 0);
      }
    }
  }
  return { groups: [...groups.values()], dropped };
}
