import { spawn, type ChildProcess } from "node:child_process";
import type { Engine, EngineEvent, RunRequest } from "./Engine";
import { parseStreamLine } from "./streamJson";
import { pluginPreamble, type RunKind } from "../prompts";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const SAVE_TOOLS = [
  ...READ_TOOLS,
  "Edit",
  "Write",
  "Bash(node --experimental-strip-types tools/*)",
];
const GIT_TOOLS = [
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git rev-parse:*)",
  "Bash(git -C sources/*)",
  "Bash(git submodule update:*)",
  "Bash(git submodule status:*)",
];

export function buildClaudeArgs(opts: {
  kind: RunKind;
  prompt: string;
  model: string;
  sessionId?: string;
  maxBudgetUsd?: number;
}): string[] {
  // The prompt must directly follow -p: --allowedTools/--disallowedTools are
  // variadic and would otherwise swallow a trailing positional prompt.
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    opts.model,
    "--append-system-prompt",
    pluginPreamble(opts.kind),
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.kind === "chat") {
    args.push("--allowedTools", ...READ_TOOLS, "--disallowedTools", "Edit", "Write", "Bash");
  } else {
    const tools = opts.kind === "ingest" ? [...SAVE_TOOLS, ...GIT_TOOLS] : SAVE_TOOLS;
    args.push("--permission-mode", "acceptEdits", "--allowedTools", ...tools);
  }
  return args;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    k.on("error", () => child.kill());
  } else {
    child.kill();
  }
}

export interface ClaudeCodeEngineOpts {
  cliPath: string;
  repoRoot: string;
  model: string;
  maxBudgetUsd?: number;
  /** Extra env vars (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY only when set). */
  env: Record<string, string>;
  /** Test-only: args placed before the CLI args (e.g. a script for `node`). */
  argsPrefix?: string[];
}

export class ClaudeCodeEngine implements Engine {
  readonly id = "claude-code" as const;
  private sessionId?: string;

  constructor(private readonly opts: ClaudeCodeEngineOpts) {}

  reset(): void {
    this.sessionId = undefined;
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    const { cliPath, repoRoot, model, maxBudgetUsd, env, argsPrefix } = this.opts;
    const args = [
      ...(argsPrefix ?? []),
      ...buildClaudeArgs({
        kind: req.kind,
        prompt: req.prompt,
        model,
        sessionId: this.sessionId,
        maxBudgetUsd,
      }),
    ];

    const queue: EngineEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const notify = () => {
      wake?.();
      wake = undefined;
    };

    let terminal: EngineEvent | undefined;
    let streamed = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let buf = "";
    let exitCode: number | null = null;

    const handleLine = (line: string) => {
      const parsed = parseStreamLine(line);
      if (!Array.isArray(parsed)) {
        this.sessionId = parsed.sessionId;
        return;
      }
      for (const ev of parsed) {
        if (ev.type === "done" || ev.type === "error") {
          terminal ??= ev;
        } else {
          if (ev.type === "text-delta") streamed += ev.text;
          queue.push(ev);
        }
      }
    };

    const child = spawn(cliPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      notify();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      spawnError = err;
      closed = true;
      notify();
    });
    child.on("close", (code) => {
      if (buf.trim()) handleLine(buf);
      buf = "";
      exitCode = code;
      closed = true;
      notify();
    });

    const onAbort = () => killTree(child);
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || closed) resolve();
        });
      }
      while (queue.length) yield queue.shift()!;
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      if (!closed) killTree(child);
    }

    if (spawnError) {
      yield {
        type: "error",
        message: `Could not start Claude Code CLI at "${cliPath}": ${spawnError.message}`,
      };
    } else if (req.signal.aborted) {
      yield { type: "done", text: streamed, cancelled: true };
    } else if (terminal) {
      yield terminal;
    } else {
      const detail = stderr.trim();
      yield {
        type: "error",
        message:
          `Claude Code exited with code ${exitCode} without a result` + (detail ? `: ${detail}` : ""),
      };
    }
  }
}
