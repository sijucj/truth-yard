#!/usr/bin/env -S deno run --watch -A --node-modules-dir=auto
// bin/web-ui/serve.ts

import { Command } from "@cliffy/command";
import { Hono } from "jsr:@hono/hono@4.11.3";
import { serveStatic } from "jsr:@hono/hono@4.11.3/deno";
import { proxy } from "jsr:@hono/hono@4.11.3/proxy";
import { TaggedProcess, taggedProcesses } from "../../lib/spawn.ts";
import { normalize, resolve } from "@std/path";
import { reconcile, ReconcileItem } from "../../lib/materialize.ts";

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
  if (p.endsWith(".db") || p.endsWith(".sqlite") || p.endsWith(".sqlite3")) {
    return "application/octet-stream";
  }
  return "application/octet-stream";
}

function makeProxyTable(processes: TaggedProcess[]) {
  const table: Array<
    { prefix: string; upstreamUrl: string; basePath: string }
  > = [];

  for (const p of processes) {
    const upstreamUrl = typeof p.upstreamUrl === "string" ? p.upstreamUrl : "";
    if (!upstreamUrl) continue;

    const ctx = typeof p.contextPath === "string" ? p.contextPath : "";
    const ctxSeg = ctx.startsWith("/") ? ctx.split("/").filter(Boolean)[0] : "";

    const candidates = new Set<string>();
    if (typeof p.serviceId === "string" && p.serviceId.trim()) {
      candidates.add(p.serviceId.trim());
    }
    if (typeof p.sessionId === "string" && p.sessionId.trim()) {
      candidates.add(p.sessionId.trim());
    }
    if (ctxSeg) candidates.add(ctxSeg);

    for (const prefix of candidates) {
      table.push({ prefix, upstreamUrl, basePath: `/${prefix}` });
    }
  }

  const seen = new Set<string>();
  return table.filter((r) =>
    seen.has(r.prefix) ? false : (seen.add(r.prefix), true)
  );
}

function htmlEscape(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");
}

function renderDirListing(
  params: {
    mountUrl: string;
    relPath: string;
    entries: Array<{ name: string; isDir: boolean; size?: number }>;
  },
) {
  const { mountUrl, relPath, entries } = params;
  const parts = relPath.split("/").filter(Boolean);
  const crumbs = [`<a href="${mountUrl}/">ledger.d</a>`].concat(
    parts.map((p, i) => {
      const sub = parts.slice(0, i + 1).join("/");
      return `<a href="${mountUrl}/${sub}">${htmlEscape(p)}</a>`;
    }),
  ).join(" / ");

  const rows = entries.map((e) => {
    const href = `${mountUrl}/${[relPath, e.name].filter(Boolean).join("/")}`;
    const label = e.isDir ? `${e.name}/` : e.name;
    const meta = e.isDir
      ? "dir"
      : (typeof e.size === "number" ? `${e.size} bytes` : "file");
    return `<tr>
      <td><a href="${href}">${htmlEscape(label)}</a></td>
      <td class="mono">${htmlEscape(meta)}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>db-yard ledger browser</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    a { color: inherit; }
    .crumbs { margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="crumbs">${crumbs}</div>
  <table>
    <thead><tr><th>Name</th><th>Type/Size</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

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
  const refreshMs = cmd.options.refreshMs;
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

  // Everything "owned" by this web-ui must live under /.db-yard/*
  const mount = "/.db-yard";
  const assetsMount = `${mount}/asset`;
  const uiMount = `${mount}/ui`;
  const apiMount = `${mount}/api`;
  const ledgerMount = `${mount}/ledger.d`;

  // Root convenience: / -> /.db-yard/ui/
  app.get("/", (c) => c.redirect(`${uiMount}/`));

  // Also handle bare /.db-yard without trailing slash
  app.get(`${mount}`, (c) => c.redirect(`${uiMount}/`));

  // Assets (served from /.db-yard/asset/*)
  app.get(
    `${assetsMount}/*`,
    serveStatic({
      root: ".", // project root
      rewriteRequestPath: (path) => {
        // path is like "/.db-yard/asset/styles.css"
        // map to "bin/web-ui/asset/styles.css"
        const rel = path.slice((assetsMount + "/").length);
        return `/${assetsDir}/${rel}`;
      },
    }),
  );

  // Index UI (served from /.db-yard/ui/ and /.db-yard/ui/index.html)
  app.get(`${uiMount}`, (c) => c.redirect(`${uiMount}/`));
  app.get(`${uiMount}/`, async (c) => {
    const indexPath = `${assetsDir}/index.html`;
    if (!(await exists(indexPath))) return c.text(`Missing ${indexPath}`, 500);
    const html = await Deno.readTextFile(indexPath);
    return c.html(html.replace("{{REFRESH_MS}}", String(refreshMs)));
  });

  // Optional convenience: /.db-yard -> /.db-yard/ui/
  app.get(`${mount}/`, (c) => c.redirect(`${uiMount}/`));

  // API: processes
  app.get(`${apiMount}/tagged-processes.json`, async (c) => {
    const processes = await Array.fromAsync(taggedProcesses());
    return c.json({
      now: new Date().toISOString(),
      ledgerDir,
      count: processes.length,
      taggedProcesses: processes,
    });
  });

  // bin/web-ui/serve.ts (add this new API route near the other API routes)
  app.get(`${apiMount}/reconcile.json`, async (c) => {
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
        });
      }
      items.push(next.value);
    }
  });

  // Ledger static file browsing (directory listing + file preview)
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

  // Proxy candidate: everything NOT under /.db-yard/*
  if (proxyEnabled) {
    app.all("*", async (c) => {
      if (c.req.path.startsWith(`${mount}/`)) return c.notFound();
      if (c.req.path === mount) return c.notFound();

      const processes = await Array.fromAsync(taggedProcesses());
      const table = makeProxyTable(processes);

      const path = c.req.path;
      const firstSeg = path.split("/").filter(Boolean)[0] ?? "";
      const route = table.find((r) => r.prefix === firstSeg);

      if (!route) {
        return c.text(
          `No upstream mapping for prefix "${firstSeg}". Try ${uiMount}/ to browse running services.`,
          502,
        );
      }

      const rest = path.slice(route.basePath.length) || "/";
      const target = new URL(route.upstreamUrl);
      const proxiedUrl = new URL(rest, target);
      proxiedUrl.search = new URL(c.req.url).search;

      return await proxy(proxiedUrl.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.raw.body,
      });
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
