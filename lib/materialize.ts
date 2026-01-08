// lib/materialize.ts
import { ensureDir } from "@std/fs";
import { basename, join, resolve } from "@std/path";
import type { Path } from "./discover.ts";
import { encounters, fileSystemSource } from "./discover.ts";
import type { ExposableService } from "./exposable.ts";
import { richTextUISpawnEvents } from "./spawn-event.ts";
import {
  isPidAlive,
  readProcCmdline,
  spawn,
  type SpawnedContext,
  type SpawnEventListener,
  SpawnLedgerNature,
  type SpawnSummary,
  taggedProcesses,
} from "./spawn.ts";
import { proxyPrefixFromRel, relDirFromRoots, relFromRoots } from "./path.ts";

export function sortableDateTimeText(d = new Date()): string {
  function fmt2(n: number): string {
    return String(n).padStart(2, "0");
  }
  const yyyy = d.getFullYear();
  const mm = fmt2(d.getMonth() + 1);
  const dd = fmt2(d.getDate());
  const hh = fmt2(d.getHours());
  const mi = fmt2(d.getMinutes());
  const ss = fmt2(d.getSeconds());
  return `${yyyy}-${mm}-${dd}-${hh}-${mi}-${ss}`;
}

export async function createSpawnSessionHome(
  spawnedLedgerHome: string,
) {
  const home = resolve(spawnedLedgerHome);
  await ensureDir(spawnedLedgerHome);

  const sessionName = sortableDateTimeText();
  const sessionHome = join(home, sessionName);
  await ensureDir(sessionHome);

  // Pointer file for “current session” (portable, no symlinks).
  await Deno.writeTextFile(join(home, ".current-session"), `${sessionName}\n`);

  return { spawnedLedgerHome: home, sessionHome, sessionName };
}
export type MaterializeVerbose = false | "essential" | "comprehensive";

export type MaterializeOptions = Readonly<{
  verbose: MaterializeVerbose;
  spawnedLedgerHome: string;
}>;

export type MaterializeResult = Readonly<{
  sessionHome: string;
  summary: SpawnSummary;
  spawned: SpawnedContext[];
}>;

export function spawnedLedgerPathForEntry(
  entry: ExposableService,
  nature: SpawnLedgerNature,
  args: Readonly<{ sessionHome: string; rootsAbs: readonly string[] }>,
): string | undefined {
  const fileAbs = Deno.realPathSync(resolve(entry.supplier.location));

  const relFromRoot = relFromRoots(fileAbs, args.rootsAbs);
  const relDir = relDirFromRoots(fileAbs, args.rootsAbs);

  const outDir = relDir ? join(args.sessionHome, relDir) : args.sessionHome;
  const fileName = basename(relFromRoot);

  if (nature === "context") return join(outDir, `${fileName}.context.json`);
  if (nature === "stdout") return join(outDir, `${fileName}.stdout.log`);
  if (nature === "stderr") return join(outDir, `${fileName}.stderr.log`);
  return undefined;
}

export async function materialize(
  srcPaths: Iterable<Path>,
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const src = Array.from(srcPaths);

  const rootsAbs = src.map((p) => Deno.realPathSync(resolve(p.path)));

  const spawnedLedgerHome = resolve(opts.spawnedLedgerHome);
  await ensureDir(spawnedLedgerHome);

  const session = await createSpawnSessionHome(spawnedLedgerHome);

  const onEvent: SpawnEventListener | undefined = opts.verbose === false
    ? undefined
    : richTextUISpawnEvents(opts.verbose);

  const spawned: SpawnedContext[] = [];

  const spawnedLedgerPath = (
    entry: ExposableService,
    nature: "context" | "stdout" | "stderr",
  ): string | undefined =>
    spawnedLedgerPathForEntry(entry, nature, {
      sessionHome: session.sessionHome,
      rootsAbs,
    });

  const expose = (entry: ExposableService, _candidate: string) => {
    const fileAbs = Deno.realPathSync(resolve(entry.supplier.location));
    const relFromRoot = relFromRoots(fileAbs, rootsAbs);
    const proxyEndpointPrefix = proxyPrefixFromRel(relFromRoot);
    return { proxyEndpointPrefix, exposableServiceConf: {} } as const;
  };

  const gen = spawn(src, expose, spawnedLedgerPath, {
    onEvent,
    probe: { enabled: false },
  });

  while (true) {
    const next = await gen.next();
    if (next.done) {
      return {
        sessionHome: session.sessionHome,
        summary: next.value as SpawnSummary,
        spawned,
      };
    }
    spawned.push(next.value);
  }
}

export type SpawnedLedgerEncounter = Readonly<{
  filePath: string;
  context: SpawnedContext;
  pid: number;
  pidAlive: boolean;
  procCmdline?: string;
}>;

export async function* spawnedLedgerStates(
  spawnedLedgerHomeOrSessionHome: string,
) {
  const gen = encounters(
    [{ path: spawnedLedgerHomeOrSessionHome, globs: ["**/*.json"] }],
    fileSystemSource({}, (e) => Deno.readTextFile(e.path)),
    async ({ entry, content }) => {
      const filePath = entry.path;
      if (!filePath.endsWith(".context.json")) return null;

      const text = String(await content());
      const ctx = JSON.parse(text) as SpawnedContext;

      const pid = Number(ctx?.spawned?.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(`Invalid pid in context file: ${filePath}`);
      }

      const pidAlive = isPidAlive(pid);
      const procCmdline = pidAlive ? await readProcCmdline(pid) : undefined;

      return {
        filePath,
        context: ctx,
        pid,
        pidAlive,
        procCmdline,
      } satisfies SpawnedLedgerEncounter;
    },
  );

  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
    if (next.value != null) yield next.value as SpawnedLedgerEncounter;
  }
}

/* -------------------------------- reconcile ------------------------------- */

export type ReconcileItem =
  | Readonly<{
    kind: "process_without_ledger";
    pid: number;
    serviceId: string;
    sessionId: string;
    contextPath: string;
    cmdline?: string;
  }>
  | Readonly<{
    kind: "ledger_without_process";
    ledgerContextPath: string;
    pid: number;
    serviceId?: string;
    sessionId?: string;
  }>;

export type ReconcileSummary = Readonly<{
  processWithoutLedger: number;
  ledgerWithoutProcess: number;
}>;

/**
 * Reconcile operational truth (Linux tagged processes) vs spawned ledger (context.json files).
 *
 * Input can be either the ledger home or a specific sessionHome.
 */
export async function* reconcile(
  spawnedLedgerHomeOrSessionHome: string,
): AsyncGenerator<ReconcileItem, ReconcileSummary> {
  const base = resolve(spawnedLedgerHomeOrSessionHome);

  // 1) Build ledger index (by pid, by context path)
  const ledgerByPid = new Map<number, SpawnedLedgerEncounter>();
  const ledgerByContextPath = new Map<string, SpawnedLedgerEncounter>();

  for await (const le of spawnedLedgerStates(base)) {
    ledgerByPid.set(le.pid, le);
    ledgerByContextPath.set(resolve(le.filePath), le);
  }

  // 2) Walk processes and emit process-side discrepancies
  let processWithoutLedger = 0;

  const seenLedgerPids = new Set<number>();

  for await (const tp of taggedProcesses()) {
    const pid = tp.pid;

    // We consider the ledger “present” if the process' contextPath exists in ledger scan OR pid matches.
    const ledgerByCtx = ledgerByContextPath.get(resolve(tp.contextPath));
    const ledger = ledgerByCtx ?? ledgerByPid.get(pid);

    if (!ledger) {
      processWithoutLedger++;
      yield {
        kind: "process_without_ledger",
        pid,
        serviceId: tp.serviceId,
        sessionId: tp.sessionId,
        contextPath: tp.contextPath,
        cmdline: tp.cmdline,
      };
      continue;
    }

    seenLedgerPids.add(ledger.pid);
  }

  // 3) Emit ledger-side discrepancies: contexts whose pid is not alive OR not seen in taggedProcesses
  let ledgerWithoutProcess = 0;

  for (const [pid, le] of ledgerByPid.entries()) {
    const alive = isPidAlive(pid);
    if (alive && seenLedgerPids.has(pid)) continue;

    ledgerWithoutProcess++;
    yield {
      kind: "ledger_without_process",
      ledgerContextPath: resolve(le.filePath),
      pid,
      serviceId: le.context?.service?.id,
      sessionId: le.context?.session?.sessionId,
    };
  }

  return {
    processWithoutLedger,
    ledgerWithoutProcess,
  };
}
