# Terminal Velocity in the browser

`index.html` is the whole thing: pick a level, look at the map, press **Fly**.
It reads the original game data directly; nothing is converted first.

```sh
python3 -m http.server          # from the repo root
# open http://localhost:8000/
```

On first start the page asks for the game's two archives, `STARTUP.POD` and
`CDROM.POD`. They are stored in the browser (IndexedDB) and read in place from
then on; **Forget game files** removes them. For development,
`?pods=_oracle/` downloads them from that folder instead of asking.

The page opens like the game: title, then the main menu (`src/menu.js`).
Add the loose `*.VOX` mission lists from the game folder at setup to use your
own copies; without them the shipped lists are built in.

Shortcuts past the menus:
- `?play=artic` flies a level in game mode (Esc asks to return to the menu);
  add `&difficulty=easy|normal|hard|terminal`, and `&intro=1` to run the
  level's start (story, briefing, tactical report, fly-in) as New Game does.
- `?menu=<screen>` opens one screen: `title`, `main`, `play`, `options`,
  `sound`, `graphics`, `control`, `mouse`, `quit`, `help`, `order`, `scores`,
  `credits`, `mission`, `restore`.
- Bare viewer (no menus): `?level=artic` shows the map, `&fly=1` drops into
  the cockpit, `?mode=model&model=afighter` opens a model.
- `?debug` exposes `window.tv`.

| Path | What it is |
|---|---|
| `index.html`, `src/` | The game: POD reader, file formats, palette renderer, flight |
| `tools/check/` | Node checks: `formats.mjs` and `bin.mjs` compare the JS readers with the Python extractor on `_orig/` |
| `tools/tvextract.py` | Unpacks PODs to `_orig/` and writes a browsable `extracted/` gallery (not needed to play) |
| `tools/re/` | Reverse-engineering helpers for `GAME.EXE` |
| `docs/original-engine.md` | Engine values and file formats recovered from `GAME.EXE` |
| `legacy/` | Earlier prototypes |

Flight keys, as in the original: arrows steer (up = nose down), A/Z throttle,
Shift afterburner (Alt in DOS). Added here: mouse steering (mouse up = nose up), Q/E roll,
M music, P pause, Esc leaves.
