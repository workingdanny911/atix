import type { OutputMode, TicketStatus } from "../types";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const;

/** Status icons shared by human and plain layouts (plain just drops color). */
export const STATUS_ICON: Record<TicketStatus | "orphaned", string> = {
  open: "🟢",
  claimed: "🟡",
  done: "✅",
  canceled: "✖",
  orphaned: "⚠️",
};

/**
 * Decide the rendering mode:
 * - `--json` → json
 * - TTY stdout and NO_COLOR unset → human (color + icons)
 * - otherwise (pipe or NO_COLOR) → plain (icons, no color)
 */
export function resolveOutputMode(isJson: boolean): OutputMode {
  if (isJson) return "json";
  const isTty = process.stdout.isTTY === true;
  const noColor = process.env.NO_COLOR !== undefined;
  return isTty && !noColor ? "human" : "plain";
}

export function printJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** Write a line as-is. Use `colorize` for human-mode emphasis. */
export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Apply an ANSI color only in human mode; plain/json callers should pass
 * `mode` so the same render code path serves all modes.
 */
export function colorize(mode: OutputMode, color: keyof typeof COLORS, text: string): string {
  if (mode !== "human") return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export function statusIcon(status: TicketStatus | "orphaned"): string {
  return STATUS_ICON[status];
}
