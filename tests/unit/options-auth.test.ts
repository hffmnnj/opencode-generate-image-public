import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { resolveImageCredential } from "../../src/index.ts";
import { imageInputSchema, imageOptionsSchema } from "../../src/options.ts";

test("input defaults match the working CLI and allowed generation controls remain selectable", () => {
  expect(imageInputSchema.parse({ prompt: "  A red apple  " })).toEqual({
    prompt: "A red apple", model: "gpt-image-2.5-sunburst", quality: "auto", size: "1024x1024", referenceImages: [], action: "generate",
  });
  expect(imageInputSchema.parse({ prompt: "Edit a photograph", model: "gpt-image-2.5-flare", quality: "max", size: "3840x2160", action: "edit", referenceImages: ["refs/photo.webp"] })).toMatchObject({ quality: "max", action: "edit" });
});

test.each([
  { prompt: " " }, { prompt: "x".repeat(32_001) }, { model: "gpt-image-2" }, { quality: "ultra" },
  { size: "1025x1024" }, { size: "512x512" }, { size: "3840x3840" }, { size: "4096x2048" },
  { size: "3072x768" }, { size: "1008x640" }, { action: "edit" }, { action: "erase" },
  { referenceImages: Array(6).fill("ref.png") }, { referenceImages: ["refs/../private.png"] },
  { referenceImages: ["refs/.hidden.png"] }, { referenceImages: ["ref.svg"] }, { endpoint: "http://example.com" },
  { transparent: true }, { responsesModel: "gpt-6.1-sol" }, { outputPath: "https://example.com/out.png" },
])("rejects invalid or unsupported controls %j", override => {
  expect(imageInputSchema.safeParse({ prompt: "A red apple", ...override }).success).toBe(false);
});

test("plugin options keep Responses override optional and cannot change endpoint or OAuth behavior", () => {
  expect(imageOptionsSchema.parse({})).toEqual({ timeoutMs: 600_000 });
  expect(imageOptionsSchema.parse({ timeoutMs: 1000 })).toEqual({ timeoutMs: 1000 });
  expect(imageOptionsSchema.parse({ responsesModel: "gpt-6.1-sol-2026-10-14" })).toEqual({ timeoutMs: 600_000, responsesModel: "gpt-6.1-sol-2026-10-14" });
  for (const options of [{ endpoint: "http://127.0.0.1:1000/responses" }, { refresh: true }, { timeoutMs: 999 }, { timeoutMs: 900_001 }])
    expect(imageOptionsSchema.safeParse(options).success).toBe(false);
});

test.each(["", "gpt-", "gpt-6.1-sol#max", "openai/gpt-6.1-sol", "claude-sonnet", "gpt-6.1-sol/../../responses", "gpt-6.1-sol\n", "gpt-6.1-sol?token=x", "gpt-" + "x".repeat(200), 42, null])("rejects invalid responsesModel plugin option %j", responsesModel => {
  expect(imageOptionsSchema.safeParse({ responsesModel }).success).toBe(false);
});

// Narrow stub for the native credential boundary; exact-version host coverage follows separately.
const context = (resolve: () => Promise<unknown>, active = true, onActive?: (integrationID: string) => void): Pick<Plugin.Context, "integration"> => ({
  integration: { connection: { active: async (integrationID: string) => { onActive?.(integrationID); return active ? { type: "credential", credentialID: "synthetic" } : undefined; }, resolve } },
} as unknown as Pick<Plugin.Context, "integration">);

test("uses the platform's freshly resolved OAuth value on every invocation without caching", async () => {
  let resolves = 0;
  let actives = 0;
  const ctx = context(async () => ({ type: "oauth", access: `synthetic-${++resolves}`, refresh: "not-for-image-plugin", expires: Date.now() + 60_000, metadata: { accountID: "fixture-account" } }), true,
    integrationID => { actives++; expect(integrationID).toBe("openai"); });
  expect(await resolveImageCredential(ctx)).toEqual({ access: "synthetic-1", accountID: "fixture-account" });
  expect(await resolveImageCredential(ctx)).toEqual({ access: "synthetic-2", accountID: "fixture-account" });
  expect(resolves).toBe(2);
  expect(actives).toBe(2);
});

test.each([
  undefined, { type: "key", key: "synthetic-api-key" }, { type: "external", value: "synthetic" },
  { type: "oauth", access: "synthetic", expires: 1 },
  { type: "oauth", access: "synthetic", expires: Number.NaN },
  { type: "oauth", access: "synthetic", expires: Infinity },
  { type: "oauth", access: "", expires: Date.now() + 60_000 },
  { type: "oauth", access: "synthetic\r\nInjected:yes", expires: Date.now() + 60_000 },
  { type: "oauth", access: "synthetic", expires: Date.now() + 60_000, metadata: { accountID: "bad\r\nheader" } },
])("refuses unusable credentials without exposing them (%j)", async credential => {
  await expect(resolveImageCredential(context(async () => credential))).rejects.toThrow("ChatGPT OAuth");
});

test("sanitizes errors thrown by the native resolver and handles no active connection", async () => {
  const result = await resolveImageCredential(context(async () => { throw new Error("Bearer synthetic-secret refresh_token=synthetic-secret"); })).catch(error => (error as Error).message);
  expect(result).toContain("reconnect ChatGPT OAuth");
  expect(result).not.toMatch(/Bearer|synthetic-secret|refresh_token/);
  await expect(resolveImageCredential(context(async () => { throw new Error("must not resolve"); }, false))).rejects.toThrow("ChatGPT OAuth");
});
