import { spawnSync } from "node:child_process";
import { basename } from "node:path";

import { flagString } from "./args";

import type { ParsedArgs } from "../types";
import type { Meta } from "../types";

function runQuiet(cmd: string[]): string | undefined {
  try {
    const res = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf-8", timeout: 2000 });
    if (res.status === 0 && typeof res.stdout === "string") {
      const out = res.stdout.trim();
      return out.length > 0 ? out : undefined;
    }
  } catch {
    // Probing the host environment is best-effort; absence is expected.
  }
  return undefined;
}

function parentProcessName(): string | undefined {
  const ppid = process.ppid;
  if (!ppid) return undefined;
  return runQuiet(["ps", "-o", "comm=", "-p", String(ppid)]);
}

function gitProjectName(): string | undefined {
  const top = runQuiet(["git", "rev-parse", "--show-toplevel"]);
  return top ? basename(top) : undefined;
}

function parentShellSid(): string | undefined {
  const sid = runQuiet(["ps", "-o", "sid=", "-p", String(process.pid)]);
  return sid;
}

function resolveAgent(args: ParsedArgs): string {
  return (
    flagString(args, "agent") ??
    process.env.ATIX_AGENT ??
    parentProcessName() ??
    "unknown"
  );
}

function resolveProject(args: ParsedArgs): string {
  return (
    flagString(args, "project") ??
    process.env.ATIX_PROJECT ??
    gitProjectName() ??
    basename(process.cwd())
  );
}

function resolveSession(args: ParsedArgs): string {
  // ATIX_SESSION issuance is the SKILL (caller) layer's responsibility; the CLI
  // only provides a deterministic fallback so a row is never left without a
  // session attribution.
  return (
    flagString(args, "session") ??
    process.env.ATIX_SESSION ??
    parentShellSid() ??
    String(process.pid)
  );
}

/**
 * Resolve identity/metadata for the calling process. `kind` is decided purely
 * by intent: an explicit `--agent` flag or `$ATIX_AGENT` env signals an agent
 * invocation; otherwise the caller is treated as a human. Heuristic
 * fallbacks (parent process name) only fill the display value, not the kind,
 * to avoid mislabeling an interactive shell as an agent.
 */
export function resolveMeta(args: ParsedArgs): Meta {
  const explicitAgent =
    flagString(args, "agent") !== undefined || process.env.ATIX_AGENT !== undefined;

  return {
    kind: explicitAgent ? "agent" : "human",
    agent: resolveAgent(args),
    project: resolveProject(args),
    cwd: process.cwd(),
    session: resolveSession(args),
    pid: process.pid,
  };
}
