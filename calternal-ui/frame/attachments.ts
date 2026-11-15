/**
 * Phone composer attachments (touch devices under 768px). bb lists attachments as a grid
 * above the composer's buttons, which eats the space you need to see the chat. Instead:
 *   - bb's grid is hidden and a chip sits in the free space between the left buttons
 *     (+, model) and the right ones (mic, send): a count and up to three mini thumbnails;
 *   - tapping the chip opens bb's own grid as one horizontal, swipeable strip (bb's remove
 *     buttons keep working); tapping again closes it.
 * bb's DOM is never moved: the grid is only marked and restyled (css.ts), the chip is ours.
 */
const ITEM = ":scope > div.relative";
const PHONE = "(max-width: 767px)";

function findStrip(composer: Element): HTMLElement | null {
  const img = composer.querySelector("[data-promptbox-expanded-only] button[aria-label] > img, [data-promptbox-expanded-only] button[aria-label]");
  // The grid is the flex-wrap container whose children are the attachment tiles.
  return img?.closest<HTMLElement>(".flex-wrap") ?? null;
}

export function mountAttachments(): () => void {
  if (navigator.maxTouchPoints === 0) return () => {};
  const media = window.matchMedia(PHONE);
  const chip = document.createElement("button");
  chip.type = "button";
  chip.setAttribute("data-cf-attach-chip", "");
  let composer: HTMLElement | null = null;
  let frame = 0;

  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!composer) return;
    const open = composer.getAttribute("data-cf-attach") !== "open";
    composer.setAttribute("data-cf-attach", open ? "open" : "collapsed");
    chip.setAttribute("aria-expanded", String(open));
  });

  const render = () => {
    frame = 0;
    composer = document.querySelector<HTMLElement>("[data-app-composer]");
    const strip = composer && media.matches ? findStrip(composer) : null;
    const tiles = strip ? [...strip.querySelectorAll<HTMLElement>(ITEM)] : [];
    if (!composer || tiles.length === 0) {
      chip.remove();
      composer?.removeAttribute("data-cf-attach");
      return;
    }
    strip!.setAttribute("data-cf-attach-strip", "");
    if (!composer.hasAttribute("data-cf-attach")) composer.setAttribute("data-cf-attach", "collapsed");
    const thumbs = tiles.slice(0, 3).map((t) => t.querySelector("img")?.getAttribute("src")).filter(Boolean) as string[];
    const key = `${tiles.length}|${thumbs.join("|")}`;
    if (chip.dataset.key !== key) {
      chip.dataset.key = key;
      chip.setAttribute("aria-label", `${tiles.length} attachment${tiles.length === 1 ? "" : "s"}, show`);
      chip.replaceChildren(
        ...thumbs.map((src) => Object.assign(document.createElement("img"), { src, alt: "" })),
        Object.assign(document.createElement("span"), { textContent: String(tiles.length) }),
      );
    }
    // Last in the left button group, which is flex-1: its auto margin centres the chip in the gap.
    const left = composer.querySelector('[data-promptbox-standard-actions][data-promptbox-expanded-only]');
    if (left && chip.parentElement !== left) left.append(chip);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  // One observer on the composer; edits inside the text editor are ignored (typing is hot).
  const observer = new MutationObserver((records) => {
    if (records.some((r) => !(r.target as Element).closest?.('[contenteditable="true"]'))) schedule();
  });
  const attach = () => {
    const next = document.querySelector("[data-app-composer]");
    if (next && next !== composer) {
      observer.disconnect();
      observer.observe(next, { childList: true, subtree: true });
      schedule();
    }
  };
  attach();
  const timer = window.setInterval(attach, 2000); // the composer is re-created on navigation
  media.addEventListener("change", schedule);
  return () => {
    window.clearInterval(timer);
    observer.disconnect();
    media.removeEventListener("change", schedule);
    chip.remove();
    document.querySelectorAll("[data-cf-attach]").forEach((el) => el.removeAttribute("data-cf-attach"));
  };
}
