import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWithinOsTempDir } from "../temp-dir.ts";

// Deliberately do not import the image plugin. The native config loader must
// resolve the shipped folder, load its default entrypoint and complete setup.
const root = process.argv[2]!;
assert(isWithinOsTempDir(root), "Fixture root must be inside the OS temporary directory");
assert(process.env.HOME === join(root, "home"));
const directory = join(root, "workspace");
await mkdir(directory, { recursive: true });
const packageURL = new URL("../../", import.meta.url);
const { OpenCode } = await import("@opencode/sdk");
const host = await OpenCode.create({
  app: { name: "generate-image-folder-tests", version: "2.0.25" },
  database: { path: join(root, "host.sqlite") },
  config: {
    directory: join(root, "config"), project: false,
    content: JSON.stringify({ update: "disable", plugins: ["*", "-opencode.provider.*", packageURL.href] }),
  },
  models: { fetch: false, snapshot: false },
  fs: { filewatcher: false, fff: false },
});
try {
  // Inventory alone is passive; a normal location API initializes its registry.
  await host.integration.list({ location: { directory } });
  const plugins = await host.plugin.list({ location: { directory } });
  const image = plugins.data.filter(plugin => plugin.id === "hffmnnj.generate-image");
  assert.equal(image.length, 1, "Config must load exactly one shipped image plugin");
  assert.deepEqual(image[0]!.state, { status: "active" }, "Default plugin setup must complete");
  assert.deepEqual(image[0]!.source, { type: "local", path: fileURLToPath(new URL("index.ts", packageURL)) });
  assert.equal((await host.plugin.list({ location: { directory } })).data.filter(plugin => plugin.id === "hffmnnj.generate-image").length, 1);
} finally { await host.close(); }
console.log(JSON.stringify({ status: "generate-image-package-folder-verified", closed: true }));
