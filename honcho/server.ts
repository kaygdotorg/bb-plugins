import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Slice 1 deliberately registers no runtime surfaces. */
export default async function plugin(_bb: BbPluginApi): Promise<void> {}
