import type { EngineEvent } from "./Engine";

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toolLabel(name: string, input: unknown): string {
  if (isObj(input)) {
    for (const key of ["file_path", "pattern", "command"]) {
      const v = input[key];
      if (typeof v === "string" && v) return `${name} ${v}`;
    }
  }
  return name;
}

/** Map one line of `claude --output-format stream-json` to engine events. */
export function parseStreamLine(line: string): EngineEvent[] | { sessionId: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(obj)) return [];

  switch (obj.type) {
    case "system":
      if (obj.subtype === "init" && typeof obj.session_id === "string") {
        return { sessionId: obj.session_id };
      }
      return [];
    case "stream_event": {
      const ev = obj.event;
      if (!isObj(ev) || ev.type !== "content_block_delta") return [];
      const delta = ev.delta;
      if (isObj(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
        return [{ type: "text-delta", text: delta.text }];
      }
      return [];
    }
    case "assistant": {
      const message = obj.message;
      const content = isObj(message) ? message.content : undefined;
      if (!Array.isArray(content)) return [];
      const out: EngineEvent[] = [];
      for (const block of content) {
        if (isObj(block) && block.type === "tool_use" && typeof block.name === "string") {
          out.push({ type: "tool-activity", label: toolLabel(block.name, block.input) });
        }
      }
      return out;
    }
    case "result": {
      const text = typeof obj.result === "string" ? obj.result : "";
      const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
      // Error subtypes (error_max_turns, error_max_budget_usd, ...) carry no result text.
      if (obj.is_error === true || subtype.startsWith("error")) {
        return [{ type: "error", message: text || `Claude Code reported an error${subtype ? ` (${subtype})` : ""}` }];
      }
      const done: EngineEvent = { type: "done", text };
      if (typeof obj.total_cost_usd === "number") done.costUsd = obj.total_cost_usd;
      return [done];
    }
    default:
      return [];
  }
}
