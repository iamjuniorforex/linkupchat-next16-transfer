/**
 * Phase 4B — client-side call sounds (ringtone + ringback) with WebAudio.
 *
 * No sound library, no binary assets: tones are synthesized with oscillator
 * nodes. Browser autoplay restrictions are respected — when the AudioContext
 * starts suspended (no user gesture yet) the manager records `isBlocked()` and
 * the UI can call `resumeOnGesture()` from its next genuine tap. A blocked
 * context never throws into the call flow: the call proceeds silently.
 */

export type SoundMode = 'off' | 'ringtone' | 'ringback';

/** True while any call ring/ringback pattern is the active sound. */
let callSoundActive = false;

export function isCallSoundActive(): boolean {
  return callSoundActive;
}

export interface SoundClock {
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
}

export class CallSounds {
  private ctx: AudioContext | null = null;
  private mode: SoundMode = 'off';
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private activeNodes: AudioScheduledSourceNode[] = [];
  private blocked = false;
  /** Generation counter — stale async `kick`s from a previous start are ignored. */
  private patternSeq = 0;
  private clock: SoundClock;

  constructor(clock?: SoundClock) {
    this.clock = clock ?? {
      setInterval: (fn, ms) => {
        const id = setInterval(fn, ms);
        if (typeof id.unref === 'function') id.unref();
        return id;
      },
      clearInterval: (id) => clearInterval(id)
    };
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof window !== 'undefined'
          ? (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
          : undefined;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** True when audio could not start (autoplay policy) and needs a user gesture. */
  isBlocked(): boolean {
    return this.blocked;
  }

  getMode(): SoundMode {
    return this.mode;
  }

  /** Called from a real user gesture to unblock/resume the AudioContext. */
  async resumeOnGesture(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      this.blocked = ctx.state !== 'running';
    } catch {
      this.blocked = true;
    }
    // Restart the pending pattern now that audio may be allowed.
    if (!this.blocked && this.mode !== 'off') {
      const mode = this.mode;
      this.stopAll();
      if (mode === 'ringtone') this.startRingtone();
      else this.startRingback();
    }
  }

  /** Incoming-call ring: a repeating two-note pattern (600ms on, 1.2s pause). */
  startRingtone() {
    this.startPattern('ringtone', () => {
      this.playTone(880, 0.6, 0.18);
      this.loopTimer = this.clock.setInterval(() => this.playTone(880, 0.6, 0.18), 1800);
    });
  }

  /** Outgoing ringback: a repeating beep (1s on, 3s off — standard ringback). */
  startRingback() {
    this.startPattern('ringback', () => {
      this.playTone(440, 1.0, 0.12);
      this.loopTimer = this.clock.setInterval(() => this.playTone(440, 1.0, 0.12), 4000);
    });
  }

  private startPattern(mode: SoundMode, first: () => void) {
    this.stopAll();
    const seq = ++this.patternSeq;
    this.mode = mode;
    callSoundActive = true;
    const ctx = this.ensureContext();
    if (!ctx) {
      // No WebAudio available → silent call, not a broken one.
      this.blocked = true;
      return;
    }
    const kick = () => {
      if (seq !== this.patternSeq) return; // superseded by stopAll/restart
      if (ctx.state !== 'running') {
        // Autoplay policy: record and let the UI resume on its next gesture.
        this.blocked = true;
        return;
      }
      this.blocked = false;
      first();
    };
    if (ctx.state === 'running') {
      kick();
    } else {
      // Blocked until proven otherwise — set SYNCHRONOUSLY so callers never
      // observe a silent-but-unmarked state.
      this.blocked = true;
      ctx.resume().then(kick).catch(() => {
        this.blocked = true;
      });
    }
  }

  private playTone(freq: number, durationSec: number, gainValue: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = gainValue;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      osc.start(now);
      gain.gain.setValueAtTime(gainValue, now);
      gain.gain.linearRampToValueAtTime(gainValue, now + durationSec - 0.05);
      gain.gain.linearRampToValueAtTime(0.0001, now + durationSec);
      osc.stop(now + durationSec);
      this.activeNodes.push(osc);
      osc.onended = () => {
        this.activeNodes = this.activeNodes.filter((n) => n !== osc);
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* already disconnected */
        }
      };
    } catch {
      // Tone synthesis must never break the call flow.
    }
  }

  /** Stop every tone/loop and reset to silent (idempotent). */
  stopAll() {
    this.patternSeq++; // invalidate pending async starts
    if (this.loopTimer) {
      this.clock.clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    for (const node of this.activeNodes) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeNodes = [];
    this.mode = 'off';
    callSoundActive = false;
  }

  /** Release the AudioContext entirely (provider unmount). */
  dispose() {
    this.stopAll();
    try {
      void this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.blocked = false;
  }
}
