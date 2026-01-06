// lib/fs.ts
import { dirname as stdDirname } from "@std/path/dirname";
import type { SpawnedRecord } from "./governance.ts";

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

export function spawnedJsonPath(
  spawnedDir: string,
  dbBasename: string,
  instanceId: string,
): string {
  const idHash = fnv1a32Hex(instanceId);
  return `${normalizeSlash(spawnedDir)}/${dbBasename}.${idHash}.json`;
}

export function spawnedStdoutPath(
  spawnedDir: string,
  dbBasename: string,
  instanceId: string,
): string {
  const idHash = fnv1a32Hex(instanceId);
  return `${normalizeSlash(spawnedDir)}/${dbBasename}.${idHash}.stdout.log`;
}

export function spawnedStderrPath(
  spawnedDir: string,
  dbBasename: string,
  instanceId: string,
): string {
  const idHash = fnv1a32Hex(instanceId);
  return `${normalizeSlash(spawnedDir)}/${dbBasename}.${idHash}.stderr.log`;
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
): Promise<SpawnedRecord | undefined> {
  try {
    const raw = await Deno.readTextFile(path);
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 1) return undefined;
    return obj as SpawnedRecord;
  } catch {
    return undefined;
  }
}

export async function writeSpawnedRecord(
  path: string,
  rec: SpawnedRecord,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(rec, null, 2));
  await Deno.rename(tmp, path);
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
  try {
    for await (const e of Deno.readDir(spawnedDir)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const p = `${spawnedDir}/${e.name}`;
      const rec = await readSpawnedRecord(p);
      if (!rec?.dbPath) continue;
      if (!liveDbPaths.has(rec.dbPath)) {
        await removeFileIfExists(p);
      }
    }
  } catch {
    // ignore
  }
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
  for (const r0 of watchRootsAbs) {
    const r = normalizeSlash(r0).replace(/\/+$/, "");
    if (db === r) return ".";
    if (db.startsWith(r + "/")) return db.slice(r.length + 1);
  }
  return undefined;
}

export function defaultRelativeInstanceId(relOrAbs: string): string {
  const s = normalizeSlash(relOrAbs).replace(/^\.\/+/, "");
  return s || "db";
}

export function dirname(path: string): string {
  return normalizeSlash(stdDirname(path));
}
