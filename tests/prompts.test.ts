import { describe, expect, it } from "vitest";
import {
  INGEST_PROMPT, apiSystemPrompt, basePreamble, cliPrompt, pluginPreamble, savePrompt, type RunKind,
} from "../src/prompts";

const kinds: RunKind[] = ["chat", "save", "ingest"];

describe("pluginPreamble", () => {
  it.each(kinds)("states the link/format/sources rules for %s", (k) => {
    const p = pluginPreamble(k);
    expect(p).toContain("never [[wikilinks]]");
    expect(p).toContain("no YAML frontmatter");
    expect(p).toContain("Never modify sources/");
  });
  it("chat forbids file changes", () => {
    expect(pluginPreamble("chat")).toContain("Do not modify any files");
  });
  it("save and ingest do not forbid file changes", () => {
    expect(pluginPreamble("save")).not.toContain("Do not modify any files");
    expect(pluginPreamble("ingest")).not.toContain("Do not modify any files");
  });
});

describe("basePreamble / cliPrompt", () => {
  it("base preamble is kind-neutral and every kind preamble extends it", () => {
    expect(basePreamble()).not.toContain("Do not modify any files");
    for (const k of kinds) expect(pluginPreamble(k).startsWith(basePreamble())).toBe(true);
  });
  it("prefixes the prompt with the kind clause", () => {
    const chat = cliPrompt("chat", "What is X?");
    expect(chat).toContain("Do not modify any files");
    expect(chat.endsWith("What is X?")).toBe(true);
    expect(cliPrompt("save", "p")).toContain("save run");
    expect(cliPrompt("ingest", "p")).toContain("ingest run");
    for (const k of kinds) expect(pluginPreamble(k)).toContain(cliPrompt(k, "").trim());
  });
});

describe("apiSystemPrompt", () => {
  it("is preamble + heading + CLAUDE.md", () => {
    expect(apiSystemPrompt("RULES", "chat")).toBe(
      pluginPreamble("chat") + "\n\n# Repository instructions (CLAUDE.md)\n\nRULES",
    );
  });
});

describe("savePrompt", () => {
  const base = { targetPath: "wiki/stl-browser/concepts/x.md", newFolder: false, today: "2026-11-23" };
  it("embeds the last answer verbatim and the target path", () => {
    const answer = "## Heading\n\nSome *answer* with [[odd]] text.";
    const p = savePrompt({ ...base, source: "last", lastAnswer: answer });
    expect(p).toContain(answer);
    expect(p).toContain("wiki/stl-browser/concepts/x.md");
    expect(p).toContain("2026-11-23");
    expect(p).toContain("sha.log");
  });
  it("forbids touching sha.log or anything outside wiki/", () => {
    for (const source of ["last", "synthesis"] as const) {
      expect(savePrompt({ ...base, source, lastAnswer: "a" })).toContain(
        "Do not modify `sha.log` or anything outside `wiki/`; this is not an ingest.",
      );
    }
  });
  it("synthesis asks to synthesize the conversation", () => {
    expect(savePrompt({ ...base, source: "synthesis" })).toContain("synthesize the conversation so far");
  });
  it("mentions folder index only for new folders", () => {
    expect(savePrompt({ ...base, source: "synthesis", newFolder: true })).toContain("create its index.md");
    expect(savePrompt({ ...base, source: "synthesis" })).not.toContain("create its index.md");
  });
  it("has numbered steps 1-5", () => {
    const p = savePrompt({ ...base, source: "synthesis" });
    for (const n of [1, 2, 3, 4, 5]) expect(p).toMatch(new RegExp(`^${n}\. `, "m"));
    expect(p).toContain("wiki/index.md");
    expect(p).toContain("lint");
  });
});

describe("INGEST_PROMPT", () => {
  it("is the scheduled-workflow prompt", () => {
    expect(INGEST_PROMPT).toBe("Update the wiki and lint it.");
  });
});
