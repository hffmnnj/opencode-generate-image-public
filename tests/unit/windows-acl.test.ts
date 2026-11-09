import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Pointer } from "bun:ffi";
import { ProjectFiles } from "../../src/files.ts";
import { createTestTempDir } from "../temp-dir.ts";

const windowsX64 = test.skipIf(process.platform !== "win32" || process.arch !== "x64");
const signal = () => new AbortController().signal;
const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");
const OWNER_RIGHTS_SID = Buffer.from([1, 1, 0, 0, 0, 0, 0, 3, 4, 0, 0, 0]);
const FILE_ALL_ACCESS = 0x001f01ff;
const SE_DACL_PROTECTED = 0x1000;
const fromAddress = (value: number): Pointer => value as Pointer;

windowsX64("created output directories and files have protected owner-only DACLs", async () => {
  const { dlopen, FFIType, ptr, toBuffer } = await import("bun:ffi");
  const security = dlopen("advapi32.dll", {
    GetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    GetAclInformation: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    GetAce: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetSecurityDescriptorControl: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const kernel = dlopen("kernel32.dll", {
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  const root = await createTestTempDir("windows-acl");
  try {
    const files = await ProjectFiles.open(root);
    try {
      await files.save("nested/private.png", Buffer.from("fixture bytes"), signal());
    } finally {
      await files.close();
    }

    const assertOwnerOnlyDacl = (path: string, expectedAceFlags: number) => {
      const daclOutput = Buffer.alloc(8);
      const descriptorOutput = Buffer.alloc(8);
      const status = security.GetNamedSecurityInfoW(ptr(wide(path)), 1, 4, null, null, ptr(daclOutput), null, ptr(descriptorOutput));
      expect(status).toBe(0);
      const daclAddress = Number(daclOutput.readBigUInt64LE());
      const descriptorAddress = Number(descriptorOutput.readBigUInt64LE());
      if (!daclAddress || !descriptorAddress) throw new Error("Windows security query returned no DACL or descriptor");

      try {
        const control = Buffer.alloc(2);
        const revision = Buffer.alloc(4);
        expect(security.GetSecurityDescriptorControl(fromAddress(descriptorAddress), ptr(control), ptr(revision))).toBe(1);
        expect(control.readUInt16LE() & SE_DACL_PROTECTED).toBe(SE_DACL_PROTECTED);

        const aclInfo = Buffer.alloc(12);
        expect(security.GetAclInformation(fromAddress(daclAddress), ptr(aclInfo), aclInfo.length, 2)).toBe(1);
        expect(aclInfo.readUInt32LE()).toBe(1);

        const aceOutput = Buffer.alloc(8);
        expect(security.GetAce(fromAddress(daclAddress), 0, ptr(aceOutput))).toBe(1);
        const aceAddress = Number(aceOutput.readBigUInt64LE());
        if (!aceAddress) throw new Error("Windows ACL query returned no access-control entry");
        const ace = fromAddress(aceAddress);
        const headerAndMask = toBuffer(ace, 0, 8);
        expect(headerAndMask.readUInt8(0)).toBe(0); // ACCESS_ALLOWED_ACE_TYPE
        expect(headerAndMask.readUInt8(1)).toBe(expectedAceFlags);
        expect(headerAndMask.readUInt16LE(2)).toBe(20); // 8-byte header/mask + 12-byte SID
        expect(headerAndMask.readUInt32LE(4)).toBe(FILE_ALL_ACCESS);
        expect(toBuffer(ace, 8, OWNER_RIGHTS_SID.length)).toEqual(OWNER_RIGHTS_SID);
      } finally {
        kernel.LocalFree(fromAddress(descriptorAddress));
      }
    };

    assertOwnerOnlyDacl(join(root, "nested"), 0x03); // object + container inherit
    assertOwnerOnlyDacl(join(root, "nested", "private.png"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
