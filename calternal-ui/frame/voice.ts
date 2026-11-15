/**
 * Voice input as a pill (our own take on the "voice pill" idea; sveltebits is a visual
 * reference only). bb owns recording: while it records, its composer row becomes
 *   [Cancel recording] [waveform canvas] [Stop and add to draft] [Send voice input]
 * Here, driven by composer.ts's pass (no observer of its own):
 *   - the composer is marked `data-cf-voice` (recording | transcribing), so the merged
 *     icon row steps aside instead of covering the waveform;
 *   - the waveform's box becomes an accent-tinted capsule that grows out of the mic's side
 *     (css.ts), with an elapsed clock at its end. bb paints the bars in the canvas's CSS
 *     colour, so tinting them is plain CSS.
 */
const CANCEL = 'button[aria-label="Cancel recording"], button[aria-label="Cancel transcription"]';

const format = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function createVoicePill() {
  const clock = document.createElement("span");
  clock.setAttribute("data-cf-voice-clock", "");
  clock.setAttribute("aria-hidden", "true"); // bb announces "Recording" itself
  let startedAt = 0;
  let ticker = 0;

  const tick = () => { clock.textContent = format(performance.now() - startedAt); };
  const stop = () => {
    clearInterval(ticker);
    ticker = 0;
    startedAt = 0;
    clock.remove();
  };

  /** Returns true while bb shows its recording row (the caller then skips the merged row). */
  function update(composer: HTMLElement): boolean {
    const cancel = composer.querySelector<HTMLElement>(CANCEL);
    const pill = cancel?.nextElementSibling as HTMLElement | null | undefined;
    if (!cancel || !pill) {
      composer.removeAttribute("data-cf-voice");
      if (startedAt) stop();
      return false;
    }
    const transcribing = cancel.getAttribute("aria-label") === "Cancel transcription";
    composer.setAttribute("data-cf-voice", transcribing ? "transcribing" : "recording");
    pill.setAttribute("data-cf-voice-pill", "");
    if (!startedAt) {
      startedAt = performance.now();
      tick();
    }
    // The clock runs while recording and holds its last value while transcribing.
    if (!transcribing && !ticker) ticker = window.setInterval(tick, 1000);
    if (transcribing && ticker) { clearInterval(ticker); ticker = 0; }
    if (clock.parentElement !== pill) pill.append(clock);
    return true;
  }

  return { update, dispose: stop };
}
