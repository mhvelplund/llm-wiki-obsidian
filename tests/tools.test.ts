import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeTool, resolveInRepo, SandboxError, toolDefinitions } from "../src/engine/tools";
import { makeTmpRepo } from "./helpers/tmpRepo";

const repo = () =>
  makeTmpRepo({
    "CLAUDE.md": "# schema",
    "sha.log": "abc",
    "wiki/a.md": "hello foo\nbar",
    "wiki/.obsidian/x.md": "foo secret",
    "wiki/sub/b.md": "Foo and foo",
    "sources/s.md": "foo in source",
    "sources/proj/.git/config": "foo",
    "sources/proj/node_modules/m.js": "foo",
    "secret.txt": "nope",
  });

describe("resolveInRepo", () => {
  const root = repo();
  it("rejects escapes and non-writable paths", () => {
    expect(() => resolveInRepo(root, "../x", "read")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "/etc/passwd", "read")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "C:\\Windows\\x", "read")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "secret.txt", "read")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "wiki/../sources/a.md", "write")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "sources/a.md", "write")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "wiki\\..\\CLAUDE.md", "write")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "wiki/.obsidian/plugins/x/data.json", "write")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "wiki/.OBSIDIAN/x", "write")).toThrow(SandboxError);
    expect(() => resolveInRepo(root, "CLAUDE.md", "write")).toThrow(SandboxError);
  });
  it("allows readable and writable paths", () => {
    for (const p of ["wiki/a.md", "sources/s.md", "CLAUDE.md", "sha.log", "wiki/new/dir/c.md"]) {
      expect(() => resolveInRepo(root, p, "read")).not.toThrow();
    }
    expect(() => resolveInRepo(root, "wiki/new/dir/c.md", "write")).not.toThrow();
  });
  it("rejects symlinks that escape the repo", () => {
    const r = repo();
    const outside = makeTmpRepo({ "o.md": "outside" });
    try {
      symlinkSync(outside, join(r, "wiki", "link"), "junction");
    } catch {
      return; // symlinks unavailable
    }
    expect(() => resolveInRepo(r, "wiki/link/o.md", "read")).toThrow(SandboxError);
    expect(() => resolveInRepo(r, "wiki/link/new.md", "write")).toThrow(SandboxError);
  });
});

describe("toolDefinitions", () => {
  it("has fixed order and strict schemas", () => {
    expect(toolDefinitions("read").map((t) => t.name)).toEqual(["list_dir", "read_file", "search"]);
    expect(toolDefinitions("write").map((t) => t.name)).toEqual([
      "list_dir", "read_file", "search", "write_file", "edit_file",
    ]);
    for (const t of toolDefinitions("write")) {
      expect(t.strict).toBe(true);
      const s = t.input_schema as unknown as { additionalProperties: boolean; properties: object; required: string[] };
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    }
  });
});

describe("executeTool", () => {
  it("reads CLAUDE.md", async () => {
    expect(await executeTool(repo(), "read", "read_file", { path: "CLAUDE.md" })).toEqual({
      content: "# schema",
      isError: false,
    });
  });
  it("errors instead of throwing on sandbox violations and bad input", async () => {
    const root = repo();
    expect((await executeTool(root, "read", "read_file", { path: "../x" })).isError).toBe(true);
    expect((await executeTool(root, "read", "read_file", { path: 5 })).isError).toBe(true);
    expect((await executeTool(root, "read", "read_file", null)).isError).toBe(true);
    expect((await executeTool(root, "read", "read_file", { path: "wiki/missing.md" })).isError).toBe(true);
    expect((await executeTool(root, "read", "nope", {})).isError).toBe(true);
  });
  it("write tools unavailable in read mode", async () => {
    const root = repo();
    expect(await executeTool(root, "read", "write_file", { path: "wiki/z.md", content: "x" })).toEqual({
      content: "tool not available",
      isError: true,
    });
    expect((await executeTool(root, "read", "edit_file", {})).content).toBe("tool not available");
    expect(existsSync(join(root, "wiki/z.md"))).toBe(false);
  });
  it("list_dir lists entries", async () => {
    const r = await executeTool(repo(), "read", "list_dir", { path: "wiki" });
    expect(r.isError).toBe(false);
    expect(r.content.split("\n")).toEqual(expect.arrayContaining(["a.md", "sub/"]));
    expect(r.content).not.toContain(".obsidian");
  });
  it("wiki/.obsidian is neither readable nor listable nor searchable", async () => {
    const root = repo();
    const run = (tool: string, input: unknown) => executeTool(root, "read", tool, input);
    expect((await run("read_file", { path: "wiki/.obsidian/plugins/x/data.json" })).isError).toBe(true);
    expect((await run("read_file", { path: "wiki/.Obsidian/x.md" })).isError).toBe(true);
    expect((await run("list_dir", { path: "wiki/.obsidian" })).isError).toBe(true);
    expect((await run("search", { pattern: "foo", path: "wiki/.obsidian" })).isError).toBe(true);
    expect((await run("search", { pattern: "foo", path: "wiki/.obsidian/x.md" })).isError).toBe(true);
    expect(() => resolveInRepo(root, "wiki/.obsidian", "read")).toThrow(SandboxError);
  });
  it("search finds matches and skips excluded dirs", async () => {
    const r = await executeTool(repo(), "read", "search", { pattern: "foo" });
    expect(r.isError).toBe(false);
    const lines = r.content.split("\n");
    expect(lines).toContain("wiki/a.md:1: hello foo");
    expect(lines).toContain("sources/s.md:1: foo in source");
    expect(r.content).not.toContain(".obsidian");
    expect(r.content).not.toContain(".git");
    expect(r.content).not.toContain("node_modules");
    expect(r.content).not.toContain("secret.txt");
  });
  it("search supports path, regex (null = absent) and invalid regex", async () => {
    const root = repo();
    const a = await executeTool(root, "read", "search", { pattern: "^F.o", path: "wiki/sub", regex: true });
    expect(a.content).toBe("wiki/sub/b.md:1: Foo and foo");
    const b = await executeTool(root, "read", "search", { pattern: "foo", path: null, regex: null });
    expect(b.isError).toBe(false);
    const bad = await executeTool(root, "read", "search", { pattern: "(", regex: true });
    expect(bad.isError).toBe(true);
    expect((await executeTool(root, "read", "search", { pattern: "zzz" })).content).toBe("no matches");
  });
  it("search caps at 200 lines", async () => {
    const root = makeTmpRepo({ "wiki/big.md": "foo\n".repeat(500) });
    const r = await executeTool(root, "read", "search", { pattern: "foo" });
    expect(r.content.split("\n")).toHaveLength(200);
  });
  it("write_file creates (incl. new subfolders), refuses overwrite unless asked", async () => {
    const root = repo();
    const p = "wiki/n/m/c.md";
    expect((await executeTool(root, "write", "write_file", { path: p, content: "hi", overwrite: null })).isError).toBe(false);
    expect(readFileSync(join(root, p), "utf8")).toBe("hi");
    expect((await executeTool(root, "write", "write_file", { path: p, content: "2" })).isError).toBe(true);
    expect(readFileSync(join(root, p), "utf8")).toBe("hi");
    expect((await executeTool(root, "write", "write_file", { path: p, content: "2", overwrite: true })).isError).toBe(false);
    expect(readFileSync(join(root, p), "utf8")).toBe("2");
  });
  it("write_file refuses outside wiki/", async () => {
    const root = repo();
    for (const p of ["sources/x.md", "CLAUDE.md", "wiki/.obsidian/x.json", "../x.md", "wiki/../x.md"]) {
      expect((await executeTool(root, "write", "write_file", { path: p, content: "x" })).isError).toBe(true);
    }
    expect(existsSync(join(root, "x.md"))).toBe(false);
  });
  it("edit_file requires exactly one match", async () => {
    const root = repo();
    await executeTool(root, "write", "write_file", { path: "wiki/e.md", content: "a b a c" });
    const edit = (old_str: string, new_str: string, path = "wiki/e.md") =>
      executeTool(root, "write", "edit_file", { path, old_str, new_str });
    expect((await edit("zzz", "q")).isError).toBe(true);
    expect((await edit("a", "q")).isError).toBe(true);
    expect((await edit("b", "$&")).isError).toBe(false);
    expect(readFileSync(join(root, "wiki/e.md"), "utf8")).toBe("a $& a c");
    expect((await edit("foo", "q", "sources/s.md")).isError).toBe(true);
  });
});
