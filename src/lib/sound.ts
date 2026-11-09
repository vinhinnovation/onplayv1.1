import { useSyncExternalStore } from 'react';

/**
 * Âm thanh OnQuiz (Web Audio API).
 *  - Nhạc nền: file CC0 trong /public/audio (xem CREDITS.txt), phát vòng lặp, chuyển bài có fade.
 *  - Hiệu ứng ngắn: tổng hợp trực tiếp bằng oscillator, không dùng mẫu âm của bên thứ ba.
 *  - Trình duyệt chặn tự phát âm thanh: chỉ bắt đầu sau lần chạm/bấm đầu tiên (xem unlock()).
 *  - Mọi lỗi (không giải mã được file, không có Web Audio) đều bị nuốt: game vẫn chạy, chỉ im lặng.
 */

export type Role = 'host' | 'player';
export type Track = 'lobby' | 'question' | 'leaderboard' | 'victory';
export type Sfx = 'join' | 'start' | 'click' | 'tick' | 'correct' | 'wrong' | 'timeup' | 'reveal';

// gain đã cân theo độ to (RMS) đo được của từng file để các bản nhạc nghe đều nhau
const TRACKS: Record<Track, { urls: string[]; loop: boolean; gain: number }> = {
  lobby:       { urls: ['/audio/lobby.mp3'],                            loop: true,  gain: 0.78 },
  question:    { urls: ['/audio/question.ogg', '/audio/question.mp3'],  loop: true,  gain: 0.21 }, // OGG lặp liền mạch hơn; MP3 cho trình duyệt cũ
  leaderboard: { urls: ['/audio/leaderboard.mp3'],                      loop: true,  gain: 0.36 },
  victory:     { urls: ['/audio/victory.mp3'],                          loop: false, gain: 0.7 },
};

/** Chọn file đầu tiên mà trình duyệt phát được (Safari cũ không hỗ trợ OGG Vorbis). */
function pickUrl(urls: string[]): string {
  const a = document.createElement('audio');
  const ok = (u: string) => !u.endsWith('.ogg') || a.canPlayType('audio/ogg; codecs="vorbis"') !== '';
  return urls.find(ok) ?? urls[urls.length - 1];
}

const FADE_S = 0.5;
const MUSIC_VOL = 0.7;  // âm lượng tổng của nhạc nền
const SFX_VOL = 0.8;    // âm lượng tổng của hiệu ứng

/* ---------- Cài đặt người dùng (nhớ trong localStorage, có thể bị chặn nên luôn try/catch) ---------- */
const read = (k: string, def: boolean): boolean => {
  try { const s = localStorage.getItem(k); return s === null ? def : s === '1'; } catch { return def; }
};
const write = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };

interface State { musicOn: boolean; sfxOn: boolean; locked: boolean }
let role: Role = 'player';
let state: State = { musicOn: false, sfxOn: true, locked: true };
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };

/* ---------- Engine ---------- */
let ctx: AudioContext | null = null;
let musicBus: GainNode | null = null;
let sfxBus: GainNode | null = null;
const buffers = new Map<Track, Promise<AudioBuffer | null>>();
let wanted: Track | null = null;                   // bài nhạc mà màn hình hiện tại muốn phát
let current: { track: Track; src: AudioBufferSourceNode; gain: GainNode } | null = null;
let token = 0;                                      // huỷ các lần phát đã quá hạn (đổi bài nhanh)
let listening = false;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    musicBus = ctx.createGain(); musicBus.gain.value = MUSIC_VOL; musicBus.connect(ctx.destination);
    sfxBus = ctx.createGain();   sfxBus.gain.value = SFX_VOL;     sfxBus.connect(ctx.destination);
    ctx.onstatechange = () => set({ locked: ctx?.state !== 'running' });
    set({ locked: ctx.state !== 'running' });
    return ctx;
  } catch { return null; }
}

/** Gọi trong sự kiện bấm/chạm của người dùng để mở khoá âm thanh, rồi phát bài đang chờ. */
function unlock() {
  const c = getCtx();
  if (!c) return;
  void c.resume().then(() => { set({ locked: c.state !== 'running' }); applyMusic(); }).catch(() => { /* ignore */ });
}

function ensureListeners() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) window.addEventListener(ev, unlock, { passive: true });
  // Tab bị ẩn / điện thoại khoá màn hình: tạm dừng; quay lại thì chạy tiếp
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend().catch(() => { /* ignore */ });
    else void ctx.resume().catch(() => { /* ignore */ });
  });
}

function load(track: Track): Promise<AudioBuffer | null> {
  let p = buffers.get(track);
  if (!p) {
    p = (async () => {
      const c = getCtx();
      if (!c) return null;
      try {
        const res = await fetch(pickUrl(TRACKS[track].urls));
        if (!res.ok) return null;
        return await c.decodeAudioData(await res.arrayBuffer()); // trình duyệt không hỗ trợ định dạng sẽ ném lỗi
      } catch { return null; }
    })();
    buffers.set(track, p);
  }
  return p;
}

function stopCurrent(fade = FADE_S) {
  const c = current;
  current = null;
  if (!c || !ctx) return;
  const t = ctx.currentTime;
  c.gain.gain.cancelScheduledValues(t);
  c.gain.gain.setValueAtTime(c.gain.gain.value, t);
  c.gain.gain.linearRampToValueAtTime(0, t + fade);
  try { c.src.stop(t + fade + 0.05); } catch { /* đã dừng */ }
}

/** Đưa trạng thái phát khớp với (wanted, musicOn, locked). Gọi mỗi khi một trong ba thứ đổi. */
function applyMusic() {
  const my = ++token;
  const want = state.musicOn && !state.locked ? wanted : null;
  if (!want) { stopCurrent(); return; }
  if (current?.track === want) return;
  stopCurrent();
  void load(want).then((buf) => {
    if (!buf || !ctx || !musicBus || my !== token) return; // đã có yêu cầu mới hơn
    const cfg = TRACKS[want];
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = cfg.loop;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(cfg.gain, t + FADE_S);
    src.connect(gain); gain.connect(musicBus);
    src.start();
    current = { track: want, src, gain };
    src.onended = () => { if (current?.src === src) current = null; };
  });
}

/* ---------- Hiệu ứng tổng hợp ---------- */
function tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  if (!ctx || !sfxBus) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  const t = ctx.currentTime + at;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);       // attack ngắn, tránh tiếng "tách"
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(sfxBus);
  o.start(t); o.stop(t + dur + 0.05);
}

const SFX_DEFS: Record<Sfx, () => void> = {
  join:    () => { tone(660, 0, 0.12, 'sine', 0.35); tone(990, 0.1, 0.18, 'sine', 0.35); },
  start:   () => { tone(330, 0, 0.5, 'triangle', 0.3, 990); },
  click:   () => { tone(520, 0, 0.09, 'triangle', 0.35); },
  tick:    () => { tone(1100, 0, 0.05, 'square', 0.12); },
  reveal:  () => { tone(784, 0, 0.25, 'sine', 0.3); tone(1175, 0.08, 0.3, 'sine', 0.2); },
  correct: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.09, 0.28, 'triangle', 0.35)); },
  wrong:   () => { tone(280, 0, 0.35, 'sawtooth', 0.18, 120); },
  timeup:  () => { tone(220, 0, 0.3, 'square', 0.14); tone(165, 0.22, 0.4, 'square', 0.14); },
};

/* ---------- API công khai ---------- */
export const sound = {
  /** Đặt vai trò: host mặc định bật nhạc (loa/máy chiếu); người chơi mặc định tắt nhạc (tránh hàng trăm điện thoại cùng phát) nhưng bật hiệu ứng. */
  init(r: Role) {
    role = r;
    set({ musicOn: read(`onquiz.music.${r}`, r === 'host'), sfxOn: read(`onquiz.sfx.${r}`, true) });
    ensureListeners();
    getCtx(); // tạo sớm; vẫn ở trạng thái suspended tới khi có thao tác của người dùng
  },
  /** Màn hình hiện tại muốn phát bài nào (null = im lặng). */
  music(track: Track | null) { wanted = track; applyMusic(); },
  /** Dừng nhạc (fade out) — dùng khi rời màn hình. */
  stop() { wanted = null; applyMusic(); },
  sfx(name: Sfx) {
    if (!state.sfxOn || state.locked) return;
    try { SFX_DEFS[name](); } catch { /* ignore */ }
  },
  setMusic(on: boolean) { write(`onquiz.music.${role}`, on); set({ musicOn: on }); unlock(); applyMusic(); },
  setSfx(on: boolean) { write(`onquiz.sfx.${role}`, on); set({ sfxOn: on }); unlock(); },
};

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSound = (): State => useSyncExternalStore(subscribe, () => state);
