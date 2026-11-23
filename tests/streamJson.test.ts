import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStreamLine } from "../src/engine/streamJson";
import type { EngineEvent } from "../src/engine/Engine";

function parseFixture(name: string) {
  const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
  const events: EngineEvent[] = [];
  const sessionIds: string[] = [];
  for (const l of lines) {
    const r = parseStreamLine(l);
    if (Array.isArray(r)) events.push(...r);
    else sessionIds.push(r.sessionId);
  }
  return { events, sessionIds };
}

describe("parseStreamLine", () => {
  it("parses the chat fixture", () => {
    const { events, sessionIds } = parseFixture("stream-chat.jsonl");
    expect(sessionIds).toHaveLength(1);
    expect(events.filter((e) => e.type === "text-delta").length).toBeGreaterThanOrEqual(1);
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: "done", text: "hi" });
    expect((done[0] as { costUsd?: number }).costUsd).toBeGreaterThan(0);
  });

  it("emits tool-activity from the tool fixture", () => {
    const { events } = parseFixture("stream-tool.jsonl");
    const tools = events.filter((e) => e.type === "tool-activity");
    expect(tools).toEqual([{ type: "tool-activity", label: "Read /tmp/fixture\\a.txt" }]);
  });

  it("labels tools by file_path, pattern or command", () => {
    const mk = (name: string, input: object) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name, input }] },
      });
    expect(parseStreamLine(mk("Grep", { pattern: "foo" }))).toEqual([
      { type: "tool-activity", label: "Grep foo" },
    ]);
    expect(parseStreamLine(mk("Bash", { command: "git status" }))).toEqual([
      { type: "tool-activity", label: "Bash git status" },
    ]);
    expect(parseStreamLine(mk("Foo", {}))).toEqual([{ type: "tool-activity", label: "Foo" }]);
  });

  it("maps an error result to error", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "boom" });
    expect(parseStreamLine(line)).toEqual([{ type: "error", message: "boom" }]);
  });

  it("returns [] for unknown or invalid lines", () => {
    expect(parseStreamLine("")).toEqual([]);
    expect(parseStreamLine("not json")).toEqual([]);
    expect(parseStreamLine('{"type":"rate_limit_event"}')).toEqual([]);
  });
});
