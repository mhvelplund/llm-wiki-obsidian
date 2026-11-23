import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const EXCLUDED_FOLDERS = new Set([".obsidian", "img"]);

/** The llm-wiki repo root is the parent of the vault (the vault is the repo's `wiki/` folder). */
export function resolveDefaultRepoRoot(vaultBasePath: string): string {
  return dirname(vaultBasePath);
}

export function validateRepo(root: string): { ok: true } | { ok: false; reason: string } {
  if (!isFile(join(root, "CLAUDE.md"))) {
    return { ok: false, reason: `CLAUDE.md not found in ${root}` };
  }
  if (!isDir(join(root, "wiki"))) {
    return { ok: false, reason: `wiki/ folder not found in ${root}` };
  }
  return { ok: true };
}

/** Folders under wiki/ as POSIX paths relative to wiki/ ("" is the root), sorted. */
export function listWikiFolders(root: string): string[] {
  const out: string[] = [""];
  const walk = (rel: string): void => {
    const abs = rel === "" ? join(root, "wiki") : join(root, "wiki", rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDED_FOLDERS.has(entry.name)) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(childRel);
      walk(childRel);
    }
  };
  walk("");
  return out.sort();
}

/** Lowercase, hyphen-separated, ASCII-only slug. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}
