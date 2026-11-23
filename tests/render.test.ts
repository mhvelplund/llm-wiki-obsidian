import { describe, expect, it } from "vitest";
import { rewriteLinkForVault } from "../src/view/render";

describe("rewriteLinkForVault", () => {
  it("resolves a relative .md link against the source page", () => {
    expect(rewriteLinkForVault("../operations/stlx-cli.md", "stl-browser/concepts/a.md")).toBe(
      "stl-browser/operations/stlx-cli.md",
    );
  });
  it("strips a leading wiki/ prefix", () => {
    expect(rewriteLinkForVault("wiki/stl-browser/index.md", "index.md")).toBe("stl-browser/index.md");
  });
  it("returns null for external links", () => {
    expect(rewriteLinkForVault("https://github.com/x", "index.md")).toBeNull();
    expect(rewriteLinkForVault("mailto:a@b.c", "index.md")).toBeNull();
  });
  it("keeps a heading fragment and rejects non-md or escaping links", () => {
    expect(rewriteLinkForVault("b.md#intro", "x/a.md")).toBe("x/b.md#intro");
    expect(rewriteLinkForVault("img.png", "a.md")).toBeNull();
    expect(rewriteLinkForVault("../../a.md", "x/b.md")).toBeNull();
    expect(rewriteLinkForVault("#top", "a.md")).toBeNull();
  });
});
