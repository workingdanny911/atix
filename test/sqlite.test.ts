import { test, expect, describe } from "bun:test";

import { isSqliteBusy } from "../src/lib/sqlite";

describe("isSqliteBusy", () => {
  test("matches the raw SQLITE_BUSY error code in the message", () => {
    expect(isSqliteBusy(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
  });

  test("matches the 'database is locked' phrasing", () => {
    expect(isSqliteBusy(new Error("database is locked"))).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isSqliteBusy(new Error("UNIQUE constraint failed"))).toBe(false);
  });

  test("does not match non-Error values", () => {
    expect(isSqliteBusy("SQLITE_BUSY")).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
    expect(isSqliteBusy(undefined)).toBe(false);
  });
});
