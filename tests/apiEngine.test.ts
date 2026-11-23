import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiEngine } from "../src/engine/ApiEngine";
import type { EngineEvent } from "../src/engine/Engine";

type Block = Record<string, unknown>;
type Scripted = { content: Block[]; stop_reason: string; deltas?: string[]; abort?: boolean };

function fakeClient(script: Scripted[]) {
  const calls: any[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: any, opts: { signal?: AbortSignal }) {
          calls.push({ params, opts, messages: JSON.parse(JSON.stringify(params.messages)) });
          const turn = script.shift();
          if (!turn) throw new Error("script exhausted");
          return {
            async *[Symbol.asyncIterator]() {
              for (const d of turn.deltas ?? []) {
                yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } };
              }
              if (turn.abort) throw new Anthropic.APIUserAbortError();
            },
            async finalMessage() {
              return { role: "assistant", content: turn.content, stop_reason: turn.stop_reason };
            },
          };
        },
      },
    },
  };
  return { client: client as any, calls };
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const text = (t: string): Block => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "api-engine-"));
  writeFileSync(join(root, "CLAUDE.md"), "RULES v1");
  writeFileSync(join(root, "sha.log"), "abc");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const req = (kind: "chat" | "save" | "ingest" = "chat", prompt = "hi", signal = new AbortController().signal) => ({
  kind,
  prompt,
  signal,
});

describe("ApiEngine", () => {
  it("streams a one-turn answer", async () => {
    const { client } = fakeClient([{ content: [text("Hello world")], stop_reason: "end_turn", deltas: ["Hello ", "world"] }]);
    const e = new ApiEngine({ client, repoRoot: root, model: "m" });
    const ev = await collect(e.run(req()));
    expect(ev).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
      { type: "done", text: "Hello world" },
    ]);
  });

  it("runs several tool_use blocks and returns one user message of tool_results", async () => {
    const { client, calls } = fakeClient([
      {
        content: [use("t1", "read_file", { path: "sha.log" }), use("t2", "read_file", { path: "CLAUDE.md" })],
        stop_reason: "tool_use",
      },
      { content: [text("final")], stop_reason: "end_turn", deltas: ["final"] },
    ]);
    const e = new ApiEngine({ client, repoRoot: root, model: "m" });
    const ev = await collect(e.run(req()));
    expect(ev.filter((x) => x.type === "tool-activity")).toHaveLength(2);
    expect(ev.at(-1)).toEqual({ type: "done", text: "final" });
    const msgs = calls[1].messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "abc", is_error: false },
      { type: "tool_result", tool_use_id: "t2", content: "RULES v1", is_error: false },
    ]);
  });

  it("joins text from separate tool turns with a blank line in deltas and done", async () => {
    const { client } = fakeClient([
      {
        content: [text("Let me look."), use("t1", "read_file", { path: "sha.log" })],
        stop_reason: "tool_use",
        deltas: ["Let me look."],
      },
      { content: [text("Found it.")], stop_reason: "end_turn", deltas: ["Found ", "it."] },
    ]);
    const ev = await collect(new ApiEngine({ client, repoRoot: root, model: "m" }).run(req()));
    const deltas = ev.filter((x) => x.type === "text-delta").map((x) => (x as { text: string }).text);
    expect(deltas.join("")).toBe("Let me look.\n\nFound it.");
    expect(ev.at(-1)).toEqual({ type: "done", text: "Let me look.\n\nFound it." });
  });

  it("offers write tools only for save, never for chat", async () => {
    const a = fakeClient([{ content: [text("x")], stop_reason: "end_turn" }]);
    await collect(new ApiEngine({ client: a.client, repoRoot: root, model: "m" }).run(req("chat")));
    const chatTools = a.calls[0].params.tools.map((t: any) => t.name);
    expect(chatTools).not.toContain("write_file");
    expect(chatTools).not.toContain("edit_file");
    const b = fakeClient([{ content: [text("x")], stop_reason: "end_turn" }]);
    await collect(new ApiEngine({ client: b.client, repoRoot: root, model: "m" }).run(req("save")));
    expect(b.calls[0].params.tools.map((t: any) => t.name)).toContain("write_file");
  });

  it("sends model, effort, fallbacks, beta, cached system prompt and signal", async () => {
    const { client, calls } = fakeClient([
      { content: [text("x")], stop_reason: "end_turn" },
      { content: [text("y")], stop_reason: "end_turn" },
    ]);
    const e = new ApiEngine({ client, repoRoot: root, model: "claude-test" });
    const ctl = new AbortController();
    await collect(e.run(req("chat", "hi", ctl.signal)));
    await collect(e.run(req("save")));
    const p = calls[0].params;
    expect(p.model).toBe("claude-test");
    expect(p.max_tokens).toBe(64000);
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(calls[1].params.output_config).toEqual({ effort: "high" });
    expect(p.thinking).toBeUndefined();
    expect(p.system).toHaveLength(1);
    expect(p.system[0].type).toBe("text");
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[0].text).toContain("RULES v1");
    expect(calls[0].opts.signal).toBe(ctl.signal);
  });

  it("reads CLAUDE.md fresh on each run", async () => {
    const { client, calls } = fakeClient([
      { content: [text("x")], stop_reason: "end_turn" },
      { content: [text("y")], stop_reason: "end_turn" },
    ]);
    const e = new ApiEngine({ client, repoRoot: root, model: "m" });
    await collect(e.run(req()));
    writeFileSync(join(root, "CLAUDE.md"), "RULES v2");
    await collect(e.run(req()));
    expect(calls[1].params.system[0].text).toContain("RULES v2");
  });

  it("errors on refusal and drops the turn from history", async () => {
    const { client, calls } = fakeClient([
      { content: [text("")], stop_reason: "refusal" },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    const e = new ApiEngine({ client, repoRoot: root, model: "m" });
    const ev = await collect(e.run(req()));
    expect(ev).toEqual([{ type: "error", message: "Claude declined this request" }]);
    await collect(e.run(req("chat", "again")));
    expect(calls[1].messages).toHaveLength(1);
  });

  it("errors on max_tokens with a pending tool_use", async () => {
    const { client } = fakeClient([
      { content: [use("t1", "read_file", { path: "sha.log" })], stop_reason: "max_tokens" },
    ]);
    const ev = await collect(new ApiEngine({ client, repoRoot: root, model: "m" }).run(req()));
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("error");
  });

  it("sends earlier history on a second run and reset() clears it", async () => {
    const { client, calls } = fakeClient([
      { content: [text("a1")], stop_reason: "end_turn" },
      { content: [text("a2")], stop_reason: "end_turn" },
      { content: [text("a3")], stop_reason: "end_turn" },
    ]);
    const e = new ApiEngine({ client, repoRoot: root, model: "m" });
    await collect(e.run(req("chat", "q1")));
    await collect(e.run(req("chat", "q2")));
    expect(calls[1].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(calls[1].messages[1].content).toEqual([text("a1")]);
    e.reset();
    await collect(e.run(req("chat", "q3")));
    expect(calls[2].messages).toHaveLength(1);
  });

  it("rejects ingest immediately", async () => {
    const { client, calls } = fakeClient([]);
    const ev = await collect(new ApiEngine({ client, repoRoot: root, model: "m" }).run(req("ingest")));
    expect(ev).toEqual([{ type: "error", message: "Ingest requires the Claude Code engine" }]);
    expect(calls).toHaveLength(0);
  });

  it("yields done{cancelled} with text so far on abort and keeps history clean", async () => {
    const { client, calls } = fakeClient([
      { content: [], stop_reason: "end_turn", deltas: ["par"], abort: true },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    const e = new ApiEngine({ client, repoRoot: root, model: "m" });
    const ctl = new AbortController();
    const ev = await collect(e.run(req("chat", "hi", ctl.signal)));
    expect(ev).toEqual([
      { type: "text-delta", text: "par" },
      { type: "done", text: "par", cancelled: true },
    ]);
    await collect(e.run(req("chat", "next")));
    expect(calls[1].messages).toHaveLength(1);
  });

  it("turns unexpected failures into a single error event", async () => {
    const client = {
      beta: {
        messages: {
          stream() {
            throw new Error("boom");
          },
        },
      },
    } as any;
    const ev = await collect(new ApiEngine({ client, repoRoot: root, model: "m" }).run(req()));
    expect(ev).toEqual([{ type: "error", message: "boom" }]);
  });
});
