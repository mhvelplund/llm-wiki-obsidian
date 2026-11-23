import { posix } from "node:path";

/**
 * Map a link written by Claude in an answer to a vault path (the vault is the repo's `wiki/` folder).
 * Returns null for external links and anything that is not a `.md` page inside the vault.
 */
export function rewriteLinkForVault(href: string, wikiRelSourcePath: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const hashAt = href.indexOf("#");
  const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : href.slice(hashAt);
  if (rawPath === "") return null;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  if (!path.toLowerCase().endsWith(".md")) return null;
  const resolved = path.startsWith("wiki/")
    ? posix.normalize(path.slice("wiki/".length))
    : posix.normalize(posix.join(posix.dirname(wikiRelSourcePath), path));
  if (resolved.startsWith("..") || resolved.startsWith("/")) return null;
  return resolved + fragment;
}
