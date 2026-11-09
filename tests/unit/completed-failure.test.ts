import { expect, spyOn, test } from "bun:test";
import { readdir } from "node:fs/promises";
import sharp from "sharp";
import { createTestTempDir } from "../temp-dir.ts";
import { CodexImageBackend, decodeImageStream, ImageStreamDecoder } from "../../src/api.ts";
import { ImageError } from "../../src/errors.ts";
import { imageInputSchema } from "../../src/options.ts";
import { ImageService } from "../../src/service.ts";

const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 60, b: 180, alpha: 1 } } }).png().toBuffer();
const item = { id: "PRIVATE_IMAGE_ID", type: "image_generation_call", status: "completed", result: png.toString("base64") };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = event({ type: "response.output_item.done", item });
const completed = (output: unknown[], fields: Record<string, unknown>) => event({
  type: "response.completed", response: { status: "completed", output, ...fields },
});
const input = imageInputSchema.parse({ prompt: "A blue tile", outputPath: "tile.png" });
const auth = { resolve: async () => ({ access: "SYNTHETIC_ACCESS_SECRET", accountID: "fixture-account" }) };
const diagnostic = "Image response did not complete correctly; no image was saved.";
const failures = [
  ["error", { code: "unsupported_tool", message: "Bearer PROVIDER_SECRET", metadata: { prompt: "PRIVATE_PROMPT" } }],
  ["incomplete_details", { reason: "max_output_tokens", metadata: { prompt: "PRIVATE_PROMPT", token: "PROVIDER_SECRET" } }],
] as const;

for (const [field, value] of failures) {
  for (const [shape, output] of [["retained-only", []], ["final image", [item]]] as const) {
    test.each(["backend", "service"])(`%s rejects ${shape} PNG with completed ${field} without saving or exposing provider data`, async boundary => {
      const directory = await createTestTempDir("completed-failure");
      const body = done + completed([...output], { [field]: value, metadata: "PRIVATE_RESPONSE_METADATA" });
      const stub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      try {
        const backend = new CodexImageBackend(auth);
        const signal = new AbortController().signal;
        const error = await (boundary === "service"
          ? new ImageService(backend).generate(directory, input, signal)
          : backend.generate(input, [], signal)).catch(error => error);
        expect(error).toBeInstanceOf(ImageError);
        expect(error.message).toBe(diagnostic);
        expect(error.message).not.toMatch(/unsupported_tool|max_output_tokens|Bearer|PROVIDER_SECRET|PRIVATE_|SYNTHETIC_ACCESS_SECRET/);
        expect(error.message).not.toContain(item.result);
        expect(await readdir(directory)).toEqual([]);
        expect(stub).toHaveBeenCalledTimes(1);
      } finally { stub.mockRestore(); }
    });
  }

  test(`shared completed-response entry rejects non-null ${field} before returning final PNG bytes`, () => {
    expect(() => ImageStreamDecoder.fromCompletedResponse({ status: "completed", output: [item], [field]: value })).toThrow(diagnostic);
  });
}

for (const field of ["error", "incomplete_details"]) {
  test.each([
    ["string", "PROVIDER_SECRET"], ["false", false], ["zero", 0], ["array", []], ["object", {}],
  ])(`malformed non-null completed ${field} (%s) fails closed for retained and final images`, (_, value) => {
    for (const output of [[], [item]]) {
      expect(() => decodeImageStream(done + completed(output, { [field]: value }))).toThrow(diagnostic);
    }
  });
}

test.each([
  ["omitted failure fields", {}],
  ["null error", { error: null }],
  ["null incomplete details", { incomplete_details: null }],
  ["both failure fields null", { error: null, incomplete_details: null }],
])("%s still returns exact retained and final PNG bytes after whole completion", (_, fields) => {
  for (const output of [[], [item]]) {
    expect(decodeImageStream(done + completed(output, fields))).toEqual(png);
  }
  expect(ImageStreamDecoder.fromCompletedResponse({ status: "completed", output: [item], ...fields })).toEqual(png);
});
