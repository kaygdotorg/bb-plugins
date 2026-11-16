/**
 * App entry: registers the plugin's surfaces with bb. Logic lives in frame/ (styling bb's
 * shell) and ui/ (React components); shapes live in shared/contract.ts.
 */
import "./frame/sidebar-overscan"; // first: widens bb's sidebar windowing before its list builds its observer
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountFrame } from "./frame/mount";
import { ChatNavigation } from "./ui/nav";
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
  // New thread and Search are no footer items any more (2026-11-16): they sit in the sidebar's top row,
  // left of the toggle (frame/sidebar-top.ts), and run the same nav actions (ui/nav-actions.ts). The
  // footer is [usage] ···· [settings …].
});
