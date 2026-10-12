/**
 * Short foreground notification tone. Synthesized — no audio asset to ship.
 * Autoplay rejection is swallowed; the notification row still appears.
 * Call ringtones are separate and must not be started from here.
 */

let ctx: AudioContext | null = null;
let lastStarted = 0;

export function playNotificationSound(now = Date.now()): void {
  if (typeof window === 'undefined') return;
  const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  if (now - lastStarted < 50) return;
  lastStarted = now;
  try {
    ctx = ctx ?? new AudioCtx();
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  } catch {
    /* autoplay or missing audio must never break the feed */
  }
}
