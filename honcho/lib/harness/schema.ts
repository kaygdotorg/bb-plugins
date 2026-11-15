// A tiny Standard Schema v1 so the harness host contract needs no validator
// dependency. The host RPC boundary JSON round-trips values; these guards only
// check the shape this slice relies on.
import type { StandardSchemaV1 } from "@get-bb/plugin-sdk";

export function guardSchema<T>(name: string, guard: (value: unknown) => boolean): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "bb-honcho",
      validate: (value: unknown) => (guard(value) ? { value: value as T } : { issues: [{ message: `invalid ${name}` }] }),
    },
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const emptyInput = guardSchema<Record<string, never>>("input", isRecord);
