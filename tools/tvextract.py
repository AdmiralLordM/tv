#!/usr/bin/env python3
"""Translate unpacked Terminal Velocity assets into PNGs, OBJs, and audio.

The POD archives are unpacked into a tree like _orig/, either by this tool
(--game points at the install folder) or by legacy/extract.js. This tool reads that
tree and writes extracted/: the data the game page (index.html at the repo
root) loads, plus an asset gallery at extracted/index.html.

    python3 tools/tvextract.py --game _oracle
    python3 tools/tvextract.py --root _orig --out extracted

Formats handled
  *.pod               archive: count, 80-byte label, 40-byte entries (name, size, offset)
  art/*.raw + *.act   8-bit images and 24-bit RGB palettes
  art UI screens      320x200, 256x108, 320x64, 320x25
  models/*.bin        Terminal Reality BIN models (and morph-animation lists)
  data/*.raw + *.clr  256x256 heightmap and texture-index map
  data/*.tex          texture list, index order matches the color map
  data/*.pup          power-up placements: count, then x,y,z,type
  fog/*.fog *.lte     16-step palette remaps (distance fog and lighting)
  fog/*.map           RGB555 to palette index lookup (inverse color map)
  fog/*.mix           256x256 50% blend table for translucent model faces; copied raw
  sound/*.wav         already PCM WAV (11 kHz, 8-bit, mono)
  music/*.mod         6-channel ProTracker modules (signature 6CHN)
  startup/font.*      proportional 23px font
  startup/tv*.bin     80x25 text-mode exit screens (char, attribute)
  demo/*.dmo          recorded flights: poses and key presses
  *.vox (install)     episode and mission order

Palettes: the planet .act files fill 0-239. Index 240-255 is the sky band;
the engine fills it from the sky palette's 192-207 (sky pixel i uses sky
color i - 48). Fog fades toward index 255, the horizon color.
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

# Face blocks, from the drawer table at 0x67774 in GAME.EXE (docs/original-engine.md 7.4).
# FACE_UV corners carry their own u,v; FACE_PLAIN corners are bare vertex indices
# (0x0F takes its UVs from the preceding 0x04 slot list).
FACE_UV = {0x0E, 0x11, 0x15, 0x18, 0x1E, 0x22}
FACE_PLAIN = {0x05, 0x06, 0x0F, 0x19}
# Color 0 is the engine's transparent index on these alpha-tested faces.
ALPHA_FACES = {0x0F, 0x11}
# Untextured faces (0x05, 0x19) pick a shade from a color ramp set by block 0x0A:
# index = lo + light * (hi - lo). A negative 0x0A value is a literal palette index.
COLOR_RAMPS = (
    (0, 31), (0, 15), (32, 63), (64, 95), (144, 151), (152, 159), (160, 167), (168, 175),
    (176, 183), (184, 191), (0, 7), (0, 24), (240, 240), (255, 255), (0, 0), (216, 216),
)
# Light level used to bake a ramp into one OBJ color.
RAMP_LIGHT = 0.7


def ramp_color(value: int) -> int:
    if value < 0:
        return (-value) & 255
    lo, hi = COLOR_RAMPS[value % len(COLOR_RAMPS)]
    return round(lo + RAMP_LIGHT * (hi - lo))


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


SKY_BAND = 240
SKY_SOURCE = 192

# GAME.EXE keeps the power-up models in a 16-byte-slot table; the .pup type is the slot.
POWERUP_MODELS = (
    "powerlas", "powerpla", "powerant", "powermis", "powergmi", "powersup",
    "powershe", "powervis", "powerinv", "powerfir", "powerzap", "powercan",
)

# Text-mode attribute colors (CGA/EGA order).
TEXT_COLORS = (
    "#000000", "#0000aa", "#00aa00", "#00aaaa", "#aa0000", "#aa00aa", "#aa5500", "#aaaaaa",
    "#555555", "#5555ff", "#55ff55", "#55ffff", "#ff5555", "#ff55ff", "#ffff55", "#ffffff",
)

Palette = list[tuple[int, int, int]]


def compose_palette(main: Palette, sky: Palette | None) -> Palette:
    """Planet colors below the sky band, the sky ramp in it."""
    if not sky or not any(any(c) for c in sky[SKY_SOURCE : SKY_SOURCE + 256 - SKY_BAND]):
        return list(main)
    return list(main[:SKY_BAND]) + [sky[i - SKY_BAND + SKY_SOURCE] for i in range(SKY_BAND, 256)]


def index_image(indices: bytes, palette: list[tuple[int, int, int]], alpha0: bool) -> bytes:
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


TILE = 1048576.0
TURN = math.tau / 65536.0


def wrap_tile(value: float) -> float:
    """World units to tiles, wrapped onto the 256-tile map."""
    return round((value / TILE) % 256.0, 4)


def game_angles(pitch: int, roll: int, yaw: int) -> dict:
    """Angles in radians, in the game's own left-handed convention:
    yaw 0 faces +Z and positive yaw turns toward +X (clockwise from above),
    positive pitch is nose down, positive roll lifts the right wing.
    The viewer converts to three.js in one place; nothing is negated here."""
    return {"pitch": round(pitch * TURN, 5), "roll": round(roll * TURN, 5), "yaw": round(yaw * TURN, 5)}


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
        # After the 17 file names (FUN_00032d20 in GAME.EXE): sun vector and ambient
        # (models and tunnel mouths), cave-mode light vector and ambient, then the
        # fog color's palette index. Vectors are 16.16. There is no sky drift.
        def ints(text: str) -> list[int] | None:
            try:
                return [int(part) for part in text.split(",")]
            except ValueError:
                return None
        extra = [ints(line) for line in lines[17:22]]
        if len(extra) == 5 and all(extra):
            info["sun"] = extra[0][:3]
            info["ambient"] = extra[1][0]
            info["cave_light"] = extra[2][:3]
            info["cave_ambient"] = extra[3][0]
            info["fog_index"] = extra[4][0] & 255
        levels.append(info)
    return levels


def parse_nav_start(path: Path) -> dict | None:
    """Player spawn (FUN_0003eac0): the first .nav record when it is type 6.

    x and z come from the file. The file y is ignored: the game spawns half a
    tile above the ground at (x, z), so the viewer computes y. Angles are used
    as stored. Without a type-6 record the game spawns at (0, 0) facing yaw 0.
    """
    if not path.exists() or path.suffix.lower() != ".nav":
        return None
    lines = [ln.strip() for ln in path.read_text("latin1", errors="replace").splitlines()]
    lines = [ln for ln in lines if ln and not ln.startswith(";")]
    if len(lines) < 5:
        return None
    try:
        kind = int(lines[1])
        pos = [int(part) for part in lines[2].split(",")[:3]]
        ori = [int(part) for part in lines[4].split(",")[:3]]
    except ValueError:
        return None
    if kind != 6 or len(pos) < 3 or len(ori) < 3:
        return {"x": 0.0, "z": 0.0, "pitch": 0.0, "roll": 0.0, "yaw": 0.0}
    return {"x": wrap_tile(pos[0]), "z": wrap_tile(pos[2]), **game_angles(*ori)}


def parse_tdf(path: Path) -> list[dict]:
    """Tunnel portals (FUN_00039d50).

    Record: tunnel .lvl, entrance x,y,z, exit x,y,z, entrance mode, two
    textures (the second is the mouth tile), exit mode, two exit textures,
    cave flag. A mouth is drawn only when its mode is not 0. The game
    recomputes the exit y from the ground. The cave flag switches the
    renderer to cave mode (floor and mirrored ceiling) after the tunnel.
    Coordinates are tiles.
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
    tunnels = []

    def spot(text: str) -> dict | None:
        try:
            x, y, z = [int(part) for part in text.split(",")[:3]]
        except ValueError:
            return None
        return {"x": wrap_tile(x), "y": round(y / TILE, 4), "z": wrap_tile(z)}

    def number(text: str) -> int:
        return int(text) if text.lstrip("-").isdigit() else 0

    for _ in range(count):
        if index + 9 >= len(lines):
            break
        rec = lines[index : index + 10]
        index += 10
        entrance = spot(rec[1])
        exit_ = spot(rec[2])
        if not entrance or not exit_:
            continue
        tunnels.append({
            "level": Path(rec[0]).stem.lower(),
            "entrance": entrance,
            "exit": exit_,
            "entranceMode": number(rec[3]),
            "mouth": f"textures/{Path(rec[5]).stem.lower()}.png",
            "exitMode": number(rec[6]),
            "exitMouth": f"textures/{Path(rec[8]).stem.lower()}.png",
            "cave": number(rec[9]) == 1,
        })
    return tunnels


def parse_tnl(path: Path) -> list[dict]:
    """Tunnel segments (FUN_00034770). Segment k runs from z = k to k + 1 tiles.

    Per segment: x0,y0,x1,y1,N / a0,a1,rot / rx0,ry0 / b0,b1 / rx1,ry1 / hp /
    light face / missing / obstacle / obstacle texture / N face textures /
    light mode, light intensity, ambient. Lengths are 1/4096 tile, angles
    65536 per turn. Ring vertex i of the start ring sits at angle
    a0 + i*(a1-a0)/(N-missing), at (x0 + rx0 cos, y0 + ry0 sin). Face
    textures index the tunnel level's own .tex list.
    """
    if not path.exists():
        return []
    toks = []
    for line in path.read_text("latin1", errors="replace").splitlines():
        line = line.strip().strip("\x1a")
        if line and not line.startswith(";"):
            toks.append(line)
    if not toks or not toks[0].isdigit():
        return []

    def ints(text: str) -> list[int]:
        return [int(part) for part in text.split(",")]

    segments = []
    i = 1
    try:
        for _ in range(int(toks[0])):
            x0, y0, x1, y1, n = ints(toks[i])
            a0, a1, rot = ints(toks[i + 1])
            rx0, ry0 = ints(toks[i + 2])
            b0, b1 = ints(toks[i + 3])
            rx1, ry1 = ints(toks[i + 4])
            hp, light, missing, obstacle, obstacle_tex = (int(t) for t in toks[i + 5 : i + 10])
            i += 10
            faces = [int(t) for t in toks[i : i + n]]
            i += n
            light_mode, light_level, ambient = (int(t) for t in toks[i : i + 3])
            i += 3
            segments.append({
                "start": [x0, y0], "end": [x1, y1], "sides": n,
                "a": [a0, a1], "spin": rot, "r0": [rx0, ry0],
                "b": [b0, b1], "r1": [rx1, ry1],
                "hp": hp, "lightFace": light, "missing": missing,
                "obstacle": obstacle, "obstacleTex": obstacle_tex,
                "faces": faces,
                "lightMode": light_mode, "lightLevel": light_level, "ambient": ambient,
            })
    except (ValueError, IndexError):
        pass
    return segments


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
    Coordinates are tiles, x/z wrapped onto the 256 map. The game raises a
    waypoint's y to the ground if the file value is below it.
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
            "y": round(pos[1] / tile, 4),
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


def read_def(path: Path) -> tuple[list[dict], list[list[int]]]:
    """Def table and raw placement rows from a level .def (FUN_000230a0).

    Def header: logic, ?, radius, dx, dy, dz, "model.bin,second.bin". The
    radius is replaced in game by the model's bounding radius; dx/dy/dz are
    world-unit offsets added to the placement.
    """
    if not path.exists():
        return [], []
    lines = [ln.strip() for ln in path.read_text("latin1", errors="replace").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [ln for ln in lines if ln]
    if not lines or not lines[0].isdigit():
        return [], []
    count = int(lines[0])
    index = 1
    models: list[dict] = []
    for _ in range(count):
        if index >= len(lines):
            break
        header = lines[index]
        index += 1
        parts = [part.strip() for part in header.split(",")]
        nums = []
        for part in parts[:6]:
            nums.append(int(part) if part.lstrip("-").isdigit() else 0)
        nums += [0] * (6 - len(nums))
        model = ""
        for part in parts:
            if part.lower().endswith(".bin"):
                model = Path(part).stem.lower()
                break
        models.append({
            "model": resolve_model(path, model),
            "logic": nums[0],
            "offset": [round(v / TILE, 5) for v in nums[3:6]],
        })
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
    """Object instances on a surface level (FUN_00022f20).

    Row: def index, strength, x, y, z, pitch, roll, yaw. The game ignores
    the file y: it seats every object at ground(x, z), adds the def's
    dx/dy/dz, and for logic 2, 4, 7 and 8 also half the model's bounding
    radius. The viewer does that sum, so this exports the parts.
    Strength 0 is an empty slot.
    """
    models, rows = read_def(path)
    spots = []
    for def_index, strength, x, y, z, pitch, roll, yaw in rows:
        if strength == 0 or not (0 <= def_index < len(models)):
            continue
        spec = models[def_index]
        if not spec["model"]:
            continue
        spots.append({
            "model": spec["model"],
            "logic": spec["logic"],
            "offset": spec["offset"],
            "x": wrap_tile(x),
            "z": wrap_tile(z),
            **game_angles(pitch, roll, yaw),
        })
    return spots


def parse_tunnel_contents(path: Path) -> list[dict]:
    """Props inside a tunnel, in tunnel space: x/y across the shaft, z down it,
    in tiles. Tunnel levels use the file x, y, z as stored."""
    models, rows = read_def(path)
    spots = []
    for def_index, strength, x, y, z, pitch, roll, yaw in rows:
        if strength == 0 or not (0 <= def_index < len(models)):
            continue
        spec = models[def_index]
        if not spec["model"] or spec["model"] == "cube":
            continue
        spots.append({
            "model": spec["model"],
            "logic": spec["logic"],
            "x": round(x / TILE, 4),
            "y": round(y / TILE, 4),
            "z": round(z / TILE, 4),
            **game_angles(pitch, roll, yaw),
        })
    return spots


def parse_tex(path: Path) -> list[str]:
    if not path.exists():
        return []
    lines = [ln for ln in read_text(path) if ln and not ln.startswith(";")]
    if lines and lines[0].isdigit():
        lines = lines[1:]
    return [ln for ln in lines if "." in ln]


def unpack_pods(game: Path, root: Path) -> list[str]:
    """Unpack every .pod in the install folder into root.

    Header: uint32 count, 80-byte label. Then count entries of a 32-byte
    name, uint32 size, uint32 offset. STARTUP.POD goes first; names that
    appear in more than one archive are identical copies. Loose files the
    menus use (episode lists, the TRI splash) land in root/loose.
    """
    root.mkdir(parents=True, exist_ok=True)
    base = root.resolve()
    pods = sorted(game.glob("*.[pP][oO][dD]"), key=lambda p: (p.name.lower() != "startup.pod", p.name.lower()))
    labels = []
    for pod in pods:
        data = pod.read_bytes()
        count = struct.unpack_from("<I", data, 0)[0]
        labels.append(f"{pod.name}: {cstr(data[4:84])} ({count} files)")
        for i in range(count):
            off = 84 + i * 40
            name = cstr(data[off : off + 32]).replace("\\", "/").lower()
            size, pos = struct.unpack_from("<II", data, off + 32)
            dest = (root / name).resolve()
            if not name or base not in dest.parents or pos + size > len(data):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data[pos : pos + size])
    loose = root / "loose"
    for path in game.iterdir():
        if path.is_file() and path.suffix.lower() in {".vox", ".wav", ".gif"}:
            loose.mkdir(exist_ok=True)
            shutil.copy2(path, loose / path.name.lower())
    return labels


def parse_pup(path: Path) -> list[dict]:
    """Power-ups: count, then x,y,z,type rows. The game reads only `count`
    rows, so the multiplayer levels' six rows behind a count of 0 are not
    placed; `listed` marks the rows the game uses."""
    if not path.exists():
        return []
    lines = [ln for ln in read_text(path) if ln and not ln.startswith(";")]
    if not lines or not lines[0].isdigit():
        return []
    count = int(lines[0])
    out = []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) != 4:
            continue
        try:
            x, y, z, kind = (int(p) for p in parts)
        except ValueError:
            continue
        out.append({
            "x": x, "y": y, "z": z, "type": kind,
            "model": POWERUP_MODELS[kind] if 0 <= kind < len(POWERUP_MODELS) else "",
            "listed": len(out) < count,
        })
    return out


def parse_demo(path: Path) -> dict | None:
    """Recorded flight. Line 1 is the record count, line 2 the level.

    A record is `kind,time` with time in 1/65536 s. Kind 0 is followed by the
    ship position (x,y,z, same units as .nav) and pitch,roll,yaw (2^16 per turn)
    plus a 0/1 flag that toggles in short bursts (meaning unconfirmed). Kind 1
    is a key press; the next line is the scancode (57 = space, fire).
    """
    lines = [ln for ln in read_text(path) if ln]
    if len(lines) < 2 or not lines[0].isdigit():
        return None
    count = int(lines[0])
    level = Path(lines[1]).stem.lower()
    tile = 1048576.0
    turn = math.tau / 65536.0
    poses = []
    keys = []
    i = 2
    while i < len(lines) and len(poses) + len(keys) < count:
        head = lines[i].split(",")
        i += 1
        if len(head) != 2:
            continue
        kind, time = int(head[0]), int(head[1])
        if kind == 1 and i < len(lines):
            keys.append({"t": round(time / 65536.0, 4), "key": int(lines[i])})
            i += 1
            continue
        if kind != 0 or i + 1 >= len(lines):
            continue
        pos = [int(p) for p in lines[i].split(",")[:3]]
        ori = [int(p) for p in lines[i + 1].split(",")[:4]]
        i += 2
        poses.append({
            "t": round(time / 65536.0, 4),
            "x": round((pos[0] / tile) % 256.0, 4),
            "y": round(pos[1] / (tile / 2.0), 4),
            "z": round((pos[2] / tile) % 256.0, 4),
            "pitch": round(-ori[0] * turn, 5),
            "roll": round(ori[1] * turn, 5),
            "yaw": round((ori[2] * turn + math.pi + math.pi) % math.tau - math.pi, 5),
            "flag": ori[3] if len(ori) > 3 else 0,
        })
    return {
        "level": level,
        "seconds": poses[-1]["t"] if poses else 0,
        "poses": poses,
        "keys": keys,
        "note": "x/z wrap onto the 256 map, y is pre-relief like .nav; yaw and pitch are camera-facing like level.start",
    }


def parse_vox(path: Path) -> dict | None:
    """Episode list: count, title, then planet,mission,level rows."""
    lines = [ln for ln in read_text(path) if ln]
    if len(lines) < 2:
        return None
    missions = []
    for line in lines[2:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            missions.append({"planet": int(parts[0]), "mission": int(parts[1]), "level": Path(parts[2]).stem.lower()})
    return {"file": path.name.lower(), "title": lines[1], "missions": missions}


def text_screen_html(data: bytes, title: str) -> str:
    """80x25 text-mode dump (character, attribute) as colored HTML."""
    rows = []
    for y in range(min(25, len(data) // 160)):
        cells = []
        for x in range(80):
            ch, attr = data[(y * 80 + x) * 2], data[(y * 80 + x) * 2 + 1]
            glyph = bytes([ch]).decode("cp437") if ch >= 32 else " "
            fg, bg = TEXT_COLORS[attr & 15], TEXT_COLORS[(attr >> 4) & 7]
            cells.append(f'<span style="color:{fg};background:{bg}">{html.escape(glyph)}</span>')
        rows.append("".join(cells))
    body = "\n".join(rows)
    return (
        f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
        '<style>body{margin:0;background:#000;display:grid;place-items:center;min-height:100vh}'
        'pre{font:16px/1 "Perfect DOS VGA 437",ui-monospace,monospace;margin:0}</style></head>'
        f"<body><pre>{body}</pre></body></html>\n"
    )


def colormap_image(table: bytes, palette: Palette) -> tuple[int, int, bytes]:
    """32 red slices of 32x32 (green down, blue across) for a 15-bit lookup."""
    width, height = 32 * 32, 32
    out = bytearray(width * height * 4)
    for r in range(32):
        for g in range(32):
            for b in range(32):
                cr, cg, cb = palette[table[(r << 10) | (g << 5) | b]]
                i = (g * width + r * 32 + b) * 4
                out[i : i + 4] = bytes((cr, cg, cb, 255))
    return width, height, bytes(out)


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

    # Block 0x14 (scale) then block 0x02 (vertex list: first slot, count, xyz...).
    # Face corners index slots, so the first slot is always subtracted.
    scale, _vertex_block, index_bias, nverts = struct.unpack_from("<iiii", data, 4)
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
                vi -= index_bias
                corners.append((vi, u, v, sprite))
            color = None
            if block == 0x06 and vertex_colors:
                used = [vertex_colors[c[0]] for c in corners if 0 <= c[0] < len(vertex_colors)]
                color = used[0] if used else None
            elif block in (0x19, 0x05) and flat_color is not None:
                color = ramp_color(flat_color)
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
            flat_color = struct.unpack_from("<i", data, off)[0]
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
    # 16.16 fixed point in a 0..256 texel space. 0 is the top-left edge,
    # 0x1000000 the far edge. Faces and billboard sprites use the same scale.
    del sprite
    return u / (65536.0 * 256.0), v / (65536.0 * 256.0)


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


def write_mtl(path: Path, materials: dict[str, dict], texture_url) -> None:
    """texture_url(raw name) returns the map path relative to the MTL, or None."""
    mtl = []
    for name, spec in materials.items():
        mtl.append(f"newmtl {name}")
        kd = spec["kd"]
        mtl.append(f"Kd {kd[0]:.4f} {kd[1]:.4f} {kd[2]:.4f}")
        mtl.append("Ka 0 0 0")
        mtl.append("Ks 0 0 0")
        if spec["texture"]:
            url = texture_url(spec["texture"])
            if url:
                mtl.append(f"map_Kd {url}")
        mtl.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(mtl))


def export_obj(model: dict, dest: Path, palette, texture_url) -> tuple[dict, dict[str, dict]]:
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
    write_mtl(dest / f"{model['name']}.mtl", materials, texture_url)
    return {
        "file": f"models/{model['name']}.obj",
        "vertices": len(positions),
        "faces": len(model["faces"]) - bad,
        "dropped": bad,
        "textures": model["textures"],
        "anims": model["anims"],
    }, materials


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

    def screen(s: dict) -> str:
        if s["palette"] == "text":
            return f'<figure><a href="{html.escape(s["file"])}">{html.escape(s["name"])} (80×25 text screen)</a></figure>'
        size = f' {s["width"]}×{s["height"]}' if s["width"] else ""
        return f'<figure>{img(s["file"], s["name"])}<figcaption>{html.escape(s["name"])}{size}</figcaption></figure>'

    screens = "\n".join(screen(s) for s in catalog["screens"])
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

    colormaps = "\n".join(
        f'<figure>{img(c["file"], c["name"], "sheet")}<figcaption>{html.escape(c["name"])} · {html.escape(c["palette"])}</figcaption></figure>'
        for c in catalog["colormaps"]
        if c.get("file")
    )
    episodes = "\n".join(
        f'<p><strong>{html.escape(e["title"])}</strong><br>'
        + " · ".join(f'{m["planet"]}.{m["mission"]} {html.escape(m["level"])}' for m in e["missions"])
        + "</p>"
        for e in catalog["episodes"]
    )
    demos = ", ".join(f'<code>{html.escape(d["file"])}</code> ({html.escape(d["level"])}, {d["seconds"]:.0f}s)' for d in catalog["demos"])
    if demos:
        episodes += f"<p>Demo flights: {demos}</p>"

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
  <p><a href="../index.html">Open the game page</a> for models and a flyable version of each map.</p>
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
<section><h2>Color lookups</h2><p>RGB555 to palette index tables (<code>fog/*.map</code>), drawn as 32 red slices.</p><div class="grid">{colormaps}</div></section>
<section><h2>Episodes</h2>{episodes}</section>
<section><h2>Font</h2><div class="grid"><figure>{img("font/font.png", "font", "sheet")}<figcaption>ASCII 32–126, 23px, widths in font/glyphs.json</figcaption></figure></div></section>
<section><h2>Sound effects</h2><div class="sounds">{sound_block(catalog["sounds"])}</div></section>
<section><h2>Music</h2><p>6-channel ProTracker modules. Browsers cannot play these directly; open them in OpenMPT, MilkyTracker, or anything else that understands the 6CHN signature.</p><ul>
{"".join(f"<li><code>{html.escape(m['file'])}</code> · {html.escape(m['title'])} · {m['channels']} ch</li>" for m in catalog["music"])}
</ul></section>
<section><h2>Models</h2><p>Inspect these on the <a href="../index.html?mode=model">game page</a>.</p><ul>{models}</ul></section>
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
            "start": entry.get("start"),
            "nav": entry.get("nav") or [],
            "objects": entry.get("objects") or [],
            "tunnels": entry.get("tunnels") or [],
            "powerups": entry.get("powerups") or [],
            "modelMtl": entry.get("modelMtl") or {},
            "fog": entry.get("fog"),
            "horizon": entry.get("horizon"),
            "sun": entry.get("sun"),
            "ambient": entry.get("ambient"),
            "caveLight": entry.get("caveLight"),
            "caveAmbient": entry.get("caveAmbient"),
            "music": entry.get("music"),
            "palette": entry.get("palette"),
            "mission": entry.get("mission"),
            "demos": entry.get("demos") or [],
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
    episodes = [{"title": e["title"], "levels": [m["level"] for m in e["missions"]]} for e in catalog["episodes"]]
    # Units for the viewer: positions in tiles (2^20 game units), angles in
    # radians in the game's left-handed convention (see game_angles).
    (out / "view.json").write_text(json.dumps({"version": 2, "levels": levels, "models": models, "episodes": episodes}))


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

    # Most .act files are byte-identical copies. Name each distinct palette
    # once (vga wins its group) so votes and variant folders line up.
    canon: dict[str, str] = {}
    groups: dict[bytes, list[str]] = defaultdict(list)
    for name, pal in palettes.items():
        groups[bytes(c for rgb in pal for c in rgb)].append(name)
    for names in groups.values():
        lead = "vga" if "vga" in names else min(names)
        for name in names:
            canon[name] = lead

    # Tunnels have no sky of their own; they keep the surface level's band.
    tunnel_parent: dict[str, str] = {}
    for lv in levels:
        if lv["is_tunnel"] or not lv.get("tdf", "").lower().endswith(".tdf"):
            continue
        for portal in parse_tdf(root / "data" / lv["tdf"].lower()):
            tunnel_parent.setdefault(portal["level"], lv["name"])

    world: dict[str, tuple[str, Palette]] = {}
    keyed: dict[str, Palette] = {"vga": palettes["vga"]}

    def palette_for(lv: dict) -> tuple[str, Palette]:
        if lv["name"] in world:
            return world[lv["name"]]
        main_name = canon.get(Path(lv["palette"].lower()).stem, "vga")
        source = level_by_name.get(tunnel_parent.get(lv["name"], ""), lv)
        sky_name = canon.get(Path(source["sky_palette"].lower()).stem, "")
        sky = palettes.get(sky_name) if sky_name not in ("", "null") else None
        pal = compose_palette(palettes[main_name], sky)
        key = main_name if pal == palettes[main_name] else f"{main_name}_{sky_name}"
        keyed[key] = pal
        world[lv["name"]] = (key, pal)
        return key, pal

    for lv in levels:
        palette_for(lv)

    votes: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    terrain_names: set[str] = set()
    for lv in levels:
        key, _pal = palette_for(lv)
        weight = 2 if lv["is_tunnel"] else 5
        for tex in tex_lists[lv["name"]]:
            votes[tex.lower()][key] += weight
            terrain_names.add(tex.lower())
        sky = lv["sky"].lower()
        if sky.endswith(".raw"):
            votes[sky][key] += 10

    models = []
    model_errors = []
    for path in sorted((root / "models").glob("*.bin")):
        try:
            models.append(parse_bin(path.read_bytes(), path.stem.lower()))
        except Exception as exc:
            model_errors.append(f"{path.name}: {exc}")
    model_by_name = {m["name"]: m for m in models}

    def model_textures(name: str, seen: set[str] | None = None) -> list[str]:
        """Texture names of a model, following morph lists to their frames."""
        seen = seen if seen is not None else set()
        model = model_by_name.get(name)
        if not model or name in seen:
            return []
        seen.add(name)
        if model["kind"] == "anim":
            out = []
            for frame in model["frames"]:
                out += model_textures(Path(frame).stem.lower(), seen)
            return out
        return [t.lower() for t in model["textures"]]

    def level_models(lv: dict) -> set[str]:
        def_path = root / "data" / lv["objects"].lower()
        found = set()
        if def_path.exists():
            text = def_path.read_text("latin1", errors="replace").lower()
            found = {Path(m).stem for m in re.findall(r"[\w.-]+\.bin", text)}
        for pup in parse_pup(root / "data" / lv["pup"].lower()):
            if pup["model"]:
                found.add(pup["model"])
        return {m for m in found if m in model_by_name}

    models_of = {lv["name"]: level_models(lv) for lv in levels}
    for lv in levels:
        key, _pal = palette_for(lv)
        weight = 2 if lv["is_tunnel"] else 4
        for name in models_of[lv["name"]]:
            for tex in model_textures(name):
                votes[tex][key] += weight

    def choose_palette(raw_name: str) -> tuple[Palette, str]:
        tally = votes.get(raw_name.lower())
        if not tally:
            return palettes["vga"], "vga"
        best = max(sorted(tally), key=lambda k: tally[k])
        return keyed[best], best

    # A texture is drawn once with its most-voted palette. A level whose
    # palette disagrees on any index the texture uses gets its own copy in
    # textures/<palette>/ (and models/textures/<palette>/ for model skins).
    pixel_sets: dict[str, frozenset[int]] = {}

    def used_indices(raw_name: str) -> frozenset[int]:
        if raw_name not in pixel_sets:
            path = raw_files.get(raw_name)
            pixel_sets[raw_name] = frozenset(path.read_bytes()) if path else frozenset()
        return pixel_sets[raw_name]

    def needs_variant(raw_name: str, key: str) -> bool:
        _pal, default = choose_palette(raw_name)
        if key == default:
            return False
        a, b = keyed[key], keyed[default]
        return any(a[i] != b[i] for i in used_indices(raw_name))

    variants_written: set[str] = set()

    def write_variant(raw_name: str, key: str, rel: str, alpha0: bool) -> None:
        if rel in variants_written:
            return
        path = raw_files.get(raw_name)
        size = image_size(path.stat().st_size) if path else None
        if not size:
            return
        w, h = size
        write_png(out / rel, w, h, index_image(path.read_bytes()[: w * h], keyed[key], alpha0))
        variants_written.add(rel)

    def texture_url(raw_name: str, key: str) -> str:
        raw_name = raw_name.lower()
        stem = Path(raw_name).stem
        if not needs_variant(raw_name, key):
            return f"textures/{stem}.png"
        rel = f"textures/{key}/{stem}.png"
        write_variant(raw_name, key, rel, alpha0=False)
        return rel

    def skin_url(raw_name: str, key: str | None) -> str | None:
        """Model texture path relative to models/, written on first use."""
        raw_name = raw_name.lower()
        if raw_name not in raw_files:
            return None
        png = sanitize(raw_name) + ".png"
        if key is None or not needs_variant(raw_name, key):
            _pal, key = choose_palette(raw_name)
            rel = f"textures/{png}"
        else:
            rel = f"textures/{key}/{png}"
        write_variant(raw_name, key, f"models/{rel}", alpha0=True)
        return rel

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
        "colormaps": [],
        "demos": [],
        "episodes": [],
        "undecoded": [],
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

    # Models. The default MTL uses each skin's most-voted palette; levels that
    # disagree get models/<palette>/<name>.mtl through model_mtl().
    model_dir = out / "models"
    model_materials: dict[str, dict[str, dict]] = {}
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
        pal = palettes["vga"]
        for tex in model["textures"]:
            pal, _key = choose_palette(tex)
            break
        try:
            info, materials = export_obj(model, model_dir, pal, lambda tex: skin_url(tex, None))
            model_materials[model["name"]] = materials
            catalog["models"].append(info)
        except Exception as exc:
            catalog["errors"].append(f"obj {model['name']}: {exc}")

    def model_mtl(name: str, key: str) -> str | None:
        """Path of a palette-specific MTL for this model, or None if the default fits."""
        materials = model_materials.get(name)
        if not materials:
            return None
        skins = {spec["texture"].lower() for spec in materials.values() if spec["texture"]}
        if not any(raw in raw_files and needs_variant(raw, key) for raw in skins):
            return None
        rel = f"models/{key}/{name}.mtl"
        if rel not in variants_written:
            write_mtl(out / rel, materials, lambda tex: (lambda url: f"../{url}" if url else None)(skin_url(tex, key)))
            variants_written.add(rel)
        return rel

    def mtl_overrides(names, key: str) -> dict[str, str]:
        found = {}
        for name in sorted(names):
            rel = model_mtl(name, key)
            if rel:
                found[name] = rel
        return found

    # Terrain
    fog_index: dict[str, int] = {}
    for lv in levels:
        table = root / "fog" / lv.get("fog", "").lower()
        if table.exists() and table.stat().st_size >= 4096:
            last = table.read_bytes()[15 * 256 : 16 * 256]
            fog_index[lv["name"]] = max(set(last), key=last.count)

    def hex_color(rgb) -> str:
        return "#{:02x}{:02x}{:02x}".format(*rgb)

    tile = 1048576.0
    for lv in levels:
        atlas_only = lv["is_tunnel"]
        names = tex_lists[lv["name"]]
        key, palette = palette_for(lv)
        entry = {
            "name": lv["name"],
            "textures": len(names),
            "palette": key,
            "textureFiles": [texture_url(tex, key) for tex in names],
        }
        # The .lvl names the fog color's palette index; the .fog table's last
        # row is the fallback when the line is missing.
        fog_at = lv.get("fog_index", fog_index.get(lv["name"]))
        if fog_at is not None:
            entry["fog"] = hex_color(palette[fog_at])
            entry["horizon"] = hex_color(palette[255])
        for field, key_name in (("sun", "sun"), ("ambient", "ambient"), ("cave_light", "caveLight"), ("cave_ambient", "caveAmbient")):
            if field in lv:
                entry[key_name] = lv[field]
        music = lv.get("music", "").lower()
        if music.endswith(".mod"):
            entry["music"] = f"audio/music/{music}"
        def_path = root / "data" / lv.get("objects", "").lower()
        if def_path.suffix == ".def" and def_path.exists():
            entry["objects"] = parse_def_placements(def_path)
        pups = parse_pup(root / "data" / lv.get("pup", "").lower())
        if pups and not atlas_only:
            # Surface power-ups float at ground + 2 x bounding radius; the viewer seats them.
            entry["powerups"] = [{
                "model": p["model"],
                "type": p["type"],
                "x": wrap_tile(p["x"]),
                "z": wrap_tile(p["z"]),
            } for p in pups if p["model"] and p["listed"]]
        sky = lv.get("sky", "").lower()
        if sky.endswith(".raw") and sky in raw_files:
            entry["sky"] = texture_url(sky, key)
        nav_name = lv.get("nav", "").lower()
        start = parse_nav_start(root / "data" / nav_name)
        if start:
            entry["start"] = start
        nav_points = parse_nav(root / "data" / nav_name)
        if nav_points:
            entry["nav"] = nav_points
        if not atlas_only:
            overrides = mtl_overrides(models_of[lv["name"]], key)
            if overrides:
                entry["modelMtl"] = overrides
        tdf_name = lv.get("tdf", "").lower()
        portals = parse_tdf(root / "data" / tdf_name) if tdf_name.endswith(".tdf") else []
        if portals:
            for portal in portals:
                tunnel_level = level_by_name.get(portal["level"])
                tunnel_key = palette_for(tunnel_level)[0] if tunnel_level else key
                listed = tex_lists.get(portal["level"]) or []
                if tunnel_level and not listed:
                    listed = parse_tex(root / "data" / tunnel_level.get("textures", "").lower())
                # The mouth tiles are painted on the surface, so they use its palette.
                portal["mouth"] = texture_url(Path(portal["mouth"]).stem + ".raw", key)
                portal["exitMouth"] = texture_url(Path(portal["exitMouth"]).stem + ".raw", key)
                portal["walls"] = [texture_url(tex, tunnel_key) for tex in listed]
                portal["segments"] = parse_tnl(root / "data" / f"{portal['level']}.tnl")
                contents = parse_tunnel_contents(root / "data" / f"{portal['level']}.def")
                if tunnel_level:
                    for p in parse_pup(root / "data" / tunnel_level.get("pup", "").lower()):
                        if p["model"] and p["listed"]:
                            contents.append({
                                "model": p["model"],
                                "powerup": p["type"],
                                "x": round(p["x"] / tile, 4),
                                "y": round(p["y"] / tile, 4),
                                "z": round(p["z"] / tile, 4),
                                "yaw": 0.0, "pitch": 0.0, "roll": 0.0,
                            })
                portal["contents"] = contents
                if tunnel_level:
                    tunnel_models = {spot["model"] for spot in contents}
                    overrides = mtl_overrides(tunnel_models & set(model_materials), tunnel_key)
                    if overrides:
                        portal["modelMtl"] = overrides
                    if tunnel_level["name"] in fog_index:
                        tpal = palette_for(tunnel_level)[1]
                        portal["fog"] = hex_color(tpal[fog_index[tunnel_level["name"]]])
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
        catalog["terrain"].append(entry)

    # Fog and lighting remaps, drawn with the palette of a level that uses them.
    table_owner: dict[str, dict] = {}
    for lv in levels:
        for field in ("fog", "light"):
            table_owner.setdefault(lv.get(field, "").lower(), lv)
    for kind, folder in (("fog", "effects/fog"), ("lte", "effects/light")):
        for path in sorted((root / "fog").glob(f"*.{kind}")):
            table = path.read_bytes()
            lv = table_owner.get(path.name.lower()) or level_by_name.get(path.stem.lower())
            key, palette = palette_for(lv) if lv else ("vga", palettes["vga"])
            rows = max(1, len(table) // 256)
            rel = f"{folder}/{path.stem}.png"
            write_png(out / rel, 256, rows, remap_image(table, palette, rows))
            catalog["effects"].append({"name": f"{path.stem} {kind}", "file": rel, "palette": key})

    # 15-bit color lookups. Only a couple are distinct; draw each one once.
    seen_maps: dict[bytes, str] = {}
    for path in sorted((root / "fog").glob("*.map")):
        table = path.read_bytes()
        if len(table) != 32768:
            continue
        lv = level_by_name.get(path.stem.lower())
        key, palette = palette_for(lv) if lv else ("vga", palettes["vga"])
        digest = table[:]
        if digest in seen_maps:
            catalog["colormaps"].append({"name": path.stem, "same_as": seen_maps[digest]})
            continue
        seen_maps[digest] = path.stem
        w, h, rgba = colormap_image(table, palette)
        rel = f"effects/colormap/{path.stem}.png"
        write_png(out / rel, w, h, rgba)
        catalog["colormaps"].append({
            "name": path.stem,
            "file": rel,
            "palette": key,
            "note": "index = r5<<10 | g5<<5 | b5; drawn as 32 red slices, green down, blue across",
        })
    for path in sorted((root / "fog").glob("*.mix")):
        if path.stat().st_size == 0:
            continue
        dest = out / "effects" / "mix" / path.name.lower()
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        catalog["undecoded"].append({"file": f"effects/mix/{dest.name}", "bytes": path.stat().st_size, "note": "31x256 sky blend table"})

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
    # The TRI*.WAV clips sit loose in the install folder next to TRI.GIF.
    sound_sources = [("audio/sfx", p) for p in sorted((root / "sound").glob("*.wav"))]
    sound_sources += [("audio/extra", p) for p in sorted((root / "loose").glob("*.wav"))]
    for folder, path in sound_sources:
        dest = out / folder / path.name.lower()
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        with wave.open(str(path)) as wav:
            rate = wav.getframerate()
            frames = wav.getnframes()
            catalog["sounds"].append({
                "name": path.stem.lower(),
                "file": f"{folder}/{dest.name}",
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
    sources = [("data", f"*.{ext}") for ext in ("txt", "mic", "def", "nav", "tdf", "tnl", "tex", "pup")]
    sources += [("levels", "*.lvl"), ("loose", "*.vox")]
    for folder, pattern in sources:
        for path in sorted((root / folder).glob(pattern)):
            if path.stat().st_size == 0:
                continue
            body = path.read_bytes().replace(b"\x1a", b"").decode("latin1").replace("\r\n", "\n")
            (text_dir / path.name.lower()).write_text(body)
    # The .ani and .qke tables are a bare 0 in every level; nothing to export.

    # Text-mode screens shown on exit (shareware and registered).
    for path in sorted((root / "startup").glob("tv*.bin")):
        data = path.read_bytes()
        if len(data) != 4000:
            continue
        rel = f"screens/{path.stem.lower()}.html"
        (out / rel).write_text(text_screen_html(data, path.stem.lower()))
        catalog["screens"].append({"name": path.stem.lower(), "file": rel, "width": 80, "height": 25, "palette": "text"})
    for path in sorted((root / "loose").glob("*.gif")):
        rel = f"screens/{path.name.lower()}"
        shutil.copy2(path, out / rel)
        catalog["screens"].append({"name": path.stem.lower(), "file": rel, "width": 0, "height": 0, "palette": "gif"})

    # Recorded demo flights.
    for path in sorted((root / "demo").glob("*.dmo")):
        demo = parse_demo(path)
        if not demo:
            catalog["errors"].append(f"demo {path.name}: unreadable")
            continue
        rel = f"demo/{path.stem.lower()}.json"
        (out / "demo").mkdir(exist_ok=True)
        (out / rel).write_text(json.dumps(demo))
        catalog["demos"].append({"file": rel, "level": demo["level"], "seconds": demo["seconds"], "poses": len(demo["poses"]), "keys": len(demo["keys"])})
    for terrain in catalog["terrain"]:
        runs = [{"file": d["file"], "seconds": d["seconds"]} for d in catalog["demos"] if d["level"] == terrain["name"]]
        if runs:
            terrain["demos"] = runs

    # Episodes, in menu order.
    order = {"share.vox": 0, "retail1.vox": 1, "retail2.vox": 2}
    for path in sorted((root / "loose").glob("*.vox"), key=lambda p: (order.get(p.name.lower(), 9), p.name.lower())):
        episode = parse_vox(path)
        if episode and episode["missions"]:
            catalog["episodes"].append(episode)
    mission_of = {}
    for episode in catalog["episodes"]:
        for m in episode["missions"]:
            mission_of[m["level"]] = f'{episode["title"]} · planet {m["planet"]} mission {m["mission"]}'
    for terrain in catalog["terrain"]:
        if terrain["name"] in mission_of:
            terrain["mission"] = mission_of[terrain["name"]]

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
        "colormaps": len(catalog["colormaps"]),
        "demos": len(catalog["demos"]),
        "episodes": len(catalog["episodes"]),
        "undecoded": len(catalog["undecoded"]),
        "errors": len(catalog["errors"]),
    }
    (out / "catalog.json").write_text(json.dumps(catalog, indent=2))
    write_view_manifest(out, catalog)
    build_gallery(out, catalog)
    return catalog


def main() -> None:
    here = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Translate unpacked Terminal Velocity assets")
    parser.add_argument("--game", type=Path, help="install folder with the .pod files; unpacked into --root first")
    parser.add_argument("--root", type=Path, default=here / "_orig", help="unpacked game tree")
    parser.add_argument("--out", type=Path, default=here / "extracted", help="output directory")
    args = parser.parse_args()
    if args.game:
        for label in unpack_pods(args.game, args.root):
            print("unpacked", label)
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
