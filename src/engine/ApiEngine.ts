import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine, EngineEvent, RunRequest } from "./Engine";
import { executeTool, toolDefinitions } from "./tools";
import { apiSystemPrompt } from "../prompts";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TURNS = 50;

export function createAnthropicClient(apiKey: string): Anthropic {
  // Runs inside Obsidian's Electron renderer, which the SDK treats as a browser.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

function readClaudeMd(root: string): string {
  try {
    return readFileSync(join(root, "CLAUDE.md"), "utf8");
  } catch {
    return "";
  }
}

function activityLabel(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const target = [o.path, o.pattern].find((v) => typeof v === "string");
  return target ? `${name} ${target}` : name;
}

export class ApiEngine implements Engine {
  readonly id = "api" as const;
  private history: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(private readonly opts: { client: Pick<Anthropic, "beta">; repoRoot: string; model: string }) {}

  reset(): void {
    this.history = [];
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    if (req.kind === "ingest") {
      yield { type: "error", message: "Ingest requires the Claude Code engine" };
      return;
    }
    const mode = req.kind === "chat" ? "read" : "write";
    const { repoRoot } = this.opts;
    const system = [
      {
        type: "text" as const,
        text: apiSystemPrompt(readClaudeMd(repoRoot), req.kind),
        cache_control: { type: "ephemeral" as const },
      },
    ];
    // Work on a copy; history only advances when the run ends cleanly, so an
    // abort/error never leaves an assistant tool_use without its tool_result.
    const turn: Anthropic.Beta.BetaMessageParam[] = [...this.history, { role: "user", content: req.prompt }];
    let streamed = "";

    try {
      for (let i = 0; i < MAX_TURNS; i++) {
        const stream = this.opts.client.beta.messages.stream(
          {
            model: this.opts.model,
            max_tokens: 64000,
            system,
            tools: toolDefinitions(mode),
            messages: [...turn],
            output_config: { effort: req.kind === "chat" ? "medium" : "high" },
            betas: [FALLBACK_BETA],
            fallbacks: "default",
          },
          { signal: req.signal },
        );
        // Text from separate tool turns is joined with a blank line, in the deltas and in done.text alike.
        let needSeparator = streamed !== "";
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            if (needSeparator && ev.delta.text !== "") {
              needSeparator = false;
              streamed += "\n\n";
              yield { type: "text-delta", text: "\n\n" };
            }
            streamed += ev.delta.text;
            yield { type: "text-delta", text: ev.delta.text };
          }
        }
        const msg = await stream.finalMessage();
        if (req.signal.aborted) {
          yield { type: "done", text: streamed, cancelled: true };
          return;
        }
        if (msg.stop_reason === "refusal") {
          yield { type: "error", message: "Claude declined this request" };
          return;
        }
        const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (msg.stop_reason === "max_tokens" && uses.length > 0) {
          yield { type: "error", message: "Response hit the token limit while calling a tool" };
          return;
        }
        turn.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });

        if (msg.stop_reason === "tool_use" && uses.length > 0) {
          for (const u of uses) yield { type: "tool-activity", label: activityLabel(u.name, u.input) };
          const results = await Promise.all(uses.map((u) => executeTool(repoRoot, mode, u.name, u.input)));
          turn.push({
            role: "user",
            content: uses.map((u, k) => ({
              type: "tool_result" as const,
              tool_use_id: u.id,
              content: results[k].content,
              is_error: results[k].isError,
            })),
          });
          continue;
        }
        if (msg.stop_reason === "pause_turn") continue;

        this.history = turn;
        yield { type: "done", text: streamed };
        return;
      }
      yield { type: "error", message: "Stopped after too many tool-use turns" };
    } catch (e) {
      if (req.signal.aborted || e instanceof Anthropic.APIUserAbortError) {
        yield { type: "done", text: streamed, cancelled: true };
      } else {
        yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      }
    }
  }
}
