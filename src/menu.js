// The game's front end: title, menus, help/order pages, scores, credits and
// the new-game screens (GAME.EXE 0x1fa24 → 0x31d70 and what it dispatches).
// Drawn the way the game draws it: a 320x200 screen of palette indices shown
// through the VGA palette. Only the screens are here; the viewer starts the
// flight through the hooks.

const W = 320;
const H = 200;
const GAME_SECOND = 0.98864; // one 16.16 game second in real seconds (2.2)
const BIG_H = 23; // startup/font.bin rows (FUN_00013c10)
const BIG_STEP = 0x17; // menu line pitch (FUN_00030700)
const FOOTER = "Terminal Velocity (c) 1995 Terminal Reality, Inc.";
const MENU_MUSIC = "music/sex.mod"; // 0x63074, started by the menu loop
const TITLE_TIME = 4; // 0x480000 timer units = 4 game seconds (0x1fa1a)
const PAGES = 7; // help1..7, order1..7 (FUN_0002c520 / FUN_0002c540)
const PAGE_X = 0x22; // the 256x108 page sits in savesc's screen (FUN_0002c3c0)
const PAGE_Y = 0x1e;
const SCORE_TIME = 30; // FUN_0002b9c0(0x1e0000)
const SHIP_RECT = { x: 0x50, y: 0x16, w: 0xef - 0x50 + 1, h: 99 - 0x16 + 1 }; // FUN_0004b5e0
const NAME_LEN = 9;
// Level start (FUN_0002cdd0): story text, briefing, tactical report.
const STORY_TIME = 45; // FUN_0004b930 gives up after 0x2d0000
const STORY_X = 8;
const BRIEF_STEP = 0x2801 / 0x10000; // one pixel of scroll (FUN_0004aef0)
const BRIEF_TEXT = { x: 0x3e, y: 0xac, top: 0x94, bottom: 0xb4, w: 0xc1 }; // FUN_0004ae60 rows 148..180
const BRIEF_TAIL = 0x20; // scrolls after the last line
const REPORT_TURN = 0x4000 / 0x10000; // turns per game second (FUN_00049cb0)
const REPORT_TURNS = 2; // 0x20000: two circles, and the text all typed
// [I] The original types one character per drawn frame; the frame rate is
// the machine's. These rates stand in for it.
const STORY_CPS = 70;
const REPORT_CPS = 24;
const LEVEL_COLOURS = 0xf0; // 2D art is matched to palette 0..0xef (FUN_00013e00)

// GAME.EXE falls back to these three when there is no mission.ini (FUN_0002e060).
const EPISODES = [
  { file: "share.vox", name: "Episode One: Tactical Strike" },
  { file: "retail1.vox", name: "Episode Two: Heavy Fire" },
  { file: "retail2.vox", name: "Episode Three: The Mad God" },
];
const HIDDEN = { file: "geiger.vox", name: "Hidden Mission" };
// [I] The .vox mission lists sit loose in the game folder, outside the PODs.
// When they were not given, these copies of the shipped ones stand in.
const SHIPPED_VOX = {
  "share.vox": ["artic", "artic3", "artic6", "canyon", "canyon3", "canyon6", "alien", "alien3", "alien6"],
  "retail1.vox": ["desert", "desert3", "desert6", "lava", "lava3", "lava6", "mine", "mine3", "mine6"],
  "retail2.vox": ["bughunt", "bughunt3", "bughunt6", "astroid", "astroid3", "astroid6", "core", "mcore"],
  "geiger.vox": ["geiger"],
};

const DIFFICULTIES = ["Easy", "Normal", "Hard", "Terminal"]; // PTR_DAT_000682d4
const MOUSE_BUTTONS = ["Fire", "Burn", "Throt Up", "Throt Dn", "Roll L", "Roll R"]; // 0x684ac
const CONTROLS = ["Keyboard", "Gamepad", "Joystick", "Joy/Throt", "CH Flight Pro"];

// The 54 lines of FUN_0002b4c0 (0x681e4). "i" marks a highlighted line,
// "^" splits a name from a quoted call sign.
const CREDITS = [
  "Terminal Velocity 1.2", "iConceived, Designed, and Programmed by", "Mark Randel",
  "iMusic and Sound Effects by", "Kyle Richards", "iOriginal Artwork and Animations by",
  "Karl Hagood", "Drew Haworth", "Brad Heitmeyer", "Mark Humphrey", "Ray Rodriguez", "Terry Simmons",
  "iCreative Coordinator", "Joseph Selinske", "iBiz/Resident Psychologist", "Brett Combs",
  "iModem/Network Transport Layer", "Mark Dochtermann", "iAdditional Art", "James Storey",
  "Stephen Hornback", "iManual Design", "Robert M. Atkins", "iCo-produced by", "Tom Hall at 3D Realms",
  "iSpecial Thanks to: ", "George Broussard", "Scott Miller", "Gaither Simmons", "Ron and Geoff",
  "iBeta Testers", "iTest Pilot                           Call Sign",
  "Todd Aubin^Sly Fox", "Mike Bartelt^Sandman", "Wayne Benner^TygerHawk", "Neil Bonner^T-Rex",
  "Glenn Brensinger^Doc Shadow", "Michael Callahan^Bogie", "Daniel Creeron^Cupelix",
  "Jason Ewasiuk^Arch Mage", "Erik Harris^Leviathan", "Ken Heckbert^Islander", "John Howard^Howard",
  "Terry Herrin^Deathstar", "Greg Hively^DocNsanE", "Doug Howell^Flash", "Lee Jackson^Fnord",
  "Dennis Kurek^Techlord", "Hank Leukart^Covox/Baxter", "Ken Mayer^Hirsch", "Jeff Rausch^Phoenix",
  "Kelly Rogers^Angel", "Joe Siegler^Dopefish", "iTerminal Velocity (c) 1995 Terminal Reality, Inc.",
];

// The table FUN_0002ee70 writes when there is no score.dat.
const DEFAULT_SCORES = {
  quote: "Order your copy today!",
  rows: [["Mark", "Ice Man"], ["Brett", "Bandit"], ["Karl", "Maniac"], ["Drew", "Drewbie"], ["Joe", "Wolverine"]]
    .map(([name, callsign], i) => ({ name, callsign, air: 5 - i, ground: 5 - i, green: 5 - i, score: 5 - i })),
};

// vox.ini as shipped (the game's saved settings), except Shadows: shipped
// Off (airShadowFlag 0), here Pentium [port].
export const DEFAULT_SETTINGS = {
  sound: 1, music: 1, soundVolume: 0x10000, musicVolume: 0x10000,
  briefings: 1, cinemas: 1, demos: 1,
  sky: 1, shadows: 2, debris: 1,
  control: 0, mouseControl: 0, autoLevel: 1,
  mouseFlip: 1, mouseX: 8, mouseY: 16, mouseMotion: 1, mouseLeft: 0, mouseRight: 1,
  difficulty: 1,
};

const percent = (v) => Math.trunc((v * 100) / 0x10000);
const step25 = (v) => (v + 0x4000 > 0x10000 ? 0x4000 : v + 0x4000);
const onOff = (v) => (v ? "On" : "Off");

export class Menu {
  // hooks: musicUrl(path), playMusic(url), stopMusic(), sound(name), wake(),
  // startGame({ level, difficulty, mission, name, callsign }), resumeGame(),
  // canResume(), windowView(rect|null, view), settingsChanged(settings), quit().
  constructor({ archive, canvas, palette, mix, smallFont, vox = {}, settings, hooks }) {
    this.archive = archive;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.image = this.ctx.createImageData(W, H);
    this.palette = palette;
    this.vga = palette;
    this.remap = null; // VGA index -> level palette index, in a level
    this.view = null; // what the viewer draws in the window
    this.mix = mix;
    this.small = smallFont; // 128 x 64 bytes from GAME.EXE, or null
    this.vox = vox;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.hooks = hooks;
    this.fb = new Uint8Array(W * H);
    this.hole = null; // a rect left transparent (the ship view)
    this.raws = new Map();
    this.active = false;
    this.screen = null;
    this.menuId = 1;
    this.cursor = 0;
    this.idle = 0;
    this.items = [];
    this.pointerItems = [];
    canvas.addEventListener("pointerdown", (event) => this.pointer(event));
  }

  async load() {
    const widths = (await this.archive.text("startup/font.ndx")).split(/\s+/).filter((t) => /^-?\d+$/.test(t)).map(Number);
    const blob = await this.archive.bytes("startup/font.bin");
    this.big = [];
    let offset = 0;
    for (const width of widths) {
      this.big.push({ width, rows: blob.subarray(offset, offset + width * BIG_H) });
      offset += width * BIG_H;
    }
    const names = ["title.raw", "savesc.raw", "brief.raw", "vel2.raw"];
    for (let i = 1; i <= PAGES; i++) names.push(`help${i}.raw`, `order${i}.raw`);
    await Promise.all(names.map((name) => this.raw(name)));
  }

  async raw(name) {
    if (!this.raws.has(name)) {
      const path = `art/${name}`;
      this.raws.set(name, this.archive.has(path) ? await this.archive.bytes(path) : null);
    }
    return this.raws.get(name);
  }

  rawNow(name) {
    return this.raws.get(name) || null;
  }

  // ------------------------------------------------------------ drawing

  clear(index = 0) {
    this.fb.fill(index);
  }

  blit(name) {
    const src = this.rawNow(name);
    if (src) this.fb.set(src.subarray(0, W * H));
    else this.clear();
  }

  blitAt(name, x, y, w, h) {
    const src = this.rawNow(name);
    if (!src) return;
    for (let row = 0; row < h; row++) this.fb.set(src.subarray(row * w, row * w + w), (y + row) * W + x);
  }

  bigWidth(text) {
    let width = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code < 128) width += this.big[code - 32]?.width || 0;
    }
    return width;
  }

  // FUN_00013cb0 / FUN_00013c10: each glyph gets a 3x3 black outline
  // (FUN_00013b10), then its pixels v are drawn as palette v >> shift
  // (3 for the lit line, 4 for the dim ones).
  bigText(text, x, y, shift) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      const glyph = code >= 32 && code < 128 ? this.big[code - 32] : null;
      if (!glyph) continue;
      const { width, rows } = glyph;
      if (y > 0 && y + 0x18 < H && x > 0 && x + 0x17 < W) {
        for (let gy = 0; gy < BIG_H; gy++) {
          for (let gx = 0; gx < width; gx++) {
            if (!rows[gy * width + gx]) continue;
            for (let dy = -1; dy <= 1; dy++) {
              const at = (y + gy + dy) * W + x + gx - 1;
              this.fb.fill(0, at, at + 3);
              this.inked?.fill(1, at, at + 3);
            }
          }
        }
      }
      for (let gy = 0; gy < BIG_H; gy++) {
        const py = y + gy;
        if (py < 0 || py >= H) continue;
        for (let gx = 0; gx < width; gx++) {
          const v = rows[gy * width + gx];
          const px = x + gx;
          if (v && px >= 0 && px < W) {
            this.fb[py * W + px] = v >> shift;
            if (this.inked) this.inked[py * W + px] = 1;
          }
        }
      }
      x += width;
    }
  }

  // FUN_00014a30: each 8-row glyph advances its width plus one.
  smallWidth(text) {
    let width = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code < 128) width += this.glyphWidth(code) + 1;
    }
    return width;
  }

  glyphWidth(code) {
    return this.small ? this.small[code * 64] : (code === 32 ? 3 : 5);
  }

  glyphPixel(code, gx, gy) {
    if (this.small) return this.small[code * 64 + 1 + gy * this.small[code * 64] + gx];
    const rows = FALLBACK_FONT[String.fromCharCode(code).toUpperCase()];
    return rows && gy < 7 && rows[gy] & (1 << (4 - gx)) ? 10 : 0;
  }

  // Three ways the game draws the small font:
  //   opaque (FUN_00013aa0): every pixel, 0 included, plus a black column
  //     after each glyph; wraps to the next line at the right edge;
  //   plain (FUN_00014d40): set pixels v as palette v;
  //   lit (FUN_00014c90): set pixels v as palette 0x20 + v.
  // A glyph is skipped when it would start off screen or within 8 of the
  // right or bottom edge.
  smallText(text, x, y, mode = "opaque") {
    const left = x;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code >= 128) continue;
      const width = this.glyphWidth(code);
      if (x < 0 || y < 0 || x > W - 8 || y > H - 8) continue; // drawn nowhere, no advance
      for (let gy = 0; gy < 8; gy++) {
        const row = (y + gy) * W + x;
        for (let gx = 0; gx < width; gx++) {
          const v = this.glyphPixel(code, gx, gy);
          if (mode === "opaque") this.fb[row + gx] = v;
          else if (v) this.fb[row + gx] = mode === "lit" ? 0x20 + v : v;
        }
        if (mode === "opaque") this.fb[row + width] = 0;
      }
      x += width + 1;
      if (mode === "opaque" && x > W) {
        x = left;
        y += 8;
      }
    }
  }

  centred(text, y, mode = "opaque") {
    this.smallText(text, Math.trunc((W - this.smallWidth(text)) / 2), y, mode);
  }

  // FUN_00030590: the box behind a menu is the picture mixed 50/50 with
  // palette 8 (vga.mix), a title band of palette 100 with a rule under it,
  // and a one-pixel frame in palette 0x10.
  box(x, y, w, h, titled) {
    for (let row = y; row <= y + h; row++) {
      for (let col = x; col <= x + w; col++) {
        const i = row * W + col;
        this.fb[i] = this.mix ? this.mix[8 * 256 + this.fb[i]] : this.fb[i];
      }
    }
    const edge = 0x10;
    if (titled) {
      for (let row = y; row < y + 25; row++) this.fb.fill(100, row * W + x, row * W + x + w + 1);
      this.fb.fill(edge, (y + 25) * W + x, (y + 25) * W + x + w + 1);
    }
    this.fb.fill(edge, (y - 1) * W + x - 1, (y - 1) * W + x - 1 + w + 2);
    this.fb.fill(edge, (y + h + 1) * W + x - 1, (y + h + 1) * W + x - 1 + w + 2);
    for (let row = y - 1; row <= y + h + 1; row++) {
      this.fb[row * W + x - 1] = edge;
      this.fb[row * W + x + 1 + w] = edge;
    }
  }

  present() {
    const data = this.image.data;
    const pal = this.palette;
    const hole = this.hole;
    for (let i = 0; i < W * H; i++) {
      const c = this.fb[i] * 3;
      data[i * 4] = pal[c];
      data[i * 4 + 1] = pal[c + 1];
      data[i * 4 + 2] = pal[c + 2];
      data[i * 4 + 3] = 255;
    }
    if (this.inked) {
      // Over the frozen flight only what was drawn is opaque.
      for (let i = 0; i < W * H; i++) data[i * 4 + 3] = this.inked[i] ? 255 : 0;
    } else if (hole) {
      for (let y = hole.y; y < hole.y + hole.h; y++) {
        for (let x = hole.x; x < hole.x + hole.w; x++) {
          // The ship is drawn over the window; its black stays see-through.
          if (this.fb[y * W + x] === 0) data[(y * W + x) * 4 + 3] = 0;
        }
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  // ------------------------------------------------------------ flow

  show(screen) {
    this.active = true;
    this.canvas.hidden = false;
    this.setScreen(screen);
  }

  hide() {
    this.active = false;
    this.canvas.hidden = true;
    this.setHole(null);
    this.inked = null;
    this.screen = null;
  }

  setScreen(screen) {
    this.setHole(null);
    this.inked = null;
    this.screen = screen;
    this.pointerItems = [];
    screen.enter?.();
  }

  // A window where palette 0 is see-through, so the viewer's 3D shows:
  // view.kind "ship" (name screen), "brief" (the briefing model) or
  // "report" (the level, round a target).
  setHole(rect, view = rect ? { kind: "ship" } : null) {
    this.hole = rect;
    this.view = view;
    this.hooks.windowView?.(rect, view);
  }

  // Each frame while the menu is up.
  tick(dt) {
    if (!this.active || !this.screen) return;
    this.screen.tick?.(dt / GAME_SECOND);
    if (!this.screen) return;
    this.screen.draw();
    this.present();
  }

  key(event) {
    if (!this.active || !this.screen) return false;
    this.hooks.wake?.();
    this.screen.key?.(event.key, event);
    return true;
  }

  // [I] Clicks and taps: a menu line is chosen by touching it; anywhere
  // else counts as Enter. The original reads only the keyboard here.
  pointer(event) {
    if (!this.active || !this.screen) return;
    event.preventDefault();
    this.hooks.wake?.();
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * W;
    const y = ((event.clientY - rect.top) / rect.height) * H;
    const hit = this.pointerItems.find((item) => x >= item.x && x < item.x + item.w && y >= item.y && y < item.y + item.h);
    if (hit) hit.choose();
    else this.screen.key?.("Enter", event);
  }

  save() {
    this.hooks.settingsChanged?.({ ...this.settings });
  }

  // The title (0x1fa24), then the menu loop.
  start(name = "title") {
    const jump = SCREENS[name];
    if (jump) return jump(this);
    this.show(this.titleScreen());
  }

  titleScreen() {
    let time = 0;
    return {
      draw: () => this.blit("title.raw"),
      tick: (dt) => {
        time += dt;
        if (time >= TITLE_TIME) this.enterLoop();
      },
      key: () => this.enterLoop(),
    };
  }

  // 0x31d70: the main menu, sex.mod, an idle clock for the demos.
  enterLoop(id = 1, cursor = 0) {
    this.useLevelPalette(null);
    this.menuId = id;
    this.cursor = cursor;
    this.idle = 0;
    this.hooks.playMusic(this.hooks.musicUrl(MENU_MUSIC));
    this.show(this.loopScreen());
  }

  // Back from an activity (0x31f16): the menu again, its music restarted if
  // something else was playing.
  backToLoop(id = this.menuId, cursor = this.cursor) {
    this.enterLoop(id, cursor);
  }

  loopScreen() {
    return {
      draw: () => {
        this.blit("title.raw");
        this.drawMenu();
      },
      tick: (dt) => {
        // [I] The original plays demo1-3.dmo after 30 idle game seconds
        // (then every 15) when Demos is on; there is no demo player here.
        this.idle += dt;
      },
      key: (key) => {
        this.idle = 0;
        const menu = this.currentMenu();
        if (key === "ArrowUp") this.cursor = (this.cursor + menu.items.length - 1) % menu.items.length;
        else if (key === "ArrowDown") this.cursor = (this.cursor + 1) % menu.items.length;
        else if (key === "Enter") menu.items[this.cursor]?.choose();
        else if (key === "Escape") menu.escape?.();
        else if (key === "F1") this.pager("help", () => this.backToLoop());
      },
    };
  }

  go(id, cursor = 0) {
    this.menuId = id;
    this.cursor = cursor;
  }

  // FUN_00030700: the title and lines in the big font, centred on a box.
  drawMenu() {
    const menu = this.currentMenu();
    if (this.cursor >= menu.items.length) this.cursor = 0;
    const lines = menu.items.length + (menu.title ? 1 : 0);
    let widest = -0x80000000;
    for (const item of menu.items) widest = Math.max(widest, this.bigWidth(item.label));
    if (menu.title) widest = Math.max(widest, this.bigWidth(menu.title));
    let y = Math.trunc((H - lines * BIG_STEP) / 2);
    this.box(Math.trunc((W - widest) / 2) - 2, y - 6, widest + 4, lines * BIG_STEP + 6, !!menu.title);
    if (menu.title) {
      this.bigText(menu.title, Math.trunc((W - this.bigWidth(menu.title)) / 2), y - 4, 3);
      y += BIG_STEP;
    }
    this.pointerItems = [];
    menu.items.forEach((item, i) => {
      const width = this.bigWidth(item.label);
      const x = Math.trunc((W - width) / 2);
      this.bigText(item.label, x, y, i === this.cursor ? 3 : 4);
      this.pointerItems.push({
        x: Math.trunc((W - widest) / 2), y, w: widest, h: BIG_STEP,
        choose: () => {
          this.cursor = i;
          item.choose();
        },
      });
      y += BIG_STEP;
    });
    this.smallText(FOOTER, Math.trunc((W - this.smallWidth(FOOTER)) / 2), H - 10, "plain");
  }

  // The jump table at 0x31cb8, indexed by DAT_000e3500.
  currentMenu() {
    const s = this.settings;
    const toggle = (key) => () => {
      s[key] = 1 - s[key];
      this.save();
    };
    switch (this.menuId) {
      case 1: // 0x30980
        return {
          title: "Main Menu",
          items: [
            { label: "Play Game", choose: () => this.go(7, this.hooks.canResume() ? 2 : 0) },
            { label: "Options", choose: () => this.go(2) },
            { label: "Instructions", choose: () => this.pager("help", () => this.backToLoop(1, 2)) },
            { label: "Scores/Credits", choose: () => this.scores(() => this.credits(() => this.backToLoop(1, 3))) },
            { label: "Ordering Info", choose: () => this.pager("order", () => this.backToLoop(1, 4)) },
            { label: "Quit", choose: () => this.go(6) },
          ],
          escape: () => this.go(6),
        };
      case 2: // FUN_00030b20
        return {
          title: "Options Menu",
          items: [
            { label: "Sound Options", choose: () => this.go(3) },
            { label: "Graphics Options", choose: () => this.go(4) },
            { label: "Control Options", choose: () => this.go(5) },
            { label: `Level Briefings: ${onOff(s.briefings)}`, choose: toggle("briefings") },
            { label: `Cinemas: ${onOff(s.cinemas)}`, choose: toggle("cinemas") },
            { label: `Demos: ${onOff(s.demos)}`, choose: toggle("demos") },
          ],
          escape: () => this.go(1),
        };
      case 3: // FUN_00030d90; Music Freq and Playback are left out (always 44 kHz stereo here)
        return {
          title: "Sound Options",
          items: [
            { label: `Sound F/X: ${onOff(s.sound)}`, choose: toggle("sound") },
            { label: `Music : ${onOff(s.music)}`, choose: toggle("music") },
            {
              label: `Sound Volume : ${percent(s.soundVolume)}%`,
              choose: () => {
                s.soundVolume = step25(s.soundVolume);
                this.save();
                this.hooks.sound("laser.wav");
              },
            },
            {
              label: `Music Volume : ${percent(s.musicVolume)}%`,
              choose: () => {
                s.musicVolume = step25(s.musicVolume);
                this.save();
              },
            },
          ],
          escape: () => this.go(2),
        };
      case 4: // FUN_00031240; Image Quality, Texture and Resolution are left out
        return {
          title: "Graphics Options",
          items: [
            { label: `Sky Texture : ${onOff(s.sky)}`, choose: toggle("sky") },
            {
              label: `Shadows : ${["Off", "486", "Pentium"][s.shadows]}`,
              choose: () => {
                s.shadows = (s.shadows + 1) % 3;
                this.save();
              },
            },
            {
              label: `Debris : ${["Off", "Normal", "Overkill"][s.debris]}`,
              choose: () => {
                s.debris = (s.debris + 1) % 3;
                this.save();
              },
            },
          ],
          escape: () => this.go(2),
        };
      case 5: // FUN_00031590
        return {
          title: "Control Options",
          items: [
            {
              label: `Control : ${s.mouseControl ? "Mouse" : CONTROLS[s.control]}`,
              choose: () => {
                // Keyboard → Mouse → Gamepad → ... → CH Flight Pro → Keyboard.
                if (s.control === 0 && !s.mouseControl) s.mouseControl = 1;
                else {
                  s.control += 1;
                  s.mouseControl = 0;
                }
                if (s.control > 4) s.control = 0;
                this.save();
              },
            },
            // [I] Calibration and the three Customize screens are not built yet.
            { label: "Calibrate", choose: () => {} },
            { label: "Customize Keyboard", choose: () => {} },
            { label: "Customize Joystick", choose: () => {} },
            { label: "Customize Mouse", choose: () => this.go(8) },
            { label: `Auto Leveling : ${onOff(s.autoLevel)}`, choose: toggle("autoLevel") },
          ],
          escape: () => this.go(2),
        };
      case 6: // FUN_000317c0
        return {
          title: "Quit Game",
          items: [
            { label: "No", choose: () => this.go(1) },
            { label: "Yes", choose: () => this.quit() },
          ],
        };
      case 7: { // FUN_00031880
        const items = [
          { label: "New Game", choose: () => this.newGame() },
          { label: "Restore Game", choose: () => this.restore() },
        ];
        if (this.hooks.canResume()) items.push({ label: "Resume Game", choose: () => this.resume() });
        return { title: "Play Game", items, escape: () => this.go(1) };
      }
      case 8: // FUN_00031a80
        return {
          title: "Mouse Options",
          items: [
            { label: `Y-Axis : ${s.mouseFlip ? "Flipped" : "Normal"}`, choose: toggle("mouseFlip") },
            {
              label: `Mouse X sens : ${s.mouseX}`,
              choose: () => {
                s.mouseX = s.mouseX >= 0x40 ? 1 : s.mouseX + 1;
                this.save();
              },
            },
            {
              label: `Mouse Y sens : ${s.mouseY}`,
              choose: () => {
                s.mouseY = s.mouseY >= 0x40 ? 1 : s.mouseY + 1;
                this.save();
              },
            },
            { label: `Motion : ${s.mouseMotion ? "Relative" : "Absolute"}`, choose: toggle("mouseMotion") },
            {
              label: `L button : ${MOUSE_BUTTONS[s.mouseLeft]}`,
              choose: () => {
                s.mouseLeft = (s.mouseLeft + 1) % 6;
                this.save();
              },
            },
            {
              label: `R button : ${MOUSE_BUTTONS[s.mouseRight]}`,
              choose: () => {
                s.mouseRight = (s.mouseRight + 1) % 6;
                this.save();
              },
            },
          ],
          escape: () => this.go(5),
        };
      default:
        throw new Error("Bad menu!");
    }
  }

  // [I] Yes in the quit menu ends GAME.EXE; here it goes back to the title.
  quit() {
    this.hooks.quit?.();
    this.hooks.stopMusic();
    this.show(this.titleScreen());
  }

  // ------------------------------------------------------------ pages

  // FUN_0002c480: savesc.raw with one 256x108 page in its screen.
  // PgUp/Left and PgDn/Right turn pages, Esc leaves.
  pager(prefix, done) {
    let page = 1;
    this.setScreen({
      draw: () => {
        this.blit("savesc.raw");
        this.blitAt(`${prefix}${page}.raw`, PAGE_X, PAGE_Y, 256, 108);
      },
      key: (key, event) => {
        if (key === "PageUp" || key === "ArrowLeft") page = Math.max(1, page - 1);
        else if (key === "PageDown" || key === "ArrowRight") page = Math.min(PAGES, page + 1);
        else if (key === "Escape") done();
        // [I] A tap turns to the next page, and leaves after the last.
        else if (event?.type === "pointerdown") {
          if (page < PAGES) page += 1;
          else done();
        }
      },
    });
  }

  // FUN_0002f140: the Top Aces table, shown for 30 game seconds or a key.
  scores(done) {
    const table = DEFAULT_SCORES;
    const lit = -1; // DAT_000dddfc: the row just earned (none from the menu)
    let time = 0;
    this.setScreen({
      draw: () => {
        this.blit("savesc.raw");
        this.centred("Top Aces", 0x20);
        this.centred(`Words of Wisdom from ${table.rows[0].callsign}`, 0x30);
        this.centred(`"${table.quote}"`, 0x40);
        this.smallText("Callsign", 0x20, 0x50);
        this.smallText("Air", 0x70, 0x50);
        this.smallText("Ground", 0x98, 0x50);
        this.smallText("Green", 200, 0x50, "lit");
        this.smallText("Score", 0xf8, 0x50);
        table.rows.forEach((row, i) => {
          const mode = i === lit ? "lit" : "opaque";
          const y = 0x60 + i * 8;
          this.smallText(row.callsign, 0x20, y, mode);
          this.smallText(String(row.air), 0x78, y, mode);
          this.smallText(String(row.ground), 0xa8, y, mode);
          this.smallText(String(row.green), 0xd8, y, mode);
          this.smallText(String(row.score), 0x108, y, mode);
        });
      },
      tick: (dt) => {
        time += dt;
        if (time >= SCORE_TIME) done();
      },
      key: () => done(),
    });
  }

  // FUN_0002b4c0: the credits roll up over vel2.raw one pixel every
  // 0x2000 (1/8 game second); Left/Right make it faster/slower. The top and
  // bottom 8 rows are kept clear of text.
  credits(done) {
    let top = H;
    let period = 0x2000 / 0x10000;
    let clock = 0;
    this.setScreen({
      draw: () => {
        this.blit("vel2.raw");
        CREDITS.forEach((line, i) => {
          const y = top + i * 16;
          const centre = Math.trunc((W - this.smallWidth(line)) / 2);
          const split = line.indexOf("^");
          if (split >= 0) {
            this.smallText(line.slice(0, split), Math.trunc(W / 4) - Math.trunc(W / 8), y, "plain");
            this.smallText(`"${line.slice(split + 1)}"`, W - Math.trunc(W / 4) - Math.trunc(W / 8), y, "plain");
          } else if (line[0] === "i") this.smallText(line.slice(1), centre, y, "lit");
          else this.smallText(line, centre, y, "plain");
        });
        const bg = this.rawNow("vel2.raw");
        if (bg) {
          this.fb.set(bg.subarray(0, W * 8), 0);
          this.fb.set(bg.subarray(W * (H - 8), W * H), W * (H - 8));
        }
      },
      tick: (dt) => {
        clock += Math.min(dt, 0.25);
        while (clock > period) {
          clock -= period;
          top -= 1;
        }
        if (top < -0x360) done();
      },
      key: (key) => {
        if (key === "Escape") done();
        else if (key === "ArrowLeft") period = Math.max(0x800, period * 0x10000 - 0x800) / 0x10000;
        else if (key === "ArrowRight") period = Math.min(0x10000, period * 0x10000 + 0x800) / 0x10000;
        else if (key === "Enter") done(); // [I] tap
      },
    });
  }

  // ------------------------------------------------------------ new game

  // 0x2e640: mission, difficulty, name and call sign, then the first level.
  newGame() {
    this.selectMission((episode) => {
      if (!episode) return this.backToLoop(1, 0);
      this.selectDifficulty((difficulty) => {
        if (difficulty < 0) return this.backToLoop(1, 0);
        this.enterName((pilot) => {
          if (!pilot) return this.backToLoop(1, 0);
          // Name "Terminal", call sign "Reality": the hidden mission.
          const mission = pilot.name === "Terminal" && pilot.callsign === "Reality" ? HIDDEN : episode;
          const levels = this.missionLevels(mission.file);
          if (!levels.length) return this.backToLoop(1, 0);
          this.settings.difficulty = difficulty;
          this.save();
          this.hide();
          this.hooks.startGame({ level: levels[0], levels, difficulty, mission: mission.name, ...pilot });
        });
      });
    });
  }

  // A .vox file: a count, the mission name, then "planet,stage,file.lvl" lines.
  missionLevels(file) {
    const text = this.vox[file];
    if (!text) return SHIPPED_VOX[file] || [];
    const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return rows.slice(2).map((row) => row.split(",")[2]).filter(Boolean).map((name) => name.trim().toLowerCase().replace(/\.lvl$/, ""));
  }

  // FUN_0002e060: the episodes in the small font, the chosen one lit.
  selectMission(done) {
    let cursor = 0;
    const count = EPISODES.length;
    this.setScreen({
      draw: () => {
        this.blit("savesc.raw");
        let y = Math.trunc((H - (count * 8 + 0x10)) / 2);
        this.centred("Select Mission", y - 0x10);
        this.pointerItems = [];
        EPISODES.forEach((episode, i) => {
          this.centred(episode.name, y, i === cursor ? "lit" : "opaque");
          this.pointerItems.push({ x: 0, y, w: W, h: 8, choose: () => done(EPISODES[i]) });
          y += 8;
        });
      },
      key: (key) => {
        if (key === "ArrowUp") cursor = (cursor + count - 1) % count;
        else if (key === "ArrowDown") cursor = (cursor + 1) % count;
        else if (key === "Enter") done(EPISODES[cursor]);
        else if (key === "Escape") done(null);
      },
    });
  }

  // FUN_0002e3d0: Easy/Normal/Hard/Terminal, Normal first.
  selectDifficulty(done) {
    let cursor = 1;
    this.setScreen({
      draw: () => {
        this.blit("savesc.raw");
        let y = 0x4c;
        this.centred("Select Difficulty Level", y - 0x10);
        this.pointerItems = [];
        DIFFICULTIES.forEach((name, i) => {
          this.centred(name, y, i === cursor ? "lit" : "opaque");
          this.pointerItems.push({ x: 0, y, w: W, h: 8, choose: () => done(i) });
          y += 8;
        });
      },
      key: (key) => {
        if (key === "ArrowUp") cursor = (cursor + 3) % 4;
        else if (key === "ArrowDown") cursor = (cursor + 1) % 4;
        else if (key === "Enter") done(cursor);
        else if (key === "Escape") done(-1);
      },
    });
  }

  // FUN_0004b750: brief.raw with the ship turning in its window (FUN_0004b5e0),
  // a name and a call sign of up to 9 characters each.
  enterName(done) {
    const pilot = { name: "", callsign: "" };
    const typed = { name: "", callsign: "" };
    let field = "name";
    this.setScreen({
      enter: () => this.setHole(SHIP_RECT),
      draw: () => {
        this.blit("brief.raw");
        // The ship's view is cleared to palette 0 each frame (FUN_00042fe5(0)).
        for (let y = SHIP_RECT.y; y < SHIP_RECT.y + SHIP_RECT.h; y++) {
          this.fb.fill(0, y * W + SHIP_RECT.x, y * W + SHIP_RECT.x + SHIP_RECT.w);
        }
        // The input line is "%s%s_    " with ": " in front (FUN_0004b4a0);
        // a finished line keeps its last look, cursor and all.
        this.smallText("Enter your name, pilot", 0x3e, 0x94, "lit");
        this.smallText(`: ${typed.name}_    `, 0x3e, 0x9c);
        if (field === "callsign") {
          this.smallText("Enter your call sign", 0x3e, 0xa4, "lit");
          this.smallText(`: ${typed.callsign}_    `, 0x3e, 0xac);
        }
      },
      key: (key) => {
        if (key === "Escape") {
          this.setHole(null);
          return done(null);
        }
        if (key === "Enter") {
          if (field === "name") {
            pilot.name = typed.name || "John Doe";
            field = "callsign";
          } else {
            pilot.callsign = typed.callsign || "Ice Man";
            this.setHole(null);
            done(pilot);
          }
          return;
        }
        if (key === "Backspace") typed[field] = typed[field].slice(0, -1);
        else if (key.length === 1 && key >= " " && key < "\x80" && typed[field].length < NAME_LEN) typed[field] += key;
      },
    });
  }

  // 0x2e800 → FUN_0002dbe0: eight save slots. [I] There are no saved games
  // here, so every slot reads empty and choosing one does nothing.
  restore() {
    let cursor = 0;
    this.setScreen({
      draw: () => {
        this.blit("savesc.raw");
        const mid = Math.trunc((W - Math.trunc(W / 2)) / 2) + Math.trunc(W / 8);
        const top = Math.trunc((H - 0x40) / 2);
        const quarter = Math.trunc(W / 4);
        this.centred("Select Restore Game", top - 0x28);
        this.smallText("Name", mid - quarter, top - 0x18);
        this.smallText("Description", mid, top - 0x18);
        this.smallText("Stage", W - quarter, top - 0x18);
        for (let i = 0; i < 8; i++) {
          const y = top - 8 + i * 8;
          const mode = i === cursor ? "lit" : "opaque";
          this.smallText("- Empty -", mid - quarter, y, mode);
          this.smallText("- No description -", mid, y, mode);
          this.smallText("(0-0)", W - quarter, y, mode);
        }
      },
      key: (key) => {
        if (key === "ArrowUp") cursor = (cursor + 7) % 8;
        else if (key === "ArrowDown") cursor = (cursor + 1) % 8;
        else if (key === "Escape" || key === "Enter") this.backToLoop(1, 0);
      },
    });
  }

  // 0x2ed30: back to the flight that was left with Esc.
  resume() {
    this.hide();
    this.hooks.resumeGame();
  }

  // ------------------------------------------------------------ in game

  // FUN_0002b900: "Loading level" in the big font on a cleared screen.
  loading() {
    this.show({
      draw: () => {
        this.clear();
        const text = "Loading level";
        this.bigText(text, Math.trunc((W - this.bigWidth(text)) / 2), Math.trunc((H - BIG_H) / 2), 3);
      },
    });
    this.screen.draw();
    this.present();
  }

  // ------------------------------------------------------------ level start

  // In a level the screen shows the level's palette (FUN_000146d0). 2D art
  // drawn in the VGA palette is matched to it first when the two differ
  // (DAT_00095d24, built at startup; DAT_00067770 says they are the same).
  useLevelPalette(palette) {
    this.palette = palette || this.vga;
    this.remap = null;
    if (!palette || palette.every((v, i) => v === this.vga[i])) return;
    this.remap = new Uint8Array(256);
    for (let i = 0; i < 256; i++) this.remap[i] = nearest(palette, this.vga[i * 3], this.vga[i * 3 + 1], this.vga[i * 3 + 2]);
  }

  blitMatched(name) {
    this.blit(name);
    if (this.remap) for (let i = 0; i < W * H; i++) this.fb[i] = this.remap[this.fb[i]];
  }

  // FUN_0004b880: every colour cut to its top two bits of six (>> 4), read
  // back through the 5-bit colour cube, so the picture goes nearly black.
  dim() {
    const pal = this.palette;
    const table = new Uint8Array(256);
    const level = (c) => (((c >> 2) >> 4) * 255) / 31;
    for (let i = 0; i < 256; i++) table[i] = nearest(pal, level(pal[i * 3]), level(pal[i * 3 + 1]), level(pal[i * 3 + 2]));
    for (let i = 0; i < W * H; i++) this.fb[i] = table[this.fb[i]];
  }

  clearWindow() {
    for (let y = SHIP_RECT.y; y < SHIP_RECT.y + SHIP_RECT.h; y++) {
      this.fb.fill(0, y * W + SHIP_RECT.x, y * W + SHIP_RECT.x + SHIP_RECT.w);
    }
  }

  // FUN_0004b930 (from FUN_0004bbf0): the level's story .mic typed in the
  // small font over vel2.raw, dimmed, from (8, 8); a newline goes down 8.
  // Ends after 45 game seconds, or on Esc, Enter or fire.
  story(text, done) {
    const chars = [...text.replaceAll("\r", "")];
    let at = 0;
    let x = STORY_X;
    let y = 8;
    let time = 0;
    let typing = 0;
    const finish = () => {
      if (this.screen !== screen) return;
      this.screen = null;
      done();
    };
    const screen = {
      enter: () => {
        this.blit("vel2.raw");
        this.dim();
      },
      draw: () => {},
      tick: (dt) => {
        time += dt;
        typing += dt * STORY_CPS;
        for (; typing >= 1 && at < chars.length; typing--) {
          const ch = chars[at++];
          if (ch === "\n") {
            x = STORY_X;
            y += 8;
          } else {
            this.smallText(ch, x, y, "plain");
            x += this.smallWidth(ch);
          }
        }
        if (time > STORY_TIME) finish();
      },
      key: (key, event) => {
        if (key === "Escape" || key === "Enter" || key === " " || event?.type === "pointerdown") finish();
      },
    };
    this.show(screen);
  }

  // FUN_0004aef0: the planet briefing. brief.raw; the model named on the
  // file's first line (with the texture on its second) turns in the window
  // over the stars; the rest scrolls up under it a pixel every 0x2801, a
  // new line every 8 pixels, lit at (0x3e, 0xac). "$" and all after it
  // become the call sign (FUN_0004aeb0). A line starting "." ends it, then
  // 32 more pixels of scroll. done(key): the key that cut it short, if any.
  briefing({ text, callsign }, done) {
    const head = /^\s*(\S+)\s+(\S+)\s*/.exec(text);
    const body = head ? text.slice(head[0].length) : text;
    const lines = body.split(/(?<=\n)/);
    let remaining = text.length; // the file size, less each line read
    let next = 0;
    let clock = 0;
    let scrolled = 8;
    let tail = 0;
    const view = { kind: "brief", model: head?.[1].toLowerCase() || "", texture: head?.[2].toLowerCase() || "", angle: 0 };
    const finish = (key = null) => {
      if (this.screen !== screen) return;
      this.setHole(null);
      this.screen = null;
      done(key);
    };
    const readLine = () => {
      let line = next < lines.length ? lines[next++].slice(0, 0x4f) : null;
      if (line === null) return false;
      remaining -= line.length;
      if (remaining < 1 || line[0] === ".") return false;
      const sign = line.indexOf("$");
      if (sign >= 0) line = line.slice(0, sign) + callsign;
      this.smallText(line, BRIEF_TEXT.x, BRIEF_TEXT.y, "lit");
      return true;
    };
    const scroll = () => {
      const { x, top, bottom, w } = BRIEF_TEXT;
      for (let y = top; y < bottom; y++) this.fb.copyWithin(y * W + x, (y + 1) * W + x, (y + 1) * W + x + w);
    };
    const screen = {
      enter: () => {
        this.blitMatched("brief.raw");
        this.setHole(SHIP_RECT, view);
      },
      draw: () => this.clearWindow(),
      tick: (dt) => {
        view.angle += dt * 0x1000 / 0x10000; // 1/16 turn per game second
        clock += dt;
        if (clock <= BRIEF_STEP) return;
        clock -= BRIEF_STEP;
        scroll();
        scrolled += 1;
        if (tail) {
          if (++tail > BRIEF_TAIL) finish();
        } else if (scrolled > 7) {
          scrolled = 0;
          if (!readLine()) tail = 1;
        }
      },
      key: (key, event) => {
        if (key === "Escape" || key === "F1") finish("Escape");
        else if (key === " " || event?.type === "pointerdown") finish(" ");
      },
    };
    this.show(screen);
  }

  // FUN_00049cb0: one target of the tactical report. brief.raw again; the
  // level turns round the target in the window while its description is
  // typed lit from (0x3e, 0x94), a word wrapped when it would pass 0x3e
  // from the right edge at 7 pixels a letter. done("next") after two
  // circles with the text all out, or on Space; done("abort") on Esc/F1.
  report(target, done) {
    const text = target.description;
    const view = { kind: "report", target, angle: 0 };
    let at = 0;
    let x = BRIEF_TEXT.x;
    let y = 0x94;
    let typing = 0;
    const finish = (how) => {
      if (this.screen !== screen) return;
      this.setHole(null);
      this.screen = null;
      done(how);
    };
    const typeOne = () => {
      const ch = text[at];
      this.smallText(ch, x, y, "lit");
      x += this.smallWidth(ch);
      at += 1;
      if (text[at] !== " ") return;
      const rest = text.slice(at + 1);
      const space = rest.indexOf(" ");
      const word = space < 0 ? rest.length : space;
      if (W - BRIEF_TEXT.x < word * 7 + x) {
        at += 1;
        y += 8;
        x = BRIEF_TEXT.x;
      }
    };
    const screen = {
      enter: () => {
        this.blitMatched("brief.raw");
        this.setHole(SHIP_RECT, view);
      },
      draw: () => this.clearWindow(),
      tick: (dt) => {
        view.angle += dt * REPORT_TURN;
        typing += dt * REPORT_CPS;
        for (; typing >= 1 && at < text.length; typing--) typeOne();
        if (view.angle > REPORT_TURNS && at >= text.length) finish("next");
      },
      key: (key, event) => {
        if (key === "Escape" || key === "F1") finish("abort");
        else if (key === " " || event?.type === "pointerdown") finish("next");
      },
    };
    this.show(screen);
  }

  // FUN_0002cdd0: Esc in flight asks "Return to Menu (Y/N)" in the big font
  // over the frozen view; Y goes back to the main menu (and Play Game then
  // offers Resume Game), any other key flies on.
  // [I] y = a quarter down the screen; the original uses the 3D view's
  // window (DAT_0007cf9c + DAT_0007cf84 / 4).
  askReturn(done) {
    this.show({
      draw: () => {
        this.clear();
        this.inked = new Uint8Array(W * H);
        const text = "Return to Menu (Y/N)";
        this.bigText(text, Math.trunc((W - this.bigWidth(text)) / 2), Math.trunc(H / 4), 3);
      },
      key: (key) => {
        const yes = key.toLowerCase() === "y";
        this.hide();
        done(yes);
        if (yes) this.backToLoop(1, 0);
      },
    });
  }
}

// Nearest of palette entries 0..0xef to an 8-bit colour.
function nearest(pal, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < LEVEL_COLOURS; i++) {
    const d = (pal[i * 3] - r) ** 2 + (pal[i * 3 + 1] - g) ** 2 + (pal[i * 3 + 2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Jumps for ?menu=<name> (debugging).
const SCREENS = {
  title: (m) => m.show(m.titleScreen()),
  main: (m) => m.enterLoop(1),
  options: (m) => m.enterLoop(2),
  sound: (m) => m.enterLoop(3),
  graphics: (m) => m.enterLoop(4),
  control: (m) => m.enterLoop(5),
  quit: (m) => m.enterLoop(6),
  play: (m) => m.enterLoop(7),
  mouse: (m) => m.enterLoop(8),
  help: (m) => { m.enterLoop(1, 2); m.pager("help", () => m.backToLoop(1, 2)); },
  order: (m) => { m.enterLoop(1, 4); m.pager("order", () => m.backToLoop(1, 4)); },
  scores: (m) => { m.enterLoop(1, 3); m.scores(() => m.credits(() => m.backToLoop(1, 3))); },
  credits: (m) => { m.enterLoop(1, 3); m.credits(() => m.backToLoop(1, 3)); },
  mission: (m) => { m.enterLoop(7); m.newGame(); },
  restore: (m) => { m.enterLoop(7, 1); m.restore(); },
};

// [I] 5x7 stand-in for the small font when GAME.EXE was not given.
const FALLBACK_FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12], ":": [0, 12, 12, 0, 12, 12, 0], ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 12, 4, 8], "-": [0, 0, 0, 31, 0, 0, 0], "/": [1, 1, 2, 4, 8, 16, 16],
  "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8], '"': [10, 10, 0, 0, 0, 0, 0],
  "%": [24, 25, 2, 4, 8, 19, 3], "!": [4, 4, 4, 4, 4, 0, 4], "?": [14, 17, 1, 2, 4, 0, 4],
  _: [0, 0, 0, 0, 0, 0, 31], "^": [4, 10, 17, 0, 0, 0, 0],
};
