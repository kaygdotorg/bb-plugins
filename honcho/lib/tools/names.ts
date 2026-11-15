export const HONCHO_TOOL_NAMES = ["honcho_chat", "honcho_search", "honcho_conclude", "honcho_conclusions"] as const;
export type HonchoToolName = typeof HONCHO_TOOL_NAMES[number];
