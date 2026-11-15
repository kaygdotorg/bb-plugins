/**
 * App entry: registers the plugin's surfaces with bb. Logic lives in frame/ (styling bb's
 * shell) and ui/ (React components); shapes live in shared/contract.ts.
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountFrame } from "./frame/mount";
import { ChatNavigation } from "./ui/nav";
import { activateNavItem, NEW_THREAD, SEARCH_THREADS } from "./ui/nav-actions";
import { FrameOverlay } from "./ui/overlay";
import { FrameSettings } from "./ui/settings";

export default definePluginApp((app) => {
  // The frame itself: stylesheet + backdrop over bb's own DOM.
  app.contentScripts.register({ id: "frame", mount: () => mountFrame() });
  // Keeps the frame in sync with settings.
  app.slots.experimental_appOverlay({ id: "frame-sync", component: FrameOverlay });
  app.slots.settingsSection({ id: "appearance", component: FrameSettings });
  // Compact navigation above bb's thread list.
  app.slots.experimental_sidebarNavigation({
    id: "calternal-nav",
    title: "Calternal",
    description: "Compact navigation above the thread list, in calternal's frame.",
    placement: "list",
    component: ChatNavigation,
  });
  // New thread and Search sit in the sidebar footer: usage ···· + search settings (css.ts orders them).
  app.experimental_sidebarFooter.register({
    kind: "action", id: "new-thread", label: "New thread", icon: "Plus",
    onActivate: () => activateNavItem(NEW_THREAD),
  });
  app.experimental_sidebarFooter.register({
    kind: "action", id: "search", label: "Search threads", icon: "Search",
    onActivate: () => activateNavItem(SEARCH_THREADS),
  });
});
