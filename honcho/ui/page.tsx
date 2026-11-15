import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ActivityTab } from "./activity";
import { ConclusionsTab } from "./conclusions";
import { ConnectionTab } from "./connection";
import { PeersTab } from "./peers";
import { PrivacyTab } from "./privacy";
import { cx } from "./primitives";
import { MEMORY_PATH } from "./thread";

export const TABS = [
  { id: "activity", label: "activity", component: ActivityTab },
  { id: "conclusions", label: "what it learned", component: ConclusionsTab },
  { id: "peers", label: "assistants", component: PeersTab },
  { id: "privacy", label: "privacy", component: PrivacyTab },
  { id: "connection", label: "connection", component: ConnectionTab },
] as const;

export function MemoryPage({ subPath }: PluginNavPanelProps) {
  const nav = useBbNavigate();
  const current = TABS.find((t) => t.id === decodeURIComponent(subPath.split("/")[0] ?? "")) ?? TABS[0];
  const Body = current.component;
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <nav role="tablist" aria-label="memory" className="flex gap-1 border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === current.id}
              onClick={() => nav.toPluginPanel(MEMORY_PATH, { subPath: tab.id })}
              className={cx(
                "-mb-px border-b-2 px-2.5 pb-1.5 text-xs transition-colors",
                tab.id === current.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div role="tabpanel" aria-label={current.label}><Body /></div>
      </div>
    </div>
  );
}
