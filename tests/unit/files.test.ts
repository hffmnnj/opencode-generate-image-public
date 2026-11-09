import { expect, test } from "bun:test";
import { link, lstat, mkdir, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { createTestTempDir } from "../temp-dir.ts";
import { ImageService } from "../../src/service.ts";
import { imageInputSchema } from "../../src/options.ts";
import { normalizeImage } from "../../src/images.ts";
import { CANCELLED } from "../../src/errors.ts";

const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 40, g: 70, b: 200, alpha: 0.5 } } }).png().toBuffer();
const root = () => createTestTempDir("unit");
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
const linkDirectory = (target: string, path: string) => symlink(target, path, directoryLinkType);
const signal = () => new AbortController().signal;
const input = (extra: Record<string, unknown> = {}) => imageInputSchema.parse({ prompt: "A blue tile", ...extra });

async function detectFileSymlinkCapability(): Promise<{ supported: boolean; errorCode?: string }> {
  if (process.platform !== "win32") return { supported: true };
  const directory = await root();
  const target = join(directory, "target.png");
  await writeFile(target, png);
  try {
    await symlink(target, join(directory, "link.png"), "file");
    return { supported: true };
  } catch (error) {
    const errorCode = error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (errorCode === "EPERM" || errorCode === "EACCES") return { supported: false, errorCode };
    throw error;
  }
}

const fileSymlinkCapability = await detectFileSymlinkCapability();
if (!fileSymlinkCapability.supported)
  console.info(`Skipping file-symlink-dependent tests: Windows denied a temp file symlink (${fileSymlinkCapability.errorCode}); junction and hardlink tests remain enabled.`);
const fileSymlinkTest = test.skipIf(!fileSymlinkCapability.supported);

test("saves a decoded PNG with real dimensions, alpha, exclusive mode and a file URI", async () => {
  const directory = await root();
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return png; } });
  const output = await service.generate(directory, input({ outputPath: "assets/new.png" }), signal());
  expect(output.path).toBe(join(directory, "assets/new.png"));
  expect(output.uri).toBe(pathToFileURL(join(directory, "assets", "new.png")).href);
  expect(output).toMatchObject({ mime: "image/png", width: 4, height: 3, transparent: true, model: "gpt-image-2.5-sunburst", requestedSize: "1024x1024" });
  expect(output.warning).toContain("backend returned 4x3");
  expect(output.bytes).toBe((await readFile(output.path)).length);
  expect((await sharp(await readFile(output.path)).metadata()).format).toBe("png");
  // Windows reports generic POSIX mode bits; its backend enforces this through an owner-only DACL.
  if (process.platform !== "win32") expect((await lstat(output.path)).mode & 0o777).toBe(0o600);
  expect(calls).toBe(1);
  await expect(service.generate(directory, input({ outputPath: "assets/new.png" }), signal())).rejects.toThrow("Output already exists");
  expect(await readFile(output.path)).toEqual(png);
  expect(calls).toBe(1);
});

test("default outputs are unique and do not overwrite earlier generations", async () => {
  const directory = await root();
  const service = new ImageService({ async generate() { return png; } });
  const first = await service.generate(directory, input({ size: "auto" }), signal());
  const second = await service.generate(directory, input({ size: "auto" }), signal());
  expect(first.path).not.toBe(second.path);
  expect(first.warning).toBeUndefined();
  expect(await readdir(join(directory, "generated-images"))).toHaveLength(2);
});

test.each(["/outside.png", "../outside.png", "assets/../outside.png", "assets/.private/../outside.png", "assets/./out.png", ".hidden/out.png", "assets//out.png", "assets\\out.png", "C:/out.png", "assets/out.png\0", "assets/out.jpg"])("rejects raw output path %s before generating", async outputPath => {
  const directory = await root();
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return png; } });
  const unchecked = { ...input(), outputPath };
  await expect(service.generate(directory, unchecked, signal())).rejects.toThrow("Invalid image input");
  expect(calls).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});

test("rejects symlink output parents and leaves the outside directory unchanged", async () => {
  const directory = await root();
  const outside = await root();
  await linkDirectory(outside, join(directory, "assets"));
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return png; } });
  await expect(service.generate(directory, input({ outputPath: "assets/new.png" }), signal())).rejects.toThrow(/symlink|reparse point|changed during file access/i);
  expect(calls).toBe(0);
  expect(await readdir(outside)).toEqual([]);
});

test("revalidates output parents after the network call rather than trusting preflight checks", async () => {
  const directory = await root();
  const outside = await root();
  const service = new ImageService({ async generate() { await linkDirectory(outside, join(directory, "assets")); return png; } });
  await expect(service.generate(directory, input({ outputPath: "assets/new.png" }), signal())).rejects.toThrow(/symlink|reparse point|changed during file access/i);
  expect(await readdir(outside)).toEqual([]);
});

test("rejects a symlink session directory and a session outside its project", async () => {
  const directory = await root();
  const outside = await root();
  await linkDirectory(outside, join(directory, "linked"));
  const service = new ImageService({ async generate() { throw new Error("must not generate"); } });
  await expect(service.generate(join(directory, "linked"), input(), signal())).rejects.toThrow(/symlink|reparse point/i);
  await expect(service.generate(outside, input(), signal(), directory)).rejects.toThrow("inside its project");
});

fileSymlinkTest("rejects final output symlinks, including dangling links, before sending a request", async () => {
  const directory = await root();
  await symlink(join(directory, "missing.png"), join(directory, "output.png"), "file");
  const service = new ImageService({ async generate() { throw new Error("must not generate"); } });
  await expect(service.generate(directory, input({ outputPath: "output.png" }), signal())).rejects.toThrow("Output already exists");
  expect((await lstat(join(directory, "output.png"))).isSymbolicLink()).toBe(true);
});

test("normalizes PNG/JPEG/WebP references and sends no other project file", async () => {
  const directory = await root();
  await mkdir(join(directory, "refs"));
  await writeFile(join(directory, "refs/a.png"), png);
  await writeFile(join(directory, "refs/b.jpg"), await sharp(png).jpeg().toBuffer());
  await writeFile(join(directory, "refs/c.webp"), await sharp(png).webp().toBuffer());
  await writeFile(join(directory, "private.txt"), "DO NOT SEND");
  let seen: readonly string[] = [];
  let action = "";
  const service = new ImageService({ async generate(options, references) { seen = references; action = options.action; return png; } });
  await service.generate(directory, input({ action: "edit", referenceImages: ["refs/a.png", "refs/b.jpg", "refs/c.webp"] }), signal());
  expect(action).toBe("edit");
  expect(seen).toHaveLength(3);
  for (const reference of seen) {
    expect(reference).toStartWith("data:image/png;base64,");
    expect(reference).not.toContain("DO NOT SEND");
    expect((await sharp(Buffer.from(reference.split(",")[1]!, "base64")).metadata()).format).toBe("png");
  }
});

fileSymlinkTest("rejects file-symlinked references", async () => {
  const directory = await root();
  const outside = await root();
  await writeFile(join(outside, "private.png"), png);
  await symlink(join(outside, "private.png"), join(directory, "symlink.png"), "file");
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return png; } });
  await expect(service.generate(directory, input({ referenceImages: ["symlink.png"] }), signal())).rejects.toThrow(/symlink|reparse point|non-hardlinked/i);
  expect(calls).toBe(0);
});

test("rejects hardlinked references", async () => {
  const directory = await root();
  const outside = await root();
  await writeFile(join(outside, "private.png"), png);
  await link(join(outside, "private.png"), join(directory, "hardlink.png"));
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return png; } });
  await expect(service.generate(directory, input({ referenceImages: ["hardlink.png"] }), signal())).rejects.toThrow("non-hardlinked");
  expect(calls).toBe(0);
});

test("rejects malformed references and provider images without writing output", async () => {
  const directory = await root();
  await writeFile(join(directory, "bad.png"), "not an image");
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return Buffer.from("Bearer sensitive-codec-data"); } });
  await expect(service.generate(directory, input({ referenceImages: ["bad.png"] }), signal())).rejects.toThrow("safely decoded");
  expect(calls).toBe(0);
  await expect(service.generate(directory, input({ outputPath: "output.png" }), signal())).rejects.toThrow("safely decoded");
  expect(await readdir(directory)).toEqual(["bad.png"]);
});

test("rejects oversized reference files before reading, decoding or generating", async () => {
  const directory = await root();
  const file = await open(join(directory, "large.png"), "wx", 0o600);
  try { await file.truncate(20 * 1024 * 1024 + 1); } finally { await file.close(); }
  let calls = 0;
  const service = new ImageService({ async generate() { calls++; return png; } });
  await expect(service.generate(directory, input({ referenceImages: ["large.png"] }), signal())).rejects.toThrow("at most 20 MiB");
  expect(calls).toBe(0);
});

test("rejects non-PNG provider output and decompression-sized images", async () => {
  const jpeg = await sharp(png).jpeg().toBuffer();
  await expect(normalizeImage(jpeg)).rejects.toThrow("single PNG image");
  // Small compressed input, >16 million pixels: tests decoding limits rather than a file-size proxy.
  const large = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: "white" } }).png().toBuffer();
  await expect(normalizeImage(large, true)).rejects.toThrow("safely decoded");
});

test("exclusive final write wins once when two generations target the same new file", async () => {
  const directory = await root();
  let calls = 0;
  const bothArrived = Promise.withResolvers<void>();
  const service = new ImageService({ async generate() {
    if (++calls === 2) bothArrived.resolve();
    await bothArrived.promise;
    return png;
  } });
  const outputs = await Promise.allSettled([
    service.generate(directory, input({ outputPath: "same.png" }), signal()),
    service.generate(directory, input({ outputPath: "same.png" }), signal()),
  ]);
  expect(outputs.filter(output => output.status === "fulfilled")).toHaveLength(1);
  expect(outputs.filter(output => output.status === "rejected")).toHaveLength(1);
  const rejected = outputs.find(output => output.status === "rejected");
  if (rejected?.status !== "rejected") throw new Error("Missing rejection");
  expect((rejected.reason as Error).message).toContain("never overwritten");
  expect(await readFile(join(directory, "same.png"))).toEqual(png);
});

test("cancellation after generation prevents decoding/saving", async () => {
  const directory = await root();
  const controller = new AbortController();
  const service = new ImageService({ async generate() { controller.abort(); return png; } });
  await expect(service.generate(directory, input(), controller.signal)).rejects.toThrow("cancelled or timed out");
  expect(await readdir(directory)).toEqual([]);
});

test.each([false, true])("pre-aborted normalization rejects valid image bytes (reference=%s)", async reference => {
  const controller = new AbortController();
  controller.abort();
  await expect(normalizeImage(png, reference, controller.signal)).rejects.toThrow(CANCELLED);
});

test("aborting during a native normalization await returns cancellation rather than an image", async () => {
  const controller = new AbortController();
  const pending = normalizeImage(png, false, controller.signal);
  // Native metadata runs asynchronously: cancel in this turn before it settles.
  controller.abort();
  await expect(pending).rejects.toThrow(CANCELLED);
});

test("pre-aborted service sends no request and creates no output", async () => {
  const directory = await root();
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const service = new ImageService({ async generate() { requests++; return png; } });
  await expect(service.generate(directory, input(), controller.signal)).rejects.toThrow(CANCELLED);
  expect(requests).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});
