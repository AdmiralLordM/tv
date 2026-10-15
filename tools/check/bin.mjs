// Parses every models/*.bin in an unpacked tree with src/bin.js and compares
// face counts with the Python extractor's catalog.
//   node tools/check/bin.mjs [_orig]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBin, binGroups } from "../../src/bin.js";

const root = process.argv[2] || "_orig";
const catalog = JSON.parse(readFileSync("extracted/catalog.json", "utf8"));
const py = new Map(catalog.models.filter((m) => m.file?.endsWith(".obj")).map((m) => [m.file.replace(/^models\/|\.obj$/g, ""), m]));
let models = 0, anims = 0, errors = 0, mismatch = 0, dropped = 0;
for (const name of readdirSync(join(root, "models")).filter((n) => n.endsWith(".bin"))) {
  const stem = name.slice(0, -4).toLowerCase();
  try {
    const model = parseBin(new Uint8Array(readFileSync(join(root, "models", name))), stem);
    if (model.kind === "anim") { anims += 1; continue; }
    models += 1;
    const built = binGroups(model);
    dropped += built.dropped;
    const p = py.get(stem);
    if (p && p.faces !== model.faces.length - built.dropped) {
      mismatch += 1;
      console.log(stem, "faces js", model.faces.length - built.dropped, "py", p.faces);
    }
  } catch (err) {
    errors += 1;
    console.log("ERROR", name, err.message);
  }
}
console.log(`${models} models, ${anims} morph lists, ${errors} errors, ${mismatch} face-count mismatches, ${dropped} dropped faces`);
