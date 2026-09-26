#!/usr/bin/env python3
"""Translate unpacked Terminal Velocity assets into PNGs, OBJs, and audio.

The POD archives are unpacked first (see extract.js) into a tree like _orig/.
This tool reads those files and writes a browsable extracted/ folder.

    python3 tools/tvextract.py
    python3 tools/tvextract.py --root _orig --out extracted

Formats handled
  art/*.raw + *.act   8-bit images and 24-bit RGB palettes
  art UI screens      320x200, 256x108, 320x64, 320x25
  models/*.bin        Terminal Reality BIN models (and morph-animation lists)
  data/*.raw + *.clr  256x256 heightmap and texture-index map
  data/*.tex          texture list, index order matches the color map
  fog/*.fog *.lte     16-step palette remaps (distance fog and lighting)
  sound/*.wav         already PCM WAV (11 kHz, 8-bit, mono)
  music/*.mod         6-channel ProTracker modules (signature 6CHN)
  startup/font.*      proportional 23px font
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import shutil
import struct
import wave
import zlib
from collections import defaultdict
from pathlib import Path

UI_SIZES = {
    64000: (320, 200),
    27648: (256, 108),
    20480: (320, 64),
    8000: (320, 25),
}
RAW_SIZES = {
    4096: (64, 64),
    65536: (256, 256),
    **UI_SIZES,
}

FACE_UV = {0x0E, 0x11, 0x18, 0x29, 0x33, 0x34, 0x22}
FACE_PLAIN = {0x19, 0x05, 0x0F, 0x06}
# Color 0 is the engine's transparent index on sprites and masked faces.
ALPHA_FACES = {0x11, 0x0F, 0x33}

LEVEL_FIELDS = (
    "kind",
    "story",
    "height_or_tunnel",
    "color_map",
    "palette",
    "textures",
    "qke",
    "pup",
    "ani",
    "tdf",
    "sky",
    "sky_palette",
    "objects",
    "nav",
    "music",
    "fog",
    "light",
)


def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    if len(rgba) != width * height * 4:
        raise ValueError(f"rgba size {len(rgba)} != {width}x{height}")

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    rows = bytearray()
    stride = width * 4
    for y in range(height):
        rows.append(0)
        rows += rgba[y * stride : (y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def align_sparse_palette(indices: bytes, palette: list[tuple[int, int, int]]) -> bytes:
    """Sky palettes store their ramp up high (index 192+) while the RAW
    indexes an even higher band (around 240). Slide the pixels down so the
    darkest pixel lands on the first real color."""
    first = next((i for i, (r, g, b) in enumerate(palette) if r or g or b), 0)
    if first < 128 or not indices:
        return indices
    lowest = min(indices)
    if lowest <= first:
        return indices
    shift = lowest - first
    return bytes(max(0, value - shift) for value in indices)


def index_image(indices: bytes, palette: list[tuple[int, int, int]], alpha0: bool) -> bytes:
    indices = align_sparse_palette(indices, palette)
    out = bytearray(len(indices) * 4)
    for i, idx in enumerate(indices):
        r, g, b = palette[idx]
        out[i * 4 : i * 4 + 4] = bytes((r, g, b, 0 if alpha0 and idx == 0 else 255))
    return bytes(out)


# navtar01's flat gray field (and the dither around it) is the sprite's
# backing plate. The compass already has an opaque dial, so those indices
# stay transparent and only the chevron is drawn.
NAVTAR_FIELD = {0, 8, 9, 10, 12}


def navtar_marker(indices: bytes, palette: list[tuple[int, int, int]]) -> bytes:
    out = bytearray(len(indices) * 4)
    for i, idx in enumerate(indices):
        r, g, b = palette[idx]
        out[i * 4 : i * 4 + 4] = bytes((r, g, b, 0 if idx in NAVTAR_FIELD else 255))
    return bytes(out)


def fill_compass_face(rgba: bytes, width: int, height: int) -> bytes:
    """The status bar's compass interior is palette 0, which we treat as
    transparent so the view shows around the metal. The dial itself stays
    opaque so the ship icon sits on a solid face."""
    pixels = bytearray(rgba)
    start = 282 + 31 * width
    if pixels[start * 4 + 3] != 0:
        return rgba
    face = bytes((14, 14, 14, 255))
    stack = [start]
    seen = bytearray(width * height)
    while stack:
        i = stack.pop()
        if seen[i] or pixels[i * 4 + 3] != 0:
            continue
        seen[i] = 1
        pixels[i * 4 : i * 4 + 4] = face
        x = i % width
        y = i // width
        if x > 0:
            stack.append(i - 1)
        if x + 1 < width:
            stack.append(i + 1)
        if y > 0:
            stack.append(i - width)
        if y + 1 < height:
            stack.append(i + width)
    return bytes(pixels)


def cstr(buf: bytes) -> str:
    text = buf.split(b"\x00", 1)[0].decode("latin1")
    return "".join(ch for ch in text if ch.isprintable()).strip()


def read_text(path: Path) -> list[str]:
    data = path.read_bytes().replace(b"\x1a", b"")
    return [line.strip() for line in data.decode("latin1").splitlines()]


def load_palette(path: Path) -> list[tuple[int, int, int]] | None:
    data = path.read_bytes()
    if len(data) < 768:
        return None
    return [(data[i], data[i + 1], data[i + 2]) for i in range(0, 768, 3)]


def image_size(nbytes: int) -> tuple[int, int] | None:
    return RAW_SIZES.get(nbytes)


def sanitize(name: str) -> str:
    stem = Path(name).stem.lower()
    stem = re.sub(r"[^a-z0-9._-]+", "_", stem).strip("._")
    return stem or "unnamed"


def parse_levels(root: Path) -> list[dict]:
    levels = []
    for path in sorted((root / "levels").glob("*.lvl")):
        lines = [ln for ln in read_text(path) if ln and not ln.startswith(";")]
        if len(lines) < 16:
            continue
        info = {"name": path.stem.lower(), "file": path.name}
        for key, value in zip(LEVEL_FIELDS, lines):
            info[key] = value
        info["kind"] = lines[0]
        info["is_tunnel"] = lines[0] == "1" or lines[2].lower().endswith(".tnl")
        # After the light table: sun vector, sun scalar, sky-drift vector, drift scalar.
        # Components are 16.16 fixed point (65536 = 1). The third component is vertical.
        if len(lines) > 20 and lines[20].lstrip("-").isdigit():
            info["sky_scroll"] = lines[19]
            info["sky_speed"] = lines[20]
        levels.append(info)
    return levels


def parse_nav_start(path: Path) -> dict | None:
    """First waypoint of a .nav is the player spawn.

    After the point count: type, x,y,z, description, pitch,roll,yaw.
    One tile is 2^20. x and z wrap onto the 256 map. y is stored in the
    same pre-relief units as object altitudes (game Y / (tile/2)).
    Angles are 2^16 per turn, clockwise. File yaw 0 faces increasing Z.
    The camera is stored a half-turn on from that, because rotation 0
    looks down decreasing Z.
    """
    if not path.exists() or path.suffix.lower() != ".nav":
        return None
    lines = [ln.strip() for ln in path.read_text("latin1", errors="replace").splitlines()]
    lines = [ln for ln in lines if ln and not ln.startswith(";")]
    if len(lines) < 5:
        return None
    try:
        pos = [int(part) for part in lines[2].split(",")[:3]]
        ori = [int(part) for part in lines[4].split(",")[:3]]
    except ValueError:
        return None
    if len(pos) < 3 or len(ori) < 3:
        return None
    tile = 1048576.0
    turn = math.tau / 65536.0

    def wrap(value: float) -> float:
        wrapped = (value / tile) % 256.0
        return wrapped + 256.0 if wrapped < 0 else wrapped

    return {
        "x": round(wrap(pos[0]), 4),
        "y": round(pos[1] / (tile / 2.0), 4),
        "z": round(wrap(pos[2]), 4),
        "pitch": round(ori[0] * turn, 5),
        "roll": round(ori[1] * turn, 5),
        "yaw": round((ori[2] * turn + math.pi + math.pi) % math.tau - math.pi, 5),
    }


def parse_tdf(path: Path) -> list[dict]:
    """Where a tunnel meets the heightmap.

    Each record is the tunnel level, the entrance and exit coordinates,
    and the ground texture painted on those tiles (the hole in the ice,
    canyon, and so on). Coordinates match object placements.
    """
    if not path.exists():
        return []
    lines = []
    for line in path.read_text("latin1", errors="replace").splitlines():
        line = line.strip().strip("\x1a")
        if not line or line.startswith(";") or line.startswith("!"):
            continue
        lines.append(line)
    if not lines or not lines[0].isdigit():
        return []
    count = int(lines[0])
    index = 1
    tile = 1048576.0
    tunnels = []

    def wrap(value: float) -> float:
        wrapped = (value / tile) % 256.0
        return wrapped + 256.0 if wrapped < 0 else wrapped

    def spot(text: str) -> dict | None:
        try:
            x, y, z = [int(part) for part in text.split(",")[:3]]
        except ValueError:
            return None
        return {
            "x": round(wrap(x), 4),
            "y": round(y / (tile / 2.0), 4),
            "z": round(wrap(z), 4),
        }

    for _ in range(count):
        if index + 9 >= len(lines):
            break
        level = Path(lines[index]).stem.lower()
        entrance = spot(lines[index + 1])
        exit_ = spot(lines[index + 2])
        mouth = Path(lines[index + 5]).stem.lower()
        exit_mouth = Path(lines[index + 8]).stem.lower()
        index += 10
        if not entrance or not exit_:
            continue
        tunnels.append({
            "level": level,
            "entrance": entrance,
            "exit": exit_,
            "mouth": f"textures/{mouth}.png",
            "exitMouth": f"textures/{exit_mouth}.png",
        })
    return tunnels


def parse_tnl(path: Path) -> dict:
    """Tunnel centerline, wall faces, and per-segment object slots.

    Each segment is one tile long: x0,y0,x1,y1,w0,h0,w1,h1. The centerline
    uses 4096 file units per terrain tile. The cross-section numbers are the
    radius in those same units. After the sizes, a segment lists an object
    slot (an index into the surface level's models, or 0) and one texture
    index per wall. Those indices point at the tunnel level's own texture list.
    """
    empty = {"segments": [], "faces": [], "fittings": []}
    if not path.exists():
        return empty
    lines = []
    for line in path.read_text("latin1", errors="replace").splitlines():
        line = line.strip().strip("\x1a")
        if not line or line.startswith(";") or line.startswith("!"):
            continue
        lines.append(line)
    if not lines or not lines[0].isdigit():
        return empty
    count = int(lines[0])
    headers = [
        i for i, line in enumerate(lines)
        if line.count(",") == 4 and all(part.lstrip("-").isdigit() for part in line.split(","))
    ]
    segments = []
    faces = []
    fittings = []
    chosen = headers[:count]
    for nth, index in enumerate(chosen):
        stop = chosen[nth + 1] if nth + 1 < len(chosen) else len(lines)
        block = lines[index:stop]
        try:
            head = [int(part) for part in block[0].split(",")]
            start = [int(part) for part in block[2].split(",")]
            end = [int(part) for part in block[4].split(",")]
        except (ValueError, IndexError):
            break
        if len(head) < 4 or len(start) < 2 or len(end) < 2:
            break
        segments.append([
            head[0], head[1], head[2], head[3],
            start[0], start[1], end[0], end[1],
        ])
        tail = []
        for line in block[5:]:
            if line.lstrip("-").isdigit():
                tail.append(int(line))
        fitting = tail[3] if len(tail) > 3 and tail[3] > 0 else 0
        face = []
        for value in tail[4:]:
            if value < 0 or value > 64:
                break
            face.append(value)
        fittings.append(fitting)
        faces.append(face)
    return {"segments": segments, "faces": faces, "fittings": fittings}


def nav_label(descr: str, kind: int) -> str:
    # Type 1 is a tunnel entrance and type 4 is the matching exit.
    # The status bar calls both TUN. Type 3 is the departure unit.
    if kind in {1, 4}:
        return "TUN"
    if kind == 3:
        return "DUN"
    text = descr.strip()
    low = text.lower()
    if not text or low in {"put descr here", "nav description"}:
        return "TGT"
    if low.endswith(".lvl"):
        return Path(text).stem.upper()
    return text.upper()


def parse_nav(path: Path) -> list[dict]:
    """Waypoints from a .nav file, in file order.

    The first point is the player spawn. The route continues in file order.
    A run of integers between points is a strike list (how many things to
    destroy, and which ones) plus the next point's type. Those integers are
    not the next waypoint. Tunnel entrances are type 1 and exits are type 4.
    Type 3 is the departure unit, the exit port, labeled DUN.
    Coordinates are stored like object placements: x/z wrapped onto the 256
    map, y in pre-relief units.
    """
    if not path.exists() or path.suffix.lower() != ".nav":
        return []
    raw = []
    for line in path.read_text("latin1", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith(";") or line.startswith("!"):
            continue
        raw.append(line)
    if not raw or not raw[0].isdigit() or int(raw[0]) == 0:
        return []
    count = int(raw[0])
    index = 1
    if index >= len(raw) or not raw[index].lstrip("-").isdigit():
        return []
    pending: int | None = int(raw[index])
    index += 1
    tile = 1048576.0
    points: list[dict] = []

    def wrap(value: float) -> float:
        wrapped = (value / tile) % 256.0
        return wrapped + 256.0 if wrapped < 0 else wrapped

    while len(points) < count and index < len(raw):
        kind = pending if pending is not None else 0
        while index < len(raw) and "," not in raw[index]:
            index += 1
        if index >= len(raw):
            break
        try:
            pos = [int(part) for part in raw[index].split(",")[:3]]
        except ValueError:
            break
        index += 1
        descr = raw[index] if index < len(raw) else ""
        index += 1
        if (
            index < len(raw)
            and raw[index].count(",") >= 2
            and all(part.lstrip("-").isdigit() for part in raw[index].split(",")[:3])
        ):
            ori = [int(part) for part in raw[index].split(",")[:3]]
            if ori and max(abs(part) for part in ori) <= 131072:
                index += 1
        ints: list[int] = []
        while index < len(raw) and "," not in raw[index] and raw[index].lstrip("-").isdigit():
            ints.append(int(raw[index]))
            index += 1
        links: list[int] = []
        pending = None
        if len(points) + 1 < count and ints:
            pending = ints[-1]
            rest = ints[:-1]
            if rest and rest[0] == len(rest) - 1:
                links = rest[1:]
            else:
                links = rest
        elif ints:
            links = ints
        while index < len(raw) and "," not in raw[index]:
            if pending is None and raw[index].lstrip("-").isdigit() and len(points) + 1 < count:
                pending = int(raw[index])
            index += 1
        if len(pos) < 3:
            continue
        points.append({
            "x": round(wrap(pos[0]), 4),
            "y": round(pos[1] / (tile / 2.0), 4),
            "z": round(wrap(pos[2]), 4),
            "type": kind,
            "label": nav_label(descr, kind),
            "links": links,
        })
    return points


def resolve_model(def_path: Path, model: str) -> str:
    """Animation-control bins name the frames. Use the first frame's mesh."""
    if not model:
        return ""
    bin_path = def_path.parent.parent / "models" / f"{model}.bin"
    if not bin_path.exists():
        return model
    data = bin_path.read_bytes()
    if len(data) < 40 or struct.unpack_from("<I", data, 0)[0] != 0x20:
        return model
    frames = struct.unpack_from("<I", data, 8)[0]
    if frames < 1:
        return model
    name = data[24:40].split(b"\x00", 1)[0].decode("latin1", errors="replace")
    return Path(name).stem.lower() or model


def read_def(path: Path) -> tuple[list[tuple[str, int]], list[list[int]]]:
    """Model table and raw placement rows from a level .def."""
    if not path.exists():
        return [], []
    lines = [ln.strip() for ln in path.read_text("latin1", errors="replace").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [ln for ln in lines if ln]
    if not lines or not lines[0].isdigit():
        return [], []
    count = int(lines[0])
    index = 1
    models: list[tuple[str, int]] = []
    for _ in range(count):
        if index >= len(lines):
            break
        header = lines[index]
        index += 1
        logic = 0
        parts = [part.strip() for part in header.split(",")]
        if parts and parts[0].lstrip("-").isdigit():
            logic = int(parts[0])
        model = ""
        for part in parts:
            if part.lower().endswith(".bin"):
                model = Path(part).stem.lower()
                break
        models.append((resolve_model(path, model), logic))
        # thrust, flags, firing vertices
        index += 3
        if index < len(lines) and lines[index].lower().startswith(";newhit"):
            index += 2
        if index < len(lines) and lines[index].lower().startswith("!newatakret"):
            index += 2
        index += 1  # description
        if index < len(lines) and lines[index].lower().startswith("#new2ndweapon"):
            index += 2
        if index < len(lines) and lines[index].lower().startswith("%sfx"):
            index += 3
        if index < len(lines) and lines[index].lower().startswith(": path"):
            index += 2
        if index < len(lines) and lines[index].lower().startswith("= cannon"):
            index += 4
        if index < len(lines) and lines[index].lower().startswith("@ friendly"):
            index += 2
        if index < len(lines) and lines[index].startswith("{"):
            index += 3
    if index >= len(lines) or not lines[index].isdigit():
        return models, []
    placed = int(lines[index])
    index += 1
    rows = []
    for _ in range(placed):
        if index >= len(lines):
            break
        nums = lines[index].split(",")
        index += 1
        if len(nums) < 8:
            continue
        try:
            rows.append([int(part) for part in nums[:8]])
        except ValueError:
            continue
    return models, rows


def parse_def_placements(path: Path) -> list[dict]:
    """Object instances from a level .def.

    A placement is def-index, strength, x, y, z, pitch, roll, yaw.
    World axes match the heightmap: +x is a column, +z is a row.
    One tile is 2^20 game units. The height byte lines up with object
    altitudes at byte/32, and the viewer mesh uses byte/16, so altitudes
    are doubled into viewer units. Strength 0 is an empty slot.
    Angles are 2^16 per turn, clockwise; yaw is negated for Three.js.
    """
    models, rows = read_def(path)
    if not rows:
        return []
    tile = 1048576.0
    turn = math.tau / 65536.0
    spots = []
    for values in rows:
        def_index, strength, x, y, z, pitch, roll, yaw = values
        if strength == 0 or not (0 <= def_index < len(models)):
            continue
        model, logic = models[def_index]
        if not model:
            continue

        def wrap(value: int) -> float:
            wrapped = (value / tile) % 256.0
            return wrapped + 256.0 if wrapped < 0 else wrapped

        # Ground vehicles and buildings sit on the terrain. Aircraft keep
        # the altitude written in the file.
        ground = {0, 1, 3, 9, 10, 14, 15, 19, 20, 21, 24, 33, 41}
        spots.append({
            "model": model,
            "seat": "ground" if logic in ground else "air",
            "x": round(wrap(x), 3),
            "y": round(y / (tile / 2.0), 3),
            "z": round(wrap(z), 3),
            "yaw": round(-yaw * turn, 5),
            "pitch": round(pitch * turn, 5),
            "roll": round(roll * turn, 5),
        })
    return spots


def parse_tunnel_contents(path: Path) -> list[dict]:
    """Props inside a tunnel. X/Y are the cross-section and Z runs down the shaft.

    Same 2^20 game units as the surface, but these are tunnel-local: one tile
    along the shaft, not a wrapped map coordinate. The cross-section matches
    the centerline (game units / 2^20 = file units / 4096).
    """
    models, rows = read_def(path)
    tile = 1048576.0
    turn = math.tau / 65536.0
    spots = []
    for values in rows:
        def_index, strength, x, y, z, pitch, roll, yaw = values
        if strength == 0 or not (0 <= def_index < len(models)):
            continue
        model, _logic = models[def_index]
        if not model or model == "cube":
            continue
        spots.append({
            "model": model,
            "x": round(x / tile, 4),
            "y": round(y / tile, 4),
            "z": round(z / tile, 4),
            "yaw": round(-yaw * turn, 5),
            "pitch": round(pitch * turn, 5),
            "roll": round(roll * turn, 5),
        })
    return spots


def parse_tex(path: Path) -> list[str]:
    if not path.exists():
        return []
    lines = [ln for ln in read_text(path) if ln and not ln.startswith(";")]
    if lines and lines[0].isdigit():
        lines = lines[1:]
    return [ln for ln in lines if "." in ln]


def parse_bin(data: bytes, name: str) -> dict:
    if len(data) < 24:
        raise ValueError("too small")
    ident = struct.unpack_from("<I", data, 0)[0]
    if ident == 0x20:
        frames = struct.unpack_from("<I", data, 8)[0]
        delay = struct.unpack_from("<I", data, 12)[0]
        names = []
        off = 24
        for _ in range(frames):
            names.append(cstr(data[off : off + 16]))
            off += 16
        return {
            "name": name,
            "kind": "anim",
            "frames": [n for n in names if n],
            "delay": delay,
            "faces": [],
            "vertices": [],
            "textures": [],
            "anims": [],
        }
    if ident != 0x14:
        raise ValueError(f"unknown id {ident:#x}")

    scale, _u1, index_bias, nverts = struct.unpack_from("<iiii", data, 4)
    if nverts < 0 or 20 + nverts * 12 > len(data):
        raise ValueError(f"bad vertex count {nverts}")
    vertices = [struct.unpack_from("<iii", data, 20 + i * 12) for i in range(nverts)]
    off = 20 + nverts * 12
    texture = None
    anim = None
    sprite_uvs: list[tuple[int, int]] | None = None
    flat_color = None
    vertex_colors: list[int] | None = None
    skip_ends = 0
    faces = []
    anims = []
    textures: list[str] = []

    def remember(tex: str | None) -> None:
        if tex and tex.lower().endswith(".raw") and tex not in textures:
            textures.append(tex)

    while off + 4 <= len(data):
        block = struct.unpack_from("<I", data, off)[0]
        off += 4
        if block == 0:
            if skip_ends > 0:
                skip_ends -= 1
                continue
            break
        if block == 0x0D:
            off += 4
            texture = cstr(data[off : off + 16]) or None
            off += 16
            anim = None
            remember(texture)
            continue
        if block == 0x1D:
            header = struct.unpack_from("<6I", data, off)
            off += 24
            count = header[1]
            frames = []
            for _ in range(count):
                frame = cstr(data[off : off + 16])
                sfx = cstr(data[off + 16 : off + 32])
                off += 32
                if frame:
                    frames.append({"texture": frame, "sfx": sfx})
                    remember(frame)
            anim = {"frames": frames, "delay": header[3]}
            anims.append(anim)
            texture = frames[0]["texture"] if frames else texture
            continue
        if block in FACE_UV or block in FACE_PLAIN:
            nface, nx, ny, nz, _magic = struct.unpack_from("<iiiii", data, off)
            off += 20
            if nface < 1 or nface > 8:
                raise ValueError(f"{name}: bad face size {nface} in block {block:#x}")
            corners = []
            for i in range(nface):
                if block in FACE_UV:
                    vi, u, v = struct.unpack_from("<iii", data, off)
                    off += 12
                    sprite = False
                else:
                    vi = struct.unpack_from("<i", data, off)[0]
                    off += 4
                    if block == 0x0F and sprite_uvs and i < len(sprite_uvs):
                        u, v = sprite_uvs[i]
                        sprite = True
                    else:
                        u = v = 0
                        sprite = False
                if vi < 0 or vi >= nverts:
                    vi -= index_bias
                corners.append((vi, u, v, sprite))
            color = None
            if block == 0x06 and vertex_colors:
                used = [vertex_colors[c[0]] for c in corners if 0 <= c[0] < len(vertex_colors)]
                color = used[0] if used else None
            elif block in (0x19, 0x05) and flat_color is not None:
                color = flat_color
            faces.append({
                "type": block,
                "normal": (nx, ny, nz),
                "corners": corners,
                "texture": texture if block not in (0x06, 0x19, 0x05) else None,
                "alpha": block in ALPHA_FACES,
                "color": color,
                "anim": anim if block not in (0x06, 0x19, 0x05) else None,
            })
            continue
        if block == 0x0A:
            flat_color = struct.unpack_from("<I", data, off)[0]
            off += 4
            continue
        if block == 0x04:
            _zero, count = struct.unpack_from("<II", data, off)
            off += 8
            sprite_uvs = []
            for _ in range(count):
                sprite_uvs.append(struct.unpack_from("<ii", data, off))
                off += 8
            continue
        if block == 0x1F:
            _zero, count = struct.unpack_from("<II", data, off)
            off += 8
            vertex_colors = list(struct.unpack_from("<" + "I" * count, data, off))
            off += count * 4
            continue
        if block == 0x03:
            _zero, count = struct.unpack_from("<II", data, off)
            off += 8 + count * 12
            continue
        if block == 0x17:
            off += 8
            continue
        if block == 0x16:
            off += 16
            continue
        if block == 0x0C:
            off += 24
            skip_ends += 1
            continue
        if block == 0x12:
            off += 4
            continue
        if block == 0x02:
            off += 136
            continue
        raise ValueError(f"{name}: unknown block {block:#x} at {off - 4:#x}")

    return {
        "name": name,
        "kind": "model",
        "scale": scale or 1,
        "index_bias": index_bias,
        "vertices": vertices,
        "faces": faces,
        "textures": textures,
        "anims": anims,
    }


def norm_uv(u: int, v: int, sprite: bool = False) -> tuple[float, float]:
    # 16.16 fixed point in a 0..255 texture space. 0 is the top-left,
    # 0xFF0000 is the far edge. Faces and billboard sprites use the same scale.
    del sprite
    return (u / 65536.0) / 255.0, (v / 65536.0) / 255.0


def orient(corners, positions, normal):
    if len(corners) < 3 or normal == (0, 0, 0):
        return corners
    i0, i1, i2 = corners[0][0], corners[1][0], corners[2][0]
    if min(i0, i1, i2) < 0 or max(i0, i1, i2) >= len(positions):
        return corners
    ax = positions[i1][0] - positions[i0][0]
    ay = positions[i1][1] - positions[i0][1]
    az = positions[i1][2] - positions[i0][2]
    bx = positions[i2][0] - positions[i0][0]
    by = positions[i2][1] - positions[i0][1]
    bz = positions[i2][2] - positions[i0][2]
    cx = ay * bz - az * by
    cy = az * bx - ax * bz
    cz = ax * by - ay * bx
    if cx * normal[0] + cy * normal[1] + cz * normal[2] < 0:
        return list(reversed(corners))
    return corners


def average_color(indices: bytes, palette) -> tuple[int, int, int]:
    if not indices:
        return (0, 0, 0)
    r = g = b = 0
    for idx in indices:
        pr, pg, pb = palette[idx]
        r += pr
        g += pg
        b += pb
    n = len(indices)
    return r // n, g // n, b // n


def sequence_groups(raw_files: dict[str, Path]) -> dict[str, list[str]]:
    groups: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for name in raw_files:
        match = re.match(r"^(.*\D)(\d+)$", Path(name).stem, re.I)
        if not match:
            continue
        groups[match.group(1).lower()].append((int(match.group(2)), name))
    out = {}
    for prefix, items in groups.items():
        items.sort()
        if len(items) < 3:
            continue
        steps = {b[0] - a[0] for a, b in zip(items, items[1:])}
        if len(steps) != 1:
            continue
        size = raw_files[items[0][1]].stat().st_size
        if size != 4096 or any(raw_files[n].stat().st_size != size for _, n in items):
            continue
        out[prefix] = [n for _, n in items]
    return out


def sheet(frames: list[tuple[int, int, bytes]], columns: int = 8) -> tuple[int, int, bytes]:
    if not frames:
        raise ValueError("empty sheet")
    fw, fh = frames[0][0], frames[0][1]
    columns = min(columns, len(frames))
    rows = (len(frames) + columns - 1) // columns
    width, height = fw * columns, fh * rows
    image = bytearray(width * height * 4)
    for i, (_w, _h, rgba) in enumerate(frames):
        ox = (i % columns) * fw
        oy = (i // columns) * fh
        for y in range(fh):
            src = y * fw * 4
            dst = ((oy + y) * width + ox) * 4
            image[dst : dst + fw * 4] = rgba[src : src + fw * 4]
    return width, height, bytes(image)


def export_obj(model: dict, dest: Path, palette, written_textures: set[str], art: dict[str, Path]) -> dict:
    scale = model["scale"] or 1
    positions = [(x / scale, y / scale, z / scale) for x, y, z in model["vertices"]]
    obj_lines = [
        f"# Terminal Velocity model {model['name']}.bin",
        f"# vertex units = file integers / {scale}",
        f"mtllib {model['name']}.mtl",
    ]
    for x, y, z in positions:
        obj_lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")

    uv_index: dict[tuple[float, float], int] = {}
    uv_lines = []

    def uv_id(u: float, v: float) -> int:
        # Game v grows downward; OBJ v grows upward.
        key = (round(u, 6), round(1.0 - v, 6))
        if key not in uv_index:
            uv_index[key] = len(uv_lines) + 1
            uv_lines.append(f"vt {key[0]:.6f} {key[1]:.6f}")
        return uv_index[key]

    materials: dict[str, dict] = {}
    bad = 0
    face_lines = []
    current_mtl = None

    def material_for(face) -> str:
        if face["texture"]:
            stem = sanitize(face["texture"])
            name = stem + ("_alpha" if face["alpha"] else "")
            materials[name] = {"texture": face["texture"], "alpha": face["alpha"], "kd": (1, 1, 1)}
            return name
        color = face["color"]
        if isinstance(color, int) and palette is not None:
            rgb = palette[color & 255]
            name = f"pal_{color & 255:03d}"
        else:
            rgb = (180, 180, 180)
            name = "flat"
        materials[name] = {"texture": None, "alpha": False, "kd": tuple(c / 255 for c in rgb)}
        return name

    for face in model["faces"]:
        corners = orient(face["corners"], positions, face["normal"])
        if any(i < 0 or i >= len(positions) for i, *_ in corners):
            bad += 1
            continue
        mtl = material_for(face)
        if mtl != current_mtl:
            face_lines.append(f"usemtl {mtl}")
            current_mtl = mtl
        bits = []
        for i, u, v, sprite in corners:
            bits.append(f"{i + 1}/{uv_id(*norm_uv(u, v, sprite))}")
        face_lines.append("f " + " ".join(bits))

    obj_lines.extend(uv_lines)
    obj_lines.extend(face_lines)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{model['name']}.obj").write_text("\n".join(obj_lines) + "\n")

    mtl = []
    tex_dir = dest / "textures"
    for name, spec in materials.items():
        mtl.append(f"newmtl {name}")
        kd = spec["kd"]
        mtl.append(f"Kd {kd[0]:.4f} {kd[1]:.4f} {kd[2]:.4f}")
        mtl.append("Ka 0 0 0")
        mtl.append("Ks 0 0 0")
        if spec["texture"]:
            png = sanitize(spec["texture"]) + ".png"
            mtl.append(f"map_Kd textures/{png}")
            if png not in written_textures:
                raw = art.get(spec["texture"].lower())
                if raw and palette is not None:
                    size = image_size(raw.stat().st_size)
                    if size:
                        w, h = size
                        rgba = index_image(raw.read_bytes()[: w * h], palette, alpha0=True)
                        write_png(tex_dir / png, w, h, rgba)
                        written_textures.add(png)
        mtl.append("")
    (dest / f"{model['name']}.mtl").write_text("\n".join(mtl))
    return {
        "file": f"models/{model['name']}.obj",
        "vertices": len(positions),
        "faces": len(model["faces"]) - bad,
        "dropped": bad,
        "textures": model["textures"],
        "anims": model["anims"],
    }


def remap_image(table: bytes, palette, rows: int = 16) -> bytes:
    width = 256
    out = bytearray(width * rows * 4)
    for y in range(rows):
        for x in range(width):
            src = table[y * width + x] if y * width + x < len(table) else x
            r, g, b = palette[src & 255]
            i = (y * width + x) * 4
            out[i : i + 4] = bytes((r, g, b, 255))
    return bytes(out)


def build_gallery(out: Path, catalog: dict) -> None:
    def img(src: str, alt: str, cls: str = "") -> str:
        return f'<img loading="lazy" class="{cls}" src="{html.escape(src)}" alt="{html.escape(alt)}">'

    screens = "\n".join(
        f'<figure>{img(s["file"], s["name"])}<figcaption>{html.escape(s["name"])} {s["width"]}×{s["height"]}</figcaption></figure>'
        for s in catalog["screens"]
    )
    sheets = "\n".join(
        f'<figure>{img(s["file"], s["name"], "sheet")}<figcaption>{html.escape(s["name"])} · {s["frames"]} frames</figcaption></figure>'
        for s in catalog["sheets"]
    )
    terrains = "\n".join(
        f'''<figure class="wide">
            <div class="pair">{img(t["height"], t["name"] + " height")}<span>height</span></div>
            <div class="pair">{img(t["color"], t["name"] + " color")}<span>textured</span></div>
            <figcaption>{html.escape(t["name"])} · {t["textures"]} textures</figcaption>
        </figure>'''
        for t in catalog["terrain"]
        if t.get("height")
    )
    atlases = "\n".join(
        f'<figure>{img(t["atlas"], t["name"] + " atlas", "sheet")}<figcaption>{html.escape(t["name"])} atlas</figcaption></figure>'
        for t in catalog["terrain"]
        if t.get("atlas")
    )
    sprites = "\n".join(
        f'<figure class="sprite"><img alt="{html.escape(s["name"])}" data-src="{html.escape(s["file"])}" decoding="async" width="64" height="64"><figcaption>{html.escape(s["name"])}</figcaption></figure>'
        for s in catalog["sprites"]
    )
    fog = "\n".join(
        f'<figure>{img(e["file"], e["name"], "remap")}<figcaption>{html.escape(e["name"])}</figcaption></figure>'
        for e in catalog["effects"]
    )

    def sound_block(items):
        blocks = []
        for s in items:
            src = html.escape(s["file"])
            label = html.escape(s["name"])
            meta = f'{s.get("rate", "")} Hz' if "rate" in s else s.get("format", "")
            blocks.append(
                f'<div class="sound"><div>{label}<small>{html.escape(str(meta))}</small></div>'
                f'<audio controls preload="none" src="{src}"></audio></div>'
            )
        return "\n".join(blocks)

    models = "\n".join(
        f'<li><code>{html.escape(m["file"])}</code> · {m["vertices"]} verts, {m["faces"]} faces'
        + (f' · textures {html.escape(", ".join(m["textures"][:4]))}' if m["textures"] else "")
        + (" · morph" if m.get("kind") == "anim" else "")
        + "</li>"
        for m in catalog["models"]
    )
    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Terminal Velocity assets</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; font: 14px/1.4 ui-monospace, monospace; background: #12110f; color: #e6e0d4; }}
  header, section {{ padding: 20px 24px; }}
  header {{ background: #1c1915; border-bottom: 1px solid #3a3328; }}
  h1 {{ font-size: 22px; margin: 0 0 8px; }}
  h2 {{ margin: 0 0 12px; font-size: 16px; color: #e3b15a; }}
  p {{ max-width: 78ch; color: #c8bfb0; }}
  a {{ color: #f0d7a2; }}
  .grid {{ display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }}
  figure {{ margin: 0; background: #1c1915; border: 1px solid #3a3328; padding: 8px; }}
  figcaption {{ margin-top: 6px; font-size: 11px; color: #b5aa98; }}
  img {{ display: block; image-rendering: pixelated; background: #2a241c; max-width: 100%; height: auto; }}
  .sprite {{ content-visibility: auto; contain-intrinsic-size: 112px 128px; }}
  .sprite img {{
    width: 96px; height: 96px;
    background: repeating-conic-gradient(#241f1a 0% 25%, #3a3228 0% 50%) 50% / 12px 12px;
  }}
  .sheet img {{ max-width: min(920px, 92vw); }}
  .remap img {{ width: 512px; height: 64px; }}
  .pair {{ display: inline-block; margin-right: 8px; }}
  .pair span {{ display: block; font-size: 11px; color: #b5aa98; }}
  .pair img {{ width: 256px; height: 256px; }}
  .sounds {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }}
  .sound {{ background: #1c1915; border: 1px solid #3a3328; padding: 8px; }}
  .sound small {{ display: block; color: #b5aa98; }}
  audio {{ width: 100%; margin-top: 6px; }}
  ul {{ columns: 2; padding-left: 18px; }}
  li {{ break-inside: avoid; margin: 0 0 4px; }}
  code {{ color: #f0d7a2; }}
</style>
</head>
<body>
<header>
  <h1>Terminal Velocity assets</h1>
  <p><a href="viewer.html">Open the 3D viewer</a> for models and a textured flyover of each map.</p>
  <p>{catalog["counts"]["screens"]} screens, {catalog["counts"]["textures"]} textures,
  {catalog["counts"]["sprites"]} sprites, {catalog["counts"]["sheets"]} effect sheets,
  {catalog["counts"]["models"]} models, {catalog["counts"]["sounds"]} sounds,
  {catalog["counts"]["music"]} music modules. Palette index 0 is transparent on sprites.
  Models are Wavefront OBJ, one unit = one game unit divided by the model's scale.</p>
</header>
<section><h2>Screens</h2><div class="grid">{screens}</div></section>
<section><h2>Effects and animations</h2><div class="grid">{sheets}</div></section>
<section><h2>Terrain</h2><div class="grid">{terrains}</div></section>
<section><h2>Texture atlases</h2><p>Tile order matches the level <code>.tex</code> list, which is what <code>.clr</code> indexes.</p><div class="grid">{atlases}</div></section>
<section><h2>Fog and light tables</h2><p>Each row is a palette remap. The top row is the near color; lower rows are farther or darker.</p><div class="grid">{fog}</div></section>
<section><h2>Sprites and object textures</h2>
<p>Sprites load as they scroll into view. The checkerboard is the transparent colour (palette index 0).</p>
<div class="grid" id="sprites">{sprites}</div></section>
<section><h2>Font</h2><div class="grid"><figure>{img("font/font.png", "font", "sheet")}<figcaption>ASCII 32–126, 23px, widths in font/glyphs.json</figcaption></figure></div></section>
<section><h2>Sound effects</h2><div class="sounds">{sound_block(catalog["sounds"])}</div></section>
<section><h2>Music</h2><p>6-channel ProTracker modules. Browsers cannot play these directly; open them in OpenMPT, MilkyTracker, or anything else that understands the 6CHN signature.</p><ul>
{"".join(f"<li><code>{html.escape(m['file'])}</code> · {html.escape(m['title'])} · {m['channels']} ch</li>" for m in catalog["music"])}
</ul></section>
<section><h2>Models</h2><p>Inspect these in the <a href="viewer.html">3D viewer</a>.</p><ul>{models}</ul></section>
<script>
const spriteObserver = new IntersectionObserver((entries) => {{
  for (const entry of entries) {{
    if (!entry.isIntersecting) continue;
    const img = entry.target.querySelector("img[data-src]");
    if (img) {{
      img.src = img.dataset.src;
      img.removeAttribute("data-src");
    }}
    spriteObserver.unobserve(entry.target);
  }}
}}, {{ rootMargin: "800px 0px" }});
document.querySelectorAll("#sprites figure").forEach((fig) => spriteObserver.observe(fig));
</script>
</body>
</html>
"""
    (out / "index.html").write_text(page)


def write_view_manifest(out: Path, catalog: dict) -> None:
    levels = []
    for entry in catalog["terrain"]:
        if not entry.get("height") or not entry.get("index"):
            continue
        levels.append({
            "name": entry["name"],
            "height": entry["height"],
            "index": entry["index"],
            "textures": entry.get("textureFiles") or [],
            "sky": entry.get("sky"),
            "skyScroll": entry.get("skyScroll"),
            "start": entry.get("start"),
            "nav": entry.get("nav") or [],
            "objects": entry.get("objects") or [],
            "tunnels": entry.get("tunnels") or [],
        })
    models = []
    for entry in catalog["models"]:
        if entry.get("kind") == "anim" or not str(entry.get("file", "")).endswith(".obj"):
            continue
        obj = entry["file"]
        models.append({
            "name": Path(obj).stem,
            "obj": obj,
            "mtl": str(Path(obj).with_suffix(".mtl")),
            "textures": entry.get("textures") or [],
        })
    (out / "view.json").write_text(json.dumps({"levels": levels, "models": models}))


def install_viewer(out: Path) -> None:
    src = Path(__file__).resolve().parent / "viewer"
    for name in ("viewer.html", "viewer.js"):
        shutil.copy(src / name, out / name)


def extract(root: Path, out: Path) -> dict:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    art_dir = root / "art"
    palettes = {}
    for path in art_dir.glob("*.act"):
        pal = load_palette(path)
        if pal:
            palettes[path.stem.lower()] = pal
    if "vga" not in palettes:
        raise SystemExit(f"no vga.act under {art_dir}")

    raw_files = {p.name.lower(): p for p in art_dir.glob("*.raw")}
    levels = parse_levels(root)
    level_by_name = {lv["name"]: lv for lv in levels}

    tex_lists = {}
    for lv in levels:
        tex_path = root / "data" / lv["textures"]
        tex_lists[lv["name"]] = parse_tex(tex_path)

    votes: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    terrain_names: set[str] = set()
    for lv in levels:
        pal = lv["palette"].lower()
        if not pal.endswith(".act"):
            continue
        pal_name = Path(pal).stem.lower()
        weight = 2 if lv["is_tunnel"] else 5
        for tex in tex_lists[lv["name"]]:
            votes[tex.lower()][pal_name] += weight
            terrain_names.add(tex.lower())
        sky = lv["sky"].lower()
        sky_pal = Path(lv["sky_palette"].lower()).stem
        if sky.endswith(".raw") and sky_pal in palettes:
            votes[sky][sky_pal] += 10

    models = []
    model_errors = []
    for path in sorted((root / "models").glob("*.bin")):
        try:
            models.append(parse_bin(path.read_bytes(), path.stem.lower()))
        except Exception as exc:
            model_errors.append(f"{path.name}: {exc}")
    model_by_name = {m["name"]: m for m in models}

    for lv in levels:
        def_path = root / "data" / lv["objects"]
        if not def_path.exists():
            continue
        text = def_path.read_text("latin1", errors="replace").lower()
        pal_name = Path(lv["palette"].lower()).stem
        if pal_name not in palettes:
            continue
        weight = 2 if lv["is_tunnel"] else 4
        for match in re.findall(r"[\w.-]+\.bin", text):
            model = model_by_name.get(Path(match).stem)
            if not model:
                continue
            for tex in model.get("textures") or []:
                votes[tex.lower()][pal_name] += weight

    def choose_palette(raw_name: str):
        tally = votes.get(raw_name.lower())
        if not tally:
            return palettes["vga"], "vga"
        best = max(tally, key=lambda k: (tally[k], k in palettes))
        if best not in palettes:
            return palettes["vga"], "vga"
        return palettes[best], best

    catalog = {
        "screens": [],
        "textures": [],
        "sprites": [],
        "sheets": [],
        "terrain": [],
        "effects": [],
        "sounds": [],
        "music": [],
        "models": [],
        "errors": model_errors,
    }

    # Images
    for name, path in sorted(raw_files.items()):
        size = image_size(path.stat().st_size)
        if not size:
            catalog["errors"].append(f"unknown image size {name} ({path.stat().st_size})")
            continue
        width, height = size
        data = path.read_bytes()[: width * height]
        palette, pal_name = choose_palette(name)
        if path.stat().st_size in UI_SIZES:
            # Full-screen and HUD art uses the VGA palette, unless the picture
            # has its own ACT (the registration and logo screens do).
            stem = Path(name).stem.lower()
            if stem in palettes:
                palette, pal_name = palettes[stem], stem
            else:
                palette, pal_name = palettes["vga"], "vga"
            rgba = index_image(data, palette, alpha0=(stem == "statbar"))
            if stem == "statbar":
                rgba = fill_compass_face(rgba, width, height)
            rel = f"screens/{Path(name).stem}.png"
            write_png(out / rel, width, height, rgba)
            catalog["screens"].append({"name": Path(name).stem, "file": rel, "width": width, "height": height, "palette": pal_name})
            continue
        rel = f"textures/{Path(name).stem}.png"
        write_png(out / rel, width, height, index_image(data, palette, alpha0=False))
        catalog["textures"].append({"name": Path(name).stem, "file": rel, "width": width, "height": height, "palette": pal_name})
        if name not in terrain_names:
            srel = f"sprites/{Path(name).stem}.png"
            write_png(out / srel, width, height, index_image(data, palette, alpha0=True))
            catalog["sprites"].append({"name": Path(name).stem, "file": srel, "palette": pal_name})
            if Path(name).stem.lower() == "navtar01":
                write_png(out / "screens/navtar01.png", width, height, navtar_marker(data, palette))

    # Effect sheets: numbered 64x64 runs that are not terrain tiles, plus BIN animations.
    tex_members = terrain_names
    for prefix, names in sorted(sequence_groups(raw_files).items()):
        if all(n in tex_members for n in names):
            continue
        frames = []
        palette, _pal = choose_palette(names[0])
        for raw_name in names:
            raw = raw_files[raw_name].read_bytes()
            frames.append((64, 64, index_image(raw[:4096], palette, alpha0=True)))
        width, height, rgba = sheet(frames)
        rel = f"effects/sheets/{prefix.strip('-_')}.png"
        write_png(out / rel, width, height, rgba)
        catalog["sheets"].append({"name": prefix.strip("-_"), "file": rel, "frames": len(frames), "source": "sequence"})

    seen_anims = set()
    for model in models:
        for anim in model.get("anims") or []:
            key = tuple(f["texture"].lower() for f in anim["frames"])
            if not key or key in seen_anims:
                continue
            seen_anims.add(key)
            frames = []
            palette, _pal = choose_palette(key[0])
            ok = True
            for tex in key:
                raw_path = raw_files.get(tex)
                if not raw_path:
                    ok = False
                    break
                size = image_size(raw_path.stat().st_size)
                if not size:
                    ok = False
                    break
                w, h = size
                frames.append((w, h, index_image(raw_path.read_bytes()[: w * h], palette, alpha0=True)))
            if not ok or not frames:
                continue
            stems = [Path(tex).stem.lower() for tex in key]
            prefixes = set()
            for stem in stems:
                match = re.match(r"^(.*\D)\d+$", stem)
                if match:
                    prefixes.add(match.group(1).strip("-_"))
            # Numbered runs were already written as one sheet.
            if prefixes and prefixes <= {s["name"] for s in catalog["sheets"]}:
                continue
            width, height, rgba = sheet(frames, columns=len(frames))
            label = sanitize(Path(key[0]).stem)
            rel = f"effects/sheets/{label}.png"
            if (out / rel).exists():
                continue
            write_png(out / rel, width, height, rgba)
            catalog["sheets"].append({"name": label, "file": rel, "frames": len(frames), "source": model["name"]})

    # Terrain
    for lv in levels:
        if lv["is_tunnel"]:
            atlas_only = True
        else:
            atlas_only = False
        names = tex_lists[lv["name"]]
        pal_name = Path(lv["palette"].lower()).stem
        palette = palettes.get(pal_name, palettes["vga"])
        entry = {
            "name": lv["name"],
            "textures": len(names),
            "palette": pal_name,
            "textureFiles": [f"textures/{Path(tex).stem.lower()}.png" for tex in names],
        }
        def_path = root / "data" / lv.get("objects", "").lower()
        if def_path.suffix == ".def" and def_path.exists():
            entry["objects"] = parse_def_placements(def_path)
        sky = lv.get("sky", "").lower()
        if sky.endswith(".raw"):
            entry["sky"] = f"textures/{Path(sky).stem.lower()}.png"
        scroll = lv.get("sky_scroll")
        speed = lv.get("sky_speed")
        if scroll and speed:
            parts = [int(p) for p in scroll.split(",")[:3]]
            while len(parts) < 3:
                parts.append(0)
            entry["skyScroll"] = [parts[0], parts[1], parts[2], int(speed)]
        nav_name = lv.get("nav", "").lower()
        start = parse_nav_start(root / "data" / nav_name)
        if start:
            entry["start"] = start
        nav_points = parse_nav(root / "data" / nav_name)
        if nav_points:
            entry["nav"] = nav_points
        tdf_name = lv.get("tdf", "").lower()
        portals = parse_tdf(root / "data" / tdf_name) if tdf_name.endswith(".tdf") else []
        if portals:
            by_name = {item["name"]: item for item in levels}
            for portal in portals:
                tunnel_level = by_name.get(portal["level"])
                tex_name = ""
                if tunnel_level:
                    listed = tex_lists.get(portal["level"]) or []
                    if listed:
                        tex_name = Path(listed[0]).stem.lower()
                    else:
                        tunnel_tex = root / "data" / tunnel_level.get("textures", "").lower()
                        names_tnl = parse_tex(tunnel_tex)
                        if names_tnl:
                            tex_name = Path(names_tnl[0]).stem.lower()
                tnl_path = root / "data" / f"{portal['level']}.tnl"
                parsed = parse_tnl(tnl_path)
                wall_names = []
                if tunnel_level:
                    listed = tex_lists.get(portal["level"]) or []
                    if not listed:
                        tunnel_tex = root / "data" / tunnel_level.get("textures", "").lower()
                        listed = parse_tex(tunnel_tex)
                    wall_names = [Path(tex).stem.lower() for tex in listed]
                surface_models = [name for name, _logic in read_def(def_path)[0]] if def_path.suffix == ".def" and def_path.exists() else []
                fittings = []
                for slot in parsed["fittings"]:
                    if slot <= 0 or slot >= len(surface_models):
                        fittings.append("")
                        continue
                    model = surface_models[slot]
                    fittings.append("" if model in ("", "cube") else model)
                portal["wall"] = f"textures/{tex_name}.png" if tex_name else ""
                portal["walls"] = [f"textures/{name}.png" for name in wall_names]
                portal["segments"] = parsed["segments"]
                portal["faces"] = parsed["faces"]
                portal["fittings"] = fittings
                portal["contents"] = parse_tunnel_contents(root / "data" / f"{portal['level']}.def")
            entry["tunnels"] = portals
        if names:
            frames = []
            averages = []
            for tex in names:
                raw_path = raw_files.get(tex.lower())
                if not raw_path:
                    frames.append((64, 64, bytes([80, 0, 80, 255]) * 4096))
                    averages.append((80, 0, 80))
                    continue
                blob = raw_path.read_bytes()
                size = image_size(len(blob)) or (64, 64)
                # Atlas cells are 64px. Larger tiles are sampled down by stride.
                w, h = size
                cell = bytearray(64 * 64 * 4)
                indices = blob[: w * h]
                averages.append(average_color(indices, palette))
                for y in range(64):
                    sy = min(h - 1, int(y * h / 64))
                    for x in range(64):
                        sx = min(w - 1, int(x * w / 64))
                        idx = indices[sy * w + sx]
                        r, g, b = palette[idx]
                        cell[(y * 64 + x) * 4 : (y * 64 + x) * 4 + 4] = bytes((r, g, b, 255))
                frames.append((64, 64, bytes(cell)))
            aw, ah, rgba = sheet(frames)
            rel = f"terrain/{lv['name']}/atlas.png"
            write_png(out / rel, aw, ah, rgba)
            entry["atlas"] = rel
        else:
            averages = []

        height_name = lv["height_or_tunnel"].lower()
        color_name = lv["color_map"].lower()
        height_path = root / "data" / height_name
        color_path = root / "data" / color_name
        if not atlas_only and height_path.exists() and height_path.stat().st_size == 65536:
            height = height_path.read_bytes()
            hrel = f"terrain/{lv['name']}/height.png"
            write_png(out / hrel, 256, 256, index_image(height, [(i, i, i) for i in range(256)], False))
            entry["height"] = hrel
            if color_path.exists() and color_path.stat().st_size == 65536:
                clr = color_path.read_bytes()
                irel = f"terrain/{lv['name']}/index.png"
                write_png(out / irel, 256, 256, index_image(clr, [(i, i, i) for i in range(256)], False))
                entry["index"] = irel
                color = bytearray(256 * 256 * 4)
                for i, idx in enumerate(clr):
                    x, y = i % 256, i // 256
                    left = height[i - 1] if x else height[i]
                    up = height[i - 256] if y else height[i]
                    shade = 0.55 + 0.45 * ((height[i] - left) + (height[i] - up)) / 255
                    shade = max(0.25, min(1.4, shade))
                    base = averages[idx] if idx < len(averages) else (255, 0, 255)
                    color[i * 4 : i * 4 + 4] = bytes((
                        max(0, min(255, int(base[0] * shade))),
                        max(0, min(255, int(base[1] * shade))),
                        max(0, min(255, int(base[2] * shade))),
                        255,
                    ))
                crel = f"terrain/{lv['name']}/color.png"
                if averages:
                    write_png(out / crel, 256, 256, bytes(color))
                    entry["color"] = crel
        if len(entry) > 3:
            catalog["terrain"].append(entry)

    # Fog and lighting remaps
    for kind, folder in (("fog", "effects/fog"), ("lte", "effects/light")):
        src = root / "fog"
        for path in sorted(src.glob(f"*.{kind}")):
            table = path.read_bytes()
            lv = level_by_name.get(path.stem.lower())
            pal_name = "vga"
            if lv:
                pal_name = Path(lv["palette"].lower()).stem
            palette = palettes.get(pal_name, palettes["vga"])
            rows = max(1, len(table) // 256)
            rel = f"{folder}/{path.stem}.png"
            write_png(out / rel, 256, rows, remap_image(table, palette, rows))
            catalog["effects"].append({"name": f"{path.stem} {kind}", "file": rel, "palette": pal_name})

    # Models
    written = set()
    model_dir = out / "models"
    for model in models:
        if model["kind"] == "anim":
            catalog["models"].append({
                "file": f"models/{model['name']}.json",
                "vertices": 0,
                "faces": 0,
                "dropped": 0,
                "textures": [],
                "kind": "anim",
                "frames": model["frames"],
                "delay": model["delay"],
            })
            (model_dir / f"{model['name']}.json").parent.mkdir(parents=True, exist_ok=True)
            (model_dir / f"{model['name']}.json").write_text(json.dumps({
                "type": "morph",
                "frames": model["frames"],
                "delay": model["delay"],
                "note": "delay is 65536/frames_per_second; each frame is a sibling BIN",
            }, indent=2))
            continue
        # Prefer a planet palette that actually voted for this model's textures.
        pal = palettes["vga"]
        for tex in model["textures"]:
            chosen, _name = choose_palette(tex)
            pal = chosen
            break
        try:
            info = export_obj(model, model_dir, pal, written, raw_files)
            catalog["models"].append(info)
        except Exception as exc:
            catalog["errors"].append(f"obj {model['name']}: {exc}")

    # Font
    ndx = root / "startup" / "font.ndx"
    font_bin = root / "startup" / "font.bin"
    if ndx.exists() and font_bin.exists():
        widths = [int(x) for x in read_text(ndx) if x.lstrip("-").isdigit()]
        blob = font_bin.read_bytes()
        height = 23
        glyphs = []
        offset = 0
        for width in widths:
            glyphs.append(blob[offset : offset + width * height])
            offset += width * height
        cell_w, cell_h = 24, 28
        cols = 16
        rows = (len(glyphs) + cols - 1) // cols
        sheet_w, sheet_h = cols * cell_w, rows * cell_h
        image = bytearray(sheet_w * sheet_h * 4)
        meta = []
        for i, (width, glyph) in enumerate(zip(widths, glyphs)):
            ch = chr(32 + i) if 32 + i < 127 else "?"
            ox = (i % cols) * cell_w
            oy = (i // cols) * cell_h
            meta.append({"char": ch, "width": width, "height": height})
            for y in range(min(height, cell_h)):
                for x in range(min(width, cell_w)):
                    v = glyph[y * width + x] if y * width + x < len(glyph) else 0
                    dst = ((oy + y) * sheet_w + (ox + x)) * 4
                    image[dst : dst + 4] = bytes((v, v, v, 255))
        write_png(out / "font" / "font.png", sheet_w, sheet_h, bytes(image))
        (out / "font" / "glyphs.json").write_text(json.dumps({"height": height, "first": 32, "glyphs": meta}, indent=2))

    # Audio
    sfx_dir = out / "audio" / "sfx"
    sfx_dir.mkdir(parents=True, exist_ok=True)
    for path in sorted((root / "sound").glob("*.wav")):
        dest = sfx_dir / path.name.lower()
        shutil.copy2(path, dest)
        with wave.open(str(path)) as wav:
            rate = wav.getframerate()
            frames = wav.getnframes()
            catalog["sounds"].append({
                "name": path.stem.lower(),
                "file": f"audio/sfx/{dest.name}",
                "rate": rate,
                "channels": wav.getnchannels(),
                "bits": wav.getsampwidth() * 8,
                "seconds": round(frames / rate, 3) if rate else 0,
            })
    music_dir = out / "audio" / "music"
    music_dir.mkdir(parents=True, exist_ok=True)
    for path in sorted((root / "music").glob("*.mod")):
        dest = music_dir / path.name.lower()
        shutil.copy2(path, dest)
        blob = path.read_bytes()
        catalog["music"].append({
            "name": path.stem.lower(),
            "file": f"audio/music/{dest.name}",
            "title": blob[:20].decode("latin1").strip(),
            "channels": 6 if blob[1080:1084] == b"6CHN" else 4,
            "format": blob[1080:1084].decode("latin1", "replace"),
        })

    # Readable mission text
    text_dir = out / "text"
    text_dir.mkdir(parents=True, exist_ok=True)
    for folder, pattern in (("data", "*.txt"), ("data", "*.mic"), ("data", "*.def"), ("data", "*.nav")):
        for path in sorted((root / folder).glob(pattern)):
            if path.stat().st_size == 0:
                continue
            body = path.read_bytes().replace(b"\x1a", b"").decode("latin1").replace("\r\n", "\n")
            (text_dir / path.name.lower()).write_text(body)

    catalog["counts"] = {
        "screens": len(catalog["screens"]),
        "textures": len(catalog["textures"]),
        "sprites": len(catalog["sprites"]),
        "sheets": len(catalog["sheets"]),
        "terrain": len(catalog["terrain"]),
        "effects": len(catalog["effects"]),
        "models": len(catalog["models"]),
        "sounds": len(catalog["sounds"]),
        "music": len(catalog["music"]),
        "errors": len(catalog["errors"]),
    }
    (out / "catalog.json").write_text(json.dumps(catalog, indent=2))
    write_view_manifest(out, catalog)
    install_viewer(out)
    build_gallery(out, catalog)
    return catalog


def main() -> None:
    here = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Translate unpacked Terminal Velocity assets")
    parser.add_argument("--root", type=Path, default=here / "_orig", help="unpacked game tree")
    parser.add_argument("--out", type=Path, default=here / "extracted", help="output directory")
    args = parser.parse_args()
    catalog = extract(args.root, args.out)
    counts = catalog["counts"]
    print(
        f"wrote {args.out} · screens {counts['screens']} · textures {counts['textures']} · "
        f"sprites {counts['sprites']} · sheets {counts['sheets']} · models {counts['models']} · "
        f"sounds {counts['sounds']} · music {counts['music']} · errors {counts['errors']}"
    )
    for err in catalog["errors"][:20]:
        print(" ", err)


if __name__ == "__main__":
    main()
