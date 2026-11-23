import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".obsidian"]);

/** Root files outside wiki/ that runs may update (ingest updates sha.log). */
const ROOT_FILES = ["sha.log"];

/** mtimeMs of every file under wiki/ plus ROOT_FILES, keyed by repo-relative POSIX path. */
export function snapshotWiki(root: string): Map<string, number> {
  const snap = new Map<string, number>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(childRel);
      } else if (entry.isFile()) {
        snap.set(childRel, statSync(join(root, childRel)).mtimeMs);
      }
    }
  };
  try {
    walk("wiki");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const f of ROOT_FILES) {
    try {
      const st = statSync(join(root, f));
      if (st.isFile()) snap.set(f, st.mtimeMs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return snap;
}

export function diffSnapshots(
  before: Map<string, number>,
  after: Map<string, number>,
): { created: string[]; modified: string[]; deleted: string[] } {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined) created.push(path);
    else if (prev !== mtime) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}
