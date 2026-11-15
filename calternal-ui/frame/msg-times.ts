/**
 * Every message shows its time, by default (kayg). bb only half does:
 *   - agent replies: bb renders a <time> in the message's action metadata, but hidden until hover
 *     (opacity 0) on desktop, and not at all in the phone layout;
 *   - your messages: no time anywhere.
 * So:
 *   - bb's own agent times are always visible (CSS below) and re-formatted with the plugin's clock
 *     setting: bb builds its formatter before the plugin wraps Intl (clock.ts), so its times stayed
 *     12-hour. Only the text node's value is changed, so React keeps its node.
 *   - where bb renders none (your messages; agent replies on phones), a small <time data-cf-msg-time> is
 *     added: under your bubble, right-aligned; for agent replies, inside bb's own metadata slot (so it
 *     takes bb's styling and position). Times come from the plugin's RPC (times.ts, cached 30s).
 *
 * Cost: one MutationObserver, coalesced to one pass per frame; a pass is a query per message row (React
 * can drop our label when it re-renders a message, so presence is checked, not remembered), and times are
 * fetched again (at most every 5s) only when a message's id is missing from them (a new message).
 */
import { R } from "./selectors";
import { formatTime, messageTimes } from "./times";

const ROW = "[data-timeline-row-id]";
const USER_BUBBLE = ".rounded-xl.bg-surface-recessed";
const META = "[data-message-action-metadata]";

export const MSG_TIMES_CSS = `
/* bb's agent times: always shown, not only on hover. */
${R} ${META}:has(time) { display: flex !important; opacity: 1 !important; }
/* Our time under your bubble: small, quiet, at the bubble's right edge. */
${R} [data-cf-msg-time-row]:not([data-cf-msg-time-row="meta"]) {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.25rem;
  padding-right: 0.25rem;
  font-size: 0.75rem;
  line-height: 1rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
}
`;

const threadId = () => /\/threads\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;

export function mountMsgTimes(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = MSG_TIMES_CSS;
  document.head.append(style);

  let frame = 0;
  let times: Record<string, number> = {};
  let timesFor = "";
  let fetchedAt = 0;
  let fetching = false;
  let disposed = false;

  const reformat = (t: HTMLTimeElement) => {
    const at = Date.parse(t.getAttribute("datetime") ?? "");
    if (!Number.isFinite(at)) return;
    const text = formatTime(at);
    const node = [...t.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (node && node.nodeValue !== text) node.nodeValue = text;
  };

  const label = (at: number) => {
    const el = document.createElement("time");
    el.setAttribute("data-cf-msg-time", "");
    el.dateTime = new Date(at).toISOString();
    el.textContent = formatTime(at);
    return el;
  };

  const pass = () => {
    frame = 0;
    if (disposed) return;
    const id = threadId();
    if (!id) return;
    if (id !== timesFor) { times = {}; timesFor = id; fetchedAt = 0; }
    let missing = false;
    for (const row of document.querySelectorAll<HTMLElement>(ROW)) {
      const key = row.getAttribute("data-timeline-row-id") ?? "";
      const meta = row.querySelector<HTMLElement>(META);
      const own = meta?.querySelector<HTMLTimeElement>("time:not([data-cf-msg-time])");
      if (own) { reformat(own); continue; }
      if (row.querySelector("[data-cf-msg-time]")) continue; // already labelled
      const bubble = key.includes(":user-") ? row.querySelector<HTMLElement>(USER_BUBBLE) : null;
      if (!meta && !bubble) continue; // not a message (tool groups, reasoning): nothing to time
      const at = times[key];
      if (!at) { missing = true; continue; }
      if (bubble) {
        const line = document.createElement("div");
        line.setAttribute("data-cf-msg-time-row", "");
        line.append(label(at));
        bubble.after(line);
      } else if (meta) {
        const wrap = document.createElement("div");
        wrap.setAttribute("data-cf-msg-time-row", "meta");
        wrap.append(label(at));
        meta.append(wrap); // bb's slot shows itself once it has content (has-[>*>*]:flex)
      }
    }
    if (missing && !fetching && Date.now() - fetchedAt > 5000) {
      fetching = true;
      fetchedAt = Date.now();
      void messageTimes(id, true).then((next) => {
        fetching = false;
        if (disposed || threadId() !== id) return;
        times = next;
        schedule();
        // The first call can come before the overlay registered the RPC loader ({}): try again soon,
        // without waiting for the page to change.
        if (!Object.keys(next).length) window.setTimeout(() => { fetchedAt = 0; schedule(); }, 1000);
      });
    }
  };
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(pass); };

  // Rows arrive and re-render under the page; the body observer is coalesced to one pass per frame.
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  schedule();

  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.querySelectorAll("[data-cf-msg-time-row]").forEach((e) => e.remove());
    style.remove();
  };
}
