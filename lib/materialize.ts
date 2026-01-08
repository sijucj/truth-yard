// lib/materialize.ts
import { ensureDir } from "@std/fs";
import { basename, join, resolve } from "@std/path";
import type { Path } from "./discover.ts";
import { encounters, fileSystemSource } from "./discover.ts";
import type { ExposableService } from "./exposable.ts";
import {
  joinUrl,
  proxyPrefixFromRel,
  relDirFromRoots,
  relFromRoots,
} from "./path.ts";
import { richTextUISpawnEvents } from "./spawn-event.ts";
import {
  isPidAlive,
  killPID,
  readProcCmdline,
  spawn,
  type SpawnedContext,
  SpawnEventListener,
  type SpawnSummary,
} from "./spawn.ts";

export type MaterializeVerbose = false | "essential" | "comprehensive";

export type MaterializeOptions = Readonly<{
  verbose: MaterializeVerbose;
  spawnStateHome: string;
}>;

export type MaterializeResult = Readonly<{
  sessionHome: string;
  summary: SpawnSummary;
  spawned: SpawnedContext[];
}>;

function fmt2(n: number): string {
  return String(n).padStart(2, "0");
}

function sessionStamp(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = fmt2(d.getMonth() + 1);
  const dd = fmt2(d.getDate());
  const hh = fmt2(d.getHours());
  const mi = fmt2(d.getMinutes());
  const ss = fmt2(d.getSeconds());
  return `${yyyy}-${mm}-${dd}-${hh}-${mi}-${ss}`;
}

export async function materialize(
  srcPaths: Iterable<Path>,
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const src = Array.from(srcPaths);

  // Canonicalize roots so prefix checks work even with symlinks.
  const rootsAbs = src.map((p) => Deno.realPathSync(resolve(p.path)));

  const spawnStateHome = resolve(opts.spawnStateHome);
  await ensureDir(spawnStateHome);

  const sessionHome = join(spawnStateHome, sessionStamp());
  await ensureDir(sessionHome);

  const onEvent: SpawnEventListener | undefined = opts.verbose === false
    ? undefined
    : richTextUISpawnEvents(opts.verbose);

  const spawned: SpawnedContext[] = [];

  const spawnStatePath = (
    entry: ExposableService,
    nature: "context" | "stdout" | "stderr",
  ): string | undefined => {
    // Canonicalize discovered file too.
    const fileAbs = Deno.realPathSync(resolve(entry.supplier.location));

    const relFromRoot = relFromRoots(fileAbs, rootsAbs);
    const relDir = relDirFromRoots(fileAbs, rootsAbs);

    const outDir = relDir ? join(sessionHome, relDir) : sessionHome;
    const fileName = basename(relFromRoot);

    if (nature === "context") return join(outDir, `${fileName}.context.json`);
    if (nature === "stdout") return join(outDir, `${fileName}.stdout.log`);
    if (nature === "stderr") return join(outDir, `${fileName}.stderr.log`);
    return undefined;
  };

  const expose = (entry: ExposableService, _candidate: string) => {
    const fileAbs = Deno.realPathSync(resolve(entry.supplier.location));
    const relFromRoot = relFromRoots(fileAbs, rootsAbs);
    const proxyEndpointPrefix = proxyPrefixFromRel(relFromRoot);

    return { proxyEndpointPrefix, exposableServiceConf: {} } as const;
  };

  const gen = spawn(src, expose, spawnStatePath, {
    onEvent,
    probe: { enabled: false },
  });

  while (true) {
    const next = await gen.next();
    if (next.done) {
      return {
        sessionHome,
        summary: next.value as SpawnSummary,
        spawned,
      };
    }
    spawned.push(next.value);
  }
}

export type SpawnedStateEncounter = Readonly<{
  filePath: string;
  context: SpawnedContext;
  pid: number;
  pidAlive: boolean;
  procCmdline?: string;
  upstreamUrl: string;
}>;

export async function* spawnedStates(spawnStateHome: string) {
  const gen = encounters(
    [{ path: spawnStateHome, globs: ["**/*.json"] }],
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

      const upstreamUrl = joinUrl(
        ctx.listen.baseUrl,
        ctx.service.proxyEndpointPrefix === ""
          ? "/"
          : ctx.service.proxyEndpointPrefix,
      );

      return {
        filePath,
        context: ctx,
        pid,
        pidAlive,
        procCmdline,
        upstreamUrl,
      };
    },
  );

  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
    if (next.value != null) yield next.value;
  }
}

export async function killSpawnedStates(spawnStateHome: string): Promise<void> {
  for await (const state of spawnedStates(spawnStateHome)) {
    const { pid, pidAlive } = state;
    if (pidAlive) {
      await killPID(pid);
    }
  }
}
