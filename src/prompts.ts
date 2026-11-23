export type RunKind = "chat" | "save" | "ingest";

const BASE =
  "You are running inside the Obsidian plugin for this wiki. Follow CLAUDE.md. " +
  "Links are relative Markdown links with .md, never [[wikilinks]], no YAML frontmatter. " +
  "Never modify sources/.";

const CHAT_EXTRA =
  " Do not modify any files; if an answer is worth keeping, say the user can save it.";

export function pluginPreamble(kind: RunKind): string {
  return kind === "chat" ? BASE + CHAT_EXTRA : BASE;
}

export function apiSystemPrompt(claudeMd: string, kind: RunKind): string {
  return pluginPreamble(kind) + "\n\n# Repository instructions (CLAUDE.md)\n\n" + claudeMd;
}

export interface SavePromptOpts {
  source: "last" | "synthesis";
  lastAnswer?: string;
  targetPath: string;
  newFolder: boolean;
  today: string;
}

export function savePrompt(opts: SavePromptOpts): string {
  const { source, lastAnswer, targetPath, newFolder, today } = opts;
  const basis =
    source === "last"
      ? "Use the following answer as the content basis, verbatim as the starting point:\n\n" +
        "<answer>\n" + (lastAnswer ?? "") + "\n</answer>"
      : "Content basis: synthesize the conversation so far into the page.";
  const folderNote = newFolder
    ? `\n\nThe target folder is new: create its index.md as CLAUDE.md requires.`
    : "";
  const steps = [
    `1. Write the page at ${targetPath} in the CLAUDE.md page format. Sources are the source files and wiki pages you actually relied on, with source links at the SHA from sha.log. Set Last updated to ${today} plus that SHA.`,
    "2. Add prose links and ## Related pages entries both ways with related pages. If none fit, link the page from wiki/index.md.",
    "3. Update the containing folder's index.md and wiki/index.md as CLAUDE.md requires.",
    "4. Run the CLAUDE.md lint over the whole wiki: apply auto-fixes and report the rest as a numbered list.",
    "5. End with a summary: files created or modified, and lint findings.",
  ];
  return [
    `Save this as a wiki page at the repo-relative path ${targetPath}.${folderNote}`,
    basis,
    "Steps:
" + steps.join("
"),
  ].join("

");
}

export const INGEST_PROMPT = "Update the wiki and lint it.";
