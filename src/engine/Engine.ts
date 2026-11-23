import type { RunKind } from "../prompts";

export type EngineEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-activity"; label: string } // e.g. "Read wiki/index.md"
  | { type: "done"; text: string; cancelled?: boolean; costUsd?: number }
  | { type: "error"; message: string };

export interface RunRequest {
  kind: RunKind;
  prompt: string;
  signal: AbortSignal;
}

export interface Engine {
  readonly id: "api" | "claude-code";
  /** Yields exactly one terminal `done` or `error` event, last. */
  run(req: RunRequest): AsyncIterable<EngineEvent>;
  /** Forget the conversation. */
  reset(): void;
}
