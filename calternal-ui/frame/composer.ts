/**
 * A denser composer, on every device, without moving bb's DOM (React owns it).
 *
 * Expanded (desktop; phones while typing), three rows:
 *   text area
 *   attachments
 *   [+] [model + reasoning] [toolbar: context ring, permission, environment] ··· [mic] [send]   (all pills)
 * bb's own row under the composer (environment, branch, new-thread, permission, context) is
 * pinned into the composer's bottom row, right after the model button: positioned over that
 * row's free space and re-measured with one ResizeObserver. Its labels become icons with warm
 * tooltips (data-cf-title, read by tooltip.ts). "New thread here" moves into the + menu.
 *
 * Collapsed (phones when not typing): one line, [attachments] [text] ··· [model] [mic] [send].
 * bb renders no footer and no model button then, so the model icon is remembered from the
 * expanded composer (localStorage); tapping it expands the composer and opens bb's picker.
 */
import { createVoicePill } from "./voice";

const COMPOSER = '[data-app-composer][data-app-composer-role="primary"]';
const FOOTER = "[data-follow-up-composer-footer]";
const ROW = "[data-promptbox-action-row]";
// Never the chip we add for the one-line composer (it must not count as bb's button, or
// collapsed/expanded flips every frame and the icon flickers).
const MODEL = 'button[aria-label^="Provider, model"]:not([data-cf-model-chip])';
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
  const voice = createVoicePill();
  // The last model seen, so the collapsed line can show its icon before the picker exists.
  let lastModel: { icon: string; label: string } = { icon: "", label: "Model" };
  /** The form's height as of the last pass, and whether it was collapsed: the start of the focus morph. */
  let lastForm: { el: HTMLElement | null; h: number; collapsed: boolean } = { el: null, h: 0, collapsed: false };
  let flippedAt = -Infinity;
  let morphing: { form: HTMLElement; until: number } | null = null;
  let opening: { form: HTMLElement; composer: HTMLElement; anim: Animation; at: number; from: number; to: number } | null = null;
  let expandedH = 0; // the two-row form's height, last seen (the early open grows toward it)
  let collapsedH = 0; // the one-line form's height, last seen (the early close shrinks toward it)
  let closing: { form: HTMLElement; composer: HTMLElement; anim: Animation; fade: Animation | null; at: number; from: number; to: number } | null = null;
  const MORPH_MS = 350;
  const MORPH_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
  const phone = matchMedia("(max-width: 767px)");
  const animates = () => document.documentElement.getAttribute("data-cf-input") !== "keys" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** The form's size, seen after layout and before paint (a ResizeObserver): bb lays out the new rows a frame
   *  after it flips the flag, so the pass alone would let one full-height frame show before the morph. */
  const formSize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const f = (e.target as HTMLElement).closest<HTMLElement>("form[data-promptbox]");
      if (f) morphHeight(f, f.closest("[data-app-composer]")?.hasAttribute("data-cf-collapsed") ?? lastForm.collapsed);
    }
  });
  let sizedForm: HTMLElement | null = null;
  try { lastModel = { ...lastModel, ...JSON.parse(localStorage.getItem(MODEL_CACHE) ?? "{}") }; } catch { /* none yet */ }

  let composer: HTMLElement | null = null;
  let frame = 0;
  // After dispose, nothing may run again: a pass already queued for the next frame would
  // re-observe the row and re-add the model chip, leaving a zombie generation behind each
  // plugin reload (two chips on kayg's phone, 2026-11-15).
  let disposed = false;
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

  // Write only what changed. The observer below watches aria-label/title in the composer, and every
  // setAttribute queues a mutation record even when the value is the same: unconditional writes made
  // each pass schedule the next, a loop that forced a frame (style + layout reads) every frame on
  // an idle page (desktop trace, 2026-11-15: ~97 identical writes/attribute in 2s).
  const setAttr = (el: Element, name: string, value: string) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
  const setVar = (el: HTMLElement, name: string, value: string) => { if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value); };

  function pass() {
    frame = 0;
    if (disposed) return;
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

    // ── Reads first, writes after: a write followed by a layout read forces a second layout, and
    // this pass runs on every frame of a resize (the sidebar slide resizes the composer): with the
    // reads interleaved it cost ~9ms a call (desktop trace, 2026-11-15).
    const modelBox = model?.getBoundingClientRect();
    let geo: { x: number; y: number; free: number | null; need: number; shown: boolean; gap: number } | null = null;
    if (footer && !collapsed && modelBox && modelBox.width > 0) {
      const base = followUp.getBoundingClientRect();
      // The footer is a toolbar capsule (pills-composer.ts): it starts one pill gap after the
      // model pill (the gap the left group already uses, so + → model → toolbar are equal), and
      // its centre line is the model pill's, so everything shares one line.
      const gap = parseFloat(getComputedStyle(model!.parentElement ?? model!).columnGap) || 0;
      // Never over the right-hand buttons (the mic): cap the width to the free space.
      const right = row.lastElementChild?.getBoundingClientRect();
      geo = {
        x: modelBox.right + gap - base.left,
        y: modelBox.top + modelBox.height / 2 - base.top,
        free: right ? Math.max(0, right.left - modelBox.right - 2 * gap) : null,
        need: footer.scrollWidth, // its natural width (it clips to --cf-foot-w)
        shown: getComputedStyle(footer).display !== "none",
        gap,
      };
    }

    // ── Writes.
    composer.toggleAttribute("data-cf-collapsed", collapsed);
    if (sizedForm !== form) {
      formSize.disconnect();
      formSize.observe(form);
      // The rows' own box too: during an early open the form's height is the animation's, so only this one
      // tells when bb has laid out its rows.
      const rows = form.querySelector("[data-promptbox-layout]");
      if (rows) formSize.observe(rows);
      sizedForm = form;
    }
    morphHeight(form, collapsed);
    // Collapsed composers render neither the footer nor the model button.
    if (footer) labelControls(footer);
    if (model) {
      const seen = {
        // bb draws the provider logo as a masked span, not an svg.
        icon: model.querySelector("[data-provider-logo]")?.parentElement?.outerHTML ?? lastModel.icon,
        // "Claude Code: Opus 5.5 · Medium reasoning" (bb's title), else its generic label.
        label: model.querySelector("[title]")?.getAttribute("title")
          ?? model.querySelector("[data-cf-title]")?.getAttribute("data-cf-title")
          ?? lastModel.label,
      };
      if (seen.icon !== lastModel.icon || seen.label !== lastModel.label) {
        lastModel = seen;
        try { localStorage.setItem(MODEL_CACHE, JSON.stringify(seen)); } catch { /* private mode */ }
      }
    }

    // While bb records voice its row is the recording bar: the merged icons step aside.
    const recording = voice.update(composer);

    // Expanded: pin the footer into the bottom row, after the model button.
    if (footer && geo && !recording) {
      const px = (n: number) => `${n.toFixed(1)}px`;
      setVar(followUp, "--cf-foot-x", px(geo.x));
      setVar(followUp, "--cf-foot-y", px(geo.y));
      const free = geo.free ?? Infinity;
      if (geo.free !== null) setVar(followUp, "--cf-foot-w", px(geo.free));
      const shown = geo.shown && geo.need > 0;
      const fits = geo.need <= free + 0.5;
      composer.toggleAttribute("data-cf-foot-off", shown && !fits);
      setVar(followUp, "--cf-foot-room", px(shown && fits ? geo.need + geo.gap : 0));
      composer.toggleAttribute("data-cf-merged", true);
      resize.observe(row);
      resize.observe(model!); // its width changes with the keyboard (phones) and the model name
    } else {
      composer.removeAttribute("data-cf-merged");
      composer.removeAttribute("data-cf-foot-off");
    }

    // Collapsed on a phone: add the model icon (remembered from the expanded composer) to
    // bb's right-hand group.
    const submit = composer.querySelector<HTMLElement>("[data-promptbox-submit-group]");
    if (collapsed && lastModel.icon && submit) {
      if (modelChip.dataset.icon !== lastModel.icon) {
        modelChip.dataset.icon = lastModel.icon;
        modelChip.innerHTML = lastModel.icon;
      }
      setAttr(modelChip, "aria-label", lastModel.label);
      // First in the right-hand group, so the line reads [model] [mic] [send].
      const group = submit.parentElement!;
      if (group.firstElementChild !== modelChip) group.prepend(modelChip);
    } else {
      modelChip.remove();
    }
  }

  /**
   * The phone composer's focus morph, height half (the width half is CSS, pills-composer.ts): bb switches the
   * one-line composer to its two-row form at once (its grid-rows transition can't run between a fixed row
   * and an auto one), so the form's height is animated from the last pass's to the new one, with the same
   * 350ms iOS ease-out as the width, like ChatGPT's composer riding up with the keyboard. The pass runs in
   * the frame bb changed the DOM (a rAF from the observer), before it is painted, so there is no flash.
   * Not for the keyboard (input-mode), nor with reduced motion; desktop has no collapsed state.
   */
  function morphHeight(form: HTMLElement, collapsed: boolean) {
    const now = performance.now();
    // While our morph runs, the measured height is the animated one: leave lastForm at the target.
    if (morphing && morphing.form === form && now < morphing.until) {
      if (collapsed !== lastForm.collapsed) { lastForm.collapsed = collapsed; flippedAt = now; }
      return;
    }
    // An early open (a tap on the one-line composer, see beginOpen) is under way and bb has now laid out
    // its rows: carry on from wherever the box is to the real height, in the time left, never restart.
    if (opening && opening.form === form && !collapsed) {
      // bb flips its flag a frame before it lays out the rows. The true height can only be read with the
      // animation off: cancel, read, and if the rows aren't there yet, resume toward the same target from the
      // same point, all in this one task, so nothing paints in between.
      const current = form.getBoundingClientRect().height; // the animated height
      opening.anim.cancel();
      const h = form.getBoundingClientRect().height;       // bb's real one
      if (h < opening.from + 8) {
        const rest = Math.max(1, MORPH_MS - (now - opening.at));
        opening.anim = form.animate({ height: [`${current}px`, `${opening.to}px`] }, { duration: rest, easing: MORPH_EASE, fill: "forwards" });
        // Nothing else will say when the rows land (the animation holds the box's size): look again next frame.
        requestAnimationFrame(() => { if (!disposed) morphHeight(form, !!form.closest("[data-app-composer]")?.hasAttribute("data-cf-collapsed")); });
        return;
      }
      const left = Math.max(160, MORPH_MS - (now - opening.at));
      opening.composer.removeAttribute("data-cf-opening");
      opening = null;
      lastForm = { el: form, h, collapsed };
      if (Math.abs(current - h) >= 2) {
        morphing = { form, until: now + left + 10 };
        form.animate({ height: [`${current}px`, `${h}px`] }, { duration: left, easing: MORPH_EASE });
      }
      revealRows(form);
      return;
    }
    // The early close's handover, the mirror of the open's (see beginClose).
    if (closing && closing.form === form && collapsed) {
      const current = form.getBoundingClientRect().height;
      closing.anim.cancel();
      const h = form.getBoundingClientRect().height;
      if (h > closing.from - 8) {
        const rest = Math.max(1, MORPH_MS - (now - closing.at));
        closing.anim = form.animate({ height: [`${current}px`, `${closing.to}px`], minHeight: ["0px", "0px"], overflow: ["clip", "clip"] }, { duration: rest, easing: MORPH_EASE, fill: "forwards" });
        requestAnimationFrame(() => { if (!disposed) morphHeight(form, !!form.closest("[data-app-composer]")?.hasAttribute("data-cf-collapsed")); });
        return;
      }
      const left = Math.max(140, MORPH_MS - (now - closing.at));
      closing.fade?.cancel();
      closing.composer.removeAttribute("data-cf-closing");
      closing = null;
      lastForm = { el: form, h, collapsed };
      if (Math.abs(current - h) >= 2) {
        morphing = { form, until: now + left + 10 };
        form.animate({ height: [`${current}px`, `${h}px`] }, { duration: left, easing: MORPH_EASE });
      }
      return;
    }
    const h = form.getBoundingClientRect().height;
    const was = lastForm;
    if (was.el === form && collapsed !== was.collapsed) flippedAt = now;
    lastForm = { el: form, h, collapsed };
    // Resting heights only: mid-animation the box's height is the animation's, not bb's.
    if (!form.getAnimations().length) {
      if (!collapsed) expandedH = h;
      else collapsedH = h;
    }
    // bb flips the flag a frame before it lays out the new rows: animate any real height change that
    // follows a flip closely, whichever pass sees it.
    if (was.el !== form || now - flippedAt > 400 || Math.abs(was.h - h) < 4) return;
    if (!animates()) return;
    morphing = { form, until: now + MORPH_MS + 10 };
    form.animate({ height: [`${was.h}px`, `${h}px`] }, { duration: MORPH_MS, easing: MORPH_EASE });
    if (!collapsed) revealRows(form);
  }

  /**
   * The open starts at the tap, like ChatGPT's and Claude's (kayg's 60fps recordings, 2026-11-15): their
   * composers widen and grow while the keyboard is still rising. bb switches to its two-row layout only once
   * the keyboard has settled (~230ms later on an iPhone), and a morph started then read as a second jolt.
   * So a touch on the one-line composer (not on its buttons) marks it opening: the width eases out at once
   * (CSS, [data-cf-opening]) and the height grows toward the expanded height last seen; when bb's rows
   * arrive, morphHeight carries on from there. If no focus follows (the touch was a scroll), it eases back.
   */
  function beginOpen(e: TouchEvent) {
    if (!phone.matches || !animates() || e.touches.length !== 1) return;
    const target = e.target as Element;
    const host = target.closest<HTMLElement>("[data-app-composer][data-cf-collapsed]");
    if (!host || target.closest("button, a, [role=button]")) return;
    const form = host.querySelector<HTMLElement>("form[data-promptbox]");
    if (!form || opening) return;
    const from = form.getBoundingClientRect().height;
    const to = expandedH > from + 8 ? expandedH : from * 2.6;
    host.setAttribute("data-cf-opening", "");
    const anim = form.animate({ height: [`${from}px`, `${to}px`] }, { duration: MORPH_MS, easing: MORPH_EASE, fill: "forwards" });
    const me = { form, composer: host, anim, at: performance.now(), from, to };
    opening = me;
    const back = () => {
      if (opening !== me) return;
      const current = form.getBoundingClientRect().height;
      me.anim.cancel();
      host.removeAttribute("data-cf-opening");
      opening = null;
      form.animate({ height: [`${current}px`, `${from}px`] }, { duration: 220, easing: MORPH_EASE });
    };
    // The touch became a scroll (it moved): ease back. Otherwise wait for bb's rows (on an iPhone they come
    // once the keyboard has settled; focus itself can land late), with a safety net if they never do.
    const x0 = e.touches[0].clientX, y0 = e.touches[0].clientY;
    const onMove = (m: TouchEvent) => {
      const p = m.touches[0];
      if (p && Math.hypot(p.clientX - x0, p.clientY - y0) > 10) { stop(); back(); }
    };
    const stop = () => {
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("touchend", stop, true);
    };
    document.addEventListener("touchmove", onMove, { capture: true, passive: true });
    document.addEventListener("touchend", stop, true);
    window.setTimeout(() => { stop(); back(); }, 2000);
  }

  /**
   * The close starts when the text field loses focus, which is when the keyboard starts down (kayg: ChatGPT and
   * Claude collapse WITH the keyboard; bb only collapses once it is gone). The buttons row fades out, the
   * capsule narrows (CSS, [data-cf-closing]) and the box shrinks toward the one-line height last seen; when
   * bb collapses, morphHeight carries on. If focus stayed in the composer (a tap on its own buttons), or bb
   * doesn't collapse, it reverses.
   */
  function beginClose(e: FocusEvent) {
    if (!phone.matches || !animates() || opening || closing) return;
    const target = e.target as Element;
    if (!target.closest?.('[contenteditable="true"]')) return;
    const host = target.closest<HTMLElement>("[data-app-composer]");
    if (!host || host.hasAttribute("data-cf-collapsed")) return;
    if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) return; // focus stays in the composer
    const form = host.querySelector<HTMLElement>("form[data-promptbox]");
    if (!form) return;
    // Only an empty draft collapses in bb; with text, nothing changes.
    if ((target.textContent ?? "").trim()) return;
    const from = form.getBoundingClientRect().height;
    const to = collapsedH > 0 && collapsedH < from - 8 ? collapsedH : Math.max(52, from / 2.6);
    host.setAttribute("data-cf-closing", "");
    const row = form.querySelector<HTMLElement>("[data-promptbox-action-row]");
    const fade = row?.animate({ opacity: [1, 0] }, { duration: 140, easing: "linear", fill: "forwards" }) ?? null;
    // min-height 0 and a clip: as a layout item the form won't go below its content's height otherwise.
    const anim = form.animate({ height: [`${from}px`, `${to}px`], minHeight: ["0px", "0px"], overflow: ["clip", "clip"] }, { duration: MORPH_MS, easing: MORPH_EASE, fill: "forwards" });
    const me = { form, composer: host, anim, fade, at: performance.now(), from, to };
    closing = me;
    window.setTimeout(() => {
      if (closing !== me) return;
      // bb kept it expanded: back to where it was.
      const current = form.getBoundingClientRect().height;
      me.anim.cancel();
      me.fade?.cancel();
      host.removeAttribute("data-cf-closing");
      closing = null;
      form.animate({ height: [`${current}px`, `${from}px`] }, { duration: 220, easing: MORPH_EASE });
    }, 1500);
  }

  /** bb's new rows (the buttons) ease in instead of popping: a short fade and rise, after the box has room. */
  function revealRows(form: HTMLElement) {
    const row = form.querySelector<HTMLElement>("[data-promptbox-action-row]");
    row?.animate({ opacity: [0, 1], translate: ["0 6px", "0 0"] }, { duration: 240, delay: 60, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" });
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
      const title = branch ? `${name} · ${branch}` : name;
      envBox.toggleAttribute("data-cf-env", true);
      setAttr(envBox, "data-cf-title", title);
      if (!envBox.hasAttribute("role")) envBox.setAttribute("role", "img");
      setAttr(envBox, "aria-label", title);
    }
    const permission = footer.querySelector<HTMLElement>('button[aria-label="Permission mode"]');
    const permissionTitle = permission?.querySelector("[title]")?.getAttribute("title")
      ?? permission?.querySelector("[data-cf-title]")?.getAttribute("data-cf-title") ?? "";
    if (permission && permissionTitle) {
      setAttr(permission, "data-cf-title", permissionTitle);
      setAttr(permission, "data-cf-perm", permissionKind(permissionTitle));
    }
    const context = footer.querySelector<HTMLElement>('button[aria-label^="Context window"]');
    const pct = Number(/(\d+)%/.exec(context?.getAttribute("aria-label") ?? "")?.[1] ?? 0);
    context?.toggleAttribute("data-cf-hot", pct >= 80);
  }

  function schedule() {
    if (!frame && !disposed) frame = requestAnimationFrame(pass);
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
  document.addEventListener("touchstart", beginOpen, { capture: true, passive: true });
  document.addEventListener("focusout", beginClose, true);
  schedule();
  return () => {
    disposed = true;
    formSize.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
    window.clearInterval(timer);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("touchstart", beginOpen, { capture: true });
    document.removeEventListener("focusout", beginClose, true);
    closing?.anim.cancel();
    opening?.anim.cancel();
    mutations.disconnect();
    resize.disconnect();
    modelChip.remove();
    voice.dispose();
    document.querySelectorAll("[data-cf-merged], [data-cf-collapsed], [data-cf-foot-off]").forEach((el) => {
      el.removeAttribute("data-cf-merged");
      el.removeAttribute("data-cf-collapsed");
      el.removeAttribute("data-cf-foot-off");
    });
  };
}
