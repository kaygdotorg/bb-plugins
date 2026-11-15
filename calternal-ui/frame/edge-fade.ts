/**
 * Edge fades for scrollers whose top and bottom bars float over the content (kayg: "a progressive fade for
 * the content going under the footer, starting at the top of the footer and ending at its bottom"; the same
 * under the header). A reusable CSS generator: give it the scroller, the rows that should fade, and the
 * heights of the bars over the top and bottom edges.
 *
 * Why per row, not a mask: the bars live INSIDE the scroller (bb's DOM; moving them out would mean moving
 * bb's nodes), and a mask on the scroller would fade the bars themselves too. Instead each row runs a CSS
 * scroll-driven animation on its own view timeline, with the scrollport inset by the bars: a row fades from
 * 1 to 0 as it crosses under the header (its "exit") or the footer (its "entry"). Two registered numbers
 * (one per edge) multiply into its opacity; no JS. Where scroll-driven animations aren't supported (Safari < 26), rows
 * simply don't fade (the bars stay readable: they float, they don't cover).
 */
export interface EdgeFade {
  /** A unique name (keyframes are named after it). */
  name: string;
  /** The scroll container. */
  scroller: string;
  /** The rows inside it that fade (keep them row-sized: a tall block would fade as a whole). */
  rows: string;
  /** CSS lengths of the bars over the top and bottom edges (each fade spans its bar). Leave one out for an
   *  edge without a bar (a zero-length range would leave the rows invisible). */
  top?: string;
  bottom?: string;
  /** Half a row's height: the fade follows the row's middle (its text), not its top edge. */
  mid?: string;
}

export function edgeFadeCSS(f: EdgeFade): string {
  const mid = f.mid ?? "0px";
  // Two edges, two animations: both can't drive opacity (the later one would win), so each drives its own
  // registered number and the opacity is their product. Each is measured from the row's middle:
  //  - under the bottom bar: a plain view; "entry <mid>" is the row's middle at the scroller's bottom edge
  //    (0), "entry <bar + mid>" is it at the bar's top (1);
  //  - under the top bar: the view starts below the bar (inset, less mid); "exit 0px" is the row's middle at
  //    the bar's bottom (1), "exit <bar>" is it at the scroller's top (0).
  // So each fade spans its bar: from the bar's inner edge to its outer edge.
  const parts: { anim: string; timeline: string; range: string }[] = [];
  if (f.bottom) parts.push({ anim: `cf-fade-in-${f.name} linear both`, timeline: "view(block 0px 0px)", range: `entry ${mid} entry calc(${f.bottom} + ${mid})` });
  if (f.top) parts.push({ anim: `cf-fade-out-${f.name} linear both`, timeline: `view(block calc(${f.top} - ${mid}) 0px)`, range: `exit 0px exit ${f.top}` });
  if (!parts.length) return "";
  return `
@property --cf-fade-in-${f.name} { syntax: "<number>"; inherits: false; initial-value: 1; }
@property --cf-fade-out-${f.name} { syntax: "<number>"; inherits: false; initial-value: 1; }
@supports (animation-timeline: view()) {
  /* Progressive, not linear: 85% of the fade happens in the bar's inner 30%, so whatever is behind the bar's
     own content (the wordmark, the footer's pills, the composer) is already faint. */
  @keyframes cf-fade-in-${f.name} { 0% { --cf-fade-in-${f.name}: 0; } 70% { --cf-fade-in-${f.name}: 0.15; } 100% { --cf-fade-in-${f.name}: 1; } }
  @keyframes cf-fade-out-${f.name} { 0% { --cf-fade-out-${f.name}: 1; } 30% { --cf-fade-out-${f.name}: 0.15; } 100% { --cf-fade-out-${f.name}: 0; } }
  ${f.scroller} :is(${f.rows}) {
    animation: ${parts.map((x) => x.anim).join(", ")};
    animation-timeline: ${parts.map((x) => x.timeline).join(", ")};
    animation-range: ${parts.map((x) => x.range).join(", ")};
    opacity: calc(var(--cf-fade-in-${f.name}) * var(--cf-fade-out-${f.name}));
  }
}
`;
}
