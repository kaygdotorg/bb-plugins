import { useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarNavigation as useSidebarNavigation,
} from "@get-bb/plugin-sdk/app";

/** Compact single-column navigation above bb's thread list: 24px rows. */
type NavItem = ReturnType<typeof useSidebarNavigation>["items"][number];

function badgeText(item: NavItem): string | null {
  if (!item.badge) return null;
  if (item.badge.count) return item.badge.count > 99 ? "99+" : String(item.badge.count);
  return item.badge.text ?? null;
}

const rowClass = (active: boolean) =>
  `flex h-6 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-xs transition-colors ${
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
  }`;

function RowItem({
  item,
  active,
  showShortcut,
  onActivate,
}: {
  item: NavItem;
  active: boolean;
  showShortcut: boolean;
  onActivate: () => void;
}) {
  const badge = badgeText(item);
  return (
    <button
      type="button"
      className={rowClass(active)}
      aria-label={item.badge ? `${item.label}, ${item.badge.label}` : item.label}
      aria-current={active ? "page" : undefined}
      disabled={item.isDisabled || item.isLoading}
      onClick={onActivate}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <SidebarNavigationIcon icon={item.icon} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge ? <span className="text-[10px] tabular-nums">{badge}</span> : null}
      {showShortcut && item.shortcut ? (
        <span className="text-[10px] text-muted-foreground">{item.shortcut.label}</span>
      ) : null}
    </button>
  );
}

export function ChatNavigation() {
  const { items, activeItemId, isHomeActive, isShortcutModifierHeld, actions } =
    useSidebarNavigation();
  const [moreOpen, setMoreOpen] = useState(false);
  const visibleItems = items.filter((item) => item.isVisible);
  const hiddenItems = items.filter((item) => !item.isVisible);
  const activate = (id: string) => actions.activate(id, { target: "current" });
  const renderItem = (item: NavItem) => (
    <RowItem
      key={item.id}
      item={item}
      active={item.id === activeItemId}
      showShortcut={isShortcutModifierHeld}
      onActivate={() => activate(item.id)}
    />
  );

  return (
    <nav aria-label="BB navigation" className="flex flex-col px-2 py-1">
      <button
        type="button"
        className={rowClass(isHomeActive)}
        aria-current={isHomeActive ? "page" : undefined}
        onClick={() => actions.goHome()}
      >
        <Icon name="House" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Threads</span>
      </button>
      {visibleItems.map(renderItem)}
      <button
        type="button"
        className={rowClass(false)}
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((v) => !v)}
      >
        <Icon name={moreOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">More</span>
      </button>
      {moreOpen ? (
        <>
          {hiddenItems.map(renderItem)}
          <button type="button" className={rowClass(false)} onClick={() => actions.openCustomize()}>
            <Icon name="Settings2" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Customize navigation…</span>
          </button>
        </>
      ) : null}
    </nav>
  );
}

