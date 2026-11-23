import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { listWikiFolders, resolveDefaultRepoRoot, slugify, validateRepo } from "../src/repo";
import { makeTmpRepo } from "./helpers/tmpRepo";

describe("resolveDefaultRepoRoot", () => {
  it("returns the parent directory", () => {
    expect(resolveDefaultRepoRoot(join("a", "b", "wiki"))).toBe(join("a", "b"));
  });
});

describe("validateRepo", () => {
  it("is ok with CLAUDE.md and wiki/", () => {
    const root = makeTmpRepo({ "CLAUDE.md": "x", "wiki/index.md": "y" });
    expect(validateRepo(root)).toEqual({ ok: true });
  });
  it("mentions CLAUDE.md when missing", () => {
    const root = makeTmpRepo({ "wiki/index.md": "y" });
    const r = validateRepo(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("CLAUDE.md");
  });
  it("mentions wiki when the folder is missing", () => {
    const root = makeTmpRepo({ "CLAUDE.md": "x" });
    const r = validateRepo(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("wiki");
  });
});

describe("listWikiFolders", () => {
  it("lists folders relative to wiki/, excluding .obsidian and img", () => {
    const root = makeTmpRepo({
      "wiki/index.md": "",
      "wiki/a/index.md": "",
      "wiki/a/b/x.md": "",
      "wiki/img/p.png": "",
      "wiki/.obsidian/app.json": "{}",
    });
    expect(listWikiFolders(root)).toEqual(["", "a", "a/b"]);
  });
});

describe("slugify", () => {
  it("lowercases, hyphenates and strips punctuation", () => {
    expect(slugify("Archive Patterns & Co.")).toBe("archive-patterns-co");
  });
  it("strips diacritics", () => {
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
  });
});
