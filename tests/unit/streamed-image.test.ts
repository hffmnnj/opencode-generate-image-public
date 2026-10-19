import { expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import sharp from "sharp";
import { CodexImageBackend, decodeImageStream, ImageStreamDecoder } from "../../src/api.ts";
import { ImageError } from "../../src/errors.ts";
import { imageInputSchema, LIMITS } from "../../src/options.ts";
import { ImageService } from "../../src/service.ts";

const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 10, g: 40, b: 150, alpha: 0.5 } } }).png().toBuffer();
const item = { id: "private-image-id", type: "image_generation_call", status: "completed", result: png.toString("base64") };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = (value: unknown = item) => event({ type: "response.output_item.done", item: value });
const completed = (output: unknown[] = []) => event({ type: "response.completed", response: { status: "completed", output } });
const message = { type: "message", content: [{ type: "output_text", text: "PRIVATE_PROMPT Bearer secret" }] };
const observedStream = done() + done(message) + completed();
const input = imageInputSchema.parse({ prompt: "A blue tile", outputPath: "tile.png" });
const auth = { resolve: async () => ({ access: "synthetic-only", accountID: "fixture-account" }) };

function decodeFailure(stream: string): Error {
  try { decodeImageStream(stream); } catch (error) {
    expect(error).toBeInstanceOf(ImageError);
    return error as Error;
  }
  throw new Error("Expected stream rejection, not image bytes");
}

// Independent oracle: local image CLI:593–605 returns
// output_item.done image results without requiring them in final output.
// Coordinator's seventh native invocation confirms that exact response shape.
test("completed image and message done events plus empty completed output return the image", () => {
  expect(decodeImageStream(observedStream)).toEqual(png);
});

test("retained done image is not returned before whole-response completion", () => {
  const decoder = new ImageStreamDecoder();
  decoder.push(Buffer.from(done() + done(message)));
  expect(() => decoder.finish()).toThrow("Incomplete image response stream");
});

test("duplicate identical done events deduplicate to one image after whole completion", () => {
  expect(decodeImageStream(done() + done() + completed())).toEqual(png);
});

test("non-image final output is still scanned while retaining the streamed image", () => {
  expect(decodeImageStream(done() + completed([message, { type: "reasoning", summary: [] }]))).toEqual(png);
});

test.each([
  ["failed event", done() + event({ type: "response.failed", error: { message: "Bearer secret" } }), "failed or was refused"],
  ["incomplete event", done() + event({ type: "response.incomplete" }), "failed or was refused"],
  ["refusal delta", done() + event({ type: "response.refusal.delta", delta: "PRIVATE_PROMPT Bearer secret" }), "failed or was refused"],
  ["refusal done", done() + event({ type: "response.refusal.done", refusal: "PRIVATE_PROMPT" }), "failed or was refused"],
  ["refusal in done message", done() + done({ type: "message", content: [{ type: "refusal", refusal: "secret" }] }) + completed(), "was refused"],
  ["refusal in final output", done() + completed([{ type: "message", content: [{ type: "refusal", refusal: "secret" }] }]), "was refused"],
  ["malformed final item", done() + completed([null]), "Malformed image response item"],
  ["failed completed status", done() + event({ type: "response.completed", response: { status: "failed", output: [] } }), "did not complete correctly"],
  ["incomplete completed status", done() + event({ type: "response.completed", response: { status: "incomplete", output: [] } }), "did not complete correctly"],
  ["in-progress completed status", done() + event({ type: "response.completed", response: { status: "in_progress", output: [] } }), "did not complete correctly"],
  ["missing final output", done() + event({ type: "response.completed", response: { status: "completed" } }), "did not complete correctly"],
  ["non-array final output", done() + event({ type: "response.completed", response: { status: "completed", output: {} } }), "did not complete correctly"],
  ["missing completion", done() + done(message), "Incomplete image response stream"],
  ["DONE without completion", done() + "data: [DONE]\n\n", "ended before completion"],
  ["truncated completion", done() + completed().trimEnd(), "Incomplete image response stream"],
  ["partial image only", event({ type: "response.image_generation_call.partial_image", partial_image_b64: item.result }) + completed(), "exactly one completed image"],
  ["pending done image", done({ ...item, status: "in_progress" }) + completed(), "incomplete or oversized image result"],
  ["final image missing result", done() + completed([{ ...item, result: undefined }]), "incomplete or oversized image result"],
  ["final image pending", done() + completed([{ ...item, status: "in_progress" }]), "incomplete or oversized image result"],
  ["two unique done images", done() + done({ ...item, id: "private-second-id" }) + completed(), "exactly one completed image"],
  ["conflicting same image ID", done() + done({ ...item, result: "YWJj" }) + completed(), "Conflicting image results"],
  ["different final image ID", done() + completed([{ ...item, id: "private-second-id" }]), "exactly one completed image"],
  ["conflicting final result", done() + completed([{ ...item, result: "YWJj" }]), "Conflicting image results"],
  ["duplicate final images", done() + completed([item, item]), "exactly one completed image"],
  ["malformed retained encoding", done({ ...item, result: "a===" }) + completed(), "Invalid image encoding"],
  ["noncanonical retained encoding", done({ ...item, result: "AB==" }) + completed(), "Invalid or oversized image encoding"],
  ["error after completion", observedStream + event({ type: "error", message: "Bearer secret" }), "failed or was refused"],
  ["second completion", observedStream + completed(), "did not complete correctly"],
])("streamed image still rejects %s and does not echo provider data", (_, stream, diagnostic) => {
  const error = decodeFailure(stream);
  expect(error.message).toContain(diagnostic);
  expect(error.message).not.toMatch(/PRIVATE_PROMPT|Bearer|secret|private-image-id|private-second-id|YWJj/);
  expect(error.message).not.toContain(item.result);
});

test("retained image result still enforces the existing image-byte limit", () => {
  const error = decodeFailure(done({ ...item, result: "A".repeat(Math.ceil(LIMITS.imageBytes / 3) * 4 + 4) }) + completed());
  expect(error.message).toContain("incomplete or oversized image result");
});

test.each(["text/event-stream", "application/json", "text/plain", "application/x-private-secret", undefined])(
  "observed stream under %s saves the same normalized PNG with no retry", async mediaType => {
    const directory = await mkdtemp("/var/tmp/generate-image-streamed-");
    const response = new Response(observedStream, mediaType ? { headers: { "content-type": mediaType } } : undefined);
    if (!mediaType) response.headers.delete("content-type");
    const stub = spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      const result = await new ImageService(new CodexImageBackend(auth)).generate(directory, input, new AbortController().signal);
      expect(await readFile(result.path)).toEqual(png);
      expect(result).toMatchObject({ mime: "image/png", width: 3, height: 2, transparent: true, bytes: png.length });
      expect((await lstat(result.path)).mode & 0o777).toBe(0o600);
      expect(stub).toHaveBeenCalledTimes(1);
    } finally { stub.mockRestore(); }
  },
);

test.each([
  ["uncompleted stream", done(), "Incomplete image response stream"],
  ["canonical base64 which is not an image", done({ ...item, result: "YWJj" }) + completed(), "Image could not be safely decoded"],
  ["refusal after done image", done() + completed([{ type: "message", content: [{ type: "refusal", refusal: "secret" }] }]), "was refused"],
])("%s does not create an output file", async (_, stream, diagnostic) => {
  const directory = await mkdtemp("/var/tmp/generate-image-streamed-");
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  try {
    const error = await new ImageService(new CodexImageBackend(auth)).generate(directory, input, new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ImageError);
    expect(error.message).toContain(diagnostic);
    expect(await readdir(directory)).toEqual([]);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test("whole JSON without streamed results still requires one final completed image", async () => {
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    object: "response", id: "private-response-id", status: "completed", output: [],
  }));
  try {
    const error = await new CodexImageBackend(auth).generate(input, [], new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ImageError);
    expect(error.message).toContain("exactly one completed image");
    expect(error.message).toContain('"final_output":0,"final_image_generation_call":0');
    expect(error.message).not.toContain("private-response-id");
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});
