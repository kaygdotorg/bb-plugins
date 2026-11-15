/**
 * The sidebar navigation's actions, for callers outside React: the footer's + and search
 * items (app.tsx) run the same host behaviour as the nav rows. ChatNavigation publishes
 * them while it is mounted.
 */
import type { experimental_useSidebarNavigation } from "@get-bb/plugin-sdk/app";

type Actions = ReturnType<typeof experimental_useSidebarNavigation>["actions"];

/** bb's stable ids for the two items the footer's + and search run. */
export const NEW_THREAD = "__bb__/new-thread";
export const SEARCH_THREADS = "__bb__/search-threads";

let current: Actions | null = null;

export function publishNavActions(actions: Actions | null) {
  current = actions;
}

/** Runs a nav item in place; a no-op until the navigation has mounted once. */
export function activateNavItem(id: string) {
  current?.activate(id, { target: "current" });
}
