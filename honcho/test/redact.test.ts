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
  // Synthetic values only, assembled at runtime so the secret scan doesn't trip on this file.
  const hex64 = ["9f86d081884c7d65", "9a2feaa0c55ad015", "a3bf4f1b2b0b822c", "d15d6c15b0f00a08"].join("");
  const hex32 = ["7f7b3787e68e7f53", "ad1b320fabf57aaa"].join("");
  const b64 = ["q5Nf3u8Wc0Zl", "Yb2KxR7pVt1H", "sA9mJdE4"].join("");
  const b64slash = ["CCD5w+TigjhX", "LWplriCcC2ZW", "WRiwZ6iR2nLz", "TUsnJ8g="].join("");
  it.each([
    ["openssl rand -hex 32", `token is ${hex64}`, hex64],
    ["openssl rand -hex 16", `use ${hex32} here`, hex32],
    ["base64 without _ or -", `key ${b64} ok`, b64],
    ["base64 with + and /", `secret ${b64slash} ok`, b64slash],
    ["export of any name", "export ANTHROPIC_KEY=abcd1234efgh", "abcd1234efgh"],
    ["export of a plain value", "export MY_SERVICE=hunter2 && run", "hunter2"],
    ["json apiKey", '{"apiKey": "abcd1234efgh5678"}', "abcd1234efgh5678"],
    ["json api_key", "{'api_key': 'abcd1234efgh5678'}", "abcd1234efgh5678"],
    ["yaml password", "password: hunter2hunter2", "hunter2hunter2"],
    ["yaml passwd", "  db_passwd: s3cr3t", "s3cr3t"],
    ["yaml token", "token: 'tok-value-1'", "tok-value-1"],
    ["yaml secret", "client_secret: shhh", "shhh"],
    ["KEY assignment", "ANTHROPIC_KEY=abcd1234efgh cmd", "abcd1234efgh"],
    ["apiKey assignment", "apiKey = 'abcd1234efgh'", "abcd1234efgh"],
    ["header key", "-H 'X-Api-Key: zz9plural9z9alpha'", "zz9plural9z9alpha"],
    ["passwd assignment", "passwd=abc", "abc"],
  ])("masks %s", (_, text, secret) => {
    const result = redact(text);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(REDACTED);
  });
  it.each([
    "commit 0123456789abcdef0123456789abcdef01234567", `sha256:${["9f86d081884c7d65", "9a2feaa0c55ad015", "a3bf4f1b2b0b822c", "d15d6c15b0f00a08"].join("")}`,
    `git show ${["9f86d081884c7d65", "9a2feaa0c55ad015", "a3bf4f1b2b0b822c", "d15d6c15b0f00a08"].join("")}`,
    "src/components/Button2/index.tsx", "createUser2FactorAuthTokenHandler", "export NODE_ENV=production", "export JAVA_HOME=/opt/jdk21",
    "interface Config { token: string; apiKey?: string }", "const sortKey = a.id", 'queryKey: ["users"]', "primaryKey: id",
    "token: undefined", "key: value",
    `const s = "${Buffer.from("A sentence that is only encoded text").toString("base64")}";`,
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
