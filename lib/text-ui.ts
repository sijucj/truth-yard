// lib/text-ui.ts
import {
  brightGreen,
  brightRed,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
  yellow,
} from "@std/fmt/colors";
import type { VerboseKind } from "./governance.ts";

export function vTag(kind: VerboseKind): string {
  switch (kind) {
    case "detect":
      return `[${cyan(kind)}]`;
    case "spawn":
      return `[${green(kind)}]`;
    case "stop":
      return `[${red(kind)}]`;
    case "refresh":
      return `[${yellow(kind)}]`;
    case "skip":
      return `[${gray(kind)}]`;
    case "reconcile":
      return `[${magenta(kind)}]`;
    default:
      return `[${kind}]`;
  }
}

export function vlog(
  enabled: boolean,
  kind: VerboseKind,
  msg: string,
  extra?: Record<string, unknown>,
) {
  if (!enabled) return;

  const head = `${vTag(kind)} ${msg}`;
  if (!extra) {
    console.log(head);
    return;
  }
  const details = Object.entries(extra)
    .map(([k, v]) => `${gray(k)}=${String(v)}`)
    .join(" ");
  console.log(details ? `${head} ${details}` : head);
}

export function formatPidSkipSelf(args: {
  pid: number;
  sourcesCount: number;
}): string {
  return `${yellow(String(args.pid))} ${
    dim("(skipping self)")
  } sources=${args.sourcesCount}`;
}

export function formatPidStatusLine(args: {
  pid: number;
  alive: boolean;
  sourcesCount: number;
  cmdline?: string;
}): string {
  const status = args.alive ? brightGreen("alive") : brightRed("dead");
  const srcHint = args.sourcesCount ? ` sources=${args.sourcesCount}` : "";
  const cmdHint = args.cmdline ? ` ${dim(args.cmdline)}` : "";
  return `${args.pid} ${status}${srcHint}${cmdHint}`;
}

export function formatKillSkipDead(pid: number): string {
  return `${pid} ${brightRed("dead")} ${dim("(skip kill)")}`;
}

export function formatKillResult(args: {
  pid: number;
  stillAlive: boolean;
  cmdline?: string;
}): string {
  const tail = args.cmdline ? ` ${dim(args.cmdline)}` : "";
  return `${args.pid} ${
    args.stillAlive ? brightRed("still-alive") : brightGreen("killed")
  }${tail}`;
}
