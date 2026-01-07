// lib/fs.ts
import { dirname as stdDirname } from "@std/path/dirname";
import { normalize as stdNormalize } from "@std/path/normalize";
import type { SpawnedProcess } from "./governance.ts";

const text = new TextDecoder();

export function nowMs() {
  return Date.now();
}

export function normalizeSlash(p: string) {
  return p.replaceAll("\\", "/");
}

export function isAbsPath(p: string) {
  const s = normalizeSlash(p);
  if (s.startsWith("/")) return true;
  if (/^[A-Za-z]:\//.test(s)) return true;
  if (s.startsWith("//")) return true;
  return false;
}

export function resolvePath(p: string) {
  const s = normalizeSlash(p.trim());
  return isAbsPath(s) ? s : normalizeSlash(`${Deno.cwd()}/${s}`);
}

export function resolveGlob(g: string) {
  const s = normalizeSlash(g.trim());
  return isAbsPath(s) ? s : normalizeSlash(`${Deno.cwd()}/${s}`);
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function sessionStamp(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd}-${hh}-${mi}-${ss}`;
}

export async function ensureDir(dir: string) {
  await Deno.mkdir(dir, { recursive: true }).catch(() => {});
}

export async function fileStatSafe(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch {
    return undefined;
  }
}

export function safeBaseName(path: string): string {
  const p = normalizeSlash(path);
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function toSafeRelativeDir(rel: string): string {
  // Normalize and keep it safely relative.
  // - no absolute paths
  // - no ".." segments
  // - strip leading "./" and leading "/"
  const n = normalizeSlash(stdNormalize(normalizeSlash(rel)))
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");

  if (!n) return "";

  const parts = n.split("/").filter((x) => x.length > 0);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part);
  }
  return safe.join("/");
}

export function spawnedSubdirForDb(args: {
  spawnedDir: string;
  dbRelPath?: string;
}): string {
  const root = normalizeSlash(args.spawnedDir).replace(/\/+$/, "");
  const rel = typeof args.dbRelPath === "string" ? args.dbRelPath.trim() : "";
  if (!rel) return root;

  // Store under the directory portion of dbRelPath.
  const dir = toSafeRelativeDir(dirname(rel));
  if (!dir || dir === ".") return root;

  return normalizeSlash(`${root}/${dir}`);
}

export function spawnedJsonPath(args: {
  spawnedDir: string;
  dbRelPath?: string;
  dbBasename: string;
  instanceId: string;
}): string {
  const idHash = fnv1a32Hex(args.instanceId);
  const dir = spawnedSubdirForDb({
    spawnedDir: args.spawnedDir,
    dbRelPath: args.dbRelPath,
  });
  return `${dir}/${args.dbBasename}.${idHash}.json`;
}

export function spawnedStdoutPath(args: {
  spawnedDir: string;
  dbRelPath?: string;
  dbBasename: string;
  instanceId: string;
}): string {
  const idHash = fnv1a32Hex(args.instanceId);
  const dir = spawnedSubdirForDb({
    spawnedDir: args.spawnedDir,
    dbRelPath: args.dbRelPath,
  });
  return `${dir}/${args.dbBasename}.${idHash}.stdout.log`;
}

export function spawnedStderrPath(args: {
  spawnedDir: string;
  dbRelPath?: string;
  dbBasename: string;
  instanceId: string;
}): string {
  const idHash = fnv1a32Hex(args.instanceId);
  const dir = spawnedSubdirForDb({
    spawnedDir: args.spawnedDir,
    dbRelPath: args.dbRelPath,
  });
  return `${dir}/${args.dbBasename}.${idHash}.stderr.log`;
}

export async function loadOrCreateOwnerToken(
  spawnedDir: string,
): Promise<string> {
  const p = `${normalizeSlash(spawnedDir)}/.db-yard.owner-token`;
  try {
    const existing = (await Deno.readTextFile(p)).trim();
    if (existing) return existing;
  } catch {
    // ignore
  }
  const tok = crypto.randomUUID();
  await Deno.writeTextFile(p, tok);
  return tok;
}

export async function writeSpawnedPidsFile(
  spawnedDir: string,
  pids: number[],
): Promise<void> {
  const unique = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))]
    .sort((a, b) => a - b);

  const path = `${normalizeSlash(spawnedDir)}/spawned-pids.txt`;
  const content = unique.join(" ");

  try {
    const prev = await Deno.readTextFile(path);
    if (prev.trim() === content.trim()) return;
  } catch {
    // ignore
  }

  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, path);
}

export async function readSpawnedRecord(
  path: string,
): Promise<SpawnedProcess | undefined> {
  try {
    const raw = await Deno.readTextFile(path);
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 1) return undefined;
    return obj as SpawnedProcess;
  } catch {
    return undefined;
  }
}

export async function writeSpawnedRecord(
  path: string,
  rec: SpawnedProcess,
): Promise<void> {
  const p = normalizeSlash(path);
  const dir = dirname(p);
  if (dir) await ensureDir(dir);

  const tmp = `${p}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(rec, null, 2));
  await Deno.rename(tmp, p);
}

export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // ignore
  }
}

export async function cleanupSpawnedDir(
  spawnedDir: string,
  liveDbPaths: Set<string>,
) {
  const root = normalizeSlash(spawnedDir);

  async function walk(dir: string) {
    let it: AsyncIterable<Deno.DirEntry>;
    try {
      it = Deno.readDir(dir);
    } catch {
      return;
    }

    for await (const e of it) {
      const p = normalizeSlash(`${dir}/${e.name}`);
      if (e.isDirectory) {
        await walk(p);
        continue;
      }
      if (!e.isFile || !p.endsWith(".json")) continue;

      const rec = await readSpawnedRecord(p);
      if (!rec?.dbPath) continue;

      if (!liveDbPaths.has(rec.dbPath)) {
        await removeFileIfExists(p);
      }
    }
  }

  await walk(root);
}

export async function readProcCmdline(
  pid: number,
): Promise<string | undefined> {
  // Platform-specific: Linux-first best-effort via /proc
  const p = `/proc/${pid}/cmdline`;
  try {
    const raw = await Deno.readFile(p);
    const s = text.decode(raw);
    const parts = s.split("\0").filter((x) => x.length);
    if (!parts.length) return undefined;
    return parts.join(" ");
  } catch {
    return undefined;
  }
}

export async function listSpawnedPidFiles(
  spawnedStatePath: string,
): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(spawnedStatePath)) {
      if (!e.isDirectory) continue;
      const p = `${spawnedStatePath}/${e.name}/spawned-pids.txt`;
      try {
        const st = await Deno.stat(p);
        if (st.isFile) out.push(p);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return out;
}

export async function readPidsFromFile(path: string): Promise<number[]> {
  try {
    const raw = (await Deno.readTextFile(path)).trim();
    if (!raw) return [];
    return raw.split(/\s+/)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.floor(n));
  } catch {
    return [];
  }
}

export function parseListenHost(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "127.0.0.1";
  if (/[^\w.\-:[\]]/.test(trimmed)) return "127.0.0.1";
  return trimmed;
}

export function toPositiveInt(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

export function isPidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pickFreePort(listenHost: string): number {
  const listener = Deno.listen({ hostname: listenHost, port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

export function computeRelPath(
  watchRootsAbs: readonly string[],
  dbAbsPath: string,
): string | undefined {
  const db = normalizeSlash(dbAbsPath);

  let bestRoot: string | undefined;

  for (const r0 of watchRootsAbs) {
    const r = normalizeSlash(r0).replace(/\/+$/, "");

    if (db === r || db.startsWith(r + "/")) {
      if (!bestRoot || r.length < bestRoot.length) {
        bestRoot = r;
      }
    }
  }

  if (!bestRoot) return undefined;

  if (db === bestRoot) return ".";
  return db.slice(bestRoot.length + 1);
}

export function defaultRelativeInstanceId(relOrAbs: string): string {
  const s = normalizeSlash(relOrAbs).replace(/^\.\/+/, "");
  return s || "db";
}

export function dirname(path: string): string {
  return normalizeSlash(stdDirname(path));
}

/**
 * Scan a spawned-state root directory, read all v1 SpawnedRecord JSON files,
 * and return only those whose PID is still alive.
 */
export async function liveSpawnedRecords(
  root: string,
): Promise<SpawnedProcess[]> {
  const out: SpawnedProcess[] = [];
  const rootN = normalizeSlash(root);

  async function walk(dir: string) {
    let it: AsyncIterable<Deno.DirEntry>;
    try {
      it = Deno.readDir(dir);
    } catch {
      return;
    }

    for await (const e of it) {
      const p = normalizeSlash(`${dir}/${e.name}`);

      if (e.isDirectory) {
        await walk(p);
        continue;
      }

      if (!e.isFile || !p.endsWith(".json")) continue;

      let rec: SpawnedProcess | undefined;
      try {
        const raw = await Deno.readTextFile(p);
        const obj = JSON.parse(raw);
        if (obj && obj.version === 1) rec = obj as SpawnedProcess;
      } catch {
        rec = undefined;
      }

      if (!rec?.pid || !rec.id) continue;
      if (!isPidAlive(rec.pid)) continue;

      out.push(rec);
    }
  }

  await walk(rootN);

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
