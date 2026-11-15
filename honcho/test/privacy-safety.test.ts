import { describe, expect, it } from "vitest";
import { redact, REDACTED, unsafePattern } from "../lib/redact";
import { denyEntryProblem, globMatcher } from "../lib/capture/deny";
import { privacyIssues } from "../lib/rpc-server";

describe("user regex safety", () => {
  it.each(["(a+)+$", "(x*)*", "(x+)*", "(a|a)*", "(.|x)+", "(\\w+\\s?)+", "(a)\\1", "(?<=a)b", "x".repeat(501), "(a+", "((a+))+"])("refuses %s", (source) => {
    expect(unsafePattern(source)).toEqual(expect.any(String));
  });
  it.each(["internal-\\d{4,8}", "acme\\.corp", "(foo|bar)+", "(ab)*c", "[a-z]+@example\\.test", "\\bproj-[A-Z]{3}\\b", "(?:a+b)?", "(?<id>\\d+)x"])("accepts %s", (source) => {
    expect(unsafePattern(source)).toBeNull();
  });
  it("skips an unsafe pattern at run time and runs safe ones", () => {
    const text = `${"a".repeat(40)}b internal-1234`;
    const out = redact(text, { patterns: [/(a+)+$/, /internal-\d+/] });
    expect(out.text).toBe(`${"a".repeat(40)}b ${REDACTED}`);
  });
  it("runs user patterns per line and in bounded pieces, with offsets intact", () => {
    const out = redact(`first\nsecret-77 here\n${"z".repeat(25_000)} secret-88`, { patterns: [/secret-\d+/] });
    expect(out.text).toBe(`first\n${REDACTED} here\n${"z".repeat(25_000)} ${REDACTED}`);
    expect(out.count).toBe(2);
  });
  it("completes the built-in detectors on 2 MB of a", () => {
    expect(redact("a".repeat(2 * 1024 * 1024)).count).toBeGreaterThanOrEqual(0);
  }, 120_000);
});

describe("deny entries", () => {
  it.each(["*", "**", "/", "", "  ", "/*", "/**", "//", "?", "*/"])("refuses %j as a path and as a remote", (entry) => {
    expect(denyEntryProblem(entry, "path")).toEqual(expect.any(String));
    expect(denyEntryProblem(entry, "remote")).toEqual(expect.any(String));
  });
  it.each(["/work/client", "/work/*", "~/clients/**", "/home/*/secret"])("accepts path %s", (entry) => {
    expect(denyEntryProblem(entry, "path")).toBeNull();
    expect(globMatcher(entry)!.test("")).toBe(false);
  });
  it("accepts specific remotes", () => {
    expect(denyEntryProblem("git@example.test:client/*", "remote")).toBeNull();
  });
  it("caps entries at 1,000 chars and lists at 200 entries", () => {
    expect(privacyIssues({ denyPaths: ["/" + "a".repeat(1_000)] })).toEqual([{ field: "denyPaths", index: 0, message: expect.stringContaining("1000") }]);
    expect(privacyIssues({ denyPaths: Array.from({ length: 201 }, (_, i) => `/p${i}`) })).toEqual([{ field: "denyPaths", index: -1, message: expect.stringContaining("200") }]);
    expect(privacyIssues({ denyPaths: Array.from({ length: 200 }, (_, i) => `/p${i}`) })).toEqual([]);
  });
});

describe("privacyIssues", () => {
  it("returns every problem together with field and index", () => {
    const issues = privacyIssues({ denyPaths: ["/ok", "*"], denyRemotes: ["**"], patterns: ["fine", "(a+)+$", "(", ""] });
    expect(issues.map(i => [i.field, i.index])).toEqual([["denyRemotes", 0], ["denyPaths", 1], ["patterns", 1], ["patterns", 2]]);
    expect(issues.every(i => i.message.length > 0)).toBe(true);
  });
});

describe("natural-language secrets", () => {
  it.each([
    ["my password is FAKEpass123", "my password is "],
    ["The PASSWORD IS Hunter2x.", "The PASSWORD IS "],
    ["api key: abcd-1234-efgh", "api key: "],
    ["use api key = zq9_Xw3m please", "use api key = "],
    ["the secret is 'blue horse battery'", "the secret is "],
    ["pin is 482913, ok?", "pin is "],
    ["passcode = 77xx99", "passcode = "],
    ["token is Ab3dEf9k)", "token is "],
  ])("redacts only the value in %s", (text, prefix) => {
    const out = redact(text);
    expect(out.count).toBe(1);
    expect(out.text.startsWith(prefix + REDACTED)).toBe(true);
    expect(out.text).not.toMatch(/FAKEpass|Hunter2x|abcd-1234|zq9_|blue horse|482913|77xx99|Ab3dEf9k/);
  });
  it.each([
    "the password field is required",
    "the password is required",
    "your token is expired",
    "the pin is optional",
    "secret: true",
    "token is null",
    "the api key is missing",
    "a spin is fun",
    "password is 8 characters long",
    "the secret is ${SECRET}",
  ])("leaves %s alone", (text) => {
    expect(redact(text)).toEqual({ text, count: 0 });
  });
});
