/**
 * Simple outline icons for the sidebar's top items (kayg: "better simple icons", like Claude's and ChatGPT's
 * sidebars). One family: 24-unit grid, 1.75 stroke, round caps and joins, no fills. bb's own set had no good
 * match for some items (Threads and Skills both drew a lightning bolt). Items not listed here keep bb's icon.
 */
import type { ReactNode } from "react";

/**
 * The viewBox is cropped to the drawing (2.25..21.75 of the 24 grid): drawn on the full grid the glyphs' ink
 * was 11–12.8px in the 15.4px slot, while the provider logos on the thread rows fill theirs (~15px), so these
 * read a size smaller (kayg, 2026-11-16: "what about the icon sizing?"). Cropped, the ink is ~13.5–15px and
 * the stroke ~1.4px, close to the logos' weight. No CSS scale, so layout and hit areas don't change.
 */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="2.25 2.25 19.5 19.5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-cf-nav-icon="">
    {children}
  </svg>
);

/** Threads: a chat bubble. */
const Threads = () => <Svg><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z" /></Svg>;
/** Plugins: a puzzle piece. */
const Plugins = () => (
  <Svg><path d="M9.5 4h-4A1.5 1.5 0 0 0 4 5.5v4a2.25 2.25 0 1 1 0 4.5v4.5A1.5 1.5 0 0 0 5.5 20H10a2.25 2.25 0 1 1 4.5 0h4a1.5 1.5 0 0 0 1.5-1.5v-4a2.25 2.25 0 1 0 0-4.5v-4A1.5 1.5 0 0 0 18.5 4h-4.5a2.25 2.25 0 1 0-4.5 0Z" /></Svg>
);
/** Skills: sparkles. */
const Skills = () => (
  <Svg>
    <path d="M10 4.5 11.4 9a2 2 0 0 0 1.3 1.3L17 11.7 12.7 13a2 2 0 0 0-1.3 1.3L10 18.8 8.6 14.3A2 2 0 0 0 7.3 13L3 11.7 7.3 10.3A2 2 0 0 0 8.6 9Z" />
    <path d="M18 3v4M16 5h4M19 17v3M17.5 18.5h3" />
  </Svg>
);
/** Automations: a clock (they run on a schedule or a trigger). */
const Automations = () => <Svg><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
/** Memory: a simple brain. */
const Memory = () => (
  <Svg>
    <path d="M9.5 4.5A2.5 2.5 0 0 0 7 7a3 3 0 0 0-2 5.2A3 3 0 0 0 7.5 17 2.5 2.5 0 0 0 12 18.5V6a1.5 1.5 0 0 0-2.5-1.5Z" />
    <path d="M14.5 4.5A2.5 2.5 0 0 1 17 7a3 3 0 0 1 2 5.2 3 3 0 0 1-2.5 4.8 2.5 2.5 0 0 1-4.5 1.5" />
  </Svg>
);
/** Customize navigation: sliders. */
export const Customize = () => <Svg><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Svg>;
export const Home = Threads;
/** New thread: a plus, on the same grid and stroke (its arms span the drawing area like the others' ink). */
export const NewThread = () => <Svg><path d="M12 4.5v15M4.5 12h15" /></Svg>;

/** By label (bb's item ids are internal; labels are what the user sees and are stable enough). */
const BY_LABEL: Record<string, () => ReactNode> = {
  threads: Threads,
  plugins: Plugins,
  skills: Skills,
  automations: Automations,
  memory: Memory,
};

/** The icon for a nav item, or null to keep bb's. */
export function navIcon(label: string): ReactNode | null {
  const Icon = BY_LABEL[label.trim().toLowerCase()];
  return Icon ? <Icon /> : null;
}
