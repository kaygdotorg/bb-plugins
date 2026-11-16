import { useEffect, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarNavigation as useSidebarNavigation,
} from "@get-bb/plugin-sdk/app";
import { publishNavActions } from "./nav-actions";
import { Customize, Home, navIcon } from "./nav-icons";

/**
 * Compact single-column navigation above bb's thread list. Rows are shorter than bb's
 * thread rows (density), but text and icons line up with them exactly: the same text-sm,
 * the same 14px icon centred in a 16px slot, the same 8px gap and inset.
 */
type NavItem = ReturnType<typeof useSidebarNavigation>["items"][number];

function badgeText(item: NavItem): string | null {
  if (!item.badge) return null;
  if (item.badge.count) return item.badge.count > 99 ? "99+" : String(item.badge.count);
  return item.badge.text ?? null;
}

/** bb's thread rows centre a 14px icon in a 16px slot; the nav does the same so text aligns. */
function IconSlot({ children }: { children: React.ReactNode }) {
  return <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">{children}</span>;
}

const rowClass = (active: boolean) =>
  // pl-[8px]: bb pads thread rows by a fixed 8px, not by the (scaled) spacing unit.
  `flex h-6 w-full min-w-0 items-center gap-2 rounded-md pl-[8px] pr-2 text-left text-sm transition-colors ${
    active
      ? "bg-accent text-accent-foreground"
      : "text-sidebar-foreground hover:bg-accent/60 hover:text-foreground" // the thread rows' colour
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
      <IconSlot>{navIcon(item.label) ?? <SidebarNavigationIcon icon={item.icon} />}</IconSlot>
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
  // bb's own "Customize navigation" decides what shows here (kayg hides New thread and
  // Search threads there: they live in the footer as + and search). Hidden items go under More.
  const visibleItems = items.filter((item) => item.isVisible);
  const hiddenItems = items.filter((item) => !item.isVisible);
  useEffect(() => {
    publishNavActions(actions);
    return () => publishNavActions(null);
  }, [actions]);
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
    <nav data-cf-nav="" aria-label="BB navigation" className="flex flex-col px-2 py-1">
      <button
        type="button"
        className={rowClass(isHomeActive)}
        aria-current={isHomeActive ? "page" : undefined}
        onClick={() => actions.goHome()}
      >
        <IconSlot><Home /></IconSlot>
        <span className="min-w-0 flex-1 truncate">Threads</span>
      </button>
      {visibleItems.map(renderItem)}
      <button
        type="button"
        className={rowClass(false)}
        data-cf-nav-more=""
        data-open={moreOpen ? "" : undefined}
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((v) => !v)}
      >
        <IconSlot><Icon name={moreOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" /></IconSlot>
        <span className="min-w-0 flex-1 truncate">More</span>
      </button>
      {moreOpen ? (
        <>
          {hiddenItems.map(renderItem)}
          <button type="button" className={rowClass(false)} onClick={() => actions.openCustomize()}>
            <IconSlot><Customize /></IconSlot>
            <span className="min-w-0 flex-1 truncate">Customize navigation…</span>
          </button>
        </>
      ) : null}
    </nav>
  );
}

