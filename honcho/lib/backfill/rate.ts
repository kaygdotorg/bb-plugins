/** Spaces batches so the average stays at `perMinute` messages. One batch may go
 * out immediately; the next waits for the previous batch's share of the minute. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export const defaultSleep: Sleep = (ms, signal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});
export class RateLimiter {
  private nextAt = 0;
  constructor(private readonly now: () => number = Date.now, private readonly sleep: Sleep = defaultSleep) {}
  async take(count: number, perMinute: number, signal?: AbortSignal): Promise<void> {
    const rate = Math.max(1, perMinute);
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait, signal);
    if (signal?.aborted) return;
    this.nextAt = Math.max(this.nextAt, this.now()) + (count * 60_000) / rate;
  }
}
