/**
 * A denser composer, on every device, without moving bb's DOM (React owns it).
 *
 * Expanded (desktop; phones while typing), three rows:
 *   text area
 *   attachments
 *   [+] [model + reasoning] [context ring] [permission icon] [environment icon] ··· [mic] [send]
 * bb's own row under the composer (environment, branch, new-thread, permission, context) is
 * pinned into the composer's bottom row, right after the model button: positioned over that
 * row's free space and re-measured with one ResizeObserver. Its labels become icons with warm
 * tooltips (data-cf-title, read by tooltip.ts). "New thread here" moves into the + menu.
 *
 * Collapsed (phones when not typing): one line, [attachments] [text] ··· [model] [mic] [send].
 * bb renders no footer and no model button then, so the model icon is remembered from the
 * expanded composer (localStorage); tapping it expands the composer and opens bb's picker.
 */
const COMPOSER = '[data-app-composer][data-app-composer-role="primary"]';
const FOOTER = "[data-follow-up-composer-footer]";
const ROW = "[data-promptbox-action-row]";
const MODEL = 'button[aria-label^="Provider, model"]';
const NEW_THREAD = 'button[aria-label="New thread in this environment"]';

/** Maps bb's permission-mode title to one of four icons (css.ts). */
function permissionKind(title: string): "full" | "edit" | "plan" | "ask" {
  if (/full access|bypass|yolo|no sandbox/i.test(title)) return "full";
  if (/plan|read[- ]only/i.test(title)) return "plan";
  if (/edit|write|accept|auto/i.test(title)) return "edit";
  return "ask";
}

const MODEL_CACHE = "cf-composer-model";

export function mountComposer(): () => void {
  // The last model seen, so the collapsed line can show its icon before the picker exists.
  let lastModel: { icon: string; label: string } = { icon: "", label: "Model" };
  try { lastModel = { ...lastModel, ...JSON.parse(localStorage.getItem(MODEL_CACHE) ?? "{}") }; } catch { /* none yet */ }

  let composer: HTMLElement | null = null;
  let frame = 0;
  const resize = new ResizeObserver(() => schedule());
  const mutations = new MutationObserver((records) => {
    // Typing is hot: edits inside the editor never trigger a pass.
    if (records.some((r) => !(r.target as Element).closest?.('[contenteditable="true"]'))) schedule();
  });

  // The phone's collapsed line gets a model icon: tap expands, then opens bb's picker.
  const modelChip = document.createElement("button");
  modelChip.type = "button";
  modelChip.setAttribute("data-cf-model-chip", "");
  modelChip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const editor = composer?.querySelector<HTMLElement>('[contenteditable="true"]');
    editor?.focus();
    setTimeout(() => composer?.querySelector<HTMLButtonElement>(MODEL)?.click(), 220);
  });

  function pass() {
    frame = 0;
    const next = document.querySelector<HTMLElement>(COMPOSER);
    if (next !== composer) {
      mutations.disconnect();
      resize.disconnect();
      composer = next;
      if (!composer) return;
      mutations.observe(composer, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label", "data-promptbox-collapsed"] });
      resize.observe(composer);
    }
    if (!composer) return;
    const followUp = composer.querySelector<HTMLElement>("[data-follow-up-composer]");
    const footer = composer.querySelector<HTMLElement>(FOOTER);
    const form = composer.querySelector<HTMLElement>("form[data-promptbox]");
    const row = composer.querySelector<HTMLElement>(ROW);
    const model = composer.querySelector<HTMLElement>(MODEL);
    if (!followUp || !form || !row) return;
    // bb also marks a desktop composer collapsed after Escape while still showing everything:
    // "collapsed" for us means the expanded-only controls (the model button) are gone.
    const modelShown = !!model && model.getBoundingClientRect().width > 0;
    const collapsed = form.hasAttribute("data-promptbox-collapsed") && !modelShown;
    composer.toggleAttribute("data-cf-collapsed", collapsed);

    // Collapsed composers render neither the footer nor the model button.
    if (footer) labelControls(footer);
    if (model) {
      const seen = {
        // bb draws the provider logo as a masked span, not an svg.
        icon: model.querySelector("[data-provider-logo]")?.parentElement?.outerHTML ?? lastModel.icon,
        label: model.getAttribute("aria-label")?.replace(/\s*\(.*\)$/, "") ?? lastModel.label,
      };
      if (seen.icon !== lastModel.icon || seen.label !== lastModel.label) {
        lastModel = seen;
        try { localStorage.setItem(MODEL_CACHE, JSON.stringify(seen)); } catch { /* private mode */ }
      }
    }

    // Expanded: pin the footer into the bottom row, after the model button.
    const modelBox = model?.getBoundingClientRect();
    if (footer && !collapsed && modelBox && modelBox.width > 0) {
      const base = followUp.getBoundingClientRect();
      // Every icon here is a 2rem box with its glyph centred, so glyph-to-glyph gaps equal the
      // + → model gap (1rem). The model button's right edge is its chevron's visual end plus
      // half that gap, so the first box starts right there. Vertically it shares the model
      // button's box, not the row's (the row is not symmetric).
      const px = (n: number) => `${n.toFixed(1)}px`;
      followUp.style.setProperty("--cf-foot-x", px(modelBox.right - base.left));
      followUp.style.setProperty("--cf-foot-y", px(modelBox.top - base.top));
      followUp.style.setProperty("--cf-foot-h", px(modelBox.height));
      // Never over the right-hand buttons (the mic): cap the width to the free space.
      const right = row.lastElementChild?.getBoundingClientRect();
      if (right) followUp.style.setProperty("--cf-foot-w", px(Math.max(0, right.left - modelBox.right - 4)));
      composer.setAttribute("data-cf-merged", "");
      resize.observe(row);
    } else {
      composer.removeAttribute("data-cf-merged");
    }

    // Collapsed on a phone: add the model icon (remembered from the expanded composer) to
    // bb's right-hand group.
    const submit = composer.querySelector<HTMLElement>("[data-promptbox-submit-group]");
    if (collapsed && lastModel.icon && submit) {
      if (modelChip.dataset.icon !== lastModel.icon) {
        modelChip.dataset.icon = lastModel.icon;
        modelChip.innerHTML = lastModel.icon;
      }
      modelChip.setAttribute("aria-label", lastModel.label);
      // First in the right-hand group, so the line reads [model] [mic] [send].
      const group = submit.parentElement!;
      if (group.firstElementChild !== modelChip) group.prepend(modelChip);
    } else {
      modelChip.remove();
    }
  }

  /** Icons need words for the tooltip; bb's own labels supply them. */
  function labelControls(footer: HTMLElement) {
    const env = footer.querySelector<HTMLElement>("[data-option-display]");
    // The flex item that holds the folder, name, branch and new-thread button: the child of
    // the footer's wrapper (that wrapper is display: contents, so this item is what orders).
    let envBox: HTMLElement | null = env ?? null;
    while (envBox?.parentElement && envBox.parentElement.parentElement !== footer) envBox = envBox.parentElement;
    const branch = footer.querySelector<HTMLElement>("[data-promptbox-hide-branch-compact]")?.textContent?.trim();
    if (envBox && env) {
      const name = (env.getAttribute("title") ?? env.textContent ?? "").replace(/^Environment:\s*/, "").trim();
      envBox.setAttribute("data-cf-env", "");
      envBox.dataset.cfTitle = branch ? `${name} · ${branch}` : name;
      envBox.setAttribute("role", envBox.getAttribute("role") ?? "img");
      envBox.setAttribute("aria-label", envBox.dataset.cfTitle);
    }
    const permission = footer.querySelector<HTMLElement>('button[aria-label="Permission mode"]');
    const permissionTitle = permission?.querySelector("[title]")?.getAttribute("title")
      ?? permission?.querySelector("[data-cf-title]")?.getAttribute("data-cf-title") ?? "";
    if (permission && permissionTitle) {
      permission.dataset.cfTitle = permissionTitle;
      permission.dataset.cfPerm = permissionKind(permissionTitle);
    }
    const context = footer.querySelector<HTMLElement>('button[aria-label^="Context window"]');
    const pct = Number(/(\d+)%/.exec(context?.getAttribute("aria-label") ?? "")?.[1] ?? 0);
    context?.toggleAttribute("data-cf-hot", pct >= 80);
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(pass);
  }

  /** "New thread here" joins the + menu when it opens (bb's own button stays the action). */
  const onPointerDown = (e: PointerEvent) => {
    const plus = (e.target as Element).closest?.('button[aria-label="Prompt actions"]');
    if (!plus || !composer) return;
    const source = composer.querySelector<HTMLButtonElement>(NEW_THREAD);
    if (!source) return;
    let tries = 0;
    const add = () => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      if (!menu) { if (++tries < 20) setTimeout(add, 25); return; }
      if (menu.querySelector("[data-cf-new-thread]")) return;
      const template = menu.querySelector<HTMLElement>('[role="menuitem"]');
      const item = document.createElement("div");
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.setAttribute("data-cf-new-thread", "");
      item.className = template?.className ?? "";
      item.innerHTML = `${source.querySelector("svg")?.outerHTML ?? ""}<span>New thread here</span>`;
      item.addEventListener("click", () => {
        // Close the menu with an outside press: Escape would also close bb's phone drawer.
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        source.click();
      });
      menu.append(item);
    };
    setTimeout(add, 0);
  };

  const timer = window.setInterval(schedule, 1500); // the composer is re-created on navigation
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  schedule();
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    mutations.disconnect();
    resize.disconnect();
    modelChip.remove();
    document.querySelectorAll("[data-cf-merged], [data-cf-collapsed]").forEach((el) => {
      el.removeAttribute("data-cf-merged");
      el.removeAttribute("data-cf-collapsed");
    });
  };
}
