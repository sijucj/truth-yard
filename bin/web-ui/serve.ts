#!/usr/bin/env -S deno run --watch -A --node-modules-dir=auto
// bin/web-ui/serve.ts

import { Command } from "@cliffy/command";
import { normalize, resolve } from "@std/path";
import { Hono } from "jsr:@hono/hono@4.11.3";
import { serveStatic } from "jsr:@hono/hono@4.11.3/deno";
import { proxy } from "jsr:@hono/hono@4.11.3/proxy";
import { reconcile, type ReconcileItem } from "../../lib/materialize.ts";
import { taggedProcesses } from "../../lib/spawn.ts";
import {
  applyTraceHeaders,
  buildProxyTableWithConflicts,
  registerDebugRoutes,
  resolveProxyPath,
} from "./debug.ts";

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

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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

  const host = cmd.options.host;
  const port = cmd.options.port;
  const ledgerDir = normalize(resolve(cmd.options.ledgerDir));
  const assetsDir = cmd.options.assetsDir;
  const proxyEnabled = !cmd.options.proxy;

  for (const deps of [ledgerDir, assetsDir]) {
    try {
      const st = await Deno.stat(deps);
      if (!st.isDirectory) {
        console.error(`expected directory: ${deps}`);
        Deno.exit(2);
      }
    } catch (e) {
      console.error(`not found: ${deps}`);
      console.error(e);
      Deno.exit(2);
    }
  }

  const app = new Hono();

  const mount = "/.db-yard";
  const assetsMount = `${mount}/asset`;
  const uiMount = `${mount}/ui`;
  const apiMount = `${mount}/api`;
  const ledgerMount = `${mount}/ledger.d`;

  // Root convenience: / -> /.db-yard/ui/
  app.get("/", (c) => c.redirect(`${uiMount}/`));
  app.get(`${mount}`, (c) => c.redirect(`${uiMount}/`));
  app.get(`${mount}/`, (c) => c.redirect(`${uiMount}/`));

  /* ---- assets ---- */

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

  /* ---- UI ---- */

  app.get(`${uiMount}`, (c) => c.redirect(`${uiMount}/`));
  app.get(`${uiMount}/`, async (c) => {
    const indexPath = `${assetsDir}/index.html`;
    if (!(await exists(indexPath))) {
      return c.text(`Missing ${indexPath}`, 500);
    }
    return c.html(await Deno.readTextFile(indexPath));
  });

  /* ---- API: processes ---- */

  app.get(`${apiMount}/tagged-processes.json`, async (c) => {
    const processes = await Array.fromAsync(taggedProcesses());
    return c.json({
      now: new Date().toISOString(),
      ledgerDir,
      count: processes.length,
      taggedProcesses: processes,
    });
  });

  // Debug endpoints (proxy-debug, proxy-roundtrip, trace-help)
  const dbg = registerDebugRoutes({
    app,
    apiMount,
    uiMount,
    ledgerDir,
    getProcesses: () => Array.fromAsync(taggedProcesses()),
  });

  /* ---- API: reconcile + proxy conflict report ---- */

  app.get(`${apiMount}/reconcile.json`, async (c) => {
    const processes = await Array.fromAsync(taggedProcesses());
    const { conflicts: proxyConflicts } = buildProxyTableWithConflicts(
      processes,
    );

    const items: ReconcileItem[] = [];
    const gen = reconcile(ledgerDir);
    while (true) {
      const next = await gen.next();
      if (next.done) {
        return c.json({
          now: new Date().toISOString(),
          ledgerDir,
          summary: next.value,
          items,
          proxyConflicts,
        });
      }
      items.push(next.value);
    }
  });

  /* ---- API: proxy table debug ---- */

  app.get(`${apiMount}/proxy-table.json`, async (c) => {
    const processes = await Array.fromAsync(taggedProcesses());
    const { table, conflicts } = buildProxyTableWithConflicts(processes);
    return c.json({
      now: new Date().toISOString(),
      ledgerDir,
      count: table.length,
      proxyTable: table,
      proxyConflicts: conflicts,
    });
  });

  /* ---- API: resolve proxy for a given path ---- */

  app.get(`${apiMount}/proxy-resolve.json`, async (c) => {
    const url = new URL(c.req.url);
    const path = url.searchParams.get("path") ?? "";
    if (!path) return jsonError('missing query param "path"', 400);

    const processes = await Array.fromAsync(taggedProcesses());
    const { table } = buildProxyTableWithConflicts(processes);

    const resolved = resolveProxyPath(path, table);
    if (!resolved) {
      return new Response(
        JSON.stringify({
          ok: false,
          input: path,
          resolved: null,
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }

    const target = new URL(resolved.route.upstreamUrl);
    const proxiedUrl = new URL(resolved.rest, target);
    proxiedUrl.search = new URL(c.req.url).search;

    return new Response(
      JSON.stringify({
        ok: true,
        input: path,
        matchBasePath: resolved.route.basePath,
        upstreamUrl: resolved.route.upstreamUrl,
        rest: resolved.rest,
        proxiedUrl: proxiedUrl.toString(),
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  });

  /* ---- API: per-route health checks ---- */

  app.get(`${apiMount}/health.json`, async (c) => {
    const url = new URL(c.req.url);
    const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "1500");
    const max = Number(url.searchParams.get("max") ?? "50");

    const processes = await Array.fromAsync(taggedProcesses());
    const { table } = buildProxyTableWithConflicts(processes);

    const checks = table.slice(0, Math.max(0, Math.min(max, table.length)));

    const results = await Promise.all(
      checks.map(async (r) => {
        const started = Date.now();
        try {
          const u = new URL(r.upstreamUrl);
          const res = await withTimeout(
            fetch(u.toString(), { method: "GET" }),
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

  /* ---- ledger browser ---- */

  app.get(`${ledgerMount}`, (c) => c.redirect(`${ledgerMount}/`));
  app.get(`${ledgerMount}/*`, async (c) => {
    const rel = c.req.path.slice((ledgerMount + "/").length);
    const fsPath = safeJoin(ledgerDir, rel);
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
      if (text !== null) {
        return c.text(text, 200, { "content-type": ct });
      }
    }

    const data = await Deno.readFile(fsPath);
    return new Response(data, { status: 200, headers: { "content-type": ct } });
  });

  /* ---- proxy ---- */

  if (proxyEnabled) {
    app.all("*", async (c) => {
      if (c.req.path.startsWith(`${mount}/`)) return c.notFound();

      const processes = await Array.fromAsync(taggedProcesses());
      const { table } = buildProxyTableWithConflicts(processes);

      const path = c.req.path;
      const resolved = resolveProxyPath(path, table);

      if (!resolved) {
        return c.text(
          `No upstream mapping for "${path}". Try ${uiMount}/`,
          502,
        );
      }

      const rest = resolved.rest;
      const target = new URL(resolved.route.upstreamUrl);
      const proxiedUrl = new URL(rest, target);
      proxiedUrl.search = new URL(c.req.url).search;

      const traceOn = dbg.traceRequested(c);
      const traceId = traceOn ? dbg.getOrMakeTraceId(c) : "";
      const started = Date.now();

      const resp = await proxy(proxiedUrl.toString(), {
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

      // One structured log line per traced request
      const ms = Date.now() - started;
      // import logTraceLine if you want; keeping this inline avoids extra imports
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

  console.log(`db-yard web-ui listening on http://${host}:${port}`);
  console.log(`UI: http://${host}:${port}${uiMount}/`);
  console.log(`Assets: http://${host}:${port}${assetsMount}/`);
  console.log(`API: http://${host}:${port}${apiMount}/tagged-processes.json`);
  console.log(`Ledger: http://${host}:${port}${ledgerMount}/`);
  Deno.serve({ hostname: host, port }, app.fetch);
}

if (import.meta.main) {
  await main();
}
