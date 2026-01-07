// lib/reverse-proxy-conf.ts
import { normalize as normalizePath } from "@std/path";
import { ensureDir, liveSpawnedRecords, normalizeSlash } from "./fs.ts";
import type { SpawnedProcess } from "./governance.ts";

function safeFileName(s: string) {
  return s.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

async function writeTextAtomic(path: string, content: string) {
  const p = normalizeSlash(path);
  const dir = p.slice(0, Math.max(0, p.lastIndexOf("/")));
  if (dir) await ensureDir(dir);
  const tmp = `${p}.tmp`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, p);
}

function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function getCfgString(
  cfg: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!cfg) return undefined;
  for (const k of keys) {
    const v = cfg[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function getCfgBool(
  cfg: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!cfg) return undefined;
  for (const k of keys) {
    const v = cfg[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
      if (t === "false" || t === "0" || t === "no" || t === "off") return false;
    }
  }
  return undefined;
}

function stripDbSuffix(name: string): string {
  const s = name.trim();
  if (!s) return "db";
  if (s.toLowerCase().endsWith(".sqlite.db")) {
    return s.slice(0, -".sqlite.db".length);
  }
  if (s.toLowerCase().endsWith(".db")) return s.slice(0, -".db".length);
  return s;
}

function splitDirAndBase(rel: string): { dir: string; base: string } {
  const p = normalizePath(rel).replace(/^\.\/+/, "").replace(/^\/+/, "");
  const parts = p.split("/").filter((x) => x.length);
  const last = parts.pop() ?? "db";
  const dir = parts.join("/");
  const base = stripDbSuffix(last) || "db";
  return { dir, base };
}

/**
 * Default proxy prefix:
 * - derived from rec.dbRelPath (relative to watch root)
 * - prefix = "/<dir>/<base>/" where <base> is db file name without ".db" or ".sqlite.db"
 * Example: "abc/def/my.sqlite.db" => "/abc/def/my/"
 */
function defaultLocationPrefix(rec: SpawnedProcess): string {
  const rel = typeof rec.dbRelPath === "string" && rec.dbRelPath.trim()
    ? rec.dbRelPath.trim()
    : rec.dbBasename;

  const { dir, base } = splitDirAndBase(rel);
  const prefix = dir ? `/${dir}/${base}/` : `/${base}/`;
  return prefix.replaceAll(/\/+/, "/");
}

function parseEntryPointsCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

export function nginxReverseProxyConf(rec: SpawnedProcess): string {
  const cfg = (rec.dbYardConfig ?? {}) as Record<string, unknown>;

  const locationPrefix = getCfgString(cfg, [
    "nginx-proxy-conf.location-prefix",
    "nginx-proxy-conf-location-prefix",
  ]) ?? defaultLocationPrefix(rec);

  const serverName = getCfgString(cfg, ["nginx-proxy-conf.server-name"]) ?? "_";

  const listen = getCfgString(cfg, ["nginx-proxy-conf.listen"]) ?? "80";

  // Default is NO STRIP
  const stripPrefix = getCfgBool(cfg, ["nginx-proxy-conf.strip-prefix"]) ??
    false;

  const extra = getCfgString(cfg, ["nginx-proxy-conf.extra"]) ?? "";

  const upstream = `http://${rec.listenHost}:${rec.port}`;

  const name = safeFileName(rec.id);
  const hash = fnv1a32Hex(rec.id);

  const lp =
    (locationPrefix.endsWith("/") ? locationPrefix : `${locationPrefix}/`)
      .replaceAll(/\/+/, "/");

  const rewriteLine = stripPrefix
    ? `    rewrite ^${lp.replaceAll("/", "\\/")}(.*)$ /$1 break;\n`
    : "";

  const extraBlock = extra.trim() ? `\n${extra.trimEnd()}\n` : "";

  return `# db-yard nginx reverse proxy (generated)
# id=${rec.id}
# db=${rec.dbPath}
# rel=${rec.dbRelPath ?? ""}
# kind=${rec.kind}
# pid=${rec.pid}
# upstream=${upstream}

# Suggested include filename:
#   db-yard.${name}.${hash}.conf

server {
  listen ${listen};
  server_name ${serverName};

  location ${lp} {
${rewriteLine}    proxy_pass ${upstream};
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }${extraBlock}}
`;
}

export function traefikReverseProxyConf(rec: SpawnedProcess): string {
  const cfg = (rec.dbYardConfig ?? {}) as Record<string, unknown>;

  const locationPrefix =
    getCfgString(cfg, ["traefik-proxy-conf.location-prefix"]) ??
      defaultLocationPrefix(rec);

  const lpNoTrail = locationPrefix.replaceAll(/\/+$/, "") ||
    defaultLocationPrefix(rec).replaceAll(/\/+$/, "");
  const url = `http://${rec.listenHost}:${rec.port}`;

  const entrypointsRaw =
    getCfgString(cfg, ["traefik-proxy-conf.entrypoints"]) ?? "web";
  const entryPoints = parseEntryPointsCsv(entrypointsRaw);
  const entryPointsYaml = entryPoints.length ? entryPoints.join(", ") : "web";

  const defaultRule = `PathPrefix(\`${lpNoTrail}/\`)`;
  const rule = getCfgString(cfg, ["traefik-proxy-conf.rule"]) ?? defaultRule;

  // Default is NO STRIP
  const stripPrefix = getCfgBool(cfg, ["traefik-proxy-conf.strip-prefix"]) ??
    false;

  const extraYaml = getCfgString(cfg, ["traefik-proxy-conf.extra"]) ?? "";

  const name = safeFileName(rec.id);
  const hash = fnv1a32Hex(rec.id);

  const routerName = `db-yard-${name}-${hash}`;
  const serviceName = `svc-${name}-${hash}`;
  const mwName = `mw-strip-${name}-${hash}`;

  const mwBlock = stripPrefix
    ? `
  middlewares:
    ${mwName}:
      stripPrefix:
        prefixes:
          - "${lpNoTrail}"
`
    : "";

  const extraBlock = extraYaml.trim() ? `\n${extraYaml.trimEnd()}\n` : "";

  return `# db-yard traefik dynamic config (generated)
# id=${rec.id}
# db=${rec.dbPath}
# rel=${rec.dbRelPath ?? ""}
# kind=${rec.kind}
# pid=${rec.pid}
http:
  routers:
    ${routerName}:
      rule: ${rule}
      entryPoints: [${entryPointsYaml}]
      service: ${serviceName}${
    stripPrefix ? `\n      middlewares: [${mwName}]` : ""
  }

  services:
    ${serviceName}:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "${url}"
${mwBlock}${extraBlock}`;
}

export async function generateReverseProxyConfsFromLiveJson(args: {
  spawnedStatePath: string;
  nginxConfHome?: string;
  traefikConfHome?: string;
  verbose: boolean;
}) {
  const live = await liveSpawnedRecords(args.spawnedStatePath);

  if (args.nginxConfHome) {
    const dir = normalizePath(args.nginxConfHome);
    await ensureDir(dir);

    for (const rec of live) {
      const fn = `db-yard.${safeFileName(rec.id)}.conf`;
      await writeTextAtomic(`${dir}/${fn}`, nginxReverseProxyConf(rec));
    }

    const bundle = live.map((r) => nginxReverseProxyConf(r)).join("\n");
    await writeTextAtomic(`${dir}/db-yard.generated.conf`, bundle);

    if (args.verbose) {
      console.log(
        `[spawned] wrote nginx conf(s) to: ${dir} (and db-yard.generated.conf)`,
      );
    }
  }

  if (args.traefikConfHome) {
    const dir = normalizePath(args.traefikConfHome);
    await ensureDir(dir);

    for (const rec of live) {
      const fn = `db-yard.${safeFileName(rec.id)}.yaml`;
      await writeTextAtomic(`${dir}/${fn}`, traefikReverseProxyConf(rec));
    }

    const bundle = live.map((r) => traefikReverseProxyConf(r)).join("\n");
    await writeTextAtomic(`${dir}/db-yard.generated.yaml`, bundle);

    if (args.verbose) {
      console.log(
        `[spawned] wrote traefik conf(s) to: ${dir} (and db-yard.generated.yaml)`,
      );
    }
  }

  if (!args.nginxConfHome && !args.traefikConfHome) {
    console.log(live.map((r) => nginxReverseProxyConf(r)).join("\n"));
  }
}
