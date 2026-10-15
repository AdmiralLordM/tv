// POD archives: uint32 count, 80-byte label, then count entries of a 32-byte
// name, uint32 size, uint32 offset. Names use backslashes ("ART\VGA.ACT").
// STARTUP.POD is read first; a name found in both archives is an identical copy.

const decoder = new TextDecoder("latin1");

function cstr(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
}

async function readDirectory(blob) {
  const head = new DataView(await blob.slice(0, 84).arrayBuffer());
  const count = head.getUint32(0, true);
  const label = cstr(new Uint8Array(head.buffer, 4, 80));
  const table = new Uint8Array(await blob.slice(84, 84 + count * 40).arrayBuffer());
  const view = new DataView(table.buffer);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const name = cstr(table.subarray(i * 40, i * 40 + 32)).replaceAll("\\", "/").toLowerCase();
    const size = view.getUint32(i * 40 + 32, true);
    const offset = view.getUint32(i * 40 + 36, true);
    if (name && offset + size <= blob.size) entries.push({ name, size, offset });
  }
  return { label, entries };
}

// A read-only file system over one or more archives.
export class Archive {
  constructor() {
    this.files = new Map();
    this.labels = [];
  }

  static async open(blobs) {
    const archive = new Archive();
    for (const blob of blobs) await archive.add(blob);
    return archive;
  }

  async add(blob) {
    const { label, entries } = await readDirectory(blob);
    this.labels.push(label);
    for (const entry of entries) {
      if (!this.files.has(entry.name)) this.files.set(entry.name, { blob, ...entry });
    }
  }

  has(name) {
    return this.files.has(name.toLowerCase());
  }

  // Paths under a folder ("data/"), optionally with an extension (".lvl").
  list(folder, ext = "") {
    const out = [];
    for (const name of this.files.keys()) {
      if (name.startsWith(folder) && name.endsWith(ext)) out.push(name);
    }
    return out.sort();
  }

  async bytes(name) {
    const file = this.files.get(name.toLowerCase());
    if (!file) throw new Error(`${name} is not in the game files`);
    return new Uint8Array(await file.blob.slice(file.offset, file.offset + file.size).arrayBuffer());
  }

  async text(name) {
    return decoder.decode(await this.bytes(name));
  }

  blob(name, type = "") {
    const file = this.files.get(name.toLowerCase());
    if (!file) return null;
    return file.blob.slice(file.offset, file.offset + file.size, type);
  }
}

// STARTUP.POD first, as the game does.
export function podOrder(names) {
  return [...names].sort((a, b) => (a.toLowerCase() !== "startup.pod") - (b.toLowerCase() !== "startup.pod") || a.localeCompare(b));
}

export function looksLikePod(bytes) {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  return count > 0 && count < 100000;
}
