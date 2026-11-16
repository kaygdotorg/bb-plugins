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

describe("natural-language secrets: wifi, door codes, recovery material, ssn, cards", () => {
  const secretOf = (text: string, value: string) => {
    const r = redact(text);
    expect(r.text).not.toContain(value);
    expect(r.text).toContain(REDACTED);
    return r;
  };
  it.each([
    ["my wi-fi code is FAKE-WIFI-ritaSecret77", "FAKE-WIFI-ritaSecret77", "my wi-fi code is "],
    ["wifi password: Synth3ticPass", "Synth3ticPass", "wifi password: "],
    ["the door code is 48213", "48213", "the door code is "],
    ["access code = 90417", "90417", "access code = "],
    ["Security code: 7731-A", "7731-A", "Security code: "],
    ["my passphrase is correct-horse-9", "correct-horse-9", "my passphrase is "],
    ["otp is 482913", "482913", "otp is "],
    ["your 2fa code is 559120.", "559120", "your 2fa code is "],
    ["recovery code: ABCD-1234-EFGH", "ABCD-1234-EFGH", "recovery code: "],
    ["my ssn is 078-05-1120", "078-05-1120", "my ssn is "],
    ["credit card: 4111 1111 1111 1111", "4111 1111 1111 1111", "credit card: "],
  ])("redacts only the value in %s", (text, value, keep) => {
    const r = secretOf(text, value);
    expect(r.text.startsWith(keep + REDACTED)).toBe(true);
  });
  it("redacts every backup code in a list", () => {
    const r = secretOf("backup codes: 1234-5678, 8765-4321 and 1122-3344 saved", "8765-4321");
    expect(r.text).toBe(`backup codes: ${REDACTED} saved`);
    expect(r.text).not.toMatch(/1234|1122/);
  });
  it("redacts a seed phrase, but not the words around it", () => {
    const r = redact("my seed phrase is apple river mountain lantern orbit velvet candle. Thanks");
    expect(r.text).toBe(`my seed phrase is ${REDACTED}. Thanks`);
    expect(r.text).not.toContain("apple");
    expect(redact('seed phrase: "alpha bravo charlie"').text).toBe(`seed phrase: ${REDACTED}`);
  });
  it.each([
    "the wifi code field is required", "the wifi code is required", "the wifi password is posted on the router",
    "the door code is on the fridge", "the security code is optional", "the access code is printed",
    "seed phrase is required", "my seed phrase is safe", "the otp is expired", "2fa code is sent by sms",
    "recovery code is shown once", "backup codes are stored offline", "ssn is required", "credit card is declined",
    "the code is 1234", "the key is Foo1", "the passphrase is optional",
    "ticket 123-45-678 and 000-12-3456, 666-12-3456, 912-34-5678", "order 4111 1111 1111 1112",
    "ts 1731700000000 and 1234567890123456", "id 4242-4242-4242-4243",
  ])("keeps the false-positive %s", text => expect(redact(text)).toEqual({ text, count: 0 }));
  it("masks Luhn-valid card numbers in all common layouts, and only those", () => {
    for (const [card, label] of [["4111111111111111", "visa"], ["5555 5555 5555 4444", "mc"], ["3782-822463-10005", "amex-dash"], ["378282246310005", "amex"], ["6011 1111 1111 1117", "discover"]]) {
      const r = redact(`paid with ${card} today`);
      expect(r, label).toEqual({ text: `paid with ${REDACTED} today`, count: 1 });
    }
  });
  it("masks a US ssn and not look-alikes", () => {
    expect(redact("ssn 123-45-6789 ok")).toEqual({ text: `ssn ${REDACTED} ok`, count: 1 });
    expect(redact("record 123-45-6789 is on file").text).toBe(`record ${REDACTED} is on file`);
    for (const text of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000", "2026-11-15", "1234-56-7890"]) expect(redact(text).count).toBe(0);
  });
  it("leaves postal addresses alone", () => {
    const text = "I live at 221 Baker Street, London NW1 6XE, flat 4";
    expect(redact(text)).toEqual({ text, count: 0 });
  });
});
