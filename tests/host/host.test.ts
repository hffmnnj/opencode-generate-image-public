import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir } from "../temp-dir.ts";

test.each(["injected", "session", "override", "fallback"])(
  "isolated 2.0.25 host uses %s backend/model selection, native OAuth, and permission denial",
  async mode => {
    const root = await createTestTempDir("host");
    try {
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./generate-image-fixture.ts", import.meta.url)), root, mode], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: join(root, "home"),
          USERPROFILE: join(root, "home"),
          TMPDIR: root,
          TEMP: root,
          TMP: root,
          XDG_CONFIG_HOME: join(root, "config-home"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
          OPENCODE_CONFIG_DIR: join(root, "config"),
          OPENCODE_DB: join(root, "host.sqlite"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      await writeFile(join(root, "result.json"), JSON.stringify({ exit, stdout, stderr }, null, 2));
      console.info(`Retained generate-image host fixture: ${root}`);
      expect({ exit, stderr, stdout }).toMatchObject({ exit: 0 });
      expect(stdout).toContain('"status":"generate-image-native-verified"');
      expect(stdout).toContain('"calls":2');
      expect(stdout).toContain('"responseShapes":["final-output","streamed-done-empty-final"]');
      expect(stdout).toContain(mode === "session" || mode === "override" ? '"refreshed":0' : '"refreshed":1');
      expect(stdout).toContain(`"mode":"${mode}"`);
      expect(stdout).toContain(mode === "session" ? '"seenModels":["gpt-6.1-sol","gpt-6.1-sol-2026-10-14"]'
        : mode === "override" ? '"seenModels":["gpt-6.1-sol-override","gpt-6.1-sol-override"]'
        : '"seenModels":["gpt-6.1-sol","gpt-6.1-sol"]');
      // Settled native host cancellation runs only in the injected variant
      // to avoid duplicating every default-model test. Real behavioral
      // evidence, not a name tautology: exactly one backend POST, observed
      // abort, and the selected outer model.
      if (mode === "injected") {
        expect(stdout).toContain('"cancelPosts":1');
        expect(stdout).toContain('"cancelAborted":true');
        expect(stdout).toContain('"cancelSeenModel":"gpt-6.1-sol"');
      } else {
        expect(stdout).toContain('"cancelPosts":0');
        expect(stdout).toContain('"cancelAborted":false');
      }
    } finally {
      /* Retain isolated evidence and source; never recursively delete fixtures. */
    }
  },
  150_000,
);

test("isolated native config loads and closes the actual file:// package folder", async () => {
  const root = await createTestTempDir("host-folder");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./package-folder-fixture.ts", import.meta.url)), root], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), USERPROFILE: join(root, "home"),
      TMPDIR: root, TEMP: root, TMP: root,
      XDG_CONFIG_HOME: join(root, "config-home"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "host.sqlite"),
    },
    stdout: "pipe", stderr: "pipe", timeout: 120_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await writeFile(join(root, "result.json"), JSON.stringify({ exit, stdout, stderr }, null, 2));
  console.info(`Retained generate-image folder host fixture: ${root}`);
  expect({ exit, stderr, stdout }).toMatchObject({ exit: 0 });
  expect(stdout).toContain('"status":"generate-image-package-folder-verified"');
  expect(stdout).toContain('"closed":true');
}, 150_000);
