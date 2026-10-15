// Data that only lives in GAME.EXE (DOS/4GW linear executable), read from the
// raw file: object table + data pages, no fixups (the tables read here hold
// no pointers). tools/re/le2flat.py does the same in full.

// The status-bar font (FUN_00014a80): 128 glyphs of 64 bytes at 0x65770,
// byte 0 the width, then width x 8 pixels; 0 is clear, any other value v is
// drawn as palette index 0x20 + v (the identity row of the remap table).
const HUD_FONT_VA = 0x65770;
const HUD_FONT_SIZE = 128 * 64;

export function readHudFont(bytes) {
  const font = readLinear(bytes, HUD_FONT_VA, HUD_FONT_SIZE);
  if (!font) return null;
  // Sanity: digits are 6 wide, space 2 (the retail GAME.EXE).
  for (const ch of "0123456789") if (font[ch.charCodeAt(0) * 64] !== 6) return null;
  if (font[32 * 64] !== 2) return null;
  return font;
}

// Bytes [va, va + size) of the loaded image, or null if not in any object.
function readLinear(bytes, va, size) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = findLe(bytes);
  if (le < 0) return null;
  // The LE offsets are relative to the inner MZ header that points at it.
  let mz = -1;
  for (let i = 0; i + 0x40 <= le; i++) {
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x5a && i + view.getUint32(i + 0x3c, true) === le) {
      mz = i;
      break;
    }
  }
  if (mz < 0) return null;
  const u32 = (offset) => view.getUint32(le + offset, true);
  const pageSize = u32(0x28);
  const objectCount = u32(0x44);
  const objectTable = le + u32(0x40);
  const dataPages = mz + u32(0x80);
  for (let i = 0; i < objectCount; i++) {
    const entry = objectTable + i * 24;
    const virtualSize = view.getUint32(entry, true);
    const base = view.getUint32(entry + 4, true);
    const firstPage = view.getUint32(entry + 12, true);
    if (va < base || va + size > base + virtualSize) continue;
    const out = new Uint8Array(size);
    for (let k = 0; k < size; k++) {
      const at = va + k - base;
      const file = dataPages + (firstPage - 1 + Math.floor(at / pageSize)) * pageSize + (at % pageSize);
      out[k] = file < bytes.length ? bytes[file] : 0;
    }
    return out;
  }
  return null;
}

function findLe(bytes) {
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] === 0x4c && bytes[i + 1] === 0x45 && bytes[i + 2] === 0 && bytes[i + 3] === 0
      && bytes[i + 4] === 0 && bytes[i + 5] === 0 && bytes[i + 6] === 0 && bytes[i + 7] === 0) return i;
  }
  return -1;
}
