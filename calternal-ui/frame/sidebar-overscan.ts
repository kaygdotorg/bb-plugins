/**
 * The sidebar renders further ahead while you scroll (kayg's recording, 2026-11-16: scrolling the thread list
 * fast showed blank stretches, and rows filled in a moment later).
 *
 * Why: bb's thread list (the thread-list built-in plugin) is windowed. Rows more than 240px outside the
 * scroller are empty placeholders; an IntersectionObserver with `rootMargin: "240px 0px"` fills them in as they
 * come near, and React commits that in a transition, so a fast scroll outruns it by a screen or more.
 *
 * What: IntersectionObserver is wrapped so that an observer created with exactly bb's margin ("240px 0px")
 * gets a much wider one (two screens either way). Rows then render well before they arrive. The cost is more
 * rows kept in the DOM (a few dozen light rows), not work per scroll frame. Every other observer is untouched.
 * The wrap is installed when this module is first imported (app.tsx imports it before anything else), so it is
 * in place before bb's list builds its observer; observers made before that keep bb's margin until the list
 * is re-created (a reload). Off switch: localStorage["cf-sb-overscan"] = "off".
 */
const BB_MARGIN = "240px 0px";
const ours = () => `${Math.round(Math.max(1600, (window.innerHeight || 900) * 2))}px 0px`;

const Native = window.IntersectionObserver;
let installed = false;

export function installSidebarOverscan() {
  if (installed || typeof Native !== "function" || localStorage.getItem("cf-sb-overscan") === "off") return;
  installed = true;
  class Wider extends Native {
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
      super(cb, opts && opts.rootMargin === BB_MARGIN ? { ...opts, rootMargin: ours() } : opts);
    }
  }
  window.IntersectionObserver = Wider;
}

installSidebarOverscan();
