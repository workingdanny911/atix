import { BadFlagError } from "./errors";

/**
 * A title is a single-line identifier (the label shown in `list`/`show`), not a
 * payload — the body carries the content. So validation stays minimal:
 *   - non-empty (an empty title cannot identify a ticket)
 *   - no control characters (0x00-0x1F + DEL 0x7F): newlines/tabs would break
 *     the tab-separated `list` table and the single-line `show` header
 *   - bounded length (a label, not a document)
 *
 * Out-of-policy titles fail at the input boundary with `bad_flag` (exit 2),
 * mirroring the channel-name validator.
 */
const MAX_TITLE_CHARS = 500;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

export function validateTitle(title: string): void {
  if (title.length === 0) {
    throw new BadFlagError("title must not be empty");
  }
  if (CONTROL_CHAR_RE.test(title)) {
    throw new BadFlagError(
      "title must not contain control characters (newline, tab, etc.) — it is a single-line label",
    );
  }
  if (title.length > MAX_TITLE_CHARS) {
    throw new BadFlagError(
      `title ${title.length} chars exceeds ${MAX_TITLE_CHARS} — titles are labels; put detail in the body`,
    );
  }
}
