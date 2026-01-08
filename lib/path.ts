// lib/path.ts
import { basename, dirname, extname, relative } from "@std/path";

export function normalizeSlash(p: string): string {
  return String(p ?? "").replaceAll("\\", "/").replaceAll(/\/+/g, "/");
}

export function stripOneExt(p: string): string {
  const ext = extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

export function normalizePathForUrl(path: string): string {
  const p = normalizeSlash(path).trim();
  if (!p) return "/";
  if (!p.startsWith("/")) return `/${p}`;
  return p;
}

export function joinUrl(baseUrl: string, path: string): string {
  const b = String(baseUrl ?? "").replace(/\/+$/, "");
  const p = normalizePathForUrl(path);
  return `${b}${p}`;
}

export function safeRelFromRoot(
  root: string | undefined,
  filePath: string,
): string {
  try {
    if (!root || root.trim().length === 0) return filePath;
    const rel0 = relative(root, filePath);
    if (rel0.startsWith("..") || rel0 === "") return filePath;
    return normalizeSlash(rel0).replaceAll(/^\.\//g, "");
  } catch {
    return filePath;
  }
}

export function defaultProxyEndpointPrefix(
  kind: string,
  relNoExt: string,
): string {
  const norm = normalizeSlash(relNoExt).replaceAll(/^\.\//g, "").trim();
  const clean = norm.length === 0 ? kind : norm;
  return `/apps/${kind}/${clean}`.replaceAll(/\/+/g, "/");
}

export function proxyPrefixFromRel(relFromRoot: string): string {
  const relNoExt = stripOneExt(relFromRoot);
  const clean = normalizeSlash(relNoExt).replaceAll(/^\.\//g, "").trim();
  if (!clean) return "/";
  return `/${clean.startsWith("/") ? clean.slice(1) : clean}`.replaceAll(
    /\/+/g,
    "/",
  );
}

export function bestRootForFile(
  fileAbs: string,
  rootsAbs: readonly string[],
): string | undefined {
  const f = normalizeSlash(fileAbs);
  const candidates = rootsAbs
    .map((r) => normalizeSlash(r))
    .filter((r) => f === r || f.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length);
  return candidates[0];
}

export function relFromRoots(
  fileAbs: string,
  rootsAbs: readonly string[],
): string {
  const root = bestRootForFile(fileAbs, rootsAbs);
  if (!root) return basename(fileAbs);

  let rel0 = relative(root, fileAbs);
  rel0 = normalizeSlash(rel0).replaceAll(/^\.\//g, "");

  const rootName = basename(root);
  const prefix = `${rootName}/`;
  if (rel0.startsWith(prefix)) rel0 = rel0.slice(prefix.length);

  if (!rel0 || rel0.startsWith("..")) return basename(fileAbs);
  return rel0;
}

export function relDirFromRoots(
  fileAbs: string,
  rootsAbs: readonly string[],
): string {
  const rel = relFromRoots(fileAbs, rootsAbs);
  const d = dirname(rel);
  if (d === "." || d === "/" || d.trim() === "") return "";
  return normalizeSlash(d).replaceAll(/\/+$/g, "");
}
