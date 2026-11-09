import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { checkSignal, ImageError } from "./errors.ts";
import { LIMITS, validRelativePath } from "./options.ts";
import type { WindowsProjectFiles } from "./windows-files.ts";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const code = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
const descriptorPath = (file: FileHandle): string => `/proc/self/fd/${file.fd}`;
const within = (root: string, path: string): boolean => {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
};

/** Linux descriptor-relative traversal. Every user path component is opened without following symlinks. */
export class ProjectFiles {
  private constructor(readonly root: string, private readonly directory: FileHandle) {}

  static async open(sessionDirectory: string, projectDirectory = sessionDirectory): Promise<ProjectFiles | WindowsProjectFiles> {
    if (process.platform === "win32") {
      const { WindowsProjectFiles } = await import("./windows-files.ts");
      return await WindowsProjectFiles.open(sessionDirectory, projectDirectory);
    }
    if (process.platform !== "linux") throw new ImageError("Safe image file access requires Linux /proc/self/fd support.");
    if (!isAbsolute(sessionDirectory) || !isAbsolute(projectDirectory) || !within(resolve(projectDirectory), resolve(sessionDirectory)))
      throw new ImageError("Session image directory must be inside its project.");
    const root = resolve(sessionDirectory);
    if (root === "/") throw new ImageError("Image generation requires a project/session directory, not the filesystem root.");
    let handle: FileHandle | undefined;
    try {
      // Reject symlinked root ancestors as well, rather than silently canonicalizing them.
      handle = await open("/", DIRECTORY_FLAGS);
      for (const segment of root.split("/").filter(Boolean)) {
        const next = await open(`${descriptorPath(handle)}/${segment}`, DIRECTORY_FLAGS);
        await handle.close();
        handle = next;
      }
      if (await realpath(descriptorPath(handle)) !== root) throw new ImageError("Project image directory changed during validation.");
      return new ProjectFiles(root, handle);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof ImageError) throw error;
      throw new ImageError("Project image directory is unavailable or contains a symlink.");
    }
  }

  async close(): Promise<void> { await this.directory.close(); }

  path(input: string): string {
    if (!validRelativePath(input) || input.split("/").length > 32)
      throw new ImageError("Image paths must be project-relative, without hidden, empty, traversal or symlink segments.");
    return resolve(this.root, input);
  }

  private async assertDirectory(handle: FileHandle, expected: string): Promise<void> {
    if (await realpath(descriptorPath(this.directory)) !== this.root || await realpath(descriptorPath(handle)) !== expected)
      throw new ImageError("Project image directory changed during file access.");
  }

  private async parent(input: string, create: boolean, signal: AbortSignal): Promise<{ handle: FileHandle; leaf: string; expected: string } | undefined> {
    this.path(input);
    const parts = input.split("/");
    const leaf = parts.pop()!;
    let expected = this.root;
    let handle = await open(descriptorPath(this.directory), DIRECTORY_FLAGS & ~constants.O_NOFOLLOW);
    try {
      for (const segment of parts) {
        checkSignal(signal);
        await this.assertDirectory(handle, expected);
        const path = `${descriptorPath(handle)}/${segment}`;
        let next: FileHandle;
        try { next = await open(path, DIRECTORY_FLAGS); }
        catch (error) {
          if (code(error) !== "ENOENT") throw error;
          if (!create) { await handle.close(); return undefined; }
          try { await mkdir(path, { mode: 0o700 }); }
          catch (error) { if (code(error) !== "EEXIST") throw error; }
          next = await open(path, DIRECTORY_FLAGS);
        }
        await handle.close();
        handle = next;
        expected = resolve(expected, segment);
      }
      await this.assertDirectory(handle, expected);
      return { handle, leaf, expected };
    } catch (error) {
      await handle.close().catch(() => {});
      if (error instanceof ImageError) throw error;
      throw new ImageError("Image parent directory is unavailable, not a directory, or contains a symlink.");
    }
  }

  async prepareOutput(input: string, signal: AbortSignal): Promise<string> {
    const path = this.path(input);
    if (!input.endsWith(".png")) throw new ImageError("Output must end in .png.");
    const parent = await this.parent(input, false, signal);
    if (!parent) return path;
    try {
      try { await lstat(`${descriptorPath(parent.handle)}/${parent.leaf}`); }
      catch (error) {
        if (code(error) === "ENOENT") return path;
        throw error;
      }
      throw new ImageError("Output already exists; choose a new image path. Existing files are never overwritten.");
    } finally { await parent.handle.close(); }
  }

  async readReference(input: string, signal: AbortSignal): Promise<Buffer> {
    if (!/\.(png|jpe?g|webp)$/i.test(input)) throw new ImageError("Reference must end in .png, .jpg, .jpeg or .webp.");
    const parent = await this.parent(input, false, signal);
    if (!parent) throw new ImageError("Reference image does not exist.");
    let file: FileHandle | undefined;
    try {
      checkSignal(signal);
      await this.assertDirectory(parent.handle, parent.expected);
      file = await open(`${descriptorPath(parent.handle)}/${parent.leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !stat.size || stat.size > LIMITS.referenceBytes)
        throw new ImageError("Reference must be a non-hardlinked regular image file of at most 20 MiB.");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        checkSignal(signal);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, LIMITS.referenceBytes + 1 - total));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > LIMITS.referenceBytes) throw new ImageError("Reference exceeds the 20 MiB limit.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      await this.assertDirectory(parent.handle, parent.expected);
      checkSignal(signal);
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageError("Reference image is unavailable or is a symlink; no image request was sent.");
    } finally { await file?.close(); await parent.handle.close(); }
  }

  async save(input: string, bytes: Buffer, signal: AbortSignal): Promise<void> {
    if (!input.endsWith(".png") || !bytes.length || bytes.length > LIMITS.imageBytes)
      throw new ImageError("Output must be a bounded PNG image.");
    checkSignal(signal);
    const parent = await this.parent(input, true, signal);
    if (!parent) throw new ImageError("Image output directory is unavailable.");
    let file: FileHandle | undefined;
    const path = `${descriptorPath(parent.handle)}/${parent.leaf}`;
    try {
      await this.assertDirectory(parent.handle, parent.expected);
      checkSignal(signal);
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(bytes, { signal });
      await file.sync();
      await this.assertDirectory(parent.handle, parent.expected);
      checkSignal(signal);
    } catch (error) {
      if (signal.aborted) checkSignal(signal);
      if (error instanceof ImageError) throw error;
      throw new ImageError(code(error) === "EEXIST" ? "Output already exists; existing files are never overwritten."
        : "PNG output could not be safely saved; an incomplete new file may remain. No automatic retry was attempted.");
    } finally {
      // No pathname cleanup: unlink-after-stat could delete another process's replacement.
      await file?.close();
      await parent.handle.close();
    }
  }
}
