/**
 * Swipe actions on touch devices, running bb's own actions (no core changes):
 *   thread row (sidebar)   left: Archive   right: Pin / Unpin   (via bb's context menu)
 *   message (chat)         right: Reply, iMessage-style (left to right; the bubble follows
 *                          your finger and a reply arrow grows in behind it). Left: none yet.
 * A horizontal drag slides the row and shows the action in the gap; past the threshold it
 * fires on release. Touches near the left screen edge are left to bb's drawer swipe, and a
 * row being swiped is marked so bb's own sidebar/panel swipes ignore it.
 */
const THRESHOLD = 72;
const EDGE = 28;
/** One thread row; the section wrapper above it carries the same data attribute but no role. */
const THREAD = '[data-sidebar-rename-row][role="button"]';
const MESSAGE = "[data-timeline-row-id]";

type Side = "left" | "right";
interface Action { label: string; icon?: string; tone?: "danger"; run: (row: HTMLElement) => void }
const REPLY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a context-menu item of a row with the menu hidden (html[data-cf-silent-menu]). On
 * touch devices bb shows that menu as an action sheet, so both forms are searched.
 */
async function viaContextMenu(row: HTMLElement, match: RegExp) {
  const root = document.documentElement;
  root.setAttribute("data-cf-silent-menu", "");
  try {
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.top + box.height / 2,
    }));
    for (let i = 0; i < 20; i++) {
      // A desktop context menu, or (on touch) bb's action sheet.
      const item = [...document.querySelectorAll<HTMLElement>(
        '[role="menu"] [role="menuitem"], [data-persistent-drawer-content] :is([role="menuitem"], button)',
      )]
        .find((el) => match.test(el.textContent?.trim() ?? ""));
      if (item) { item.click(); return; }
      await sleep(16);
    }
    // Not found: close the menu with an outside pointerdown. Escape would also close bb's drawer.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  } finally {
    setTimeout(() => root.removeAttribute("data-cf-silent-menu"), 150);
  }
}

/** A message's text without its action bar, as quoted lines for the composer. */
function quoted(row: HTMLElement): string[] {
  const column = row.querySelector<HTMLElement>("[data-message-column]") ?? row;
  const copy = column.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("button, [aria-hidden='true']").forEach((el) => el.remove());
  const text = (copy.innerText || "").trim().replace(/\n{3,}/g, "\n\n");
  const short = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return short.split("\n").filter((line) => line.trim()).map((line) => `> ${line}`);
}

function reply(row: HTMLElement) {
  const editor = document.querySelector<HTMLElement>('[data-app-composer] [contenteditable="true"]');
  if (!editor) return;
  editor.focus();
  // A synthetic paste: the editor parses it like a real one (line breaks, markdown), and
  // nothing simulates Enter, which in bb's composer sends the message.
  const data = new DataTransfer();
  data.setData("text/plain", `${quoted(row).join("\n")}\n\n`);
  editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

const ACTIONS: Record<"thread" | "message", Partial<Record<Side, Action>>> = {
  thread: {
    // Each row has its own Archive button (bb's hover action); the menu is only a fallback.
    left: {
      label: "Archive", tone: "danger",
      run: (row) => {
        const button = row.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
        if (button) button.click(); else void viaContextMenu(row, /^archive$/i);
      },
    },
    right: { label: "Pin", run: (row) => void viaContextMenu(row, /^(un)?pin$/i) },
  },
  message: {
    right: { label: "Reply", icon: REPLY_ICON, run: reply },
  },
};

export function mountSwipes(): () => void {
  let row: HTMLElement | null = null;
  let kind: "thread" | "message" = "thread";
  let startX = 0, startY = 0, dx = 0, decided: "swipe" | "scroll" | null = null;
  const label = document.createElement("div");
  label.setAttribute("data-cf-swipe-label", "");

  const settle = () => {
    if (!row) return;
    const r = row;
    r.style.transition = "translate 220ms cubic-bezier(0.32,0.72,0,1)";
    r.style.translate = "";
    label.style.opacity = "0";
    label.removeAttribute("data-ready");
    setTimeout(() => { if (!r.style.translate) { r.style.transition = ""; r.removeAttribute("data-no-sidebar-swipe"); r.removeAttribute("data-no-secondary-panel-swipe"); } }, 240);
  };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (touch.clientX < EDGE) return; // the screen edge belongs to bb's drawer swipe
    const target = e.target as Element;
    const thread = target.closest<HTMLElement>(THREAD);
    const message = thread ? null : target.closest<HTMLElement>(MESSAGE);
    row = thread ?? message;
    if (!row) return;
    kind = thread ? "thread" : "message";
    // Marked before bb's own handlers see the touch, so they leave this row alone.
    row.setAttribute("data-no-sidebar-swipe", "");
    row.setAttribute("data-no-secondary-panel-swipe", "");
    startX = touch.clientX; startY = touch.clientY; dx = 0; decided = null;
  };

  const onMove = (e: TouchEvent) => {
    if (!row || decided === "scroll") return;
    const touch = e.touches[0];
    const x = touch.clientX - startX, y = touch.clientY - startY;
    if (!decided) {
      if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
      decided = Math.abs(x) > Math.abs(y) * 1.5 ? "swipe" : "scroll";
      if (decided === "scroll") { settle(); row = null; return; }
      const parent = row.parentElement;
      if (parent && getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent?.insertBefore(label, row);
    }
    const side: Side = x < 0 ? "left" : "right";
    const action = ACTIONS[kind][side];
    // No action this way: the row barely gives, like iMessage. Otherwise 1:1 to the
    // threshold, then resistance.
    const mag = Math.abs(x);
    const travel = !action ? Math.min(12, mag * 0.15) : mag <= THRESHOLD ? mag : THRESHOLD + (mag - THRESHOLD) * 0.35;
    dx = Math.sign(x) * Math.min(140, travel);
    row.style.transition = "none";
    row.style.translate = `${dx}px 0`;
    if (!action) { label.style.opacity = "0"; return; }
    const ready = Math.abs(dx) >= THRESHOLD;
    if (ready && !label.hasAttribute("data-ready")) navigator.vibrate?.(6);
    if (action.icon) label.innerHTML = action.icon; else label.textContent = action.label;
    label.setAttribute("aria-label", action.label);
    label.dataset.tone = action.tone ?? "";
    label.style.left = side === "right" ? "0" : "auto";
    label.style.right = side === "left" ? "0" : "auto";
    label.style.top = `${row.offsetTop}px`;
    label.style.height = `${row.offsetHeight}px`;
    label.style.bottom = "auto";
    const progress = Math.min(1, Math.abs(dx) / THRESHOLD);
    label.style.opacity = String(progress);
    label.style.scale = action.icon ? String(0.6 + 0.4 * progress) : "";
    label.toggleAttribute("data-ready", ready);
  };

  const onEnd = () => {
    if (!row) return;
    const fire = decided === "swipe" && Math.abs(dx) >= THRESHOLD;
    const target = row;
    const action = ACTIONS[kind][dx < 0 ? "left" : "right"];
    settle();
    row = null;
    if (fire && action) action.run(target);
  };

  // bb decides its drawer/panel swipe from the target at pointerdown, which fires before
  // touchstart: mark the row there (capture phase, so before bb's own listeners run).
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || e.clientX < EDGE) return;
    const target = (e.target as Element).closest<HTMLElement>(`${THREAD}, ${MESSAGE}`);
    if (!target) return;
    target.setAttribute("data-no-sidebar-swipe", "");
    target.setAttribute("data-no-secondary-panel-swipe", "");
  };
  window.addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
  document.addEventListener("touchstart", onStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", settle, { passive: true });
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", settle);
    label.remove();
  };
}
