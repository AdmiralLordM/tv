// Terminal Velocity level files, read straight from the game archive.
// Ported from tools/tvextract.py; docs/original-engine.md has the layouts.
// Positions come out in tiles (one tile = 2^20 game units), angles in radians
// in the game's left-handed convention: yaw 0 faces +Z and turns toward +X,
// positive pitch is nose down, positive roll lifts the right wing.
// Every function here takes an Archive-like object: bytes(name), text(name),
// has(name), list(folder, ext). That keeps it usable from node for checks.

const TILE = 1048576;
const TURN = (Math.PI * 2) / 65536;
const SKY_BAND = 240; // palette 240-255 come from the sky palette's 192-207
const SKY_SOURCE = 192;

// GAME.EXE keeps the power-up models in a 16-byte-slot table; the .pup type is the slot.
export const POWERUP_MODELS = [
  "powerlas", "powerpla", "powerant", "powermis", "powergmi", "powersup",
  "powershe", "powervis", "powerinv", "powerfir", "powerzap", "powercan",
];

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const wrapTile = (value) => round((((value / TILE) % 256) + 256) % 256);
const isInt = (text) => /^-?\d+$/.test(text);
const ints = (text) => text.split(",").map((part) => parseInt(part, 10));
const stem = (name) => name.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");

function angles(pitch, roll, yaw) {
  return { pitch: round(pitch * TURN, 5), roll: round(roll * TURN, 5), yaw: round(yaw * TURN, 5) };
}

export function lines(text) {
  return text.replaceAll("\x1a", "").split(/\r\n|\r|\n/).map((line) => line.trim());
}

async function maybeText(archive, name) {
  return archive.has(name) ? archive.text(name) : null;
}

// ---------------------------------------------------------------- .lvl

const LEVEL_FIELDS = [
  "kind", "story", "heightOrTunnel", "colorMap", "palette", "textures", "qke", "pup", "ani",
  "tdf", "sky", "skyPalette", "objects", "nav", "music", "fog", "light",
];

// FUN_00032d20: 17 file names, then sun vector, ambient, cave light vector,
// cave ambient and the fog color's palette index.
export function parseLvl(text, name) {
  const rows = lines(text).filter((line) => line && !line.startsWith(";"));
  if (rows.length < 16) return null;
  const lvl = { name };
  LEVEL_FIELDS.forEach((key, i) => {
    lvl[key] = (rows[i] || "").toLowerCase();
  });
  lvl.isTunnel = rows[0] === "1" || lvl.heightOrTunnel.endsWith(".tnl");
  const extra = rows.slice(17, 22).map((row) => (/^-?\d+(,-?\d+)*$/.test(row) ? ints(row) : null));
  if (extra.length === 5 && extra.every(Boolean)) {
    lvl.sun = extra[0].slice(0, 3);
    lvl.ambient = extra[1][0];
    lvl.caveLight = extra[2].slice(0, 3);
    lvl.caveAmbient = extra[3][0];
    lvl.fogIndex = extra[4][0] & 255;
  }
  // After the ";" comment line, five story names (+0x2a8..+0x348): enter
  // .tvi, leave .tvi, a .tvi before the enter one, a .mic typed over
  // vel2.raw before the briefing, a .mic over planet.raw after the level.
  lvl.stories = Array.from({ length: 5 }, (_, i) => (rows[22 + i] || "null").toLowerCase());
  return lvl;
}

export async function readLevels(archive) {
  const out = [];
  for (const path of archive.list("levels/", ".lvl")) {
    const lvl = parseLvl(await archive.text(path), stem(path));
    if (lvl) out.push(lvl);
  }
  return out;
}

// Surface levels with a 256x256 heightmap.
export function isSurface(archive, lvl) {
  return !lvl.isTunnel && lvl.heightOrTunnel.endsWith(".raw") && archive.has(`data/${lvl.heightOrTunnel}`)
    && archive.has(`data/${lvl.colorMap}`);
}

// ---------------------------------------------------------------- simple lists

export function parseTex(text) {
  let rows = lines(text).filter((line) => line && !line.startsWith(";"));
  if (rows.length && /^\d+$/.test(rows[0])) rows = rows.slice(1);
  return rows.filter((line) => line.includes(".")).map((line) => line.toLowerCase());
}

// Power-ups: count, then x,y,z,type. The game reads only `count` rows.
export function parsePup(text) {
  const rows = lines(text).filter((line) => line && !line.startsWith(";"));
  if (!rows.length || !/^\d+$/.test(rows[0])) return [];
  const count = parseInt(rows[0], 10);
  const out = [];
  let read = 0;
  for (const row of rows.slice(1)) {
    if (read >= count) break;
    const parts = row.split(",");
    if (parts.length !== 4 || !parts.every((p) => isInt(p.trim()))) continue;
    read += 1;
    const [x, , z, type] = parts.map((p) => parseInt(p, 10));
    const model = POWERUP_MODELS[type] || "";
    if (model) out.push({ model, type, x: wrapTile(x), z: wrapTile(z) });
  }
  return out;
}

// ---------------------------------------------------------------- .nav

// FUN_0003eac0: the first record, when it is type 6, is the spawn: x, z
// from the file, y = ground + half a tile (the viewer computes it).
export function parseNavStart(text) {
  const rows = lines(text).filter((line) => line && !line.startsWith(";"));
  if (rows.length < 5) return null;
  const kind = parseInt(rows[1], 10);
  const pos = ints(rows[2]);
  const ori = ints(rows[4]);
  if (kind !== 6 || pos.length < 3 || ori.length < 3 || [...pos, ...ori].some(Number.isNaN)) {
    return { x: 0, z: 0, pitch: 0, roll: 0, yaw: 0 };
  }
  return { x: wrapTile(pos[0]), z: wrapTile(pos[2]), ...angles(ori[0], ori[1], ori[2]) };
}

function navLabel(descr, kind) {
  if (kind === 1 || kind === 4) return "TUN";
  if (kind === 3) return "DUN";
  const text = descr.trim();
  const low = text.toLowerCase();
  if (!text || low === "put descr here" || low === "nav description") return "TGT";
  if (low.endsWith(".lvl")) return stem(text).toUpperCase();
  return text.toUpperCase();
}

// Waypoints in file order. A run of integers between points is a strike
// list plus the next point's type. Tunnel entrances are type 1 (the line
// after the description names the tunnel .lvl), exits 4, the departure
// unit 3. A boss (5) has its slot, a music file and, after `!`, a count of
// parts that must die first (FUN_0003f350 reads them at +0x184, +0x198).
export function parseNav(text) {
  const raw = lines(text).filter((line) => line && !line.startsWith(";"));
  if (!raw.length || !/^\d+$/.test(raw[0]) || parseInt(raw[0], 10) === 0) return [];
  const count = parseInt(raw[0], 10);
  let index = 1;
  if (index >= raw.length || !isInt(raw[index])) return [];
  let pending = parseInt(raw[index], 10);
  index += 1;
  const points = [];
  while (points.length < count && index < raw.length) {
    const kind = pending ?? 0;
    while (index < raw.length && !raw[index].includes(",")) index += 1;
    if (index >= raw.length) break;
    const pos = ints(raw[index]).slice(0, 3);
    if (pos.some(Number.isNaN)) break;
    index += 1;
    const descr = raw[index] ?? "";
    index += 1;
    let tunnel = null;
    let boss = null;
    if (kind === 1 && /\.lvl$/i.test(raw[index] || "")) tunnel = stem(raw[index]);
    if (kind === 5 && isInt(raw[index] || "")) {
      boss = { slot: parseInt(raw[index], 10), parts: [] };
      index += 1;
      if (index < raw.length && !isInt(raw[index]) && !raw[index].startsWith("!") && !raw[index].includes(",")) index += 1; // music
      if (index < raw.length && raw[index].startsWith("!")) {
        index += 1;
        const n = isInt(raw[index] || "") ? parseInt(raw[index], 10) : 0;
        index += 1;
        for (let i = 0; i < n && isInt(raw[index] || ""); i++, index++) boss.parts.push(parseInt(raw[index], 10));
      }
    }
    if (index < raw.length && raw[index].split(",").length >= 3
      && raw[index].split(",").slice(0, 3).every((part) => isInt(part))) {
      const ori = ints(raw[index]).slice(0, 3);
      if (ori.length && Math.max(...ori.map(Math.abs)) <= 131072) index += 1;
    }
    const run = [];
    while (index < raw.length && !raw[index].includes(",") && isInt(raw[index])) {
      run.push(parseInt(raw[index], 10));
      index += 1;
    }
    let links = [];
    pending = null;
    if (points.length + 1 < count && run.length) {
      pending = run[run.length - 1];
      const rest = run.slice(0, -1);
      links = rest.length && rest[0] === rest.length - 1 ? rest.slice(1) : rest;
    } else if (run.length) {
      links = run;
    }
    while (index < raw.length && !raw[index].includes(",")) {
      if (pending === null && isInt(raw[index]) && points.length + 1 < count) pending = parseInt(raw[index], 10);
      index += 1;
    }
    if (pos.length < 3) continue;
    const point = {
      x: wrapTile(pos[0]),
      y: round(pos[1] / TILE),
      z: wrapTile(pos[2]),
      type: kind,
      label: navLabel(descr, kind),
      links,
    };
    if (tunnel) point.tunnel = tunnel;
    if (boss) point.boss = boss;
    points.push(point);
  }
  return points;
}

// ---------------------------------------------------------------- .def

// FUN_000230a0. Def header: logic, ?, radius, dx, dy, dz, "model.bin,second.bin";
// then a variable run of tagged lines. After the defs: count and placement
// rows (def index, strength, x, y, z, pitch, roll, yaw).
//
// The AI reads (offsets into the 0x244-byte def, FUN_00028610 and callers):
//   line 2 `speed,turn,fireEvery,weapon,shot` (+0x64..+0x70, +0xdc): speed in
//     game units per game second, turn and fireEvery in 16.16 (per second /
//     seconds);
//   `!NewAtakRet` `far,near,bossOnly,?` (+0x1f8..+0x200): fighters break off
//     inside near/16 tiles and come back past far/16; bossOnly units wait for
//     the boss nav point. Defaults 32, 16, 0;
//   `#New2ndweapon` `spread,gun2,gun2Range,shotSpeed` (+0x20c..+0x218);
//     spread 1/2 cycles shots through 3/5 directions 0x800 apart;
//     shotSpeed (units per game second) defaults to twice the speed.
//   `shot` (+0xdc) picks the projectile model (SHOT_MODELS).
export function parseDef(text) {
  const rows = lines(text).filter(Boolean);
  if (!rows.length || !/^\d+$/.test(rows[0])) return { defs: [], rows: [] };
  const count = parseInt(rows[0], 10);
  let index = 1;
  const defs = [];
  const starts = (prefix) => index < rows.length && rows[index].toLowerCase().startsWith(prefix);
  const numbers = (row, n) => {
    const out = (row || "").split(",").slice(0, n).map((part) => (isInt(part.trim()) ? parseInt(part, 10) : 0));
    while (out.length < n) out.push(0);
    return out;
  };
  for (let n = 0; n < count && index < rows.length; n++) {
    const parts = rows[index].split(",").map((part) => part.trim());
    index += 1;
    const nums = parts.slice(0, 6).map((part) => (isInt(part) ? parseInt(part, 10) : 0));
    while (nums.length < 6) nums.push(0);
    // The main model, then the second one (a wreck for logic 9, FUN_00028610).
    const [bin, second] = parts.filter((part) => part.toLowerCase().endsWith(".bin"));
    const [speed, turn, fireEvery, weapon, shot] = numbers(rows[index], 5);
    const ai = { speed, turn, fireEvery, weapon, shot, far: 32, near: 16, bossOnly: 0, spread: 0, gun2: 0, gun2Range: 0, shotSpeed: speed * 2, sfx: null };
    // Third line (+0xe0..0xec): ?, spawner may copy it, drop %, drop type
    // (-1 any; FUN_00028d90).
    // The first value (+0xe0) puts the def in the tactical report
    // (FUN_0004a130), which types its description (+0xf0).
    let brief;
    [brief, ai.spawn, ai.drop, ai.dropType] = numbers(rows[index + 1], 4);
    // Firing vertices (+0x190 count, +0x194 list): each shot leaves from one
    // of these model vertices, picked at random.
    const [muzzleCount, ...muzzleList] = numbers(rows[index + 2], 9);
    ai.muzzles = muzzleList.slice(0, Math.max(0, Math.min(muzzleCount, 8)));
    const def = { index: n, model: bin ? stem(bin) : "", wreck: second ? stem(second) : "", logic: nums[0], offset: nums.slice(3, 6).map((v) => round(v / TILE, 5)), ai, brief, description: "" };
    defs.push(def);
    index += 3; // thrust, flags, firing vertices
    // `;NewHit` `count, vertex, size, ...` (+0x1b4, +0x1b8, +0x1d8): shots
    // test cubes of half-size `size` around these model vertices instead of
    // the model's box (FUN_000290d0). The loader's sscanf writes the fourth
    // to eighth vertices all to the fourth slot, so it keeps the eighth and
    // slots five on are never filled ([I] taken as vertex 0).
    if (starts(";newhit")) {
      const [hitCount, ...hitList] = numbers(rows[index + 1], 17);
      const vertexAt = (i) => (i < 3 ? hitList[i * 2] : i === 3 ? hitList[14] : 0);
      ai.hitPoints = [];
      for (let i = 0; i < Math.min(hitCount, 8); i++) ai.hitPoints.push([vertexAt(i), hitList[i * 2 + 1] / TILE]);
      index += 2;
    }
    if (starts("!newatakret")) {
      [ai.far, ai.near, ai.bossOnly] = numbers(rows[index + 1], 3);
      index += 2;
    }
    def.description = rows[index] || "";
    index += 1;
    if (starts("#new2ndweapon")) {
      [ai.spread, ai.gun2, ai.gun2Range, ai.shotSpeed] = numbers(rows[index + 1], 4);
      index += 2;
    }
    if (starts("%sfx")) {
      // +0x21c: played at the shooter on every shot ("null" for none).
      const sfx = (rows[index + 1] || "").trim().toLowerCase();
      if (sfx && sfx !== "null") ai.sfx = sfx;
      index += 3;
    }
    if (starts(": path")) index += 2;
    if (starts("= cannon")) index += 4;
    if (starts("@ friendly")) index += 2;
    if (index < rows.length && rows[index].startsWith("{")) index += 3;
  }
  // FUN_00028e50: a killed C-Nome (0x13) becomes the first def with logic 0x14.
  const remains = defs.find((def) => def.logic === 0x14);
  for (const def of defs) if (def.logic === 0x13 && remains) def.remains = remains;
  if (index >= rows.length || !/^\d+$/.test(rows[index])) return { defs, rows: [] };
  const placed = parseInt(rows[index], 10);
  index += 1;
  const out = [];
  for (let n = 0; n < placed && index < rows.length; n++, index++) {
    const nums = rows[index].split(",");
    if (nums.length < 8 || !nums.slice(0, 8).every((p) => isInt(p.trim()))) continue;
    // The row number is kept: FUN_00022f20 derives per-enemy variety from it.
    out.push([...nums.slice(0, 8).map((p) => parseInt(p, 10)), n]);
  }
  return { defs, rows: out };
}

// Animation-control bins (id 0x20) name their frames; this gives the first
// frame's mesh. Level object lists keep the list name, so the viewer can play
// the morph; tools/check uses this to compare with the Python extractor.
export async function resolveModel(archive, model) {
  const path = `models/${model}.bin`;
  if (!model || !archive.has(path)) return model;
  const data = await archive.bytes(path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 40 || view.getUint32(0, true) !== 0x20 || view.getUint32(8, true) < 1) return model;
  const end = data.indexOf(0, 24);
  const name = new TextDecoder("latin1").decode(data.subarray(24, end < 0 || end > 40 ? 40 : end));
  return stem(name) || model;
}


// Surface objects: the game seats them on the ground itself (FUN_00022f20),
// so only x, z, the def's offsets and logic are kept.
export async function readObjects(archive, path) {
  const text = await maybeText(archive, path);
  if (!text) return [];
  const { defs, rows } = parseDef(text);
  const out = [];
  for (const [defIndex, strength, x, , z, pitch, roll, yaw, slot] of rows) {
    const def = defs[defIndex];
    if (!strength || !def?.model) continue;
    out.push({
      model: def.model, logic: def.logic, offset: def.offset, def, slot, strength,
      x: wrapTile(x), z: wrapTile(z), ...angles(pitch, roll, yaw),
    });
  }
  return out;
}

// FUN_0004a130: each def with the briefing flag, in def order, at the first
// placement row that uses it (strength not checked).
export async function readBriefTargets(archive, path) {
  const text = await maybeText(archive, path);
  if (!text) return [];
  const { defs, rows } = parseDef(text);
  const out = [];
  for (const def of defs) {
    if (!def.brief || !def.model) continue;
    const row = rows.find((r) => r[0] === def.index);
    if (row) out.push({ model: def.model, description: def.description, x: wrapTile(row[2]), z: wrapTile(row[4]) });
  }
  return out;
}

// Tunnel props keep their file x, y, z in tunnel space.
export async function readTunnelContents(archive, path) {
  const text = await maybeText(archive, path);
  if (!text) return [];
  const { defs, rows } = parseDef(text);
  const out = [];
  for (const [defIndex, strength, x, y, z, pitch, roll, yaw, slot] of rows) {
    const def = defs[defIndex];
    if (!strength || !def?.model || def.model === "cube") continue;
    out.push({
      model: def.model, logic: def.logic, def, slot, strength,
      x: round(x / TILE), y: round(y / TILE), z: round(z / TILE),
      ...angles(pitch, roll, yaw),
    });
  }
  return out;
}

// ---------------------------------------------------------------- tunnels

// FUN_00039d50: tunnel .lvl, entrance x,y,z, exit x,y,z, entrance mode, two
// textures (the second is the mouth tile), exit mode, two exit textures, cave flag.
export function parseTdf(text) {
  const rows = lines(text).filter((line) => line && !line.startsWith(";") && !line.startsWith("!"));
  if (!rows.length || !/^\d+$/.test(rows[0])) return [];
  const count = parseInt(rows[0], 10);
  const out = [];
  const spot = (row) => {
    const [x, y, z] = ints(row);
    if ([x, y, z].some(Number.isNaN)) return null;
    return { x: wrapTile(x), y: round(y / TILE), z: wrapTile(z) };
  };
  const number = (row) => (isInt(row) ? parseInt(row, 10) : 0);
  for (let n = 0, i = 1; n < count && i + 9 < rows.length; n++, i += 10) {
    const rec = rows.slice(i, i + 10);
    const entrance = spot(rec[1]);
    const exit = spot(rec[2]);
    if (!entrance || !exit) continue;
    out.push({
      level: stem(rec[0]),
      entrance,
      exit,
      entranceMode: number(rec[3]),
      mouth: `${stem(rec[5])}.raw`,
      exitMode: number(rec[6]),
      exitMouth: `${stem(rec[8])}.raw`,
      cave: number(rec[9]) === 1,
    });
  }
  return out;
}

// FUN_00034770. Per segment: x0,y0,x1,y1,N / a0,a1,rot / rx0,ry0 / b0,b1 /
// rx1,ry1 / hp / light face / missing / obstacle / obstacle texture /
// N face textures / light mode, light level, ambient. Lengths are 1/4096 tile.
export function parseTnl(text) {
  const toks = lines(text).filter((line) => line && !line.startsWith(";"));
  if (!toks.length || !/^\d+$/.test(toks[0])) return [];
  const segments = [];
  let i = 1;
  try {
    for (let n = parseInt(toks[0], 10); n > 0; n--) {
      const [x0, y0, x1, y1, sides] = ints(toks[i]);
      const [a0, a1, spin] = ints(toks[i + 1]);
      const r0 = ints(toks[i + 2]).slice(0, 2);
      const b = ints(toks[i + 3]).slice(0, 2);
      const r1 = ints(toks[i + 4]).slice(0, 2);
      const [hp, lightFace, missing, obstacle, obstacleTex] = toks.slice(i + 5, i + 10).map((t) => parseInt(t, 10));
      i += 10;
      const faces = toks.slice(i, i + sides).map((t) => parseInt(t, 10));
      i += sides;
      const [lightMode, lightLevel, ambient] = toks.slice(i, i + 3).map((t) => parseInt(t, 10));
      i += 3;
      const all = [x0, y0, x1, y1, sides, a0, a1, spin, ...r0, ...b, ...r1, hp, lightFace, missing, obstacle, obstacleTex, ...faces, lightMode, lightLevel, ambient];
      if (all.some(Number.isNaN) || faces.length !== sides) break;
      segments.push({
        start: [x0, y0], end: [x1, y1], sides, a: [a0, a1], spin, r0, b, r1,
        hp, lightFace, missing, obstacle, obstacleTex, faces, lightMode, lightLevel, ambient,
      });
    }
  } catch {
    // a short file ends the segment list
  }
  return segments;
}

// ---------------------------------------------------------------- palettes

// 768-byte RGB. A level's palette is its own 0-239 plus the sky band.
export async function readPalette(archive, name) {
  const path = `art/${stem(name)}.act`;
  if (!name || name === "null" || !archive.has(path)) return null;
  const data = await archive.bytes(path);
  return data.length >= 768 ? data.slice(0, 768) : null;
}

export function composePalette(main, sky) {
  const out = main.slice(0, 768);
  if (!sky) return out;
  const band = sky.subarray(SKY_SOURCE * 3, (SKY_SOURCE + 256 - SKY_BAND) * 3);
  if (!band.some(Boolean)) return out;
  out.set(band, SKY_BAND * 3);
  return out;
}

async function readTable(archive, folder, name) {
  const path = `${folder}/${name}`;
  if (!name || !archive.has(path)) return null;
  const data = await archive.bytes(path);
  return data.length >= 4096 ? data.slice(0, 4096) : null;
}

// ---------------------------------------------------------------- a whole level

// Everything the renderer needs for one surface level, by archive path.
export async function readLevel(archive, levels, name) {
  const byName = new Map(levels.map((lvl) => [lvl.name, lvl]));
  const lvl = byName.get(name);
  if (!lvl) throw new Error(`no level ${name}`);
  const vga = await readPalette(archive, "vga");
  const skyPalette = await readPalette(archive, lvl.skyPalette);
  const paletteOf = async (level, skyFrom) => composePalette(
    (await readPalette(archive, level.palette)) || vga,
    skyFrom,
  );
  const look = async (level, skyFrom) => ({
    palette: await paletteOf(level, skyFrom),
    fog: await readTable(archive, "fog", level.fog),
    light: await readTable(archive, "fog", level.light),
    fogIndex: level.fogIndex ?? 255,
  });

  const texList = async (level) => {
    const text = await maybeText(archive, `data/${level.textures}`);
    return text ? parseTex(text).map((tex) => `art/${tex}`) : [];
  };
  const navText = await maybeText(archive, `data/${lvl.nav}`);
  const level = {
    name,
    height: `data/${lvl.heightOrTunnel}`,
    index: `data/${lvl.colorMap}`,
    textures: await texList(lvl),
    sky: lvl.sky.endsWith(".raw") && archive.has(`art/${lvl.sky}`) ? `art/${lvl.sky}` : null,
    music: lvl.music.endsWith(".mod") && archive.has(`music/${lvl.music}`) ? `music/${lvl.music}` : null,
    sun: lvl.sun, ambient: lvl.ambient, caveLight: lvl.caveLight, caveAmbient: lvl.caveAmbient,
    look: await look(lvl, skyPalette),
    start: navText ? parseNavStart(navText) : null,
    nav: navText ? parseNav(navText) : [],
    objects: lvl.objects.endsWith(".def") ? await readObjects(archive, `data/${lvl.objects}`) : [],
    briefTargets: lvl.objects.endsWith(".def") ? await readBriefTargets(archive, `data/${lvl.objects}`) : [],
    briefing: lvl.story, // data/<planet>.txt, or null.txt
    stories: lvl.stories,
    isTunnel: lvl.isTunnel,
    powerups: [],
    tunnels: [],
  };
  const pupText = await maybeText(archive, `data/${lvl.pup}`);
  if (pupText) level.powerups = parsePup(pupText);

  const tdfText = lvl.tdf.endsWith(".tdf") ? await maybeText(archive, `data/${lvl.tdf}`) : null;
  for (const portal of tdfText ? parseTdf(tdfText) : []) {
    const tunnel = byName.get(portal.level);
    const tnlText = await maybeText(archive, `data/${portal.level}.tnl`);
    portal.segments = tnlText ? parseTnl(tnlText) : [];
    // Tunnels have no sky of their own; they keep the surface level's band.
    portal.walls = tunnel ? await texList(tunnel) : [];
    portal.look = tunnel ? await look(tunnel, skyPalette) : level.look;
    portal.contents = await readTunnelContents(archive, `data/${portal.level}.def`);
    if (tunnel) {
      const pups = await maybeText(archive, `data/${tunnel.pup}`);
      for (const pup of pups ? parsePupRaw(pups) : []) portal.contents.push(pup);
    }
    portal.mouth = `art/${portal.mouth}`;
    portal.exitMouth = `art/${portal.exitMouth}`;
    level.tunnels.push(portal);
  }
  return level;
}

// Tunnel power-ups sit at their file x, y, z in tunnel space.
function parsePupRaw(text) {
  const rows = lines(text).filter((line) => line && !line.startsWith(";"));
  if (!rows.length || !/^\d+$/.test(rows[0])) return [];
  const count = parseInt(rows[0], 10);
  const out = [];
  let read = 0;
  for (const row of rows.slice(1)) {
    if (read >= count) break;
    const parts = row.split(",");
    if (parts.length !== 4 || !parts.every((p) => isInt(p.trim()))) continue;
    read += 1;
    const [x, y, z, type] = parts.map((p) => parseInt(p, 10));
    const model = POWERUP_MODELS[type];
    if (model) out.push({ model, powerup: type, x: round(x / TILE), y: round(y / TILE), z: round(z / TILE), pitch: 0, roll: 0, yaw: 0 });
  }
  return out;
}
