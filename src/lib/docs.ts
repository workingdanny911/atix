import { flagOccurrences } from "./args";
import { BodyTooLargeError, InvalidUtf8Error, NulByteError } from "./body";
import { BadFlagError } from "./errors";

import type { ParsedArgs } from "../types";

const DOC_FLAG_KEYS = new Set(["doc", "doc-file", "doc-stdin"]);
const DOC_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const WARN_BYTES = 262144;
const DEFAULT_MAX_BYTES = 16777216;
const DEFAULT_CONTENT_TYPE = "text/markdown; charset=utf-8";

export interface ResolvedDoc {
  position: number;
  title: string;
  contentType: string;
  content: string;
  sizeBytes: number;
}

interface NamedValue {
  name: string;
  value: string;
}

function maxDocBytes(): number {
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

function parseNamedValue(raw: string, flag: string): NamedValue {
  const eq = raw.indexOf("=");
  if (eq === -1) throw new BadFlagError(`${flag} requires <name>=<value>`);

  const name = raw.slice(0, eq);
  validateDocName(name, flag);
  return { name, value: raw.slice(eq + 1) };
}

function parseDocStdinName(raw: string): string {
  validateDocName(raw, "--doc-stdin");
  return raw;
}

function validateDocName(name: string, flag: string): void {
  if (DOC_NAME_RE.test(name)) return;
  throw new BadFlagError(
    `${flag} name must match ${DOC_NAME_RE.source} (1-64 characters)`,
  );
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidUtf8Error();
  }
}

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

function fromText(position: number, title: string, content: string, maxBytes: number): ResolvedDoc {
  if (content.includes("\u0000")) throw new NulByteError();

  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > maxBytes) throw new BodyTooLargeError(sizeBytes, maxBytes);
  warnLargeDoc(title, sizeBytes);

  return {
    position,
    title,
    contentType: DEFAULT_CONTENT_TYPE,
    content,
    sizeBytes,
  };
}

async function fromFile(
  position: number,
  title: string,
  path: string,
  maxBytes: number,
): Promise<ResolvedDoc> {
  const file = Bun.file(path);
  if (file.size > maxBytes) throw new BodyTooLargeError(file.size, maxBytes);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const content = decodeStrictUtf8(bytes);
  if (content.includes("\u0000")) throw new NulByteError();
  if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(bytes.byteLength, maxBytes);
  warnLargeDoc(title, bytes.byteLength);

  return {
    position,
    title,
    contentType: DEFAULT_CONTENT_TYPE,
    content,
    sizeBytes: bytes.byteLength,
  };
}

async function fromStdin(position: number, title: string, maxBytes: number): Promise<ResolvedDoc> {
  const bytes = await readStdinCapped(maxBytes);
  const content = decodeStrictUtf8(bytes);
  if (content.includes("\u0000")) throw new NulByteError();
  warnLargeDoc(title, bytes.byteLength);

  return {
    position,
    title,
    contentType: DEFAULT_CONTENT_TYPE,
    content,
    sizeBytes: bytes.byteLength,
  };
}

function warnLargeDoc(title: string, sizeBytes: number): void {
  if (sizeBytes <= WARN_BYTES) return;
  process.stderr.write(
    `warning: doc '${title}' ${sizeBytes} bytes exceeds 256 KiB — consider --doc-file\n`,
  );
}

export async function resolveDocs(args: ParsedArgs): Promise<ResolvedDoc[]> {
  const entries = flagOccurrences(args, DOC_FLAG_KEYS);
  if (entries.length === 0) return [];

  const stdinEntries = entries.filter((entry) => entry.key === "doc-stdin");
  if (stdinEntries.length > 1) {
    throw new BadFlagError("--doc-stdin may be used at most once");
  }

  const maxBytes = maxDocBytes();
  const docs: ResolvedDoc[] = [];

  for (const entry of entries) {
    if (typeof entry.value !== "string") {
      throw new BadFlagError(`--${entry.key} requires a value`);
    }

    if (entry.key === "doc") {
      const parsed = parseNamedValue(entry.value, "--doc");
      docs.push(fromText(docs.length, parsed.name, parsed.value, maxBytes));
    } else if (entry.key === "doc-file") {
      const parsed = parseNamedValue(entry.value, "--doc-file");
      docs.push(await fromFile(docs.length, parsed.name, parsed.value, maxBytes));
    } else {
      const name = parseDocStdinName(entry.value);
      docs.push(await fromStdin(docs.length, name, maxBytes));
    }
  }

  return docs;
}
