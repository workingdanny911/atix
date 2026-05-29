import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { EXIT } from "../lib/exit";

import type { Ctx } from "../types";

/**
 * Print the resolved identity/metadata for the calling process. Reference
 * implementation for the output-mode + Meta contract — no DB access.
 */
export function run(ctx: Ctx): number {
  const { meta } = ctx;

  if (ctx.json) {
    printJson({ ok: true, ...meta });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  const label = (s: string) => colorize(mode, "dim", s);
  printLine(`${label("kind:   ")}${meta.kind}`);
  printLine(`${label("agent:  ")}${meta.agent}`);
  printLine(`${label("project:")}${meta.project}`);
  printLine(`${label("cwd:    ")}${meta.cwd}`);
  printLine(`${label("session:")}${meta.session}`);
  printLine(`${label("pid:    ")}${meta.pid}`);
  return EXIT.OK;
}
