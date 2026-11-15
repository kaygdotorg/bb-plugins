import { describe, expect, it } from "vitest";
import { dotenvSecretValues, redact, REDACTED } from "../lib/redact";

describe("redaction", () => {
  it.each([
    ["jwt", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "c3ludGhldGljU2lnbmF0dXJl"].join(".")],
    ["opaque token", "sk" + "-Synthetic9Xv_Km4Qz8Pa2Lc7Wd6Fe"],
    ["high entropy", ["Aj7_kL2", "xP9_qR4", "sT8_uV3", "wY6_zB5"].join("-")],
    ["pem", ["-----BEGIN PRIVATE", "KEY-----\nsynthetic\n-----END PRIVATE", "KEY-----"].join(" ")],
  ])("masks %s", (_, secret) => {
    expect(redact(`before ${secret} after`)).toEqual({ text: `before ${REDACTED} after`, count: 1 });
  });
  it.each([
    "Authorization: Bearer synthetic-credential", "authorization: Basic dXNlcjpwYXNz",
    "Bearer synthetic-credential", "export API_KEY=synthetic-value cmd",
    "API_KEY=synthetic-value cmd", "MY_SECRET='two words' cmd",
    'export SERVICE_TOKEN="two words"', "PASSWORD=abc cmd", "export FOO_PASSWORD=abc",
  ])("masks credential context %s", text => {
    const result = redact(text);
    expect(result.count).toBe(1);
    expect(result.text).toContain(REDACTED);
    expect(result.text).not.toMatch(/synthetic-credential|synthetic-value|two words|abc|dXNlcjpwYXNz/);
  });
  it("masks url credentials without removing host", () => {
    expect(redact("https://user:password@example.test/path")).toEqual({ text: `https://${REDACTED}example.test/path`, count: 1 });
  });
  it.each([
    "0123456789abcdef0123456789abcdef01234567",
    "a4f623a4-1b8b-4fa9-9b3d-188089f74938",
    `const data = "${Buffer.from("This is normal base64 in code").toString("base64")}";`,
    "thr_uz4enq62cb", "env_abcdefghijklmnopqrstuvwx", "foo/bar/bazLongFunctionNameInCode",
    "export PATH=/usr/bin", "NODE_ENV=production npm test", "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ])("preserves non-secret %s", text => expect(redact(text)).toEqual({ text, count: 0 }));
  it("uses literal deny values and user regexes, merging overlaps", () => {
    expect(redact("abc.* abc.* private-123", { deny: ["", "abc.*", "abc"], patterns: [/private-\d+/] })).toEqual({ text: `${REDACTED} ${REDACTED} ${REDACTED}`, count: 3 });
  });
  it("counts adjacent values separately and ignores zero-width patterns", () => {
    expect(redact("ab", { deny: ["a", "b"], patterns: [/(?=a)/] })).toEqual({ text: REDACTED.repeat(2), count: 2 });
  });
  it("does not mutate regex lastIndex", () => {
    const pattern = /private/g; pattern.lastIndex = 3;
    expect(redact("private private", { patterns: [pattern] }).count).toBe(2);
    expect(pattern.lastIndex).toBe(3);
  });
  it("parses bb-secrets dotenv without evaluation", () => {
    expect(dotenvSecretValues('# comment\nexport KEY="value with spaces"\nTOKEN=abc # note\nPATH=\'$(echo nope)\'\nEMPTY=')).toEqual(["value with spaces", "abc", "$(echo nope)"]);
  });
});
