/**
 * Background music: one looping track under the menu, and a shuffled playlist
 * across a run — each track crossfading into the next as it ends.
 *
 * `HTMLAudioElement`, not Web Audio. There is no audio graph in this project —
 * nothing pans, ducks, or reacts to the world — and a plain media element gets
 * streaming, looping, and decode for free, where an `AudioContext` would mean
 * fetching and decoding whole tracks into memory to accomplish the same thing.
 * The one thing this file has to hand-roll is the volume ramp, which is a few
 * lines of `requestAnimationFrame`.
 *
 * Three things this owns that are easy to get wrong:
 *
 * - **Autoplay.** A page that has never been interacted with cannot start
 *   audio, and the rejection arrives as a *promise rejection from `play()`* —
 *   not an exception, so a bare `el.play()` fails silently and the game is
 *   simply mute forever. Every start goes through `start()`, which catches that
 *   and re-arms itself on the next real input. In practice the menu's Standard
 *   button is that input, so a run's music is never blocked.
 * - **Fades are per element, not global.** Switching tracks crossfades: the
 *   outgoing one rides its 1 s fade down while the incoming one takes its 2 s
 *   fade up. A single "current volume" would make that a cut.
 * - **Mute is `el.muted`, not volume 0.** The fade ramp keeps running
 *   underneath, so unmuting mid-fade-in lands at the volume the ramp had
 *   reached rather than snapping to full.
 *
 * Volume is `gain × master`: `gain` is what the fades move (0..1), `master` is
 * the player's setting. They are multiplied on every write, so changing the
 * slider mid-fade does the sane thing.
 */

export interface MusicTrack {
  /** Stable key — what "don't repeat the last one" compares, and what the settings store. */
  id: string;
  title: string;
  /** Filename under `public/audio/music/`. */
  file: string;
}

/** Served straight out of `public/`, so the deploy's base path has to be prepended. */
const MUSIC_DIR = 'audio/music/';

export const MUSIC_TRACKS: readonly MusicTrack[] = [
  {
    id: 'ultra-speed',
    title: 'Ultra Speed',
    file: 'musinova-ultra-speed-liquid-jungle-breakbeat-drum-and-bass-358430.mp3',
  },
  {
    id: 'astral-waves',
    title: 'Astral Waves',
    file: 'musinova-astral-waves-liquid-jungle-breakbeat-dnb-356500.mp3',
  },
  {
    id: 'cyber-breaks',
    title: 'Cyber Breaks',
    file: 'musinova-cyber-breaks-liquid-jungle-breakbeat-drum-and-bass-470307.mp3',
  },
  {
    id: 'hyper-world',
    title: 'Hyper World',
    file: 'musinova-hyper-world-liquid-jungle-dnb-444655.mp3',
  },
  {
    id: 'light-dnb',
    title: 'Light Drum & Bass',
    file: 'penguinmusic-light-drum-and-bass-216588.mp3',
  },
  {
    id: 'proximity',
    title: 'Proximity',
    file: 'penguinmusic-proximity-liquid-drum-and-bass-186378.mp3',
  },
  {
    id: 'sleeping-sky',
    title: 'Sleeping Sky',
    file: 'wild-speed-records-shound-sleeping-sky-477427.mp3',
  },
  {
    id: 'moment-ride',
    title: 'Moment Ride',
    file: 'wild-speed-records-shound-moment-ride-477399.mp3',
  },
  {
    id: 'purple-flowers',
    title: 'Purple Flowers',
    file: 'wild-speed-records-shound-purple-flowers-477423.mp3',
  },
  {
    id: 'avalon',
    title: 'Avalon',
    file: 'Maduk - Avalon.mp3',
  },
  {
    id: 'levitate',
    title: 'Levitate',
    file: 'Maduk - Levitate.mp3',
  },
];

/** The menu bed. Fixed rather than random: the front door should sound the same every time. */
export const MENU_TRACK_ID = 'ultra-speed';

export const DEFAULT_MUSIC_VOLUME = 0.35;

const FADE_IN_SECONDS = 2;
const FADE_OUT_SECONDS = 1;

/**
 * The seam between two gameplay tracks: the outgoing one ramps down over this
 * while the incoming one ramps up, starting this long before the outgoing track
 * runs out. Shorter than the 2 s opening fade on purpose — that one introduces
 * the music, this one just gets out of the way.
 */
const CROSSFADE_SECONDS = 2;

/**
 * What counts as the interaction that lifts the autoplay block. `keydown` is in
 * here because a player who starts the menu with `1` instead of the mouse has
 * still interacted, and `pointerdown` rather than `click` so the pointer-lock
 * click that starts a run counts as early as possible.
 */
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

interface Fade {
  el: HTMLAudioElement;
  from: number;
  to: number;
  elapsed: number;
  duration: number;
  /** Pause and rewind the element once the ramp lands on zero. */
  stopAtEnd: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export class MusicManager {
  /**
   * Built on first use rather than up front: the nine tracks are ~53 MB
   * together, and a player who never leaves the menu should pay for one. The
   * cost of that is a run whose track is fetched on the spot — which the
   * fade-in covers, because it only starts once playback actually does.
   */
  private readonly elements = new Map<string, HTMLAudioElement>();
  /** Fade position per element, 0..1. Multiplied by `master` to get `el.volume`. */
  private readonly gains = new Map<HTMLAudioElement, number>();

  private fades: Fade[] = [];
  private rafHandle: number | null = null;
  private lastFrameMs = 0;

  private currentId: string | null = null;
  /** What the shuffle refuses to deal next — set by *any* start, menu included. */
  private lastTrackId: string | null = null;

  /**
   * True while a run owns the audio. It is what decides whether a track loops
   * (menu, editor) or hands over to the next one (gameplay), and it gates the
   * end-of-track watcher so a menu bed never advances.
   */
  private playlist = false;

  /**
   * The shuffle bag: every track, in a random order, dealt one at a time and
   * refilled when empty.
   *
   * A bag rather than an independent random draw each time, because "shuffle"
   * means what it means on a music player — you hear all nine before you hear
   * any of them twice. Drawing at random with only a no-immediate-repeat rule
   * would happily play four songs and leave five untouched for an hour.
   */
  private bag: string[] = [];

  /** Guards the hand-over so a burst of `timeupdate`s cannot deal twice. */
  private advancing = false;

  private master = DEFAULT_MUSIC_VOLUME;
  private muted = false;

  /** The element an autoplay block is holding, waiting on the next interaction. */
  private blocked: HTMLAudioElement | null = null;
  /** The fade the blocked start was going to use, so the retry matches it. */
  private blockedFade = FADE_IN_SECONDS;
  private unlockArmed = false;

  // ------------------------------------------------------------------ public

  /**
   * Starts a run's music and keeps it going: the shuffle bag deals a track, and
   * when that track nears its end the next one is dealt and crossfaded in. A
   * run outlasts any single song, so gameplay is a playlist rather than a loop.
   *
   * Called once per run — including restarts off the game-over screen, which is
   * why `Game` gets a run-start hook rather than `App` calling this only on the
   * way in from the menu.
   */
  playGameplayMusic(): void {
    this.playlist = true;
    this.playTrack(this.pickTrack().id);
  }

  /** Fades the run's music out over 1 s and parks it at the top of the track. */
  stopGameplayMusic(): void {
    this.playlist = false;
    this.stop();
  }

  /**
   * The fixed menu bed. Also what plays in the editor — a build session is not
   * silence. This one *does* loop: it is a single chosen track holding one
   * screen, where the run's music is a playlist that has to keep moving.
   */
  playMenuMusic(): void {
    this.playlist = false;
    this.playTrack(MENU_TRACK_ID);
  }

  /** 0..1. Applied immediately, mid-fade included. */
  setVolume(value: number): void {
    this.master = clamp01(value);
    for (const el of this.elements.values()) this.applyVolume(el);
  }

  getVolume(): number {
    return this.master;
  }

  /** Returns the state it settled on, so the caller can persist it. */
  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const el of this.elements.values()) el.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** What is playing right now, for a readout or a debug handle. Null between tracks. */
  get currentTrack(): MusicTrack | null {
    return MUSIC_TRACKS.find((track) => track.id === this.currentId) ?? null;
  }

  // ----------------------------------------------------------------- playback

  /**
   * Everything that starts audio funnels through here, so the crossfade and the
   * autoplay retry exist in exactly one place.
   */
  private playTrack(
    id: string,
    fadeIn = FADE_IN_SECONDS,
    fadeOut = FADE_OUT_SECONDS,
  ): void {
    const track = MUSIC_TRACKS.find((candidate) => candidate.id === id);
    if (!track) return;
    this.lastTrackId = id;

    const el = this.element(track);
    // A menu bed holds one screen and should loop; a run's track is one entry in
    // a playlist and has to be allowed to end so the next can be dealt. Set per
    // playback rather than per element, because the same file is both — the menu
    // track is in the shuffle bag too.
    el.loop = !this.playlist;

    if (this.currentId === id) {
      // Already the current track — this is a re-entry (menu → editor → menu),
      // not a change. Ride the existing playhead back up rather than restarting
      // the song from the top under the player.
      this.start(el, fadeIn);
      return;
    }

    // Everything else goes down as this one comes up.
    for (const other of this.elements.values()) {
      if (other !== el) this.rampTo(other, 0, fadeOut, true);
    }

    this.currentId = id;
    this.setGain(el, 0);
    // From the top: a run's music should open on the intro, not wherever the
    // last visit to this track left the playhead.
    el.currentTime = 0;
    this.start(el, fadeIn);
  }

  private stop(): void {
    this.currentId = null;
    this.blocked = null;
    for (const el of this.elements.values()) this.rampTo(el, 0, FADE_OUT_SECONDS, true);
  }

  /** Deals the next track off the shuffle bag, refilling it when it runs dry. */
  private pickTrack(): MusicTrack {
    if (this.bag.length === 0) this.refillBag();
    const id = this.bag.shift();
    return MUSIC_TRACKS.find((track) => track.id === id) ?? MUSIC_TRACKS[0];
  }

  /** Fisher-Yates over every track. */
  private refillBag(): void {
    const ids = MUSIC_TRACKS.map((track) => track.id);
    for (let i = ids.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    // The one seam a bag does not fix by itself: the last track of the old bag
    // and the first of the new one can be the same, which is the one repeat a
    // listener actually notices. Push it deeper rather than reshuffling, which
    // could land on it again.
    if (ids.length > 1 && ids[0] === this.lastTrackId) {
      const swap = 1 + Math.floor(Math.random() * (ids.length - 1));
      [ids[0], ids[swap]] = [ids[swap], ids[0]];
    }
    this.bag = ids;
  }

  /**
   * Hands over to the next track shortly *before* the current one runs out, so
   * the two overlap instead of leaving a hole.
   *
   * Driven by `timeupdate` (roughly 4 Hz, plenty of resolution for a 2 s lead)
   * with `ended` as the backstop: a backgrounded tab throttles timers, and a
   * stream whose duration is not known yet reports `NaN`, so both paths have to
   * work. `advancing` is what stops the two of them dealing twice.
   */
  private maybeAdvance(el: HTMLAudioElement, ended: boolean): void {
    if (!this.playlist || this.advancing) return;
    if (el !== this.elements.get(this.currentId ?? '')) return;

    if (!ended) {
      const remaining = el.duration - el.currentTime;
      if (!Number.isFinite(remaining) || remaining > CROSSFADE_SECONDS) return;
    }

    this.advancing = true;
    this.playTrack(this.pickTrack().id, CROSSFADE_SECONDS, CROSSFADE_SECONDS);
    this.advancing = false;
  }

  private element(track: MusicTrack): HTMLAudioElement {
    const existing = this.elements.get(track.id);
    if (existing) return existing;

    // BASE_URL carries the deploy prefix (`/surf-proto/` on Pages, `/` in dev).
    // Hard-coding a leading slash here is what would 404 every track in
    // production while working perfectly on localhost.
    const el = new Audio(`${import.meta.env.BASE_URL}${MUSIC_DIR}${track.file}`);
    // Looping is decided per playback in `playTrack` — the menu loops, a run's
    // playlist has to be allowed to end. When it does loop it is the element's
    // own `loop`, not a timeupdate seek: the browser restarts the decode at the
    // buffer boundary, which is as close to gapless as an mp3 gets.
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    el.muted = this.muted;
    // Registered once per element, for the lifetime of the manager. Both paths
    // are guarded in `maybeAdvance`, so an element that is not the current one —
    // or a menu bed, which never advances — costs a compare and returns.
    el.addEventListener('timeupdate', () => this.maybeAdvance(el, false));
    el.addEventListener('ended', () => this.maybeAdvance(el, true));
    this.elements.set(track.id, el);
    this.gains.set(el, 0);
    return el;
  }

  /**
   * `play()` returns a promise that *rejects* when autoplay policy blocks it —
   * it does not throw, so an un-awaited call fails invisibly. Catching it and
   * waiting for the next real interaction is the whole autoplay story.
   *
   * The fade-in is hung off the *resolution* rather than started alongside the
   * call, and that is not a detail: the promise settles when sound actually
   * begins, so a blocked or still-buffering track no longer burns its two
   * seconds of ramp in silence and then snap on at full volume.
   */
  private start(el: HTMLAudioElement, seconds: number): void {
    const attempt = el.play() as Promise<void> | undefined;
    // Older Safari returns undefined from play() rather than a promise.
    if (!attempt) {
      this.fadeIn(el, seconds);
      return;
    }
    attempt.then(
      () => this.fadeIn(el, seconds),
      () => {
        // Either autoplay policy, or `halt()` pausing this element out from
        // under an in-flight play() — the guard in `armUnlock` tells them
        // apart, since only the first can still be the wanted track.
        this.setGain(el, 0);
        this.armUnlock(el, seconds);
      },
    );
  }

  /**
   * Guarded because a start can resolve late: by the time a slow track finally
   * plays, the player may already have moved on, and fading in a track that has
   * since been swapped out would leave two songs going.
   */
  private fadeIn(el: HTMLAudioElement, seconds: number): void {
    if (el !== this.elements.get(this.currentId ?? '')) return;
    this.rampTo(el, 1, seconds, false);
  }

  private armUnlock(el: HTMLAudioElement, seconds: number): void {
    if (el !== this.elements.get(this.currentId ?? '')) return;
    this.blocked = el;
    this.blockedFade = seconds;
    if (this.unlockArmed) return;
    this.unlockArmed = true;

    const resume = () => {
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, resume);
      this.unlockArmed = false;
      const target = this.blocked;
      const seconds = this.blockedFade;
      this.blocked = null;
      // Only if it is still the track we want. Between the block and the click
      // the player may already have started a run, and reviving the menu bed
      // underneath the gameplay track would leave two songs playing. `start`
      // rather than `play` — this attempt gets the fade-in the blocked one
      // never got to run, and re-arms if the gesture is refused too.
      if (target && target === this.elements.get(this.currentId ?? '')) {
        this.start(target, seconds);
      }
    };

    for (const type of UNLOCK_EVENTS) {
      window.addEventListener(type, resume, { passive: true });
    }
  }

  // -------------------------------------------------------------------- fades

  private rampTo(
    el: HTMLAudioElement,
    to: number,
    duration: number,
    stopAtEnd: boolean,
  ): void {
    const from = this.gains.get(el) ?? 0;
    // One fade per element: a new ramp replaces whatever the element was doing
    // rather than fighting it, so a rapid menu → run → menu never stacks.
    this.fades = this.fades.filter((fade) => fade.el !== el);

    if (duration <= 0 || from === to) {
      this.setGain(el, to);
      if (stopAtEnd && to === 0) this.halt(el);
      return;
    }
    // Proportional to the distance left: a fade-out interrupted at 0.3 gain
    // takes 0.3 s to finish, not the full second, so a re-entered menu does not
    // sit under a long tail.
    const scaled = duration * Math.abs(to - from);
    this.fades.push({ el, from, to, elapsed: 0, duration: scaled, stopAtEnd });
    this.startTicker();
  }

  private startTicker(): void {
    if (this.rafHandle !== null) return;
    this.lastFrameMs = performance.now();
    this.rafHandle = requestAnimationFrame((now) => this.tickFades(now));
  }

  /**
   * Render-rate, not the fixed gameplay tick: fades are presentation and must
   * keep running while the sim is paused behind the "click to start" overlay.
   * A backgrounded tab stops delivering frames and so freezes a fade in place —
   * harmless, since the next frame after refocus resumes it from where it was.
   */
  private tickFades(nowMs: number): void {
    this.rafHandle = null;
    const dt = Math.max(0, Math.min(0.25, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;

    const done: Fade[] = [];
    for (const fade of this.fades) {
      fade.elapsed += dt;
      const t = fade.duration <= 0 ? 1 : Math.min(1, fade.elapsed / fade.duration);
      this.setGain(fade.el, fade.from + (fade.to - fade.from) * t);
      if (t >= 1) done.push(fade);
    }
    if (done.length > 0) {
      this.fades = this.fades.filter((fade) => !done.includes(fade));
      for (const fade of done) {
        if (fade.stopAtEnd && fade.to === 0) this.halt(fade.el);
      }
    }
    if (this.fades.length > 0) {
      this.rafHandle = requestAnimationFrame((next) => this.tickFades(next));
    }
  }

  /** Silence is not enough — a paused-out track must not keep streaming. */
  private halt(el: HTMLAudioElement): void {
    el.pause();
    el.currentTime = 0;
    if (this.blocked === el) this.blocked = null;
  }

  private setGain(el: HTMLAudioElement, gain: number): void {
    this.gains.set(el, clamp01(gain));
    this.applyVolume(el);
  }

  private applyVolume(el: HTMLAudioElement): void {
    el.volume = clamp01((this.gains.get(el) ?? 0) * this.master);
  }
}
