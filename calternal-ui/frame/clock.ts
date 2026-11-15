/**
 * The clock format across bb (Settings → Colour & size → Clock): 24-hour by default.
 *
 * bb formats times with `toLocaleTimeString(undefined, { hour: "numeric", ... })`, which
 * follows the browser's locale (en-US: 12-hour) and ignores the system's 24-hour setting;
 * bb has no setting of its own. So the time formatters are wrapped: when a caller asks for
 * an hour without choosing a cycle itself (no hour12 / hourCycle), the chosen one is added.
 * Callers that choose explicitly keep their choice. "system" leaves everything untouched.
 */
export type ClockMode = "24h" | "12h" | "system";

let mode: ClockMode = "24h";

/** Adds the chosen hour cycle when the options show an hour and don't pick a cycle. */
function withCycle(options: Intl.DateTimeFormatOptions | undefined, showsHourByDefault: boolean) {
  if (mode === "system") return options;
  const o = options ?? {};
  if ("hour12" in o || "hourCycle" in o) return options;
  const showsHour = o.hour !== undefined || o.timeStyle !== undefined
    || (showsHourByDefault && o.dateStyle === undefined && o.year === undefined && o.month === undefined && o.day === undefined && o.weekday === undefined);
  if (!showsHour) return options;
  return { ...o, hourCycle: mode === "24h" ? "h23" : "h12" } as Intl.DateTimeFormatOptions;
}

const original = {
  time: Date.prototype.toLocaleTimeString,
  string: Date.prototype.toLocaleString,
  Format: Intl.DateTimeFormat,
};

export function setClock(next: ClockMode) {
  mode = next;
}

/** Wraps the formatters; returns the undo. */
export function installClock(): () => void {
  Date.prototype.toLocaleTimeString = function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return original.time.call(this, locales, withCycle(options, true));
  };
  Date.prototype.toLocaleString = function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    // With no date or time fields, toLocaleString shows both: the hour counts.
    return original.string.call(this, locales, withCycle(options, true));
  };
  // Intl.DateTimeFormat shows only the date by default, so only explicit hours get a cycle.
  const Format = function (this: unknown, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new original.Format(locales, withCycle(options, false));
  } as unknown as typeof Intl.DateTimeFormat;
  // instanceof and supportedLocalesOf keep working.
  Object.defineProperty(Format, "prototype", { value: original.Format.prototype });
  Object.defineProperty(Format, "supportedLocalesOf", { value: original.Format.supportedLocalesOf });
  Intl.DateTimeFormat = Format;
  return () => {
    Date.prototype.toLocaleTimeString = original.time;
    Date.prototype.toLocaleString = original.string;
    Intl.DateTimeFormat = original.Format;
  };
}
