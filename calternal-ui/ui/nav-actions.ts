/**
 * The sidebar navigation's actions, for callers outside React: the sidebar top row's + and search
 * (frame/sidebar-top.ts, since 2026-11-16; they were footer items before) run the same host
 * behaviour as the nav rows. ChatNavigation publishes them while it is mounted, with bb's shortcut
 * for each item, so the top row's buttons can carry it (aria-keyshortcuts: the warm tooltip's chip).
 */
import type { experimental_useSidebarNavigation } from "@get-bb/plugin-sdk/app";

type Nav = ReturnType<typeof experimental_useSidebarNavigation>;
type Actions = Nav["actions"];

/** bb's stable ids for the two items the top row's + and search run. */
export const NEW_THREAD = "__bb__/new-thread";
export const SEARCH_THREADS = "__bb__/search-threads";

let current: Actions | null = null;
let shortcuts = new Map<string, string>();

export function publishNavActions(actions: Actions | null, items: Nav["items"] = []) {
  current = actions;
  shortcuts = new Map(items.flatMap((i) => (i.shortcut?.ariaKeyShortcuts ? [[i.id, i.shortcut.ariaKeyShortcuts] as const] : [])));
}

/** bb's aria-keyshortcuts value for a nav item, or null (none, or the nav hasn't mounted yet). */
export function navShortcut(id: string): string | null {
  return shortcuts.get(id) ?? null;
}

/** Runs a nav item in place; a no-op until the navigation has mounted once. */
export function activateNavItem(id: string) {
  current?.activate(id, { target: "current" });
}
