// lib/watch.ts
import { expandGlob } from "@std/fs";
import { globToRegExp } from "@std/path/glob-to-regexp";
import { dirname as stdDirname } from "@std/path/dirname";
import { normalizeSlash } from "./fs.ts";

export function compileGlobMatchers(globs: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const g of globs) {
    try {
      out.push(globToRegExp(g, { extended: true, globstar: true }));
    } catch {
      // ignore invalid glob
    }
  }
  return out;
}

export function matchesAny(path: string, matchers: readonly RegExp[]): boolean {
  const p = normalizeSlash(path);
  for (const rx of matchers) if (rx.test(p)) return true;
  return false;
}

export async function expandAll(globs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const g of globs) {
    for await (const e of expandGlob(g, { globstar: true })) {
      if (e.isFile) out.push(normalizeSlash(e.path));
    }
  }
  return out;
}

export async function deriveWatchRootsFromGlobs(
  watchGlobs: readonly string[],
): Promise<string[]> {
  const roots = new Set<string>();
  for (const g of watchGlobs) {
    for await (const e of expandGlob(g, { globstar: true })) {
      if (!e.isFile) continue;
      roots.add(normalizeSlash(stdDirname(e.path)));
    }
  }
  if (roots.size === 0) roots.add(normalizeSlash(Deno.cwd()));
  return [...roots];
}

export async function deriveWatchDirsFromGlobs(
  watchGlobs: readonly string[],
): Promise<string[]> {
  // Same behavior today: derive from real matches, else fallback to cwd.
  const dirs = new Set<string>();
  for (const g of watchGlobs) {
    for await (const e of expandGlob(g, { globstar: true })) {
      if (!e.isFile) continue;
      dirs.add(normalizeSlash(stdDirname(e.path)));
    }
  }
  if (dirs.size === 0) dirs.add(normalizeSlash(Deno.cwd()));
  return [...dirs];
}
