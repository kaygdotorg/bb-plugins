import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
it("uses only declared dependencies and the public plugin SDK", async () => {
  const result = await experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)), { allow: [/^better-sqlite3$/] });
  expect(result.violations).toEqual([]); expect(result.privateDependencies).toEqual([]);
});
