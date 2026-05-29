import { AtixError, EXIT } from "./exit";

import type { ParsedArgs } from "../types";

const WARN_BYTES = 262144; // 256 KiB — soft warning threshold.
const DEFAULT_MAX_BYTES = 16777216; // 16 MiB — hard default ceiling.

export class MultipleBodyInputsError extends AtixError {
  constructor() {
    super(
      "multiple_body_inputs",
      "specify exactly one of --body, --body-file, --body-stdin",
      EXIT.INPUT,
    );
    this.name = "MultipleBodyInputsError";
  }
}

export class InvalidUtf8Error extends AtixError {
  constructor() {
    super("invalid_utf8", "body must be valid UTF-8", EXIT.INPUT);
    this.name = "InvalidUtf8Error";
  }
}

export class NulByteError extends AtixError {
  constructor() {
    super("nul_byte", "body must not contain NUL byte", EXIT.INPUT);
    this.name = "NulByteError";
  }
}

export class BodyTooLargeError extends AtixError {
  constructor(sizeBytes: number, maxBytes: number) {
    const mib = (maxBytes / 1048576).toFixed(0);
    super(
      "body_too_large",
      `body ${sizeBytes} bytes exceeds ATIX_MAX_BODY_BYTES=${maxBytes} (${mib} MiB)`,
      EXIT.INPUT,
    );
    this.name = "BodyTooLargeError";
  }
}

export interface ResolvedBody {
  text: string;
  sizeBytes: number;
}

export interface ResolveBodyOptions {
  args: ParsedArgs;
  /** When true (push/reply), an empty resolved body still passes — callers
   * apply their own emptiness rule. Body validators here are about encoding/size. */
  allowEmpty?: boolean;
}

/**
 * Resolve the hard byte ceiling from `ATIX_MAX_BODY_BYTES`. An unset/empty value
 * uses the default silently (the common case). A *set but invalid* value
 * (non-numeric, zero, negative, fractional) is a misconfiguration the caller
 * likely did not intend — warn on stderr and fall back to the default rather
 * than silently honoring a meaningless override.
 */
function maxBodyBytes(): number {
  const raw = process.env.ATIX_MAX_BODY_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `warning: ATIX_MAX_BODY_BYTES='${raw}' is not a positive integer — using default ${DEFAULT_MAX_BYTES} (16 MiB)\n`,
    );
    return DEFAULT_MAX_BYTES;
  }
  return n;
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidUtf8Error();
  }
}

/**
 * Read stdin into a single buffer while enforcing `maxBytes` incrementally:
 * the running total is checked after every chunk so an unbounded pipe is
 * rejected (`BodyTooLargeError`) before it can exhaust memory. The reported
 * size on overflow is the bytes accumulated so far plus the offending chunk,
 * which is a lower bound on the true input size — sufficient for the contract.
 */
async function readStdinCapped(maxBytes: number): Promise<Uint8Array> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(total, maxBytes);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Resolve the ticket/reply body from exactly one source: --body / --body-file
 * / --body-stdin. Validates encoding (strict UTF-8), NUL byte absence, and
 * size against the hard ceiling. Emits a stderr warning past 256 KiB but keeps
 * exit 0 for that case.
 */
export async function resolveBody(opts: ResolveBodyOptions): Promise<ResolvedBody> {
  const { args } = opts;
  const sources: Array<"body" | "body-file" | "body-stdin"> = [];
  if (typeof args.flags["body"] === "string") sources.push("body");
  if (typeof args.flags["body-file"] === "string") sources.push("body-file");
  if (args.flags["body-stdin"] === true) sources.push("body-stdin");

  if (sources.length > 1) throw new MultipleBodyInputsError();

  const max = maxBodyBytes();

  let bytes: Uint8Array;
  if (sources[0] === "body") {
    bytes = new TextEncoder().encode(args.flags["body"] as string);
  } else if (sources[0] === "body-file") {
    // Pre-check size on the filesystem entry BEFORE reading the whole file
    // into memory — a multi-GiB file must be rejected without ever loading it.
    const file = Bun.file(args.flags["body-file"] as string);
    if (file.size > max) throw new BodyTooLargeError(file.size, max);
    bytes = new Uint8Array(await file.arrayBuffer());
  } else if (sources[0] === "body-stdin") {
    // Accumulate chunks, aborting the moment the running total exceeds the
    // ceiling so an unbounded pipe cannot exhaust memory before the size check.
    bytes = await readStdinCapped(max);
  } else {
    bytes = new Uint8Array(0);
  }

  const text = decodeStrictUtf8(bytes);
  if (text.includes("\u0000")) throw new NulByteError();

  const sizeBytes = bytes.byteLength;
  if (sizeBytes > max) throw new BodyTooLargeError(sizeBytes, max);
  if (sizeBytes > WARN_BYTES) {
    process.stderr.write(
      `warning: body ${sizeBytes} bytes exceeds 256 KiB — consider --body-file\n`,
    );
  }

  return { text, sizeBytes };
}
