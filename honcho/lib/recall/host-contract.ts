import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROMPT_HASH_PATTERN, THREAD_ID_PATTERN } from "./cache-file.js";

/** Host RPCs owned by the recall slice. host.ts merges these into the plugin's one host entry. */
export const recallHostContract = defineRpcContract({
  /** Only the prompt's hash crosses to the host; the host stamps createdAt on the hook's own clock. */
  "recall.write": {
    input: z.object({
      threadId: z.string().regex(THREAD_ID_PATTERN),
      hash: z.string().regex(PROMPT_HASH_PATTERN),
      memory: z.string().max(64 * 1024),
    }).strict(),
    output: z.object({ counter: z.number().int(), path: z.string() }).strict(),
  },
  /** Removes the thread's recall cache file (thread.deleted). */
  "recall.delete": {
    input: z.object({ threadId: z.string().regex(THREAD_ID_PATTERN) }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
});
export type RecallHostContract = typeof recallHostContract;
