![db-yard Logo](project-hero.png)

`db-yard` is a file-driven process yard for “SQLite DB cargo.” It treats your
filesystem as the control plane. You drop databases into a cargo directory, and
db-yard discovers, classifies, spawns, supervises, and exposes them as local web
services using deterministic, inspectable state written entirely to disk.

There is no registry, no background daemon requirement, and no internal
control-plane database. Everything db-yard knows is encoded in files you can
read, version, copy, audit, or generate tooling around.

## Core idea

A SQLite file on disk is cargo.

Dropping cargo into the yard makes it eligible to be launched. The spawned-state
directory is the operational ledger: JSON context manifests and logs are written
to disk so other tools, scripts, reverse proxies, and later invocations of
`yard.ts` can see what is running without needing an API.

The filesystem _is_ the API.

## Mental model: a Navy Yard

- The yard is a place where cargo crates get launched as vessels.
- Databases are cargo crates.
- Spawned processes are launched vessels.
- Ports are berths.
- JSON context files are manifests you can hand to other tools.
- The spawned-state directory is the ship log.

This framing is intentional. db-yard is not an app server or orchestrator in the
Kubernetes sense. It is closer to a dockyard that launches things predictably
and writes down exactly what it did.

## What db-yard supports

Today, db-yard focuses on **local-first, deterministic process orchestration**
for:

- SQLPage applications stored inside SQLite databases
- surveilr RSSDs (SQLite databases with `uniform_resource` tables)

Other tabular formats (DuckDB, Excel, etc.) may be discovered as cargo but are
not currently exposable services.

## High-level workflows

db-yard supports three complementary workflows, all using the same underlying
ledger format.

### 1. Materialize and exit

You scan cargo, spawn everything exposable, write state to disk, and exit.

This is ideal for:

- CI pipelines
- Deterministic local runs
- Generating reverse proxy configs
- One-shot demos or testing

Command:

```bash
bin/yard.ts start
```

### 2. Continuous watch and reconcile

You keep db-yard running. It watches the filesystem and reconciles reality to
intent.

- New cargo appears → spawn it
- Cargo disappears → kill it
- Process dies → respawn it

Command:

```bash
bin/yard.ts watch
```

This uses the same spawned-state ledger as materialize mode, just continuously.

### 3. Web UI and admin interface

You can expose:

- A proxy index of running services
- A JSON admin endpoint
- A browsable admin UI
- Logs and context files
- Optional unsafe SQL endpoints (explicitly marked)

All served on the same port, alongside proxied services.

This is layered _on top of_ the spawned-state ledger and watcher logic.

## Discovery and classification

### Discovery

db-yard recursively walks one or more cargo roots using the same rules as
`tabular()`.

Typical globs include:

- `**/*.db`
- `**/*.sqlite`
- `**/*.sqlite3`
- `**/*.sqlite.db`
- `**/*.duckdb`
- `**/*.xlsx`

### Classification

Each candidate file is classified cheaply and deterministically:

- If it is SQLite-like:
  - If it has table `uniform_resource`, it is a surveilr RSSD and spawned via
    `surveilr web-ui`
  - Else if it has table `sqlpage_files`, it is a SQLPage app and spawned via
    `sqlpage`
  - Else it is plain SQLite and ignored by `exposable()`
- Non-SQLite tabular files may be discovered but are not exposable services
  today

No heuristics beyond this. No magic.

## Proxy prefix assignment

Each exposable service is assigned a proxy prefix derived from its path
**relative to the cargo root**.

Examples:

- `cargo.d/controls/scf-2025.3.sqlite.db` → `/controls/scf-2025.3.sqlite`
- `cargo.d/two/example-two.db` → `/two/example-two`

This prefix is:

- Passed to the spawned service
- Written into the context JSON
- Used by the web UI
- Used by reverse proxy config generators

The same prefix flows through the entire system.

## Port allocation

Ports are assigned incrementally, starting at a configurable base (default:
3000).

In watch mode, db-yard avoids port collisions by:

- Reading the existing ledger
- Skipping ports already bound by live PIDs

This keeps restarts stable and predictable.

## Spawned-state ledger

Every spawned service writes three files:

- `<name>.context.json`
- `<name>.stdout.log`
- `<name>.stderr.log`

These files live under a session directory inside the spawn-state home.

### Session directories

Materialize mode (`start`) creates a timestamped session directory:

```
spawned.d/2026-01-07-20-15-00/
```

Watch mode and web UI use a **stable session directory** (by default `active/`)
so state is continuously reconciled instead of replaced.

### Mirrored layout

Session directories mirror the cargo directory structure:

```
spawned.d/2026-01-07-20-15-00/
  controls/
    scf-2025.3.sqlite.db.context.json
    scf-2025.3.sqlite.db.stdout.log
    scf-2025.3.sqlite.db.stderr.log
  two/
    example-two.db.context.json
    example-two.db.stdout.log
    example-two.db.stderr.log
```

This makes it trivial to trace a running service back to its source file.

## CLI overview

### Start (materialize)

```bash
bin/yard.ts start --cargo-home ./cargo.d --spawn-state-home ./spawned.d --verbose essential|comprehensive --summarize
```

### Watch (continuous reconcile)

```bash
bin/yard.ts watch --cargo-home ./cargo.d --spawn-state-home ./spawned.d --active-dir-name active --debounce-ms 250 --reconcile-every-ms 0
```

### List

```bash
bin/yard.ts ls
```

### Kill

```bash
bin/yard.ts kill
bin/yard.ts kill --clean
```

### Reverse proxy config generation

```bash
bin/yard.ts proxy-conf --type nginx
bin/yard.ts proxy-conf --type traefik
bin/yard.ts proxy-conf --type both
```

Supported options include:

- `--include-dead`
- `--location-prefix`
- `--strip-prefix`
- nginx-specific flags
- traefik-specific flags

## Web UI

The web UI is optional and layered on top of watch mode.

Endpoints:

- `/` proxy index
- `/.admin` JSON runtime state
- `/.admin/index.html` admin UI
- `/.admin/files/...` logs and context files
- `/.web-ui/...` static UI assets
- All other paths → proxied services

The web UI runs on the same port as proxied services by design.

## Unsafe SQL endpoint

For development and debugging only:

```http
POST /SQL/unsafe/<id>.json
{
  "sql": "select * from sqlite_master"
}
```

This is intentionally labeled unsafe and should never be exposed publicly.

## Operational philosophy

db-yard is built around a few strong constraints:

- Files, not APIs
- Deterministic behavior
- Zero hidden state
- Easy integration via inspection
- Killable, restartable, auditable processes

If something goes wrong, you should be able to:

- Open a JSON file
- Read a log
- Kill a PID
- Rerun a command

No control-plane archaeology required.

## Who this is for

db-yard is ideal for:

- Engineers who prefer local-first workflows
- Tooling authors who want inspectable state
- SQLPage and surveilr users
- CI systems that need deterministic spawning
- Reverse proxy generation pipelines
- Teams allergic to background daemons

## Summary

db-yard is intentionally boring in the best way possible.

If you understand files, processes, ports, and logs, you already understand
db-yard.
