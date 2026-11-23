import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Creates a temp directory populated with the given files (repo-relative path -> content). */
export function makeTmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "llm-wiki-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
