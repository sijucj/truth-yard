// lib/serve/web-ui-assets/web-ui.js
async function fetchAdmin() {
  const res = await fetch("/.admin", { cache: "no-store" });
  if (!res.ok) throw new Error(`/.admin HTTP ${res.status}`);
  return await res.json();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderRunning(items) {
  const grid = document.getElementById("runningGrid");
  while (grid.children.length > 1) grid.removeChild(grid.lastChild);

  if (!items || items.length === 0) {
    const r = el("div", "row");
    r.appendChild(el("div", "c muted", "(none)"));
    grid.appendChild(r);
    return;
  }

  for (const it of items) {
    const r = el("div", "row");

    const pfx = String(it.proxyEndpointPrefix || "/");
    const upstream = `${it.listen?.host || "127.0.0.1"}:${
      it.listen?.port || ""
    }`;
    const kind = String(it.kind || "");
    const id = String(it.id || "");
    const pid = String(it.pid || "");

    const pfxCell = el("div", "c c-prefix");
    const a = el("a", "", pfx);
    a.href = pfx;
    pfxCell.appendChild(a);

    r.appendChild(pfxCell);
    r.appendChild(el("div", "c c-up", upstream));
    r.appendChild(el("div", "c c-kind", kind));
    r.appendChild(el("div", "c c-id", id));
    r.appendChild(el("div", "c c-pid", pid));

    grid.appendChild(r);
  }
}

function renderEvents(recentEvents) {
  const pre = document.getElementById("events");
  const lines = (recentEvents || []).slice(-40).map((e) => {
    const t = e.type || "";
    if (t === "reconcile_end") {
      return `${t} reason=${e.reason} discovered=${e.discovered} ledger=${e.ledger} killed=${e.killed} spawned=${e.spawned} durMs=${
        Math.round(e.durationMs || 0)
      }`;
    }
    if (t === "fs_event") {
      const p = (e.paths || []).slice(0, 3).join(", ");
      return `${t} kind=${e.kind} paths=${p}${
        (e.paths || []).length > 3 ? "…" : ""
      }`;
    }
    if (t === "error") {
      return `${t} phase=${e.phase} error=${String(e.error || "")}`;
    }
    return t ? `${t}` : JSON.stringify(e);
  });

  pre.textContent = lines.join("\n") || "(none)";
}

function renderStatus(snapshot) {
  const s = document.getElementById("status");
  const lr = snapshot.lastReconcile;
  if (lr && lr.type === "reconcile_end") {
    s.textContent =
      `activeDir: ${snapshot.activeDir} | running: ${snapshot.count} | last reconcile: reason=${lr.reason}, spawned=${lr.spawned}, killed=${lr.killed}`;
  } else {
    s.textContent =
      `activeDir: ${snapshot.activeDir} | running: ${snapshot.count}`;
  }
}

async function tick() {
  try {
    const snap = await fetchAdmin();
    renderStatus(snap);
    renderRunning(snap.items);
    renderEvents(snap.recentEvents);
  } catch (e) {
    const s = document.getElementById("status");
    s.textContent = `Error: ${String(e)}`;
  }
}

tick();
setInterval(tick, 1000);
