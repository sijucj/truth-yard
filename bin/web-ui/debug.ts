// bin/web-ui/debug.ts
import { Hono } from "jsr:@hono/hono@4.11.3";
import type { Context } from "jsr:@hono/hono@4.11.3";
import type { TaggedProcess } from "../../lib/spawn.ts";

export type ProxyRoute = { basePath: string; upstreamUrl: string };
export type ProxyConflict = { basePath: string; upstreamUrls: string[] };

export type DebugDeps = {
  app: Hono;
  apiMount: string;
  uiMount: string;
  ledgerDir: string;
  getProcesses: () => Promise<TaggedProcess[]>;
};

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

export function buildProxyTableWithConflicts(processes: TaggedProcess[]) {
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

export function resolveProxyPath(pathname: string, routes: ProxyRoute[]) {
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
    if (opts?.redact && REDACT.has(key)) {
      obj[key] = "(redacted)";
    } else {
      obj[key] = v;
    }
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

export function applyTraceHeaders(
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

export function logTraceLine(trace: {
  traceId: string;
  method: string;
  path: string;
  matchedBasePath?: string;
  upstreamUrl?: string;
  rest?: string;
  status?: number;
  ms?: number;
  note?: string;
}) {
  const rec = {
    ts: new Date().toISOString(),
    ...trace,
  };
  console.log(JSON.stringify(rec));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function previewBodyIfSmall(
  bodyText: string,
  maxChars = 4000,
) {
  if (bodyText.length <= maxChars) return bodyText;
  return bodyText.slice(0, maxChars) + "\n…(truncated)…";
}

export function registerDebugRoutes(deps: DebugDeps) {
  const { app, apiMount, uiMount, ledgerDir, getProcesses } = deps;

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

    // what we currently forward in proxy() is basically raw headers + raw body
    // this is the “effective” set, minus redactions.
    const forwarded = headersToObject(c.req.raw.headers, { redact: true });

    return c.json({
      ok: true,
      now: new Date().toISOString(),
      ledgerDir,
      input: path,
      uiHint: `${uiMount}/`,
      matched: resolved
        ? {
          basePath: resolved.route.basePath,
          upstreamUrl: resolved.route.upstreamUrl,
          rest: resolved.rest,
          proxiedUrl: new URL(
            resolved.rest,
            new URL(resolved.route.upstreamUrl),
          ).toString(),
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

    const target = new URL(resolved.route.upstreamUrl);
    const proxiedUrl = new URL(resolved.rest, target);

    const started = Date.now();
    try {
      const res = await fetchWithTimeout(
        proxiedUrl.toString(),
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
        proxiedUrl: proxiedUrl.toString(),
        ms,
        status: res.status,
        responseHeaders: headersToObject(res.headers, { redact: true }),
        bodyPreview: preview,
      });
    } catch (e) {
      const ms = Date.now() - started;
      return c.json({
        ok: false,
        input: path,
        matchedBasePath: resolved.route.basePath,
        upstreamUrl: resolved.route.upstreamUrl,
        proxiedUrl: proxiedUrl.toString(),
        ms,
        error: e instanceof Error ? e.message : String(e),
      }, 502);
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

  return {
    traceRequested,
    getOrMakeTraceId,
  };
}
