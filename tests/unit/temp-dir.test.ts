import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createTestTempDir, isWithinOsTempDir } from "../temp-dir.ts";

test("fixture temp directories are unique and stay under the OS temporary directory", async () => {
  const roots = await Promise.all([createTestTempDir("isolated"), createTestTempDir("isolated")]);

  expect(new Set(roots).size).toBe(2);
  expect(roots.every(isWithinOsTempDir)).toBe(true);
  expect(isWithinOsTempDir(resolve(tmpdir(), "..", "outside"))).toBe(false);
});
