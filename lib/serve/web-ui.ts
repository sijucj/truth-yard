// lib/serve/web-ui.ts
import { join, resolve } from "@std/path";
import type { Path } from "../discover.ts";
import {
  contentTypeByName,
  isSafeRelativeSubpath,
  listFilesRecursive,
} from "../fs.ts";
import { type SpawnedStateEncounter, spawnedStates } from "../materialize.ts";
import { type WatchEvent, type WatchOptions, watchYard } from "./watch.ts";

function nowMs() {
  return Date.now();
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "-";
  }
}

async function readRunning(
  activeDir: string,
): Promise<SpawnedStateEncounter[]> {
  const out: SpawnedStateEncounter[] = [];
  for await (const st of spawnedStates(activeDir)) out.push(st);
  out.sort((a, b) =>
    String(a.context?.service?.proxyEndpointPrefix ?? "").localeCompare(
      String(b.context?.service?.proxyEndpointPrefix ?? ""),
    )
  );
  return out;
}

function pickByPrefix(
  running: readonly SpawnedStateEncounter[],
  pathname: string,
): SpawnedStateEncounter | undefined {
  let best: SpawnedStateEncounter | undefined;
  let bestLen = -1;

  for (const r of running) {
    if (!r.pidAlive) continue;
    const pfx = String(r.context?.service?.proxyEndpointPrefix ?? "");
    if (!pfx) continue;
    if (!pathname.startsWith(pfx)) continue;
    if (pfx.length > bestLen) {
      best = r;
      bestLen = pfx.length;
    }
  }

  return best;
}

async function proxyToTarget(
  req: Request,
  targetBase: URL,
  proxyEndpointPrefix: string,
): Promise<Response> {
  const u = new URL(req.url);

  const outUrl = new URL(targetBase.toString());
  outUrl.pathname = u.pathname;
  outUrl.search = u.search;

  const headers = new Headers(req.headers);
  headers.set("SQLPAGE_SITE_PREFIX", proxyEndpointPrefix);
  headers.set("db-yard-proxyEndpointPrefix", proxyEndpointPrefix);
  headers.set("host", outUrl.host);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    body: (req.method === "GET" || req.method === "HEAD")
      ? undefined
      : req.body,
  };

  let resp: Response;
  try {
    resp = await fetch(outUrl, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(
      {
        ok: false,
        error: "proxy failed",
        target: outUrl.toString(),
        message: msg,
      },
      502,
    );
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: resp.headers,
  });
}

type WebUiServer = Readonly<{ close: () => void }>;

export type StartWebUiArgs = Readonly<{
  webHost: string;
  webPort: number;

  // Watch inputs
  srcPaths: Iterable<Path>;
  spawnStateHome: string;
  activeDirName?: string;

  // Optional watch tuning
  debounceMs?: number;
  reconcileEveryMs?: number;

  // Forwarded to watchYard(spawn...)
  spawn?: WatchOptions["spawn"];
}>;

/**
 * Serves UI assets under `/.web-ui/*` to avoid proxy-prefix conflicts.
 *
 * Endpoints:
 * - GET  /.web-ui/              -> web-ui.html
 * - GET  /.web-ui/web-ui.css    -> css
 * - GET  /.web-ui/web-ui.js     -> js
 * - GET  /.admin                -> JSON snapshot (running, recent events, activeDir)
 * - GET  /.admin/files          -> JSON listing of files under activeDir
 * - GET  /.admin/files/<rel>    -> raw file from activeDir (supports subdirs)
 * - ALL OTHER PATHS             -> reverse proxy to a spawned service by best prefix match
 */
export function startWebUiServer(args: StartWebUiArgs): WebUiServer {
  const {
    webHost,
    webPort,
    srcPaths,
    spawnStateHome,
    activeDirName = "active",
    debounceMs,
    reconcileEveryMs,
    spawn,
  } = args;

  const activeDir = resolve(join(resolve(spawnStateHome), activeDirName));

  const serverAbort = new AbortController();
  const watcherAbort = new AbortController();

  const maxEvents = 200;
  const watchEvents: WatchEvent[] = [];
  let lastReconcile: WatchEvent | undefined;

  const pushEvent = (e: WatchEvent) => {
    watchEvents.push(e);
    while (watchEvents.length > maxEvents) watchEvents.shift();
    if (e.type === "reconcile_end") lastReconcile = e;
  };

  watchYard(srcPaths, {
    spawnStateHome,
    activeDirName,
    debounceMs,
    reconcileEveryMs,
    signal: watcherAbort.signal,
    spawn,
    onWatchEvent: (e) => pushEvent(e),
  }).catch((error) => {
    pushEvent({ type: "error", phase: "watch", error });
    pushEvent({ type: "watch_end", reason: "error" });
  });

  const staticRoot = resolve(join(import.meta.dirname ?? ".", "web-ui-assets"));
  const htmlPath = join(staticRoot, "web-ui.html");
  const cssPath = join(staticRoot, "web-ui.css");
  const jsPath = join(staticRoot, "web-ui.js");

  const readStatic = async (
    filePath: string,
    ct: string,
  ): Promise<Response> => {
    try {
      const data = await Deno.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: { "content-type": ct },
      });
    } catch {
      return jsonResponse(
        { ok: false, error: "static file missing", filePath },
        404,
      );
    }
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Static UI (served under /.web-ui/*)
    if (
      req.method === "GET" &&
      (pathname === "/.web-ui" || pathname === "/.web-ui/")
    ) {
      return await readStatic(htmlPath, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/.web-ui/web-ui.css") {
      return await readStatic(cssPath, "text/css; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/.web-ui/web-ui.js") {
      return await readStatic(jsPath, "application/javascript; charset=utf-8");
    }

    // Admin snapshot
    if (req.method === "GET" && pathname === "/.admin") {
      const running = await readRunning(activeDir);
      const items = running.map((r) => ({
        id: r.context.service.id,
        kind: r.context.service.kind,
        label: r.context.service.label,
        proxyEndpointPrefix: r.context.service.proxyEndpointPrefix,
        pid: r.pid,
        pidAlive: r.pidAlive,
        listen: r.context.listen,
        supplier: r.context.supplier,
        upstreamUrl: r.upstreamUrl,
        procCmdline: r.procCmdline,
        contextFile: r.filePath,
        paths: r.context.paths,
      }));

      return jsonResponse({
        ok: true,
        nowMs: nowMs(),
        spawnStateHome: resolve(spawnStateHome),
        activeDir,
        lastReconcile,
        eventCount: watchEvents.length,
        recentEvents: watchEvents,
        count: items.length,
        items,
      });
    }

    if (req.method === "GET" && pathname === "/.admin/files") {
      const files = await listFilesRecursive(activeDir, {
        hidePrefixes: [".db-yard."],
        hideSuffixes: [".tmp"],
        hideNames: ["spawned-pids.txt"],
      });

      const enriched = files.map((f) => {
        const name = f.name;
        const lower = name.toLowerCase();
        const kind = lower.endsWith(".json")
          ? "json"
          : (lower.endsWith(".stdout.log") || lower.endsWith(".stderr.log") ||
              lower.endsWith(".log")
            ? "log"
            : "other");
        return {
          ...f,
          kind,
          sizeHuman: formatBytes(f.size),
          mtimeIso: formatWhen(f.mtimeMs),
        };
      });

      return jsonResponse({
        ok: true,
        activeDir,
        count: enriched.length,
        files: enriched,
      });
    }

    // Serve a file from activeDir (supports subdirectories)
    if (req.method === "GET" && pathname.startsWith("/.admin/files/")) {
      const rel = decodeURIComponent(pathname.slice("/.admin/files/".length))
        .replaceAll("\\", "/")
        .replace(/^\/+/, "");

      if (!isSafeRelativeSubpath(rel)) {
        return jsonResponse({ ok: false, error: "invalid file name" }, 400);
      }

      const abs = join(activeDir, rel);
      let st: Deno.FileInfo;
      try {
        st = await Deno.stat(abs);
      } catch {
        return jsonResponse({ ok: false, error: "not found" }, 404);
      }
      if (!st.isFile) {
        return jsonResponse({ ok: false, error: "not a file" }, 400);
      }

      let f: Deno.FsFile | undefined;
      try {
        f = await Deno.open(abs, { read: true });
        return new Response(f.readable, {
          status: 200,
          headers: { "content-type": contentTypeByName(rel) },
        });
      } catch (e) {
        try {
          f?.close();
        } catch {
          // ignore
        }
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse({
          ok: false,
          error: "failed to read file",
          message: msg,
        }, 500);
      }
    }

    // Reverse proxy (all other paths)
    const running = await readRunning(activeDir);
    const picked = pickByPrefix(running, pathname);
    if (picked) {
      const host = String(picked.context.listen.host ?? "127.0.0.1");
      const port = Number(picked.context.listen.port);
      const base = new URL(`http://${host}:${port}`);
      return await proxyToTarget(
        req,
        base,
        picked.context.service.proxyEndpointPrefix,
      );
    }

    if (req.method === "GET") {
      const rows = running.map((r) => {
        const pfx = r.context.service.proxyEndpointPrefix;
        const alive = r.pidAlive ? "alive" : "dead";
        return `- ${pfx} (${alive}) pid=${r.pid} kind=${r.context.service.kind} id=${r.context.service.id}`;
      }).join("\n");

      return new Response(
        `No proxy target for ${escapeHtml(pathname)}.\n\nKnown prefixes:\n${
          rows || "(none)"
        }\n\nTry: /.admin or /.web-ui/\n`,
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    return jsonResponse({ ok: false, error: "no proxy target" }, 404);
  };

  Deno.serve(
    { hostname: webHost, port: webPort, signal: serverAbort.signal },
    handler,
  );

  return {
    close: () => {
      try {
        watcherAbort.abort();
      } catch {
        // ignore
      }
      try {
        serverAbort.abort();
      } catch {
        // ignore
      }
    },
  };
}
