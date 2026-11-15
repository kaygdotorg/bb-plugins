import { definePluginApp, experimental_THREAD_INFO_ROW_GROUPS as ROW_GROUPS } from "@get-bb/plugin-sdk/app";
import { useMemoryBadge } from "./ui/badge";
import { MemoryPage } from "./ui/page";
import { MEMORY_PATH, ThreadInfoStatusRow, ThreadMemorySection, ThreadStatusRow, ThreadStatusSegment, useSegmentVisible } from "./ui/thread";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "memory",
    title: "Memory",
    icon: "Brain",
    path: MEMORY_PATH,
    component: MemoryPage,
    experimental_useBadge: useMemoryBadge,
  });
  app.slots.experimental_threadInfoRow({ id: "memory-status", group: ROW_GROUPS.lifecycle, order: 90, component: ThreadInfoStatusRow });
  app.slots.experimental_threadContextCardRow({ id: "memory-status", group: ROW_GROUPS.lifecycle, order: 90, component: ThreadStatusRow });
  app.slots.experimental_threadContextCardSection({ id: "memory", title: "memory", group: "9_memory", order: 10, component: ThreadMemorySection });
  app.slots.experimental_threadContextSegment({
    id: "memory-status",
    title: "Memory",
    group: "9_memory",
    summary: ThreadStatusSegment,
    useVisible: useSegmentVisible,
  });
});
