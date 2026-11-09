import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function createTestTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `opencode-generate-image-${prefix}-`));
}

export function isWithinOsTempDir(path: string): boolean {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  return relativePath === "" || (
    relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
  );
}
