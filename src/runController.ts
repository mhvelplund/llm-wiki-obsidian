import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Engine, EngineEvent } from "./engine/Engine";
import { INGEST_PROMPT, savePrompt } from "./prompts";
import { listWikiFolders, slugify, validateRepo } from "./repo";
import { diffSnapshots, snapshotWiki } from "./snapshot";

export type ReportEvent = { type: "report"; markdown: string; openPath?: string };
export type ControllerEvent = EngineEvent | ReportEvent;

export interface SaveOpts {
  source: "last" | "synthesis";
  lastAnswer?: string;
  folder: string;
  name: string;
}

const BUSY: EngineEvent = { type: "error", message: "A run is already in progress" };

export function planSave(
  root: string,
  folder: string,
  name: string,
): { targetPath: string; newFolder: boolean } | { error: string } {
  if (name.trim() === "") return { error: "Enter a page name" };
  if (slugify(name) !== name) {
    return { error: `Use a lowercase-hyphenated name (${slugify(name) || "letters and digits only"})` };
  }
  if (folder.startsWith("/") || folder.includes("\\") || folder.split("/").some((s) => s === ".." || s === ".")) {
    return { error: "Invalid folder" };
  }
  const rel = folder === "" ? `${name}.md` : `${folder}/${name}.md`;
  if (existsSync(join(root, "wiki", rel))) return { error: `Page exists: wiki/${rel}` };
  return { targetPath: `wiki/${rel}`, newFolder: !listWikiFolders(root).includes(folder) };
}

/** Local date as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Serialises every run (chat, save, ingest) on one engine behind a shared busy guard. */
export class RunController {
  busy = false;

  constructor(
    private readonly engine: Engine,
    private readonly root: string,
  ) {}

  async *chat(prompt: string, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const bad = this.preflight();
    if (bad) return yield bad;
    this.busy = true;
    try {
      yield* this.engine.run({ kind: "chat", prompt, signal });
    } finally {
      this.busy = false;
    }
  }

  async *save(opts: SaveOpts, signal: AbortSignal): AsyncIterable<ControllerEvent> {
    const bad = this.preflight();
    if (bad) return yield bad;
    const plan = planSave(this.root, opts.folder, opts.name);
    if ("error" in plan) return yield { type: "error", message: plan.error };
    const prompt = savePrompt({
      source: opts.source,
      lastAnswer: opts.lastAnswer,
      targetPath: plan.targetPath,
      newFolder: plan.newFolder,
      today: localDate(),
    });
    yield* this.reported("save", prompt, signal, plan.targetPath);
  }

  async *ingest(signal: AbortSignal): AsyncIterable<ControllerEvent> {
    const bad = this.preflight();
    if (bad) return yield bad;
    yield* this.reported("ingest", INGEST_PROMPT, signal);
  }

  private preflight(): EngineEvent | null {
    if (this.busy) return BUSY;
    const repo = validateRepo(this.root);
    return repo.ok ? null : { type: "error", message: repo.reason };
  }

  private async *reported(
    kind: "save" | "ingest",
    prompt: string,
    signal: AbortSignal,
    targetPath?: string,
  ): AsyncGenerator<ControllerEvent> {
    this.busy = true;
    try {
      const before = snapshotWiki(this.root);
      let streamed = "";
      let finalText: string | null = null;
      try {
        for await (const ev of this.engine.run({ kind, prompt, signal })) {
          if (ev.type === "text-delta") streamed += ev.text;
          else if (ev.type === "done") finalText = ev.text;
          yield ev;
        }
      } catch (e) {
        yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      }
      const diff = diffSnapshots(before, snapshotWiki(this.root));
      const text = (finalText !== null && finalText !== "" ? finalText : streamed).trim();
      const list = (title: string, files: string[]) =>
        `### ${title}\n` + (files.length ? files.map((f) => `- \`${f}\``).join("\n") : "- none");
      const parts = [list("Files created", diff.created), list("Files modified", diff.modified)];
      if (diff.deleted.length) parts.push(list("Files deleted", diff.deleted));
      if (text) parts.push(text);
      const report: ReportEvent = { type: "report", markdown: parts.join("\n\n") };
      if (targetPath && existsSync(join(this.root, targetPath))) {
        report.openPath = targetPath.replace(/^wiki\//, "");
      }
      yield report;
    } finally {
      this.busy = false;
    }
  }
}
