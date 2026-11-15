import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cx } from "./primitives";

/** A chat's title as a link that opens the chat. A chat without a title reads "untitled chat". */
export function ThreadLink({ id, title, className }: { id: string; title: string | null; className?: string }) {
  const nav = useBbNavigate();
  const name = title ?? "untitled chat";
  return (
    <button
      type="button"
      title={`open chat: ${name}`}
      aria-label={`open chat ${name}`}
      onClick={() => nav.toThread(id)}
      className={cx("min-w-0 truncate text-left text-xs underline-offset-2 hover:underline", title === null && "text-muted-foreground", className)}
    >
      {name}
    </button>
  );
}
