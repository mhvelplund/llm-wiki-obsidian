import type Anthropic from "@anthropic-ai/sdk";
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ToolMode = "read" | "write";
export type ToolResult = { content: string; isError: boolean };

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

class InputError extends Error {}

const READABLE_FILES = new Set(["CLAUDE.md", "sha.log", ".gitmodules"]);
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_SEARCH_LINES = 200;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

/** Folds case and trailing dots/spaces so `.OBSIDIAN` / `.obsidian.` match on case-insensitive filesystems. */
const fold = (seg: string): string => seg.toLowerCase().replace(/[. ]+$/, "");

function isAllowed(segs: string[], access: "read" | "write"): boolean {
  if (segs.length === 0) return false;
  const [first, second] = segs;
  // wiki/.obsidian/** may hold other plugins' secrets: never readable or writable.
  if (first === "wiki" && second !== undefined && fold(second) === ".obsidian") return false;
  if (access === "write") return first === "wiki" && segs.length > 1;
  if (first === "wiki" || first === "sources") return true;
  return segs.length === 1 && READABLE_FILES.has(first);
}

/** Segments of realPath relative to realRoot; null if it lies outside the root. */
function segmentsWithin(realRoot: string, realPath: string): string[] | null {
  const rel = relative(realRoot, realPath);
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel.split(sep);
}

/**
 * Resolves a repo-relative path to an absolute real path, or throws SandboxError.
 * Symlinks are followed (via the nearest existing ancestor) and the result is re-checked.
 */
export function resolveInRepo(root: string, rel: string, access: "read" | "write"): string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) {
    throw new SandboxError("invalid path");
  }
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").some((s) => s.includes(":"))) {
    throw new SandboxError(`path must be repo-relative: ${rel}`);
  }
  const verb = access === "write" ? "writable" : "readable";
  const realRoot = realpathSync.native(root);
  const lexical = resolve(realRoot, norm);
  const lexSegs = segmentsWithin(realRoot, lexical);
  if (!lexSegs) throw new SandboxError(`path escapes the repo: ${rel}`);
  if (!isAllowed(lexSegs, access)) throw new SandboxError(`path not ${verb}: ${rel}`);

  // Realpath the nearest existing ancestor (lstat, so a dangling symlink counts as existing and fails below).
  let ancestor = lexical;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new SandboxError(`cannot resolve path: ${rel}`);
      tail.unshift(ancestor.slice(parent.length).replace(/^[\\/]+/, ""));
      ancestor = parent;
    }
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync.native(ancestor);
  } catch {
    throw new SandboxError(`cannot resolve path: ${rel}`);
  }
  const real = join(realAncestor, ...tail);
  const realSegs = segmentsWithin(realRoot, real);
  if (!realSegs) throw new SandboxError(`path escapes the repo: ${rel}`);
  if (!isAllowed(realSegs, access)) throw new SandboxError(`path not ${verb}: ${rel}`);
  return real;
}

type Def = Anthropic.Beta.BetaTool;
const str = { type: "string" } as const;
const nullable = (type: string, description: string) => ({ type: [type, "null"], description });
/** Strict schemas require every property in `required`; optional ones are nullable. */
const schema = (properties: Record<string, unknown>): Def["input_schema"] => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const READ_DEFS: Def[] = [
  {
    name: "list_dir",
    description: "List entries of a directory in the repo (wiki/, sources/). Directories end with '/'.",
    strict: true,
    input_schema: schema({ path: { ...str, description: "Repo-relative directory, e.g. wiki" } }),
  },
  {
    name: "read_file",
    description: "Read a text file. Readable: wiki/**, sources/**, CLAUDE.md, sha.log, .gitmodules.",
    strict: true,
    input_schema: schema({ path: { ...str, description: "Repo-relative file path" } }),
  },
  {
    name: "search",
    description: `Search file contents. Returns at most ${MAX_SEARCH_LINES} 'path:line: text' lines. Defaults to all of wiki/ and sources/.`,
    strict: true,
    input_schema: schema({
      pattern: { ...str, description: "Text (or regular expression if regex is true) to find" },
      path: nullable("string", "Repo-relative file or directory to limit the search; null for everything"),
      regex: nullable("boolean", "Treat pattern as a regular expression; null or false for literal text"),
    }),
  },
];

const WRITE_DEFS: Def[] = [
  {
    name: "write_file",
    description: "Create a file under wiki/ (parent folders are created). Fails if it exists unless overwrite is true.",
    strict: true,
    input_schema: schema({
      path: { ...str, description: "Repo-relative path under wiki/" },
      content: { ...str, description: "Full file content" },
      overwrite: nullable("boolean", "true to replace an existing file; null or false otherwise"),
    }),
  },
  {
    name: "edit_file",
    description: "Replace one exact occurrence of old_str with new_str in a file under wiki/. old_str must occur exactly once.",
    strict: true,
    input_schema: schema({
      path: { ...str, description: "Repo-relative path under wiki/" },
      old_str: { ...str, description: "Exact text to replace; must be unique in the file" },
      new_str: { ...str, description: "Replacement text" },
    }),
  },
];

export function toolDefinitions(mode: ToolMode): Anthropic.Beta.BetaTool[] {
  return mode === "write" ? [...READ_DEFS, ...WRITE_DEFS] : [...READ_DEFS];
}

function stringField(input: unknown, key: string): string {
  return field(input, key, "string", false) as string;
}

function field(input: unknown, key: string, type: "string" | "boolean", optional: boolean): unknown {
  if (input === null || typeof input !== "object") throw new InputError("input must be an object");
  const v = (input as Record<string, unknown>)[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new InputError(`missing required field: ${key}`);
  }
  if (typeof v !== type) throw new InputError(`field ${key} must be a ${type}`);
  return v;
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const toPosix = (p: string): string => p.split(sep).join("/");

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function executeTool(root: string, mode: ToolMode, name: string, input: unknown): Promise<ToolResult> {
  if (!toolDefinitions(mode).some((t) => t.name === name)) {
    return { content: "tool not available", isError: true };
  }
  try {
    switch (name) {
      case "list_dir": {
        const dir = resolveInRepo(root, stringField(input, "path"), "read");
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => !(fold(e.name) === ".obsidian" && fold(basename(dir)) === "wiki"))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return ok(entries.join("\n"));
      }
      case "read_file":
        return ok(readFileSync(resolveInRepo(root, stringField(input, "path"), "read"), "utf8"));
      case "search":
        return ok(search(root, input));
      case "write_file": {
        const rel = stringField(input, "path");
        const content = stringField(input, "content");
        const overwrite = field(input, "overwrite", "boolean", true) === true;
        const file = resolveInRepo(root, rel, "write");
        if (!overwrite && exists(file)) {
          throw new InputError(`file already exists: ${rel} (pass overwrite: true to replace)`);
        }
        mkdirSync(dirname(file), { recursive: true });
        // Re-resolve after creating folders so a symlink raced into place cannot redirect the write.
        writeFileSync(resolveInRepo(root, rel, "write"), content, "utf8");
        return ok(`wrote ${rel}`);
      }
      case "edit_file": {
        const rel = stringField(input, "path");
        const oldStr = stringField(input, "old_str");
        const newStr = stringField(input, "new_str");
        if (oldStr === "") throw new InputError("old_str must not be empty");
        const file = resolveInRepo(root, rel, "write");
        const text = readFileSync(file, "utf8");
        const count = text.split(oldStr).length - 1;
        if (count !== 1) throw new InputError(`old_str must occur exactly once; found ${count}`);
        writeFileSync(file, text.replace(oldStr, () => newStr), "utf8");
        return ok(`edited ${rel}`);
      }
      default:
        return { content: "tool not available", isError: true };
    }
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

function search(root: string, input: unknown): string {
  const pattern = stringField(input, "pattern");
  const pathArg = field(input, "path", "string", true) as string | undefined;
  const isRegex = field(input, "regex", "boolean", true) === true;
  let re: RegExp | null = null;
  if (isRegex) {
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new InputError(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const matches = (line: string): boolean => (re ? re.test(line) : line.includes(pattern));

  const realRoot = realpathSync.native(root);
  const starts = pathArg
    ? [resolveInRepo(root, pathArg, "read")]
    : ["wiki", "sources"].map((d) => join(realRoot, d)).filter(exists);
  const out: string[] = [];

  const visit = (abs: string): void => {
    if (out.length >= MAX_SEARCH_LINES) return;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) {
        if (SEARCH_SKIP_DIRS.has(entry)) continue;
        const child = join(abs, entry);
        if (fold(toPosix(relative(realRoot, child))) === "wiki/.obsidian") continue;
        visit(child);
      }
      return;
    }
    if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return;
    const text = readFileSync(abs, "utf8");
    if (text.includes("\0")) return;
    const relPosix = toPosix(relative(realRoot, abs));
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < MAX_SEARCH_LINES; i++) {
      if (matches(lines[i])) out.push(`${relPosix}:${i + 1}: ${lines[i]}`);
    }
  };
  for (const s of starts) visit(s);
  return out.length ? out.join("\n") : "no matches";
}
