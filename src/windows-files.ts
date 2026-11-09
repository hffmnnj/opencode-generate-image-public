import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { isAbsolute, parse, resolve, sep } from "node:path";
import { checkSignal, ImageError } from "./errors.ts";
import { LIMITS, validRelativePath } from "./options.ts";

// Windows x64 NT ABI. Handle-relative opens and denying FILE_SHARE_DELETE
// constrain rename/delete, but do not prevent in-place reparse-point mutation.
const kernel = dlopen("kernel32.dll", {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetFileType: { args: [FFIType.ptr], returns: FFIType.u32 },
  GetFileInformationByHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GetFileInformationByHandleEx: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  ReadFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  WriteFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  FlushFileBuffers: { args: [FFIType.ptr], returns: FFIType.i32 },
  LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
  GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
  GetVolumeInformationW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;
const nt = dlopen("ntdll.dll", {
  NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
}).symbols;
const security = dlopen("advapi32.dll", {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;

const p = (value: number): Pointer => value as Pointer;
const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");
const putPointer = (buffer: Buffer, offset: number, value: number | null): void => { buffer.writeBigUInt64LE(BigInt(value ?? 0), offset); };
const handleAt = (buffer: Buffer): Pointer => p(Number(buffer.readBigUInt64LE()));
const close = (handle: Pointer): void => { kernel.CloseHandle(handle); };
const MISSING = 0xc0000034;
const COLLISION = 0xc0000035;
const SHARE_READ_WRITE = 3; // Deliberately omit FILE_SHARE_DELETE.
const SYNCHRONIZE = 0x100000;
const READ_ATTRIBUTES = 0x80;
// Attribute-only opens do not participate in Windows sharing checks. Request
// FILE_LIST_DIRECTORY so denying FILE_SHARE_DELETE participates in sharing checks.
const DIRECTORY_ACCESS = READ_ATTRIBUTES | 1;
const OPTIONS = 0x00200000 | 0x20; // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT

class NativeError extends Error {
  constructor(readonly status: number) { super(`NTSTATUS 0x${status.toString(16)}`); }
}

function secureDescriptor(directory: boolean): Pointer {
  // A protected DACL grants only the new object's owner access. Directories
  // propagate this policy to any children created without an explicit DACL.
  const sddl = wide(directory ? "D:P(A;OICI;FA;;;OW)" : "D:P(A;;FA;;;OW)");
  const result = Buffer.alloc(8);
  if (!security.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddl), 1, ptr(result), null))
    throw new Error("Cannot create private security descriptor");
  return handleAt(result);
}

function openRelative(parent: Pointer, name: string, access: number, disposition: number, directory: boolean, create: boolean, share = SHARE_READ_WRITE): Pointer {
  const text = wide(name);
  const unicode = Buffer.alloc(16);
  unicode.writeUInt16LE(text.length - 2, 0);
  unicode.writeUInt16LE(text.length, 2);
  putPointer(unicode, 8, ptr(text));
  const attributes = Buffer.alloc(48);
  attributes.writeUInt32LE(48, 0);
  putPointer(attributes, 8, parent);
  putPointer(attributes, 16, ptr(unicode));
  // Respect per-directory NTFS case sensitivity. Otherwise two case-distinct
  // siblings can resolve to the wrong object even after an identity check.
  const caseInfo = Buffer.alloc(4);
  if (!kernel.GetFileInformationByHandleEx(parent, 23, ptr(caseInfo), caseInfo.length))
    throw new Error("Cannot determine directory case sensitivity");
  attributes.writeUInt32LE(caseInfo.readUInt32LE(0) & 1 ? 0 : 0x40, 24); // OBJ_CASE_INSENSITIVE
  const descriptor = create ? secureDescriptor(directory) : null;
  if (descriptor) putPointer(attributes, 32, descriptor);
  const output = Buffer.alloc(8);
  const io = Buffer.alloc(16);
  try {
    const status = nt.NtCreateFile(ptr(output), access | SYNCHRONIZE, ptr(attributes), ptr(io), null, 0, share,
      disposition, OPTIONS | (directory ? 1 : 0x40), null, 0);
    if (status !== 0) throw new NativeError(status);
    return handleAt(output);
  } finally { if (descriptor) kernel.LocalFree(descriptor); }
}

function info(handle: Pointer): { attributes: number; links: number; size: number; identity: string } {
  const data = Buffer.alloc(52);
  if (kernel.GetFileType(handle) !== 1 || !kernel.GetFileInformationByHandle(handle, ptr(data))) throw new Error("Not a disk file");
  return { attributes: data.readUInt32LE(0), size: data.readUInt32LE(32) * 0x100000000 + data.readUInt32LE(36), links: data.readUInt32LE(40),
    identity: `${data.readUInt32LE(28)}:${data.readUInt32LE(44)}:${data.readUInt32LE(48)}` };
}

function checkDirectory(handle: Pointer): string {
  const { attributes, identity } = info(handle);
  if ((attributes & 0x400) || !(attributes & 0x10)) throw new Error("Reparse point or non-directory");
  return identity;
}

const safeSegment = (segment: string): boolean => !/[<>"|?*]/.test(segment) && !/[. ]$/.test(segment)
  && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment);

function openDirectoryChain(root: string, anchor?: Pointer): Pointer[] {
  const volume = parse(root).root;
  if (!/^[a-z]:\\$/i.test(volume))
    throw new ImageError("Image generation requires a local drive project/session directory.");
  const drive = wide(volume);
  // NTFS supplies the reparse-point and hardlink metadata this backend
  // relies on. Do not assume a network or other filesystem has those semantics.
  const filesystem = Buffer.alloc(512);
  if (![2, 3].includes(kernel.GetDriveTypeW(ptr(drive)))
    || !kernel.GetVolumeInformationW(ptr(drive), null, 0, null, null, null, ptr(filesystem), 256)
    || filesystem.toString("utf16le").split("\0", 1)[0]?.toUpperCase() !== "NTFS")
    throw new ImageError("Safe Windows image file access requires a local NTFS volume.");
  const roots: Pointer[] = [];
  try {
    const first = anchor ?? kernel.CreateFileW(ptr(drive), DIRECTORY_ACCESS | SYNCHRONIZE, SHARE_READ_WRITE, null, 3, 0x02200000, null);
    if (!first || BigInt(first) === 0xffffffffffffffffn) throw new Error("Cannot open drive");
    roots.push(first);
    checkDirectory(first);
    for (const segment of root.slice(volume.length).split(sep).filter(Boolean)) {
      if (!safeSegment(segment)) throw new Error("Unsafe Windows path");
      for (const handle of roots) checkDirectory(handle);
      const next = openRelative(roots[roots.length - 1]!, segment, DIRECTORY_ACCESS, 1, true, false);
      roots.push(next);
      checkDirectory(next);
    }
    for (const handle of roots) checkDirectory(handle);
    return roots;
  } catch {
    for (const handle of roots.reverse()) if (handle !== anchor) close(handle);
    throw new ImageError("Project image directory is unavailable or contains a reparse point.");
  }
}

export class WindowsProjectFiles {
  private constructor(readonly root: string, private readonly roots: Pointer[]) {}

  static async open(sessionDirectory: string, projectDirectory = sessionDirectory): Promise<WindowsProjectFiles> {
    if (process.arch !== "x64") throw new ImageError("Safe Windows image file access requires a 64-bit x64 runtime.");
    if (!isAbsolute(sessionDirectory) || !isAbsolute(projectDirectory))
      throw new ImageError("Session image directory must be inside its project.");
    const root = resolve(sessionDirectory);
    const project = resolve(projectDirectory);
    if (root === parse(root).root)
      throw new ImageError("Image generation requires a project/session directory, not the filesystem root.");
    // Both chains start from the *same opened volume handle*, not two handles
    // whose volume serials could collide or whose drive mappings could change.
    if (parse(root).root.toUpperCase() !== parse(project).root.toUpperCase())
      throw new ImageError("Session image directory must be inside its project.");
    const projectHandles = openDirectoryChain(project);
    let roots: Pointer[] | undefined;
    let transferred = false;
    try {
      roots = openDirectoryChain(root, projectHandles[0]);
      const projectIdentity = checkDirectory(projectHandles.at(-1)!);
      const sessionIdentities = roots.map(checkDirectory);
      for (const handle of projectHandles) checkDirectory(handle);
      if (!sessionIdentities.includes(projectIdentity))
        throw new ImageError("Session image directory must be inside its project.");
      const result = new WindowsProjectFiles(root, roots);
      roots = undefined;
      transferred = true;
      return result;
    } finally {
      if (roots) for (const handle of roots.slice(1).reverse()) close(handle);
      for (const handle of projectHandles.slice(transferred ? 1 : 0).reverse()) close(handle);
    }
  }

  async close(): Promise<void> { for (const handle of this.roots.reverse()) close(handle); this.roots.length = 0; }

  path(input: string): string {
    if (!validRelativePath(input) || input.split("/").length > 32 || !input.split("/").every(safeSegment))
      throw new ImageError("Image paths must be project-relative, without hidden, empty, traversal or reparse point segments.");
    return resolve(this.root, input);
  }

  private assertDirectories(handles: Pointer[] = []): void {
    try { for (const handle of [...this.roots, ...handles]) checkDirectory(handle); }
    catch { throw new ImageError("Project image directory changed during file access."); }
  }

  private parent(input: string, create: boolean, signal: AbortSignal): { handles: Pointer[]; leaf: string } | undefined {
    this.path(input);
    const parts = input.split("/");
    const leaf = parts.pop()!;
    const handles: Pointer[] = [];
    try {
      this.assertDirectories();
      for (const segment of parts) {
        checkSignal(signal);
        this.assertDirectories(handles);
        const parent = handles.at(-1) ?? this.roots.at(-1)!;
        let next: Pointer;
        try { next = openRelative(parent, segment, DIRECTORY_ACCESS, 1, true, false); }
        catch (error) {
          if (!(error instanceof NativeError) || error.status !== MISSING) throw error;
          this.assertDirectories(handles);
          if (!create) { for (const h of handles.reverse()) close(h); return undefined; }
          // FILE_OPEN_IF avoids a check/create race; always validate the opened object.
          next = openRelative(parent, segment, DIRECTORY_ACCESS, 3, true, true);
        }
        handles.push(next);
        this.assertDirectories(handles);
      }
      this.assertDirectories(handles);
      return { handles, leaf };
    } catch (error) {
      for (const h of handles.reverse()) close(h);
      if (error instanceof ImageError) throw error;
      throw new ImageError("Image parent directory is unavailable, not a directory, or contains a reparse point.");
    }
  }

  async prepareOutput(input: string, signal: AbortSignal): Promise<string> {
    const path = this.path(input);
    if (!input.endsWith(".png")) throw new ImageError("Output must end in .png.");
    const parent = this.parent(input, false, signal);
    if (!parent) return path;
    try {
      this.assertDirectories(parent.handles);
      let file: Pointer;
      try { file = openRelative(parent.handles.at(-1) ?? this.roots.at(-1)!, parent.leaf, READ_ATTRIBUTES, 1, false, false); }
      catch (error) { if (error instanceof NativeError && error.status === MISSING) { this.assertDirectories(parent.handles); return path; } throw error; }
      close(file);
      this.assertDirectories(parent.handles);
      throw new ImageError("Output already exists; choose a new image path. Existing files are never overwritten.");
    } finally { for (const h of parent.handles.reverse()) close(h); }
  }

  async readReference(input: string, signal: AbortSignal): Promise<Buffer> {
    if (!/\.(png|jpe?g|webp)$/i.test(input)) throw new ImageError("Reference must end in .png, .jpg, .jpeg or .webp.");
    const parent = this.parent(input, false, signal);
    if (!parent) throw new ImageError("Reference image does not exist.");
    let file: Pointer | undefined;
    try {
      checkSignal(signal);
      this.assertDirectories(parent.handles);
      file = openRelative(parent.handles.at(-1) ?? this.roots.at(-1)!, parent.leaf, 1 | READ_ATTRIBUTES, 1, false, false, 1);
      this.assertDirectories(parent.handles);
      const stat = info(file);
      if ((stat.attributes & (0x400 | 0x10)) || stat.links !== 1 || !stat.size || stat.size > LIMITS.referenceBytes)
        throw new ImageError("Reference must be a non-hardlinked regular image file of at most 20 MiB.");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        checkSignal(signal);
        this.assertDirectories(parent.handles);
        const chunk = Buffer.allocUnsafe(Math.min(65536, LIMITS.referenceBytes + 1 - total));
        const count = Buffer.alloc(4);
        if (!kernel.ReadFile(file, ptr(chunk), chunk.length, ptr(count), null)) throw new Error("ReadFile failed");
        this.assertDirectories(parent.handles);
        const bytes = count.readUInt32LE(0);
        if (!bytes) break;
        total += bytes;
        if (total > LIMITS.referenceBytes) throw new ImageError("Reference exceeds the 20 MiB limit.");
        chunks.push(chunk.subarray(0, bytes));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const final = info(file);
      if (final.links !== 1 || (final.attributes & (0x400 | 0x10))) throw new ImageError("Reference must not be hardlinked or a reparse point.");
      this.assertDirectories(parent.handles);
      checkSignal(signal);
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageError("Reference image is unavailable or is a reparse point; no image request was sent.");
    } finally { if (file) close(file); for (const h of parent.handles.reverse()) close(h); }
  }

  async save(input: string, bytes: Buffer, signal: AbortSignal): Promise<void> {
    if (!input.endsWith(".png") || !bytes.length || bytes.length > LIMITS.imageBytes) throw new ImageError("Output must be a bounded PNG image.");
    checkSignal(signal);
    const parent = this.parent(input, true, signal);
    if (!parent) throw new ImageError("Image output directory is unavailable.");
    let file: Pointer | undefined;
    try {
      checkSignal(signal);
      this.assertDirectories(parent.handles);
      file = openRelative(parent.handles.at(-1) ?? this.roots.at(-1)!, parent.leaf, 2 | READ_ATTRIBUTES, 2, false, true, 0);
      this.assertDirectories(parent.handles);
      for (let offset = 0; offset < bytes.length;) {
        checkSignal(signal);
        this.assertDirectories(parent.handles);
        const chunk = bytes.subarray(offset, Math.min(offset + 65536, bytes.length));
        const count = Buffer.alloc(4);
        if (!kernel.WriteFile(file, ptr(chunk), chunk.length, ptr(count), null) || !count.readUInt32LE(0)) throw new Error("WriteFile failed");
        this.assertDirectories(parent.handles);
        offset += count.readUInt32LE(0);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (!kernel.FlushFileBuffers(file)) throw new Error("FlushFileBuffers failed");
      this.assertDirectories(parent.handles);
      checkSignal(signal);
    } catch (error) {
      if (signal.aborted) checkSignal(signal);
      if (error instanceof ImageError) throw error;
      throw new ImageError(error instanceof NativeError && error.status === COLLISION ? "Output already exists; existing files are never overwritten."
        : "PNG output could not be safely saved; an incomplete new file may remain. No automatic retry was attempted.");
    } finally { if (file) close(file); for (const h of parent.handles.reverse()) close(h); }
  }
}
