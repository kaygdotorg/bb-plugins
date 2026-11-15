/**
 * Marks: data attributes that replace NON-SUBJECT `:has()` in the plugin's CSS.
 *
 * Why: a rule like `A:has(B) C` or `main:not(:has(X)) > Y` makes Chrome flag the ancestors it had
 * to test; after that, ANY attribute change on those ancestors invalidates their whole subtree.
 * bb flips attributes high in the tree all the time (data-state on the sidebar wrapper, tooltips,
 * menus), so with ~40 such rules every one of bb's state changes restyled the whole app: the
 * sidebar toggle restyled ~1,060 elements instead of ~380 (desktop trace, 2026-11-15; removing the
 * non-subject :has rules brings it back to bb's own ~380). A subject `:has()` (the styled element
 * is the one with :has, e.g. `div:has(> x) { … }`) does not have this problem and stays in CSS.
 *
 * So the structure those rules tested is stamped here as attributes, and the CSS selects on the
 * attributes. One MutationObserver (childList over the body, plus main's data-sidebar-shelf),
 * coalesced to at most one stamping pass per frame; a pass is a handful of querySelector calls
 * and only writes when a mark changes.
 *
 * Marks (all set by this file only):
 *   main[data-cf-plain]                     main without a panel group (Settings, Skills): its content shell is the card
 *   [data-cf-pane-tools]                    the header div holding [data-thread-header-pane-actions] (the right toolbar)
 *   [data-cf-has-actions]                   the header content row when it has bb's "Thread actions" ⋯ button
 *   [data-cf-renaming]                      the title pill while bb's inline rename editor is in it
 *   [data-cf-title-wrap]                    the div inside the title pill that holds .bb-thread-title
 *   [data-cf-scroll-header]                 a header followed by the page's scroll viewport (it floats over it)
 *   html[data-cf-shelf-open]                phones: a side shelf (the thread drawer or a panel) is open
 */
const HEADER_ROW = 'main header [data-testid="app-page-header-content-row"]';

interface Mark { attr: string; find: () => Element[] }

const MARKS: Mark[] = [
  {
    attr: "data-cf-plain",
    find: () => [...document.querySelectorAll('main[data-sidebar="inset"]')].filter((m) => !m.querySelector("[data-panel-group]")),
  },
  {
    attr: "data-cf-pane-tools",
    find: () => [...document.querySelectorAll("main header [data-thread-header-pane-actions]")].map((a) => a.parentElement).filter((e): e is HTMLElement => !!e && e.tagName === "DIV"),
  },
  {
    attr: "data-cf-has-actions",
    find: () => [...document.querySelectorAll(HEADER_ROW)].filter((r) => r.querySelector('button[aria-label="Thread actions"]')),
  },
  {
    attr: "data-cf-renaming",
    // The title pill: the row's first cell's child (title-pill.ts PILL).
    find: () => [...document.querySelectorAll(`${HEADER_ROW} > div:first-child > div`)].filter((p) => p.querySelector("[data-sidebar-rename-editor]")),
  },
  {
    attr: "data-cf-title-wrap",
    find: () => [...document.querySelectorAll(`${HEADER_ROW} > div:first-child > div > div`)].filter((d) => d.querySelector(".bb-thread-title")),
  },
  {
    attr: "data-cf-scroll-header",
    find: () => {
      const out: Element[] = [];
      for (const v of document.querySelectorAll("main [data-page-scroll-viewport]")) {
        // `header + * [viewport]`: the header is the previous sibling of one of the viewport's ancestors.
        for (let a: Element | null = v.parentElement; a && a.tagName !== "MAIN"; a = a.parentElement) {
          const h = a.previousElementSibling;
          if (h?.tagName === "HEADER") { out.push(h); break; }
        }
      }
      return out;
    },
  },
  {
    attr: "data-cf-shelf-open",
    find: () => {
      const m = document.querySelector('main[data-sidebar="inset"][data-sidebar-shelf]');
      const v = m?.getAttribute("data-sidebar-shelf");
      return v && v !== "closed" ? [document.documentElement] : [];
    },
  },
];

export function mountMarks(): () => void {
  const current = new Map<string, Set<Element>>(MARKS.map((m) => [m.attr, new Set()]));
  let frame = 0;

  const pass = () => {
    frame = 0;
    for (const m of MARKS) {
      const now = new Set(m.find());
      const was = current.get(m.attr)!;
      for (const el of was) if (!now.has(el)) el.removeAttribute(m.attr);
      for (const el of now) if (!was.has(el)) el.setAttribute(m.attr, "");
      current.set(m.attr, now);
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(pass); };

  // The first pass synchronously: the CSS needs the marks before the first paint after mount.
  pass();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-sidebar-shelf"] });

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    for (const [attr, els] of current) for (const el of els) el.removeAttribute(attr);
  };
}
