import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { THREAD_ID_PATTERN } from "./cache-file.js";

/** Host RPCs owned by the recall slice. host.ts merges these into the plugin's one host entry. */
export const recallHostContract = defineRpcContract({
  "recall.write": {
    input: z.object({
      threadId: z.string().regex(THREAD_ID_PATTERN),
      text: z.string().max(20_000),
      memory: z.string().max(64 * 1024),
      createdAt: z.number().int().nonnegative(),
    }).strict(),
    output: z.object({ counter: z.number().int(), path: z.string() }).strict(),
  },
});
export type RecallHostContract = typeof recallHostContract;
