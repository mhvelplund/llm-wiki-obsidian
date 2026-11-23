import { describe, expect, it } from "vitest";
import { utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { diffSnapshots, snapshotWiki } from "../src/snapshot";
import { makeTmpRepo } from "./helpers/tmpRepo";

describe("snapshotWiki", () => {
  it("keys by repo-relative POSIX path and ignores wiki/.obsidian", () => {
    const root = makeTmpRepo({
      "wiki/index.md": "a",
      "wiki/a/x.md": "b",
      "wiki/.obsidian/app.json": "{}",
    });
    expect([...snapshotWiki(root).keys()].sort()).toEqual(["wiki/a/x.md", "wiki/index.md"]);
  });
});

describe("diffSnapshots", () => {
  it("reports created, modified and deleted files", () => {
    const root = makeTmpRepo({ "wiki/keep.md": "k", "wiki/touch.md": "t", "wiki/gone.md": "g" });
    const before = snapshotWiki(root);
    writeFileSync(join(root, "wiki/new.md"), "n");
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, "wiki/touch.md"), future, future);
    unlinkSync(join(root, "wiki/gone.md"));
    const diff = diffSnapshots(before, snapshotWiki(root));
    expect(diff).toEqual({
      created: ["wiki/new.md"],
      modified: ["wiki/touch.md"],
      deleted: ["wiki/gone.md"],
    });
  });
});
