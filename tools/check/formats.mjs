// Compares src/formats.js against the Python extractor's extracted/view.json,
// reading an unpacked game tree (default _orig/).
//   node tools/check/formats.mjs [_orig]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readLevels, isSurface, readLevel, resolveModel } from "../../src/formats.js";

const root = process.argv[2] || "_orig";
const files = new Map();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.set(relative(root, path).toLowerCase(), path);
  }
})(root);
const archive = {
  has: (name) => files.has(name.toLowerCase()),
  list: (folder, ext = "") => [...files.keys()].filter((n) => n.startsWith(folder) && n.endsWith(ext)).sort(),
  bytes: async (name) => new Uint8Array(readFileSync(files.get(name.toLowerCase()))),
  text: async (name) => readFileSync(files.get(name.toLowerCase()), "latin1"),
};

const view = JSON.parse(readFileSync("extracted/view.json", "utf8"));
const py = new Map(view.levels.map((l) => [l.name, l]));
const levels = await readLevels(archive);
const surface = levels.filter((l) => isSurface(archive, l));
let problems = 0;
// Deep equal, ignoring key order and last-digit rounding (Python rounds half to even).
const same = (a, b) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 2e-4;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    // def, slot, strength, tunnel and boss feed src/ai.js and the nav; the
    // Python extractor has no such data.
    const skip = new Set(["def", "slot", "strength", "tunnel", "boss"]);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !skip.has(k)));
    return [...keys].every((k) => same(a[k], b[k]));
  }
  return a === b;
};
const report = (name, what, a, b) => {
  problems += 1;
  if (problems < 25) console.log(`${name} ${what}\n  js: ${JSON.stringify(a)?.slice(0, 300)}\n  py: ${JSON.stringify(b)?.slice(0, 300)}`);
};
for (const lvl of surface) {
  const js = await readLevel(archive, levels, lvl.name);
  // The extractor names a morph list's first frame (cnome -> cnome1).
  const things = [...js.objects, ...js.tunnels.flatMap((t) => t.contents || [])];
  for (const thing of things) thing.model = await resolveModel(archive, thing.model);
  const p = py.get(lvl.name);
  if (!p) { report(lvl.name, "missing in view.json", true, false); continue; }
  if (!same(js.start, p.start)) report(lvl.name, "start", js.start, p.start);
  // The extractor misreads a boss point's slot, music and `!` part list as
  // the next point's type, so the routes are compared up to the boss.
  const upToBoss = (nav) => nav.slice(0, nav.findIndex((point) => point.type === 5) + 1 || nav.length);
  if (!same(upToBoss(js.nav), upToBoss(p.nav))) report(lvl.name, "nav", js.nav, p.nav);
  if (!same(js.objects, p.objects)) report(lvl.name, "objects", js.objects, p.objects);
  const pups = (p.powerups || []).map(({ model, type, x, z }) => ({ model, type, x, z }));
  if (!same(js.powerups, pups)) report(lvl.name, "powerups", js.powerups, pups);
  if (js.textures.length !== p.textures.length) report(lvl.name, "texture count", js.textures.length, p.textures.length);
  if (js.sun?.join() !== p.sun?.join() || js.ambient !== p.ambient) report(lvl.name, "light", [js.sun, js.ambient], [p.sun, p.ambient]);
  if (!!js.music !== !!p.music) report(lvl.name, "music", js.music, p.music);
  const pt = p.tunnels || [];
  if (js.tunnels.length !== pt.length) report(lvl.name, "tunnel count", js.tunnels.length, pt.length);
  js.tunnels.forEach((t, i) => {
    const q = pt[i];
    if (!q) return;
    for (const key of ["level", "entrance", "exit", "entranceMode", "exitMode", "cave", "segments", "contents"]) {
      if (!same(t[key], q[key])) report(lvl.name, `tunnel ${i} ${key}`, t[key], q[key]);
    }
    if (t.walls.length !== q.walls.length) report(lvl.name, `tunnel ${i} walls`, t.walls.length, q.walls.length);
  });
  if (!js.look.fog || !js.look.palette) report(lvl.name, "look", !!js.look.fog, !!js.look.palette);
}
console.log(`${surface.length} surface levels checked, ${problems} differences`);
process.exit(problems ? 1 : 0);
