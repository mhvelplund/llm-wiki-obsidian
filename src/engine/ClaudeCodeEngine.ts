import { spawn, type ChildProcess } from "node:child_process";
import type { Engine, EngineEvent, RunRequest } from "./Engine";
import { parseStreamLine } from "./streamJson";
import { basePreamble, cliPrompt, type RunKind } from "../prompts";

const READ_TOOLS = ["Read", "Glob", "Grep"];
/** Built-in tools available to save/ingest; what they may touch is decided by the rules below. */
const WRITE_BUILTINS = [...READ_TOOLS, "Edit", "Write", "Bash"];
const SAVE_ALLOW = [
  ...READ_TOOLS,
  "Edit(./wiki/**)",
  "Bash(node --experimental-strip-types tools/*)",
];
const INGEST_ALLOW = [
  ...SAVE_ALLOW,
  "Edit(./sha.log)",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git rev-parse:*)",
  "Bash(git -C sources/* log *)",
  "Bash(git -C sources/* diff *)",
  "Bash(git -C sources/* rev-parse *)",
  "Bash(git -C sources/* show *)",
  "Bash(git submodule update:*)",
  "Bash(git submodule status:*)",
];
/** wiki/.obsidian may hold other plugins' secrets: never readable (all kinds). */
const NO_OBSIDIAN_READ = "Read(./wiki/.obsidian/**)";
const PROTECTED_EDITS = [
  "Edit(./sources/**)",
  "Edit(./CLAUDE.md)",
  "Edit(./tools/**)",
  "Edit(./.claude/**)",
  "Edit(./.git/**)",
  "Edit(./.gitmodules)",
  "Edit(./wiki/.obsidian/**)",
];
const NO_COMMIT = [
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git -C * commit *)",
  "Bash(git -C * push *)",
  "Bash(git -C * reset *)",
  "Bash(git -C * checkout *)",
  // `-c` could set an alias or hook that turns an allowed subcommand into anything.
  "Bash(git -C * -c *)",
  "Bash(git -c *)",
];

export function buildClaudeArgs(opts: {
  kind: RunKind;
  model: string;
  sessionId?: string;
  maxBudgetUsd?: number;
}): string[] {
  // The prompt is sent on stdin, never argv (a prompt starting with "-" would
  // be parsed as an option). The system prompt is kind-neutral because a resumed
  // session keeps its first system prompt; kind instructions go with the prompt.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    opts.model,
    "--append-system-prompt",
    basePreamble(),
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  // dontAsk: anything not pre-approved below is denied without prompting.
  args.push("--permission-mode", "dontAsk");
  if (opts.kind === "chat") {
    args.push(
      "--tools",
      ...READ_TOOLS,
      "--allowedTools",
      ...READ_TOOLS,
      "--disallowedTools",
      "Edit",
      "Write",
      "Bash",
      NO_OBSIDIAN_READ,
    );
  } else {
    const deny = [NO_OBSIDIAN_READ, ...PROTECTED_EDITS, ...NO_COMMIT];
    if (opts.kind === "save") deny.push("Edit(./sha.log)");
    args.push(
      "--tools",
      ...WRITE_BUILTINS,
      "--allowedTools",
      ...(opts.kind === "ingest" ? INGEST_ALLOW : SAVE_ALLOW),
      "--disallowedTools",
      ...deny,
    );
  }
  return args;
}

/**
 * Child env: the parent's env minus inherited API credentials (they would override the
 * CLI's own login), plus the credentials the plugin explicitly passes.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return { ...env, ...extra };
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
      env: buildChildEnv(process.env, env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {}); // EPIPE if the child dies early
    child.stdin.end(cliPrompt(req.kind, req.prompt));
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
    } else if (terminal && (terminal.type === "error" || exitCode === 0 || exitCode === null)) {
      yield terminal;
    } else {
      const detail = stderr.trim();
      yield {
        type: "error",
        message:
          `Claude Code exited with code ${exitCode} ${terminal ? "after a result" : "without a result"}` + (detail ? `: ${detail}` : ""),
      };
    }
  }
}
