import { describe, expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Engine, EngineEvent, RunRequest } from "../src/engine/Engine";
import { INGEST_PROMPT } from "../src/prompts";
import { planSave, RunController, type ControllerEvent } from "../src/runController";
import { makeTmpRepo } from "./helpers/tmpRepo";

const repoFiles = { "CLAUDE.md": "rules", "wiki/index.md": "idx", "wiki/a/old.md": "old" };

function write(root: string, rel: string, content: string, future = false): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (future) {
    const t = new Date(Date.now() + 10_000);
    utimesSync(full, t, t);
  }
}

class FakeEngine implements Engine {
  readonly id = "claude-code" as const;
  reqs: RunRequest[] = [];
  constructor(private readonly script: (req: RunRequest) => AsyncIterable<EngineEvent>) {}
  run(req: RunRequest): AsyncIterable<EngineEvent> {
    this.reqs.push(req);
    return this.script(req);
  }
  reset(): void {}
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const SAVE = { source: "last" as const, lastAnswer: "ans", folder: "a", name: "new" };
const sig = () => new AbortController().signal;

describe("planSave", () => {
  it("rejects an existing page, a non-slug name, an empty name", () => {
    const root = makeTmpRepo(repoFiles);
    expect(planSave(root, "a", "old")).toHaveProperty("error");
    expect(planSave(root, "a", "Bad Name")).toHaveProperty("error");
    expect(planSave(root, "a", "")).toHaveProperty("error");
  });
  it("accepts a new page and flags unknown folders as new", () => {
    const root = makeTmpRepo(repoFiles);
    expect(planSave(root, "a", "new")).toEqual({ targetPath: "wiki/a/new.md", newFolder: false });
    expect(planSave(root, "fresh", "new")).toEqual({ targetPath: "wiki/fresh/new.md", newFolder: true });
    expect(planSave(root, "", "new")).toEqual({ targetPath: "wiki/new.md", newFolder: false });
  });
  it("rejects folder traversal", () => {
    const root = makeTmpRepo(repoFiles);
    expect(planSave(root, "../x", "new")).toHaveProperty("error");
  });
});

describe("RunController", () => {
  it("save reports created/modified files and openPath, with a save prompt", async () => {
    const root = makeTmpRepo(repoFiles);
    const engine = new FakeEngine(async function* () {
      write(root, "wiki/a/new.md", "n");
      write(root, "wiki/index.md", "idx2", true);
      yield { type: "tool-activity", label: "Write wiki/a/new.md" };
      yield { type: "done", text: "All good" };
    });
    const events = await collect(new RunController(engine, root).save(SAVE, sig()));
    expect(engine.reqs[0]!.kind).toBe("save");
    expect(engine.reqs[0]!.prompt).toContain("wiki/a/new.md");
    const report = events.at(-1) as Extract<ControllerEvent, { type: "report" }>;
    expect(report.type).toBe("report");
    expect(report.markdown).toContain("### Files created");
    expect(report.markdown).toContain("wiki/a/new.md");
    expect(report.markdown).toContain("### Files modified");
    expect(report.markdown).toContain("wiki/index.md");
    expect(report.markdown).toContain("All good");
    expect(report.openPath).toBe("a/new.md");
  });

  it("omits openPath when the target was not created", async () => {
    const root = makeTmpRepo(repoFiles);
    const engine = new FakeEngine(async function* () {
      yield { type: "done", text: "nothing" };
    });
    const events = await collect(new RunController(engine, root).save(SAVE, sig()));
    expect((events.at(-1) as { openPath?: string }).openPath).toBeUndefined();
  });

  it("yields the busy error to a second call", async () => {
    const root = makeTmpRepo(repoFiles);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = new FakeEngine(async function* () {
      await gate;
      yield { type: "done", text: "" };
    });
    const c = new RunController(engine, root);
    const first = collect(c.chat("hi", sig()));
    await new Promise((r) => setTimeout(r, 0));
    expect(c.busy).toBe(true);
    const second = await collect(c.ingest(sig()));
    expect(second).toEqual([{ type: "error", message: "A run is already in progress" }]);
    expect(await collect(c.save(SAVE, sig()))).toEqual(second);
    expect(await collect(c.chat("again", sig()))).toEqual(second);
    release();
    await first;
    expect(c.busy).toBe(false);
  });

  it("still reports files written so far when aborted", async () => {
    const root = makeTmpRepo(repoFiles);
    const ac = new AbortController();
    const engine = new FakeEngine(async function* (req) {
      write(root, "wiki/a/new.md", "partial");
      ac.abort();
      expect(req.signal.aborted).toBe(true);
      yield { type: "done", text: "", cancelled: true };
    });
    const events = await collect(new RunController(engine, root).save(SAVE, ac.signal));
    const report = events.at(-1) as Extract<ControllerEvent, { type: "report" }>;
    expect(report.markdown).toContain("wiki/a/new.md");
  });

  it("reports even when the engine throws", async () => {
    const root = makeTmpRepo(repoFiles);
    const engine = new FakeEngine(async function* () {
      write(root, "wiki/a/new.md", "x");
      throw new Error("boom");
    });
    const events = await collect(new RunController(engine, root).save(SAVE, sig()));
    expect(events.map((e) => e.type)).toEqual(["error", "report"]);
    expect(events[0]).toEqual({ type: "error", message: "boom" });
  });

  it("never calls the engine for an invalid repo", async () => {
    const root = makeTmpRepo({});
    const engine = new FakeEngine(async function* () {
      yield { type: "done", text: "" };
    });
    const c = new RunController(engine, root);
    for (const run of [c.save(SAVE, sig()), c.ingest(sig()), c.chat("x", sig())]) {
      const events = await collect(run);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("error");
    }
    expect(engine.reqs).toHaveLength(0);
    expect(c.busy).toBe(false);
  });

  it("save with an existing page errors before the engine runs", async () => {
    const root = makeTmpRepo(repoFiles);
    const engine = new FakeEngine(async function* () {
      yield { type: "done", text: "" };
    });
    const events = await collect(new RunController(engine, root).save({ ...SAVE, name: "old" }, sig()));
    expect(events[0]!.type).toBe("error");
    expect(engine.reqs).toHaveLength(0);
  });

  it("ingest sends kind ingest with INGEST_PROMPT and reports", async () => {
    const root = makeTmpRepo(repoFiles);
    const engine = new FakeEngine(async function* () {
      yield { type: "done", text: "ingested" };
    });
    const events = await collect(new RunController(engine, root).ingest(sig()));
    expect(engine.reqs[0]).toMatchObject({ kind: "ingest", prompt: INGEST_PROMPT });
    const report = events.at(-1) as Extract<ControllerEvent, { type: "report" }>;
    expect(report.markdown).toContain("ingested");
    expect(report.openPath).toBeUndefined();
  });
});
