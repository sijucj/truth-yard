// bin/web-ui/asset/app.js
const procStatusText = document.getElementById("procStatusText");
const procTbody = document.getElementById("procTbody");
const filterInput = document.getElementById("filterInput");
const refreshBtn = document.getElementById("refreshBtn");

const reconcileStatusText = document.getElementById("reconcileStatusText");
const reconcileTbody = document.getElementById("reconcileTbody");
const reconcileBtn = document.getElementById("reconcileBtn");

let lastPayload = null;

function esc(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function matchesFilter(p, q) {
    if (!q) return true;
    const hay = [
        p.pid,
        p.upstreamUrl,
        p.serviceId,
        p.sessionId,
        p.contextPath,
        p._sourceFile,
    ].map((x) => String(x ?? "")).join(" ").toLowerCase();
    return hay.includes(q.toLowerCase());
}

function toPosix(p) {
    return String(p ?? "").replaceAll("\\", "/");
}

function stripLedgerPrefix(ledgerDirAbs, p) {
    const ledger = toPosix(ledgerDirAbs || "").replace(/\/+$/, "");
    const path = toPosix(p || "");
    if (!path) return "";
    if (!ledger) return path.replace(/^\/+/, "");
    if (path.startsWith(ledger + "/")) return path.slice((ledger + "/").length);
    if (path === ledger) return "";
    return path.replace(/^\/+/, "");
}

function ledgerHref(rel) {
    const r = toPosix(rel || "").replace(/^\/+/, "");
    return r ? `/.db-yard/ledger.d/${r}` : "";
}

function deriveLogRel(relContextJson, which /* "stdout" | "stderr" */) {
    const rel = toPosix(relContextJson || "");
    if (!rel) return "";
    const suffix = which === "stderr" ? ".stderr.log" : ".stdout.log";
    if (rel.endsWith(".context.json")) {
        return rel.slice(0, -".context.json".length) + suffix;
    }
    return rel + suffix;
}

function render(payload) {
    lastPayload = payload;
    const { taggedProcesses, ledgerDir, now, count } = payload;
    const q = filterInput.value.trim();

    procStatusText.textContent =
        `Processes: ${count} | Updated ${now} | ledgerDir=${ledgerDir}`;

    procTbody.innerHTML = "";

    for (const p of taggedProcesses.filter((x) => matchesFilter(x, q))) {
        const pid = p.pid ?? "";
        const upstreamUrl = p.upstreamUrl ?? "";
        const serviceId = p.serviceId ?? "";
        const sessionId = p.sessionId ?? "";
        const contextPath = p.contextPath ?? "";

        const relContext = stripLedgerPrefix(ledgerDir, contextPath);
        const ctxHref = ledgerHref(relContext);
        const ctxLabel = relContext || String(contextPath || "");
        const ledgerCell = ctxHref
            ? `<a class="mono" href="${esc(ctxHref)}" target="_blank" rel="noreferrer">${esc(ctxLabel)}</a>`
            : `<span class="mono">${esc(ctxLabel)}</span>`;

        const stdoutRel = deriveLogRel(relContext, "stdout");
        const stderrRel = deriveLogRel(relContext, "stderr");
        const stdoutHref = ledgerHref(stdoutRel);
        const stderrHref = ledgerHref(stderrRel);

        const proxiedPath = p.proxyEndpointPrefix ?? "";
        const proxiedCell = proxiedPath
            ? `<a class="mono" href="${esc(proxiedPath)}" target="_blank" rel="noreferrer">${esc(proxiedPath)}</a>`
            : `<span class="mono"></span>`;

        const svcLabel = serviceId || "(unknown)";
        const svcTitle = sessionId ? `sessionId=${sessionId}` : "";
        const serviceCell = `<span class="mono" title="${esc(svcTitle)}">${esc(svcLabel)}</span>`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td class="mono">${esc(pid)}</td>
      <td class="mono"><a href="${esc(upstreamUrl)}" target="_blank" rel="noreferrer">${esc(upstreamUrl)}</a></td>
      <td class="mono">${proxiedCell}</td>
      <td>${serviceCell}</td>
      <td>${ledgerCell}</td>
      <td class="actions">
        <a class="btnlink" href="${esc(stdoutHref || "#")}" target="_blank" rel="noreferrer">STDOUT</a>
        <a class="btnlink" href="${esc(stderrHref || "#")}" target="_blank" rel="noreferrer">STDERR</a>
      </td>
    `;
        procTbody.appendChild(tr);
    }
}

function renderReconcile(payload) {
    const { now, ledgerDir, summary, items } = payload;
    const ok = summary?.processWithoutLedger === 0 &&
        summary?.ledgerWithoutProcess === 0;

    reconcileStatusText.textContent = ok
        ? `Reconcile: OK | Updated ${now} | ledgerDir=${ledgerDir}`
        : `Reconcile: discrepancies | Updated ${now} | ledgerDir=${ledgerDir} | processWithoutLedger=${summary?.processWithoutLedger ?? "?"} ledgerWithoutProcess=${summary?.ledgerWithoutProcess ?? "?"}`;

    reconcileTbody.innerHTML = "";

    for (const it of (items || [])) {
        const kind = it.kind || "";
        const pid = it.pid ?? "";
        const serviceId = it.serviceId ?? "";
        const sessionId = it.sessionId ?? "";

        let path = "";
        let cmdline = "";

        if (kind === "process_without_ledger") {
            path = it.contextPath ?? "";
            cmdline = it.cmdline ?? "";
        } else if (kind === "ledger_without_process") {
            path = it.ledgerContextPath ?? "";
            cmdline = "";
        } else {
            path = it.contextPath ?? it.ledgerContextPath ?? "";
            cmdline = it.cmdline ?? "";
        }

        const rel = stripLedgerPrefix(ledgerDir, path);
        const href = ledgerHref(rel);

        const pathCell = href
            ? `<a class="mono" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(rel || path)}</a>`
            : `<span class="mono">${esc(rel || path)}</span>`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td class="mono">${esc(kind)}</td>
      <td class="mono">${esc(pid)}</td>
      <td class="mono">${esc(serviceId)}</td>
      <td class="mono">${esc(sessionId)}</td>
      <td>${pathCell}</td>
      <td class="mono">${esc(cmdline)}</td>
    `;
        reconcileTbody.appendChild(tr);
    }
}

async function refresh() {
    try {
        procStatusText.textContent = "Processes: loading…";
        const res = await fetch("/.db-yard/api/tagged-processes.json", {
            cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        render(payload);
    } catch (e) {
        procStatusText.textContent = `Processes: failed to load: ${e?.message ?? e}`;
        if (lastPayload) render(lastPayload);
    }
}

async function runReconcile() {
    try {
        reconcileStatusText.textContent = "Reconcile: running…";
        const res = await fetch("/.db-yard/api/reconcile.json", {
            cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        renderReconcile(payload);
    } catch (e) {
        reconcileStatusText.textContent =
            `Reconcile: failed: ${e?.message ?? e}`;
    }
}

refreshBtn.addEventListener("click", refresh);
filterInput.addEventListener("input", () => {
    if (lastPayload) render(lastPayload);
});
reconcileBtn.addEventListener("click", runReconcile);

// run both on start
refresh();
runReconcile();
