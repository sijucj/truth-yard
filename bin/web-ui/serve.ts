#!/usr/bin/env -S deno run --watch -A --node-modules-dir=auto
// bin/web-ui/serve.ts

import { Command } from "@cliffy/command";
import { normalize, resolve } from "@std/path";
import { Hono } from "jsr:@hono/hono@4.11.3";
import type { Context } from "jsr:@hono/hono@4.11.3";
import { serveStatic } from "jsr:@hono/hono@4.11.3/deno";
import { proxy } from "jsr:@hono/hono@4.11.3/proxy";
import { reconcile, type ReconcileItem } from "../../lib/materialize.ts";
import { type TaggedProcess, taggedProcesses } from "../../lib/spawn.ts";

/* ---------------- types ---------------- */

export type ProxyRoute = { basePath: string; upstreamUrl: string };
export type ProxyConflict = { basePath: string; upstreamUrls: string[] };

type Mounts = {
  mount: string;
  assetsMount: string;
  uiMount: string;
  apiMount: string;
  ledgerMount: string;
};

type AppCfg = {
  host: string;
  port: number;
  ledgerDirAbs: string;
  assetsDir: string;
  proxyEnabled: boolean;
};

type Deps = {
  app: Hono;
  cfg: AppCfg;
  mounts: Mounts;
  getProcesses: () => Promise<TaggedProcess[]>;
};

/* ---------------- utilities ---------------- */

function toPosixPath(p: string) {
  return p.replaceAll("\\", "/");
}

function stripLeadingSlash(p: string) {
  return p.startsWith("/") ? p.slice(1) : p;
}

function safeJoin(rootAbs: string, requestPath: string) {
  const rp = stripLeadingSlash(toPosixPath(requestPath));
  const fullAbs = normalize(resolve(rootAbs, rp));
  if (fullAbs === rootAbs) return fullAbs;
  if (!fullAbs.startsWith(rootAbs + "/")) return null;
  return fullAbs;
}

async function exists(p: string) {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfSmall(path: string, maxBytes = 2_000_000) {
  const st = await Deno.stat(path);
  if (!st.isFile) return null;
  if (st.size > maxBytes) return null;
  return await Deno.readTextFile(path);
}

function guessContentType(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".js") || p.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".log") || p.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.race([
    promise,
    new Promise<T>((_, rej) =>
      ac.signal.addEventListener(
        "abort",
        () => rej(new Error(`timeout after ${ms}ms`)),
        { once: true },
      )
    ),
  ]).finally(() => clearTimeout(t));
}

/* ---------------- ledger HTML ---------------- */

function htmlEscape(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderDirListing(params: {
  mountUrl: string;
  relPath: string;
  entries: Array<{ name: string; isDir: boolean; size?: number }>;
}) {
  const { mountUrl, relPath, entries } = params;
  const parts = relPath.split("/").filter(Boolean);
  const crumbs = [`<a href="${mountUrl}/">ledger.d</a>`]
    .concat(
      parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        return `<a href="${mountUrl}/${sub}">${htmlEscape(p)}</a>`;
      }),
    )
    .join(" / ");

  const rows = entries
    .map((e) => {
      const href = `${mountUrl}/${[relPath, e.name].filter(Boolean).join("/")}`;
      const label = e.isDir ? `${e.name}/` : e.name;
      const meta = e.isDir
        ? "dir"
        : typeof e.size === "number"
        ? `${e.size} bytes`
        : "file";
      return `<tr>
        <td><a href="${href}">${htmlEscape(label)}</a></td>
        <td class="mono">${htmlEscape(meta)}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>db-yard ledger browser</title>
</head>
<body>
  <div>${crumbs}</div>
  <table>
    <thead><tr><th>Name</th><th>Type/Size</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

/* ---------------- proxy routing + tracing ---------------- */

const REDACT = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-amz-security-token",
  "x-forwarded-client-cert",
]);

function normalizeBasePath(p: string) {
  const s = p.trim();
  if (!s) return "";
  const withSlash = s.startsWith("/") ? s : `/${s}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function buildProxyTableWithConflicts(processes: TaggedProcess[]) {
  const raw: ProxyRoute[] = [];
  const byBase = new Map<string, Set<string>>();

  for (const p of processes) {
    const upstreamUrl = typeof p.upstreamUrl === "string" ? p.upstreamUrl : "";
    if (!upstreamUrl) continue;

    // Primary mapping: proxyEndpointPrefix
    const pep = typeof p.proxyEndpointPrefix === "string"
      ? String(p.proxyEndpointPrefix)
      : "";
    const basePath = normalizeBasePath(pep);
    if (basePath) raw.push({ basePath, upstreamUrl });

    // Fallback: serviceId (kept for backward compat)
    const sid = typeof p.serviceId === "string" ? p.serviceId.trim() : "";
    if (sid && !sid.includes("/")) {
      raw.push({ basePath: `/${sid}`, upstreamUrl });
    }

    // Intentionally NOT adding sessionId fallback (UUID/noisy)
  }

  const seen = new Set<string>();
  const table = raw
    .map((r) => ({ ...r, basePath: r.basePath.replace(/\/+$/, "") || "/" }))
    .filter((r) => {
      if (!byBase.has(r.basePath)) byBase.set(r.basePath, new Set());
      byBase.get(r.basePath)!.add(r.upstreamUrl);
      if (seen.has(r.basePath)) return false;
      seen.add(r.basePath);
      return true;
    })
    .sort((a, b) => b.basePath.length - a.basePath.length);

  const conflicts: ProxyConflict[] = [];
  for (const [basePath, urls] of byBase.entries()) {
    if (urls.size > 1) {
      conflicts.push({ basePath, upstreamUrls: [...urls].sort() });
    }
  }
  conflicts.sort((a, b) => b.basePath.length - a.basePath.length);

  return { table, conflicts };
}

function resolveProxyPath(pathname: string, routes: ProxyRoute[]) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const route = routes.find((r) =>
    path === r.basePath || path.startsWith(r.basePath + "/")
  );
  if (!route) return null;

  const rest = path.slice(route.basePath.length) || "/";
  return { route, rest };
}

function headersToObject(h: Headers, opts?: { redact?: boolean }) {
  const obj: Record<string, string> = {};
  for (const [k, v] of h.entries()) {
    const key = k.toLowerCase();
    if (opts?.redact && REDACT.has(key)) obj[key] = "(redacted)";
    else obj[key] = v;
  }
  return obj;
}

function traceRequested(c: Context) {
  const u = new URL(c.req.url);
  if (u.searchParams.get("__db_yard_trace") === "1") return true;
  const hv = c.req.header("x-db-yard-trace");
  if (!hv) return false;
  return hv === "1" || hv.toLowerCase() === "true" ||
    hv.toLowerCase() === "yes";
}

function getOrMakeTraceId(c: Context) {
  const provided = c.req.header("x-db-yard-trace-id");
  return (provided && provided.trim()) ? provided.trim() : crypto.randomUUID();
}

function applyTraceHeaders(
  resp: Response,
  trace: {
    traceId: string;
    matchedBasePath?: string;
    upstreamUrl?: string;
    rest?: string;
  },
) {
  const out = new Headers(resp.headers);
  out.set("x-db-yard-trace-id", trace.traceId);
  if (trace.matchedBasePath) {
    out.set("x-db-yard-matched-basepath", trace.matchedBasePath);
  }
  if (trace.upstreamUrl) out.set("x-db-yard-upstream", trace.upstreamUrl);
  if (trace.rest) out.set("x-db-yard-rest", trace.rest);

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: out,
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function previewBodyIfSmall(bodyText: string, maxChars = 4000) {
  if (bodyText.length <= maxChars) return bodyText;
  return bodyText.slice(0, maxChars) + "\n…(truncated)…";
}

function makeProxiedUrl(upstreamUrl: string, rest: string, reqUrl?: string) {
  const target = new URL(upstreamUrl);
  const proxied = new URL(rest, target);
  if (reqUrl) proxied.search = new URL(reqUrl).search;
  return proxied.toString();
}

/* ---------------- route registration (top-level sections) ---------------- */

function registerRootRedirects({ app, mounts }: Deps) {
  const { uiMount, mount } = mounts;
  app.get("/", (c) => c.redirect(`${uiMount}/`));
  app.get(`${mount}`, (c) => c.redirect(`${uiMount}/`));
  app.get(`${mount}/`, (c) => c.redirect(`${uiMount}/`));
}

function registerAssetsRoutes({ app, cfg, mounts }: Deps) {
  const { assetsMount } = mounts;
  const { assetsDir } = cfg;

  app.get(
    `${assetsMount}/*`,
    serveStatic({
      root: ".",
      rewriteRequestPath: (path) => {
        const rel = path.slice((assetsMount + "/").length);
        return `/${assetsDir}/${rel}`;
      },
    }),
  );
}

function registerUiRoutes({ app, cfg, mounts }: Deps) {
  const { uiMount } = mounts;
  const { assetsDir } = cfg;

  app.get(`${uiMount}`, (c) => c.redirect(`${uiMount}/`));
  app.get(`${uiMount}/`, async (c) => {
    const indexPath = `${assetsDir}/index.html`;
    if (!(await exists(indexPath))) return c.text(`Missing ${indexPath}`, 500);
    return c.html(await Deno.readTextFile(indexPath));
  });
}

function registerProcessesApi({ app, cfg, mounts, getProcesses }: Deps) {
  const { apiMount } = mounts;
  const { ledgerDirAbs } = cfg;

  app.get(`${apiMount}/tagged-processes.json`, async (c) => {
    const processes = await getProcesses();
    return c.json({
      now: new Date().toISOString(),
      ledgerDir: ledgerDirAbs,
      count: processes.length,
      taggedProcesses: processes,
    });
  });
}

function registerReconcileApi({ app, cfg, mounts, getProcesses }: Deps) {
  const { apiMount } = mounts;
  const { ledgerDirAbs } = cfg;

  app.get(`${apiMount}/reconcile.json`, async (c) => {
    const processes = await getProcesses();
    const { conflicts: proxyConflicts } = buildProxyTableWithConflicts(
      processes,
    );

    const items: ReconcileItem[] = [];
    const gen = reconcile(ledgerDirAbs);
    while (true) {
      const next = await gen.next();
      if (next.done) {
        return c.json({
          now: new Date().toISOString(),
          ledgerDir: ledgerDirAbs,
          summary: next.value,
          items,
          proxyConflicts,
        });
      }
      items.push(next.value);
    }
  });
}

function registerProxyIntrospectionApi(
  { app, cfg, mounts, getProcesses }: Deps,
) {
  const { apiMount, uiMount } = mounts;
  const { ledgerDirAbs } = cfg;

  app.get(`${apiMount}/proxy-table.json`, async (c) => {
    const processes = await getProcesses();
    const { table, conflicts } = buildProxyTableWithConflicts(processes);
    return c.json({
      now: new Date().toISOString(),
      ledgerDir: ledgerDirAbs,
      count: table.length,
      proxyTable: table,
      proxyConflicts: conflicts,
    });
  });

  app.get(`${apiMount}/proxy-resolve.json`, async (c) => {
    const url = new URL(c.req.url);
    const path = url.searchParams.get("path") ?? "";
    if (!path) return jsonError('missing query param "path"', 400);

    const processes = await getProcesses();
    const { table } = buildProxyTableWithConflicts(processes);

    const resolved = resolveProxyPath(path, table);
    if (!resolved) {
      return jsonResponse({ ok: false, input: path, resolved: null }, 200);
    }

    return jsonResponse({
      ok: true,
      input: path,
      matchBasePath: resolved.route.basePath,
      upstreamUrl: resolved.route.upstreamUrl,
      rest: resolved.rest,
      proxiedUrl: makeProxiedUrl(
        resolved.route.upstreamUrl,
        resolved.rest,
        c.req.url,
      ),
    });
  });

  app.get(`${apiMount}/health.json`, async (c) => {
    const url = new URL(c.req.url);
    const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "1500");
    const max = Number(url.searchParams.get("max") ?? "50");

    const processes = await getProcesses();
    const { table } = buildProxyTableWithConflicts(processes);
    const checks = table.slice(0, Math.max(0, Math.min(max, table.length)));

    const results = await Promise.all(
      checks.map(async (r) => {
        const started = Date.now();
        try {
          const res = await withTimeout(
            fetch(new URL(r.upstreamUrl).toString(), { method: "GET" }),
            timeoutMs,
          );
          const ms = Date.now() - started;
          return {
            basePath: r.basePath,
            upstreamUrl: r.upstreamUrl,
            ok: res.ok,
            status: res.status,
            ms,
          };
        } catch (e) {
          const ms = Date.now() - started;
          return {
            basePath: r.basePath,
            upstreamUrl: r.upstreamUrl,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            ms,
          };
        }
      }),
    );

    return c.json({
      now: new Date().toISOString(),
      timeoutMs,
      count: results.length,
      results,
    });
  });

  // proxy-debug: show routing + inbound headers + forwarded headers (redacted)
  app.get(`${apiMount}/proxy-debug.json`, async (c) => {
    const url = new URL(c.req.url);
    const path = url.searchParams.get("path") ?? "";
    if (!path) {
      return c.json({ ok: false, error: 'missing query param "path"' }, 400);
    }

    const processes = await getProcesses();
    const { table, conflicts } = buildProxyTableWithConflicts(processes);
    const resolved = resolveProxyPath(path, table);

    const inbound = headersToObject(c.req.raw.headers, { redact: true });
    const forwarded = headersToObject(c.req.raw.headers, { redact: true });

    return c.json({
      ok: true,
      now: new Date().toISOString(),
      ledgerDir: ledgerDirAbs,
      input: path,
      uiHint: `${uiMount}/`,
      matched: resolved
        ? {
          basePath: resolved.route.basePath,
          upstreamUrl: resolved.route.upstreamUrl,
          rest: resolved.rest,
          proxiedUrl: makeProxiedUrl(resolved.route.upstreamUrl, resolved.rest),
        }
        : null,
      proxyConflicts: conflicts,
      inboundHeaders: inbound,
      forwardedHeaders: forwarded,
      note:
        "Headers are redacted for safety. This shows what db-yard received and what it will forward upstream.",
    });
  });

  // proxy-roundtrip: actually fetch upstream and show response headers/status/body preview
  app.get(`${apiMount}/proxy-roundtrip.json`, async (c) => {
    const url = new URL(c.req.url);
    const path = url.searchParams.get("path") ?? "";
    const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "1500");
    if (!path) {
      return c.json({ ok: false, error: 'missing query param "path"' }, 400);
    }

    const processes = await getProcesses();
    const { table } = buildProxyTableWithConflicts(processes);
    const resolved = resolveProxyPath(path, table);
    if (!resolved) {
      return c.json({ ok: false, input: path, resolved: null }, 404);
    }

    const proxiedUrl = makeProxiedUrl(
      resolved.route.upstreamUrl,
      resolved.rest,
    );

    const started = Date.now();
    try {
      const res = await fetchWithTimeout(
        proxiedUrl,
        { method: "GET", headers: c.req.raw.headers },
        timeoutMs,
      );
      const ms = Date.now() - started;

      const ct = res.headers.get("content-type") ?? "";
      let preview: string | null = null;

      if (
        ct.includes("text/") || ct.includes("json") || ct.includes("xml") ||
        ct.includes("html")
      ) {
        const txt = await res.text();
        preview = previewBodyIfSmall(txt);
      }

      return c.json({
        ok: true,
        now: new Date().toISOString(),
        input: path,
        matchedBasePath: resolved.route.basePath,
        upstreamUrl: resolved.route.upstreamUrl,
        proxiedUrl,
        ms,
        status: res.status,
        responseHeaders: headersToObject(res.headers, { redact: true }),
        bodyPreview: preview,
      });
    } catch (e) {
      const ms = Date.now() - started;
      return c.json(
        {
          ok: false,
          input: path,
          matchedBasePath: resolved.route.basePath,
          upstreamUrl: resolved.route.upstreamUrl,
          proxiedUrl,
          ms,
          error: e instanceof Error ? e.message : String(e),
        },
        502,
      );
    }
  });

  // trace help (cheap doc endpoint)
  app.get(`${apiMount}/trace-help.json`, (c) => {
    return c.json({
      ok: true,
      howTo: [
        "Add ?__db_yard_trace=1 to any proxied request URL, OR send header: x-db-yard-trace: 1",
        "db-yard will add response headers like x-db-yard-trace-id, x-db-yard-matched-basepath, x-db-yard-upstream, x-db-yard-rest",
        "Use x-db-yard-trace-id to correlate with server logs (one JSON line per traced request).",
      ],
      redaction: [...REDACT.values()],
    });
  });
}

function registerLedgerBrowser({ app, cfg, mounts }: Deps) {
  const { ledgerMount } = mounts;
  const { ledgerDirAbs } = cfg;

  app.get(`${ledgerMount}`, (c) => c.redirect(`${ledgerMount}/`));
  app.get(`${ledgerMount}/*`, async (c) => {
    const rel = c.req.path.slice((ledgerMount + "/").length);
    const fsPath = safeJoin(ledgerDirAbs, rel);
    if (!fsPath) return c.text("Invalid path", 400);

    let st: Deno.FileInfo;
    try {
      st = await Deno.stat(fsPath);
    } catch {
      return c.text("Not found", 404);
    }

    if (st.isDirectory) {
      const entries: Array<{ name: string; isDir: boolean; size?: number }> =
        [];
      for await (const e of Deno.readDir(fsPath)) {
        const p = `${fsPath}/${e.name}`;
        let size: number | undefined;
        if (e.isFile) {
          try {
            size = (await Deno.stat(p)).size;
          } catch {
            // ignore
          }
        }
        entries.push({ name: e.name, isDir: e.isDirectory, size });
      }
      entries.sort((a, b) =>
        Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
      );
      return c.html(
        renderDirListing({ mountUrl: ledgerMount, relPath: rel, entries }),
      );
    }

    const ct = guessContentType(fsPath);
    if (
      ct.startsWith("text/") || ct.includes("json") ||
      ct.includes("javascript") || ct.includes("svg+xml")
    ) {
      const text = await readTextIfSmall(fsPath, 5_000_000);
      if (text !== null) return c.text(text, 200, { "content-type": ct });
    }

    const data = await Deno.readFile(fsPath);
    return new Response(data, { status: 200, headers: { "content-type": ct } });
  });
}

function registerCatchAllProxy({ app, cfg, mounts, getProcesses }: Deps) {
  if (!cfg.proxyEnabled) return;

  const { mount, uiMount } = mounts;

  app.all("*", async (c) => {
    if (c.req.path.startsWith(`${mount}/`)) return c.notFound();

    const processes = await getProcesses();
    const { table } = buildProxyTableWithConflicts(processes);

    const path = c.req.path;
    const resolved = resolveProxyPath(path, table);
    if (!resolved) {
      return c.text(`No upstream mapping for "${path}". Try ${uiMount}/`, 502);
    }

    const proxiedUrl = makeProxiedUrl(
      resolved.route.upstreamUrl,
      resolved.rest,
      c.req.url,
    );

    const traceOn = traceRequested(c);
    const traceId = traceOn ? getOrMakeTraceId(c) : "";
    const started = Date.now();

    const resp = await proxy(proxiedUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    });

    if (!traceOn) return resp;

    const traced = applyTraceHeaders(resp, {
      traceId,
      matchedBasePath: resolved.route.basePath,
      upstreamUrl: resolved.route.upstreamUrl,
      rest: resolved.rest,
    });

    const ms = Date.now() - started;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      traceId,
      method: c.req.method,
      path: c.req.path,
      matchedBasePath: resolved.route.basePath,
      upstreamUrl: resolved.route.upstreamUrl,
      rest: resolved.rest,
      status: traced.status,
      ms,
    }));

    return traced;
  });
}

/* ---------------- wiring ---------------- */

function computeMounts(): Mounts {
  const mount = "/.db-yard";
  return {
    mount,
    assetsMount: `${mount}/asset`,
    uiMount: `${mount}/ui`,
    apiMount: `${mount}/api`,
    ledgerMount: `${mount}/ledger.d`,
  };
}

async function requireDir(path: string) {
  try {
    const st = await Deno.stat(path);
    if (!st.isDirectory) {
      console.error(`expected directory: ${path}`);
      Deno.exit(2);
    }
  } catch (e) {
    console.error(`not found: ${path}`);
    console.error(e);
    Deno.exit(2);
  }
}

function logStartup(cfg: AppCfg, mounts: Mounts) {
  console.log(`db-yard web-ui listening on http://${cfg.host}:${cfg.port}`);
  console.log(`UI: http://${cfg.host}:${cfg.port}${mounts.uiMount}/`);
  console.log(`Assets: http://${cfg.host}:${cfg.port}${mounts.assetsMount}/`);
  console.log(
    `API: http://${cfg.host}:${cfg.port}${mounts.apiMount}/tagged-processes.json`,
  );
  console.log(`Ledger: http://${cfg.host}:${cfg.port}${mounts.ledgerMount}/`);
}

/* ---------------- main ---------------- */

async function main() {
  const cmd = await new Command()
    .name("db-yard-web-ui")
    .description(
      "db-yard web UI + ledger browser + simple proxy to tagged processes",
    )
    .option("--host <host:string>", "Host to bind", { default: "127.0.0.1" })
    .option("--port <port:number>", "Port to listen on", { default: 8787 })
    .option(
      "--ledger-dir <path:string>",
      "Path to the db-yard ledger directory (ledger.d parent)",
      { default: "./ledger.d" },
    )
    .option("--assets-dir <path:string>", "Path to assets directory", {
      default: "bin/web-ui/asset",
    })
    .option("--no-proxy", "Disable proxy behavior for non /.db-yard paths", {
      default: false,
    })
    .option(
      "--refresh-ms <ms:number>",
      "UI polling interval for tagged processes",
      { default: 2000 },
    )
    .parse(Deno.args);

  const cfg: AppCfg = {
    host: cmd.options.host,
    port: cmd.options.port,
    ledgerDirAbs: normalize(resolve(cmd.options.ledgerDir)),
    assetsDir: cmd.options.assetsDir,
    proxyEnabled: !cmd.options.proxy,
  };

  await requireDir(cfg.assetsDir);

  const app = new Hono();
  const mounts = computeMounts();
  const getProcesses = () => Array.fromAsync(taggedProcesses());

  const deps: Deps = { app, cfg, mounts, getProcesses };

  registerRootRedirects(deps);
  registerAssetsRoutes(deps);
  registerUiRoutes(deps);
  registerProcessesApi(deps);
  registerReconcileApi(deps);
  registerProxyIntrospectionApi(deps);
  registerLedgerBrowser(deps);
  registerCatchAllProxy(deps);

  logStartup(cfg, mounts);
  Deno.serve({ hostname: cfg.host, port: cfg.port }, app.fetch);
}

if (import.meta.main) {
  await main();
}
