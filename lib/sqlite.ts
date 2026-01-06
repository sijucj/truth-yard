// lib/sqlite.ts
import type { SpawnedCtxSnapshot } from "./governance.ts";
import { nowMs } from "./fs.ts";

const text = new TextDecoder();

function looksLikeJsonText(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (t.startsWith("{") && t.endsWith("}")) return true;
  if (t.startsWith("[") && t.endsWith("]")) return true;
  return false;
}

function coerceValue(raw: string): unknown {
  const t = raw.trim();
  if (!t) return "";
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (looksLikeJsonText(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function runSqliteQueryViaCli(opts: {
  exec: string;
  dbPath: string;
  sql: string;
}): Promise<SpawnedCtxSnapshot> {
  const ranAtMs = nowMs();

  // sqlite3 -json exists in newer sqlite3 builds, but not all.
  const tryModes: { args: string[]; mode: "json" | "line" }[] = [
    { args: ["-json", opts.dbPath, opts.sql], mode: "json" },
    { args: ["-line", opts.dbPath, opts.sql], mode: "line" },
  ];

  for (const m of tryModes) {
    try {
      const cmd = new Deno.Command(opts.exec, {
        args: m.args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      const stdout = text.decode(out.stdout).trim();
      const stderr = text.decode(out.stderr).trim();

      if (!out.success) {
        if (
          m.mode === "json" &&
          /unknown option|unrecognized option|-json/i.test(stderr)
        ) {
          continue;
        }
        return {
          exec: opts.exec,
          sql: opts.sql,
          ranAtMs,
          ok: false,
          exitCode: out.code,
          stderr: stderr || undefined,
          output: stdout || undefined,
        };
      }

      if (m.mode === "json") {
        try {
          const parsed = stdout.length ? JSON.parse(stdout) : [];
          return {
            exec: opts.exec,
            sql: opts.sql,
            ranAtMs,
            ok: true,
            exitCode: out.code,
            stderr: stderr || undefined,
            output: parsed,
          };
        } catch {
          return {
            exec: opts.exec,
            sql: opts.sql,
            ranAtMs,
            ok: true,
            exitCode: out.code,
            stderr: stderr || undefined,
            output: stdout,
            note: "sqlite3 -json output could not be parsed; stored as text",
          };
        }
      }

      return {
        exec: opts.exec,
        sql: opts.sql,
        ranAtMs,
        ok: true,
        exitCode: out.code,
        stderr: stderr || undefined,
        output: stdout,
        note: "sqlite3 -line output stored as text",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        exec: opts.exec,
        sql: opts.sql,
        ranAtMs,
        ok: false,
        stderr: msg,
      };
    }
  }

  return {
    exec: opts.exec,
    sql: opts.sql,
    ranAtMs,
    ok: false,
    stderr: "No sqlite exec mode succeeded",
  };
}

export async function readDbYardConfig(args: {
  sqliteExec: string;
  dbPath: string;
}): Promise<Record<string, unknown>> {
  const sql = `select key as k, value as v from ".db-yard" order by key`;
  const snap = await runSqliteQueryViaCli({
    exec: args.sqliteExec,
    dbPath: args.dbPath,
    sql,
  });

  if (!snap.ok) return {};

  const cfg: Record<string, unknown> = {};

  if (Array.isArray(snap.output)) {
    for (const row of snap.output as unknown[]) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const k = typeof r.k === "string"
        ? r.k
        : (typeof r.key === "string" ? r.key : "");
      const v = typeof r.v === "string"
        ? r.v
        : (typeof r.value === "string" ? r.value : "");
      if (!k) continue;
      cfg[k] = coerceValue(v);
    }
    return cfg;
  }

  // If sqlite3 -line is used, treat as empty (no reliable row parsing).
  return {};
}

export async function tableExists(args: {
  sqliteExec: string;
  dbPath: string;
  name: string;
}): Promise<boolean> {
  const nameEsc = args.name.replaceAll("'", "''");
  const sql =
    `select 1 as ok from sqlite_master where (type='table' or type='view') and name='${nameEsc}' limit 1`;
  const snap = await runSqliteQueryViaCli({
    exec: args.sqliteExec,
    dbPath: args.dbPath,
    sql,
  });
  if (!snap.ok) return false;
  if (Array.isArray(snap.output)) return snap.output.length > 0;
  const s = typeof snap.output === "string" ? snap.output.trim() : "";
  return s.length > 0;
}
