// lib/fs.ts
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";

export async function ensureParentDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (dir && dir !== "." && dir !== "/") await ensureDir(dir);
}

export function isSafeRelativeSubpath(rel: string): boolean {
  const s = String(rel ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!s) return false;
  if (s.includes("\0")) return false;
  const parts = s.split("/").filter((x) => x.length > 0);
  if (!parts.length) return false;
  for (const part of parts) {
    if (part === "." || part === "..") return false;
  }
  return true;
}

export type ListedFile = Readonly<{
  name: string; // relative to root, may include subdirs
  size: number;
  mtimeMs: number;
}>;

export async function listFilesRecursive(
  rootDir: string,
  opts?: Readonly<{
    hideNames?: ReadonlyArray<string>;
    hidePrefixes?: ReadonlyArray<string>;
    hideSuffixes?: ReadonlyArray<string>;
  }>,
): Promise<ListedFile[]> {
  const root = String(rootDir ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  const out: ListedFile[] = [];

  const hideNames = new Set(opts?.hideNames ?? []);
  const hidePrefixes = opts?.hidePrefixes ?? [];
  const hideSuffixes = opts?.hideSuffixes ?? [];

  const shouldHide = (name: string) => {
    if (hideNames.has(name)) return true;
    for (const p of hidePrefixes) if (name.startsWith(p)) return true;
    for (const s of hideSuffixes) if (name.endsWith(s)) return true;
    return false;
  };

  async function walk(dirAbs: string, relDir: string) {
    let it: AsyncIterable<Deno.DirEntry>;
    try {
      it = Deno.readDir(dirAbs);
    } catch {
      return;
    }

    for await (const e of it) {
      const abs = join(dirAbs, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const name = rel.replaceAll("\\", "/");

      if (shouldHide(name) || shouldHide(e.name)) continue;

      if (e.isDirectory) {
        await walk(abs, name);
        continue;
      }
      if (!e.isFile) continue;

      let st: Deno.FileInfo;
      try {
        st = await Deno.stat(abs);
      } catch {
        continue;
      }

      out.push({
        name,
        size: st.size,
        mtimeMs: st.mtime?.getTime() ?? 0,
      });
    }
  }

  await walk(root, "");
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function contentTypeByName(name: string): string {
  const n = String(name ?? "").toLowerCase();
  if (n.endsWith(".json")) return "application/json; charset=utf-8";
  if (n.endsWith(".html") || n.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  if (n.endsWith(".css")) return "text/css; charset=utf-8";
  if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (n.endsWith(".log") || n.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  if (n.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
