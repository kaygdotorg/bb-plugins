/**
 * An opt-in frame-timing probe, for measuring the plugin's animations on any browser (desktop
 * Chrome, iOS Safari in the simulator, a real phone) without dev tools.
 *
 * On:  open bb with `?cf-perf` in the URL (kept for the tab in sessionStorage), or set
 *      localStorage["cf-perf"] = "1". Off: `?cf-perf=0`.
 *
 * What it does, only while on:
 *   - Every pointer press and every key press starts an EPISODE: frame intervals (rAF to rAF) are
 *     recorded for 700ms. The HUD (top-right, inert) shows the last episodes: what was pressed,
 *     frames, the worst frame interval, the 95th percentile, and how many frames missed the
 *     display's interval (> 1.5 × the median idle interval: 8.3ms at 120Hz, 16.7ms at 60Hz).
 *   - Long tasks (PerformanceObserver "longtask", Chrome only) inside an episode are counted.
 *   - `window.__cfPerf` exposes start(label) / stop() → stats, and `episodes` (all of them), for
 *     scripted runs (CDP, XCUITest, the console).
 * Off, it costs nothing: nothing is installed.
 */
const KEY = "cf-perf";
const EPISODE_MS = 700;

interface Stats { label: string; frames: number; worst: number; p95: number; median: number; missed: number; longTasks: number; budget: number }

export function perfEnabled(): boolean {
  try {
    const q = new URLSearchParams(location.search).get(KEY);
    if (q !== null) {
      if (q === "0") { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); return false; }
      sessionStorage.setItem(KEY, "1");
    }
    return sessionStorage.getItem(KEY) === "1" || localStorage.getItem(KEY) === "1";
  } catch { return false; }
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export function mountPerfProbe(): () => void {
  if (!perfEnabled()) return () => {};

  // The display's frame interval, from idle frames at mount (median of 30).
  let vsync = 1000 / 60;
  const idle: number[] = [];
  let last = 0;
  let raf = 0;
  let current: { label: string; t0: number; deltas: number[]; longTasks: number } | null = null;
  let stopAt = 0;
  const episodes: Stats[] = [];

  const hud = document.createElement("div");
  hud.setAttribute("data-cf-perf-hud", "");
  hud.setAttribute("aria-hidden", "true");
  hud.style.cssText = "position:fixed;top:calc(env(safe-area-inset-top) + 56px);right:8px;z-index:2147483647;pointer-events:none;"
    + "font:11px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.72);padding:6px 8px;border-radius:8px;white-space:pre;max-width:46vw;overflow:hidden";
  document.body.append(hud);

  const finish = (): Stats | null => {
    if (!current) return null;
    const d = current.deltas;
    const st: Stats = {
      label: current.label, frames: d.length,
      worst: Math.max(0, ...d), p95: pct(d, 0.95), median: pct(d, 0.5),
      missed: d.filter((x) => x > vsync * 1.5).length, longTasks: current.longTasks, budget: vsync,
    };
    episodes.push(st);
    current = null;
    render();
    return st;
  };
  const render = () => {
    const rows = episodes.slice(-8).map((e) =>
      `${e.label.slice(0, 18).padEnd(18)} n${String(e.frames).padStart(3)} worst${e.worst.toFixed(1).padStart(6)} p95${e.p95.toFixed(1).padStart(6)} miss${String(e.missed).padStart(3)}${e.longTasks ? ` LT${e.longTasks}` : ""}`);
    hud.textContent = `cf-perf  vsync ${vsync.toFixed(1)}ms (${Math.round(1000 / vsync)}Hz)\n${rows.join("\n")}`;
  };

  const tick = (now: number) => {
    if (last) {
      const dt = now - last;
      if (current) current.deltas.push(dt);
      else if (idle.length < 30) { idle.push(dt); if (idle.length === 30) { vsync = pct(idle, 0.5); render(); } }
    }
    last = now;
    if (current && now >= stopAt) finish();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const start = (label: string, ms = EPISODE_MS) => {
    if (current) finish();
    current = { label, t0: performance.now(), deltas: [], longTasks: 0 };
    stopAt = current.t0 + ms;
  };
  const describe = (e: Event) => {
    if (e instanceof KeyboardEvent) return `key ${e.key}`;
    const el = e.target instanceof Element ? e.target.closest("[aria-label],[data-testid],[data-sidebar],button,a") : null;
    return (el?.getAttribute("aria-label") || el?.getAttribute("data-testid") || el?.getAttribute("data-sidebar") || el?.tagName.toLowerCase() || "press").trim();
  };
  const onPress = (e: Event) => start(describe(e));
  document.addEventListener("pointerdown", onPress, true);
  document.addEventListener("keydown", onPress, true);

  let longTasks: PerformanceObserver | null = null;
  try {
    longTasks = new PerformanceObserver((list) => { if (current) current.longTasks += list.getEntries().length; });
    longTasks.observe({ type: "longtask", buffered: false });
  } catch { longTasks = null; /* Safari: no long tasks */ }

  (window as unknown as { __cfPerf: unknown }).__cfPerf = { start, stop: finish, episodes, get vsync() { return vsync; } };
  render();

  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("pointerdown", onPress, true);
    document.removeEventListener("keydown", onPress, true);
    longTasks?.disconnect();
    hud.remove();
    delete (window as unknown as { __cfPerf?: unknown }).__cfPerf;
  };
}
