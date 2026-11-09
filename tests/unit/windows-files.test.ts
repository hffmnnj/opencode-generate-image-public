import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFiles } from "../../src/files.ts";
import { ImageService } from "../../src/service.ts";
import { imageInputSchema } from "../../src/options.ts";
import sharp from "sharp";
import { spawnSync } from "node:child_process";

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const signal = () => new AbortController().signal;

const supportsCaseSensitiveDirectories = async (): Promise<boolean> => {
  if (process.platform !== "win32" || process.arch !== "x64") return false;
  const base = await mkdtemp(join(tmpdir(), "image-case-probe-"));
  try { return spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", base, "enable"]).status === 0; }
  finally { await rm(base, { recursive: true, force: true }); }
};
const caseSensitive = await supportsCaseSensitiveDirectories();

windows("Windows native backend creates privately and exclusively and reads references", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-win-"));
  try {
    await mkdir(join(root, "refs"));
    await writeFile(join(root, "refs", "image.png"), "reference bytes");
    const files = await ProjectFiles.open(root);
    try {
      expect((await files.readReference("refs/image.png", signal())).toString()).toBe("reference bytes");
      expect(await files.prepareOutput("nested/output.png", signal())).toBe(join(root, "nested", "output.png"));
      await files.save("nested/output.png", Buffer.from("saved"), signal());
      expect((await readFile(join(root, "nested", "output.png"))).toString()).toBe("saved");
      await expect(files.prepareOutput("nested/output.png", signal())).rejects.toThrow("already exists");
      await expect(files.save("nested/output.png", Buffer.from("overwrite"), signal())).rejects.toThrow("never overwritten");
      expect((await readFile(join(root, "nested", "output.png"))).toString()).toBe("saved");
    } finally { await files.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

windows("rejects junctions, hardlinks, and Windows path aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-win-"));
  const outside = await mkdtemp(join(tmpdir(), "image-win-outside-"));
  try {
    await writeFile(join(outside, "private.png"), "private");
    await link(join(outside, "private.png"), join(root, "hard.png"));
    await symlink(outside, join(root, "junction"), "junction");
    const files = await ProjectFiles.open(root);
    try {
      await expect(files.readReference("hard.png", signal())).rejects.toThrow("non-hardlinked");
      await expect(files.readReference("junction/private.png", signal())).rejects.toThrow();
      await expect(files.save("junction/new.png", Buffer.from("x"), signal())).rejects.toThrow();
      for (const path of ["CON.png", "x /out.png", "foo./out.png", "a:b.png", "foo?/out.png"])
        expect(() => files.path(path)).toThrow();
      expect(await readdir(outside)).toEqual(["private.png"]);
    } finally { await files.close(); }
    await expect(ProjectFiles.open(join(root, "junction"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

windows("holds root and ancestors against rename until close", async () => {
  const base = await mkdtemp(join(tmpdir(), "image-win-"));
  const root = join(base, "project");
  await mkdir(root);
  try {
    const files = await ProjectFiles.open(root);
    try { await expect(rename(root, join(base, "moved"))).rejects.toThrow(); }
    finally { await files.close(); }
    await rename(root, join(base, "moved"));
  } finally { await rm(base, { recursive: true, force: true }); }
});

windows("mock generation saves a real PNG and rejects a junction installed during generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-win-"));
  const outside = await mkdtemp(join(tmpdir(), "image-win-outside-"));
  try {
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
    let calls = 0;
    const service = new ImageService({ async generate() { calls++; return png; } });
    const options = imageInputSchema.parse({ prompt: "tile", outputPath: "assets/output.png" });
    const output = await service.generate(root, options, signal());
    expect((await sharp(await readFile(output.path)).metadata()).format).toBe("png");
    await expect(service.generate(root, options, signal())).rejects.toThrow("already exists");
    expect(calls).toBe(1);

    const race = new ImageService({ async generate() { await symlink(outside, join(root, "race"), "junction"); return png; } });
    await expect(race.generate(root, imageInputSchema.parse({ prompt: "tile", outputPath: "race/output.png" }), signal())).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

windows("concurrent saves cannot overwrite and aborted saves do not create a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-win-"));
  try {
    const files = await ProjectFiles.open(root);
    try {
      const results = await Promise.allSettled([files.save("same.png", Buffer.alloc(131072, 1), signal()), files.save("same.png", Buffer.alloc(131072, 2), signal())]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      const bytes = await readFile(join(root, "same.png"));
      expect(bytes.every(byte => byte === 1) || bytes.every(byte => byte === 2)).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await expect(files.save("aborted.png", Buffer.from("x"), controller.signal)).rejects.toThrow();
      expect(await readdir(root)).toEqual(["same.png"]);
    } finally { await files.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

windows("holds an opened reference parent against replacement while reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-win-"));
  try {
    await mkdir(join(root, "refs"));
    await writeFile(join(root, "refs", "image.png"), Buffer.alloc(1024 * 1024, 42));
    const files = await ProjectFiles.open(root);
    try {
      const pending = files.readReference("refs/image.png", signal());
      await expect(rename(join(root, "refs"), join(root, "moved"))).rejects.toThrow();
      expect((await pending).length).toBe(1024 * 1024);
      await rename(join(root, "refs"), join(root, "moved"));
    } finally { await files.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(!caseSensitive)("rejects a case-distinct sibling as a project descendant", async () => {
  const base = await mkdtemp(join(tmpdir(), "image-case-"));
  try {
    const enabled = spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", base, "enable"]);
    expect(enabled.status).toBe(0);
    const project = join(base, "Project");
    const sibling = join(base, "project");
    await mkdir(project);
    await mkdir(sibling);
    await mkdir(join(project, "session"));
    await mkdir(join(sibling, "session"));
    await expect(ProjectFiles.open(join(sibling, "session"), project).then(async files => { await files.close(); return files; }))
      .rejects.toThrow("inside its project");
    const valid = await ProjectFiles.open(join(project, "session"), project);
    await valid.close();
  } finally { await rm(base, { recursive: true, force: true }); }
});

test.skipIf(!caseSensitive)("keeps case-distinct reference and output leaves separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-case-leaves-"));
  try {
    const enabled = spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", root, "enable"]);
    expect(enabled.status).toBe(0);
    await writeFile(join(root, "Reference.png"), "reference bytes");
    const files = await ProjectFiles.open(root);
    try {
      expect((await files.readReference("Reference.png", signal())).toString()).toBe("reference bytes");
      expect(await files.prepareOutput("reference.png", signal())).toBe(join(root, "reference.png"));
      await files.save("reference.png", Buffer.from("output bytes"), signal());
      expect((await readFile(join(root, "Reference.png"))).toString()).toBe("reference bytes");
      expect((await readFile(join(root, "reference.png"))).toString()).toBe("output bytes");
      expect((await readdir(root)).sort()).toEqual(["Reference.png", "reference.png"].sort());
    } finally { await files.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

windows("detects a held directory converted in place into a junction", async () => {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const api = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
    DeviceIoControl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const base = await mkdtemp(join(tmpdir(), "image-reparse-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  const files = await ProjectFiles.open(root);
  const name = Buffer.from(`${root}\0`, "utf16le");
  const handle = api.CreateFileW(ptr(name), 0x40000000, 7, null, 3, 0x02200000, null);
  expect(handle).not.toBeNull();
  if (!handle || BigInt(handle) === 0xffffffffffffffffn) throw new Error("Cannot open fixture for reparse mutation");
  const substitute = Buffer.from(`\\??\\${outside}`, "utf16le");
  const print = Buffer.from(outside, "utf16le");
  const data = Buffer.alloc(16 + substitute.length + 2 + print.length + 2);
  data.writeUInt32LE(0xa0000003, 0); // IO_REPARSE_TAG_MOUNT_POINT
  data.writeUInt16LE(data.length - 8, 4);
  data.writeUInt16LE(substitute.length, 10);
  data.writeUInt16LE(substitute.length + 2, 12);
  data.writeUInt16LE(print.length, 14);
  substitute.copy(data, 16);
  print.copy(data, 16 + substitute.length + 2);
  const returned = Buffer.alloc(4);
  let installed = false;
  try {
    expect(api.DeviceIoControl(handle, 0x000900a4, ptr(data), data.length, null, 0, ptr(returned), null)).toBe(1);
    installed = true;
    await expect(files.save("output.png", Buffer.from("x"), signal())).rejects.toThrow("changed during file access");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await files.close();
    if (installed) {
      const deletion = Buffer.alloc(8);
      deletion.writeUInt32LE(0xa0000003, 0);
      expect(api.DeviceIoControl(handle, 0x000900ac, ptr(deletion), deletion.length, null, 0, ptr(returned), null)).toBe(1);
    }
    api.CloseHandle(handle);
    await rm(base, { recursive: true, force: true });
  }
});
