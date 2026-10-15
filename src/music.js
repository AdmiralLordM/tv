// Level music: the game's 6-channel .mod files played through libopenmpt.
// chiptune3 runs libopenmpt (WebAssembly) inside an AudioWorklet, so decoding
// happens on the audio thread, not the page's main thread.
const CHIPTUNE = "https://cdn.jsdelivr.net/npm/chiptune3@0.8.9/chiptune3.js";
const VOLUME = 0.55;

let player = null;
let ready = null;
let playing = null;
let muted = false;
let level = 1; // Music Volume (0.25..1) and Music On/Off from the options

// Browsers start audio only after a user gesture, so the player is created
// on the first call that comes from a click or key press.
function ensurePlayer() {
  if (ready) return ready;
  ready = import(CHIPTUNE).then(({ ChiptuneJsPlayer }) => new Promise((resolve, reject) => {
    player = new ChiptuneJsPlayer({ repeatCount: -1 });
    player.onInitialized(() => {
      player.setVol(volume());
      resolve(player);
    });
    player.onError((err) => console.warn("music:", err));
    setTimeout(() => reject(new Error("music player did not start")), 15000);
  })).catch((err) => {
    console.warn("music unavailable:", err);
    ready = null;
    return null;
  });
  return ready;
}

// Call from a user gesture. Resumes a context the browser suspended.
export function wakeMusic() {
  player?.context?.resume?.();
}

export async function playMusic(url) {
  if (!url) return stopMusic();
  const p = await ensurePlayer();
  if (!p) return;
  p.context.resume?.();
  if (playing === url) {
    p.unpause();
    return;
  }
  playing = url;
  p.load(url);
}

export function stopMusic() {
  if (!player || !playing) return;
  player.pause();
}

function volume() {
  return muted ? 0 : VOLUME * level;
}

export function toggleMusic() {
  muted = !muted;
  player?.setVol(volume());
  return !muted;
}

// on: Music On/Off; scale: Music Volume as 0..1.
export function setMusicLevel(on, scale) {
  muted = !on;
  level = scale;
  player?.setVol(volume());
}
