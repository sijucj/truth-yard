// lib/spawnable.ts
import type { SpawnDriver, SpawnPlan } from "./governance.ts";
import { safeBaseName } from "./fs.ts";

function buildSqlpageDatabaseUrl(dbAbsPath: string): string {
  return `sqlite://${dbAbsPath}`;
}

function unquoteAndUnescape(v: string): string {
  const t = v.trim();
  if (t.length >= 2) {
    const q = t[0];
    const last = t[t.length - 1];
    if ((q === "'" || q === '"') && last === q) {
      const inner = t.slice(1, -1);
      // Minimal unescape (good enough for most .env blocks)
      if (q === '"') {
        return inner
          .replaceAll("\\n", "\n")
          .replaceAll("\\r", "\r")
          .replaceAll("\\t", "\t")
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\");
      }
      // single-quoted: usually literal; still allow \' and \\ as a convenience
      return inner.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
    }
  }
  return t;
}

function parseEnvBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line0 of block.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;

    // allow: export KEY=VALUE
    const s = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;

    const eq = s.indexOf("=");
    if (eq <= 0) continue;

    const key = s.slice(0, eq).trim();
    if (!key) continue;

    // Simple env-var name validation; skip weird keys.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rawVal = s.slice(eq + 1);
    const val = unquoteAndUnescape(rawVal);

    out[key] = val;
  }
  return out;
}

function envFromDbYardConfig(
  dbYardConfig: Record<string, unknown>,
): Record<string, string> {
  const v = dbYardConfig[".env"];
  if (typeof v !== "string") return {};
  const block = v.trim();
  if (!block) return {};
  return parseEnvBlock(block);
}

export function makeDefaultDrivers(): SpawnDriver[] {
  const rssd: SpawnDriver = {
    kind: "rssd",
    buildPlan: (a): SpawnPlan => {
      const bin = typeof a.dbYardConfig["surveilr.bin"] === "string"
        ? String(a.dbYardConfig["surveilr.bin"])
        : a.surveilrBin;

      const extraArgs = Array.isArray(a.dbYardConfig["surveilr.args"])
        ? (a.dbYardConfig["surveilr.args"] as unknown[]).map(String)
        : [];

      // Apply per-DB env block (if any)
      const envBlock = envFromDbYardConfig(a.dbYardConfig);

      return {
        kind: "rssd",
        command: bin,
        args: [
          "web-ui",
          "-d",
          a.dbPath,
          "--port",
          String(a.port),
          ...extraArgs,
        ],
        env: {
          SQLPAGE_SITE_PREFIX: a.proxyEndpointPrefix,
          ...envBlock,
        },
        tag: `rssd:${safeBaseName(a.dbPath)}`,
      };
    },
  };

  const sqlpage: SpawnDriver = {
    kind: "sqlpage",
    buildPlan: (a): SpawnPlan => {
      const bin = typeof a.dbYardConfig["sqlpage.bin"] === "string"
        ? String(a.dbYardConfig["sqlpage.bin"])
        : a.sqlpageBin;

      const baseEnv: Record<string, string> = {
        DATABASE_URL: buildSqlpageDatabaseUrl(a.dbPath),
        LISTEN_ON: `${a.listenHost}:${a.port}`,
        SQLPAGE_ENVIRONMENT: a.sqlpageEnv,
      };

      const extraEnv = a.dbYardConfig["sqlpage.env"];
      const extraEnvObj: Record<string, string> = {};
      if (
        extraEnv && typeof extraEnv === "object" && !Array.isArray(extraEnv)
      ) {
        for (
          const [k, v] of Object.entries(extraEnv as Record<string, unknown>)
        ) {
          extraEnvObj[k] = String(v);
        }
      }

      // Apply per-DB env block (if any). Put last so it can override defaults if desired.
      const envBlock = envFromDbYardConfig(a.dbYardConfig);

      const extraArgs = Array.isArray(a.dbYardConfig["sqlpage.args"])
        ? (a.dbYardConfig["sqlpage.args"] as unknown[]).map(String)
        : [];

      return {
        kind: "sqlpage",
        command: bin,
        args: [...extraArgs],
        env: {
          SQLPAGE_SITE_PREFIX: a.proxyEndpointPrefix,
          ...baseEnv,
          ...extraEnvObj,
          ...envBlock,
        },
        tag: `sqlpage:${safeBaseName(a.dbPath)}`,
      };
    },
  };

  return [rssd, sqlpage];
}
