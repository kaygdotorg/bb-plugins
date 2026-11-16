import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "../lib/redact.js";

const SK = ["sk", "ant", "api03", ["AbCdEf123456", "GhIjKl789012", "MnOpQr"].join("")].join("-");
const RANDOM = ["q8Zk3Vn7", "Xb2Lm9Rt", "4Wc6Yd1H", "f5Gj0Ps"].join("");

const KEEP = [
  "The full handover is ~/Developer/calternal-HANDOVER.md",
  "The full handover is ~/orch/infraternal-main-handover-2026-11-15.md",
  "see ~/Developer/Worktrees/BRIEF-COMMON.md for the brief",
  "see ~/Developer/Worktrees/BRIEF-COMMON-v2-2026-11-15.md",
  "Read /home/kayg/Developer/Worktrees/bb-honcho-fix-paths/honcho/lib/redact.ts first.",
  "worktree: /home/kayg/Developer/Worktrees/bb-honcho-fix-paths (branch honcho-fix-paths)",
  "(see ./docs/Architecture-Overview-Notes-2026-11-15/README.md)",
  "../../Developer/Worktrees/ux-honcho-fix-paths-redact-detector/lib/redact.ts",
  "C:\\Users\\kayg\\Developer\\Worktrees\\BRIEF_COMMON_2026\\Handover-Notes.md",
  "D:/Projects/infraternal/main-handover-2026-11-15/summary.json",
  "https://github.com/anthropics/claude-code/blob/main/honcho/lib/redact.ts",
  "https://forgejo.example.org/infraternal/issues/Handover-Notes-2026-11-15-Final",
  "https://example.com/Docs/Getting-Started-Guide-2026-11-15-Edition?ref=main",
  "infraternal-main-handover-2026-11-15 is done",
  "calternal-HANDOVER-2026-11-15.md",
  "npm i @anthropic-ai/claude-agent-sdk-extra-long-name",
  "@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts",
  "git checkout origin/feature-xyz-long-branch-name-2026",
  "branch origin/Feature-Honcho-Redact-Path-Detector-2026-11-15",
  "thread thr_uz4enq62cb and proj_Ab12Cd34Ef56Gh78 env_9fK2mQ7xLp4Rt8Vw",
  "evt_01HZXKJ3M4N5P6Q7R8S9T0V1W2 on turn_abcdef0123456789abcdef",
  "id V1StGXR8_Z5jdHi6B-myT in prose",
  "commit 3f2a9c1b7e4d8a0f5c6b2e1d9a8f7c6b5e4d3a2f",
  "cherry-pick 3f2a9c1b7e4d8a0f5c6b2e1d9a8f7c6b5e4d3a2f into main",
  "uuid 123e4567-e89b-12d3-a456-426614174000 was reused",
  "~/.bb/thread-storage/thr_uz4enq62cb/prompts/ux-common.md",
  "/home/kayg/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_uz4enq62cb",
  "src/components/SettingsPanelContainerWrapper/index.tsx",
  "node_modules/.pnpm/@types+node@22.0.0/node_modules/@types/node/index.d.ts",
  "tests: test/privacy-safety-regression-suite-for-paths.test.ts",
  "run npm test -- --testNamePattern=redaction-path-detector-false-positives",
];

describe("redaction keeps paths and identifiers", () => {
  it.each(KEEP)("keeps %s", (line) => {
    expect(redact(line)).toEqual({ text: line, count: 0 });
  });

  it("keeps generated path variants", () => {
    const words = ["calternal", "infraternal", "HANDOVER", "BRIEF", "COMMON", "main", "Developer", "Worktrees", "honcho", "fix", "paths", "perf", "v2", "2026-11-15", "Q4", "x86_64", "e2e", "pr42"];
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    for (let i = 0; i < 1500; i++) {
      const segs = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pick(words)).join(pick(["-", "_"])));
      const line = `handover is ${pick(["~/", "/home/kayg/", "./"])}${segs.join("/")}${pick([".md", ".ts", ""])} ok`;
      expect(redact(line).text).toBe(line);
    }
  });
});

describe("redaction still catches secrets near paths", () => {
  it.each([
    ["https://user:FAKEpass@host/path", "https://" + REDACTED + "host/path"],
    ["clone https://bot:Zx9Qw3Lp7Rt2@git.example.org/team/repo-name.git now", "clone https://" + REDACTED + "git.example.org/team/repo-name.git now"],
    [`~/.config/app/token.json holds ${SK}`, "~/.config/app/token.json holds " + REDACTED],
    ["export DEPLOY_PATH=~/Developer/x API_TOKEN=abc", "export DEPLOY_PATH=~/Developer/x API_TOKEN=" + REDACTED],
  ])("masks the secret in %s", (line, expected) => {
    expect(redact(line).text).toBe(expected);
  });

  it("masks a random segment inside a path", () => {
    const secret = RANDOM;
    const r = redact(`/var/run/secrets/${secret}/mount`);
    expect(r.text).toBe(`/var/run/secrets/${REDACTED}/mount`);
  });

  it("masks a random segment in a URL path", () => {
    const secret = RANDOM;
    expect(redact(`https://example.com/hook/${secret}`).text).toBe(`https://example.com/hook/${REDACTED}`);
  });

  it("masks long random base64 and hex in prose", () => {
    expect(redact(`key ${[RANDOM, "Hn2Bv8Kd"].join("+")} end`).count).toBe(1);
    expect(redact("rand a3f9c27be41d08c65f7a2b9e0d14c8a6e7b53f02d19c4a68 end").count).toBe(1);
  });
});
