import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeEngine, buildClaudeArgs } from "../src/engine/ClaudeCodeEngine";
import type { EngineEvent } from "../src/engine/Engine";
import { pluginPreamble } from "../src/prompts";

const fake = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/stream-chat.jsonl", import.meta.url));

const base = { prompt: "hello", model: "sonnet" };

function after(args: string[], flag: string, n: number): string[] {
  const i = args.indexOf(flag);
  expect(i).toBeGreaterThanOrEqual(0);
  return args.slice(i + 1, i + 1 + n);
}

describe("buildClaudeArgs", () => {
  it("includes the common flags for every kind", () => {
    for (const kind of ["chat", "save", "ingest"] as const) {
      const a = buildClaudeArgs({ ...base, kind });
      expect(a).toContain("-p");
      expect(a).toContain("hello");
      expect(after(a, "--output-format", 1)).toEqual(["stream-json"]);
      expect(a).toContain("--verbose");
      expect(a).toContain("--include-partial-messages");
      expect(after(a, "--model", 1)).toEqual(["sonnet"]);
      expect(after(a, "--append-system-prompt", 1)).toEqual([pluginPreamble(kind)]);
    }
  });

  it("puts the prompt right after -p so variadic flags cannot swallow it", () => {
    const a = buildClaudeArgs({ ...base, kind: "chat" });
    expect(a[a.indexOf("-p") + 1]).toBe("hello");
  });

  it("restricts chat to read-only tools", () => {
    const a = buildClaudeArgs({ ...base, kind: "chat" });
    expect(after(a, "--allowedTools", 3)).toEqual(["Read", "Glob", "Grep"]);
    expect(after(a, "--disallowedTools", 3)).toEqual(["Edit", "Write", "Bash"]);
    expect(a).not.toContain("--permission-mode");
  });

  const saveTools = [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "Bash(node --experimental-strip-types tools/*)",
  ];

  it("allows edits for save", () => {
    const a = buildClaudeArgs({ ...base, kind: "save" });
    expect(after(a, "--allowedTools", 6)).toEqual(saveTools);
    expect(after(a, "--permission-mode", 1)).toEqual(["acceptEdits"]);
  });

  it("adds the git allowlist for ingest", () => {
    const a = buildClaudeArgs({ ...base, kind: "ingest" });
    expect(after(a, "--allowedTools", 13)).toEqual([
      ...saveTools,
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git rev-parse:*)",
      "Bash(git -C sources/*)",
      "Bash(git submodule update:*)",
      "Bash(git submodule status:*)",
    ]);
    expect(after(a, "--permission-mode", 1)).toEqual(["acceptEdits"]);
  });

  it("adds --resume and --max-budget-usd when given", () => {
    const a = buildClaudeArgs({ ...base, kind: "chat", sessionId: "abc", maxBudgetUsd: 1.5 });
    expect(after(a, "--resume", 1)).toEqual(["abc"]);
    expect(after(a, "--max-budget-usd", 1)).toEqual(["1.5"]);
    const b = buildClaudeArgs({ ...base, kind: "chat" });
    expect(b).not.toContain("--resume");
    expect(b).not.toContain("--max-budget-usd");
  });
});

describe("ClaudeCodeEngine", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(env: Record<string, string> = {}, cliPath = process.execPath) {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    dirs.push(dir);
    const argsFile = join(dir, "args.jsonl");
    const engine = new ClaudeCodeEngine({
      cliPath,
      argsPrefix: [fake],
      repoRoot: dir,
      model: "sonnet",
      env: { FAKE_FIXTURE: fixture, FAKE_ARGS_FILE: argsFile, ...env },
    });
    const invocations = () =>
      readFileSync(argsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    return { engine, invocations };
  }

  async function collect(iter: AsyncIterable<EngineEvent>) {
    const out: EngineEvent[] = [];
    for await (const e of iter) out.push(e);
    return out;
  }

  const req = (signal: AbortSignal = new AbortController().signal) => ({
    kind: "chat" as const,
    prompt: "say hi",
    signal,
  });

  it("streams events and ends with exactly one done", async () => {
    const { engine } = setup();
    const events = await collect(engine.run(req()));
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ type: "done", text: "hi" });
  });

  it("resumes the captured session on the second run, and reset() drops it", async () => {
    const { engine, invocations } = setup();
    await collect(engine.run(req()));
    await collect(engine.run(req()));
    engine.reset();
    await collect(engine.run(req()));
    const [first, second, third] = invocations();
    expect(first).not.toContain("--resume");
    expect(second[second.indexOf("--resume") + 1]).toBe("cfb5337c-1268-4cd7-81a1-9837bb4c2ac5");
    expect(third).not.toContain("--resume");
  });

  it("yields a single error mentioning a missing CLI path", async () => {
    const { engine } = setup({}, join(tmpdir(), "no-such-claude-cli"));
    const events = await collect(engine.run(req()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("no-such-claude-cli");
  });

  it("includes stderr when the CLI exits non-zero without a result", async () => {
    const { engine } = setup({ FAKE_EXIT: "1", FAKE_STDERR: "not logged in", FAKE_NO_OUTPUT: "1" });
    const events = await collect(engine.run(req()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("not logged in");
  });

  it("yields cancelled done when aborted while hanging", async () => {
    const { engine } = setup({ FAKE_HANG: "1" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const events = await collect(engine.run(req(ac.signal)));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events[events.length - 1]).toMatchObject({ type: "done", cancelled: true });
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
  });
});
