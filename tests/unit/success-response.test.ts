import { expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import sharp from "sharp";
import { CodexImageBackend } from "../../src/api.ts";
import { CANCELLED, ImageError } from "../../src/errors.ts";
import { imageInputSchema, LIMITS } from "../../src/options.ts";
import { ImageService } from "../../src/service.ts";

const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 10, g: 40, b: 150, alpha: 0.5 } } }).png().toBuffer();
const item = { id: "image-1", type: "image_generation_call", status: "completed", result: png.toString("base64") };
const response = { id: "resp-fixture", object: "response", created_at: 1, status: "completed", error: null, incomplete_details: null, output: [item] };
const sse = (value: unknown = response) => `data: ${JSON.stringify({ type: "response.completed", response: value })}\n\ndata: [DONE]\n\n`;
const input = imageInputSchema.parse({ prompt: "A blue tile", outputPath: "tile.png" });
const auth = { resolve: async () => ({ access: "synthetic-access", accountID: "fixture-account" }) };

function labelledResponse(body: BodyInit, mediaType: string | undefined): Response {
  const result = new Response(body, mediaType === undefined ? undefined : { headers: { "content-type": mediaType } });
  // Response(string) supplies text/plain by default; genuinely missing means delete it.
  if (mediaType === undefined) result.headers.delete("content-type");
  return result;
}

const unknownFormat = "Response body is neither a completed Responses image object nor a complete image event stream; no image was saved.";

test.each([
  ["normalized SSE", " Text/Event-Stream ; charset=utf-8 ", sse()],
  ["JSON", "application/json", JSON.stringify(response)],
  ["normalized JSON", " Application/JSON ; charset=utf-8 ", JSON.stringify(response, null, 2)],
  ["JSON-labelled SSE", "application/json", sse()],
  ["plain-labelled SSE", "text/plain; charset=utf-8", sse()],
  ["SSE comment prefix", "text/plain", ": ready\r\n\r\n" + sse()],
  ["SSE event prefix", "application/json", "\r\nevent: response.completed\n" + sse()],
])("%s saves the same real PNG with validated metadata and exclusive permissions", async (_, mediaType, body) => {
  const directory = await mkdtemp("/var/tmp/generate-image-format-");
  let calls = 0;
  let requestBody: unknown;
  let headers: Headers | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    headers = request.headers;
    requestBody = await request.json();
    return new Response(body, { headers: { "content-type": mediaType } });
  } });
  try {
    const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`, "gpt-6-luna");
    const result = await new ImageService(backend).generate(directory, input, new AbortController().signal);
    expect(await readFile(result.path)).toEqual(png);
    expect(result).toMatchObject({ mime: "image/png", width: 3, height: 2, bytes: png.length, transparent: true });
    expect((await lstat(result.path)).mode & 0o777).toBe(0o600);
    expect(requestBody).toMatchObject({ model: "gpt-6-luna", stream: true, store: false, tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst", output_format: "png" }] });
    expect(headers?.get("chatgpt-account-id")).toBe("fixture-account");
    expect(headers?.get("authorization")).toBe("Bearer synthetic-access");
    expect(headers?.get("accept")).toBe("text/event-stream");
    expect(calls).toBe(1);
  } finally { await server.stop(true); }
});

test.each([
  ["text/html", sse(), "Unsupported image response media type (text/html)"],
  ["application/octet-stream", sse(), "Unsupported image response media type (application/octet-stream)"],
  ["image/png", png, "Unsupported image response media type"],
  ["image/png", sse(), "Unsupported image response media type (raw image)"],
  ["Image/JPEG ; charset=utf-8", JSON.stringify(response), "Unsupported image response media type (raw image)"],
  [" Text/HTML ; charset=utf-8", JSON.stringify(response), "Unsupported image response media type (text/html)"],
  ["application/octet-stream", JSON.stringify(response), "Unsupported image response media type (application/octet-stream)"],
  ["application/x-private-secret", "<html>private-secret</html>" + sse(), unknownFormat],
  ["text/event-stream-private-secret", "private-secret\n" + sse(), unknownFormat],
  ["text/plain", JSON.stringify(response), "Unexpected image response body for text/plain"],
  ["text/plain", "<html>private-secret</html>" + sse(), "Unexpected image response body for text/plain"],
  ["application/json", "private-secret\n" + sse(), "Unexpected image response body for application/json"],
])("rejects %s without exposing arbitrary headers/body or saving an image", async (mediaType, body, diagnostic) => {
  const directory = await mkdtemp("/var/tmp/generate-image-format-");
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    return new Response(body, { headers: { "content-type": mediaType } });
  } });
  try {
    const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
    const error = await new ImageService(backend).generate(directory, input, new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ImageError);
    expect(error.message).toContain(diagnostic);
    expect(error.message).not.toContain("private-secret");
    expect(await readdir(directory)).toEqual([]);
    expect(calls).toBe(1);
  } finally { await server.stop(true); }
});

test.each([
  ["incomplete response", { ...response, status: "in_progress" }, "did not complete correctly"],
  ["missing output", { ...response, output: undefined }, "did not complete correctly"],
  ["no images", { ...response, output: [] }, "exactly one completed image"],
  ["two images", { ...response, output: [item, { ...item, id: "image-2" }] }, "exactly one completed image"],
  ["pending image", { ...response, output: [{ ...item, status: "in_progress" }] }, "incomplete or oversized image result"],
  ["empty result", { ...response, output: [{ ...item, result: "" }] }, "incomplete or oversized image result"],
  ["malformed base64", { ...response, output: [{ ...item, result: "a===" }] }, "Invalid image encoding"],
  ["noncanonical base64", { ...response, output: [{ ...item, result: "AB==" }] }, "Invalid or oversized image encoding"],
  ["refusal", { ...response, output: [item, { type: "message", content: [{ type: "refusal", refusal: "private-secret" }] }] }, "was refused"],
])("JSON and mismatched-header SSE share validation for %s", async (_, value, diagnostic) => {
  for (const mediaType of ["application/json", "application/x-private-secret"]) {
    for (const body of [JSON.stringify(value), sse(value)]) {
      let calls = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        calls++;
        return labelledResponse(body, mediaType);
      } });
      try {
        const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
        const error = await backend.generate(input, [], new AbortController().signal).catch(error => error);
        expect(error).toBeInstanceOf(ImageError);
        expect(error.message).toContain(diagnostic);
        expect(error.message).not.toContain("private-secret");
        expect(calls).toBe(1);
      } finally { await server.stop(true); }
    }
  }
});

test.each([
  ["completed event instead of full response", { type: "response.completed", response }],
  ["missing response discriminator", { ...response, object: undefined }],
  ["missing response id", { ...response, id: undefined }],
  ["wrong response discriminator", { ...response, object: "image" }],
  ["wrong response id type", { ...response, id: 1 }],
  ["incomplete details despite status", { ...response, incomplete_details: { reason: "private-secret" } }],
])("full JSON rejects %s", async (_, value) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json(value); } });
  try {
    const error = await new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`).generate(input, [], new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ImageError);
    expect(error.message).toBe("Invalid completed Responses JSON object; no image was saved.");
  } finally { await server.stop(true); }
});

test.each([
  [{ error: { code: "unsupported_model", message: "Bearer private-secret" } }, "OpenAI image request rejected: requested model is unsupported; no automatic retry was attempted."],
  [{ ...response, error: { code: "unsupported_tool", message: "private-secret" } }, "OpenAI image request rejected: image_generation tool is unsupported; no automatic retry was attempted."],
  [{ detail: "Invalid quality: low; private-secret" }, "OpenAI image request rejected: image quality was rejected; no automatic retry was attempted."],
  [{ error: { code: "unknown", message: "private-secret" } }, "OpenAI image generation failed; no image was saved."],
])("HTTP 200 JSON error is classified but never accepted as an image", async (value, message) => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return Response.json(value); } });
  try {
    await expect(new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`).generate(input, [], new AbortController().signal)).rejects.toThrow(message);
    expect(calls).toBe(1);
  } finally { await server.stop(true); }
});

test.each([
  "{not-json private-secret}", JSON.stringify(response) + " private-secret",
  JSON.stringify(response).slice(0, -1), "[]", "null", "<html>private-secret</html>",
  Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff]), Buffer.from('"}')]),
])("malformed or non-response JSON fails closed", async body => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(body, { headers: { "content-type": "application/json" } }); } });
  try {
    const error = await new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`).generate(input, [], new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ImageError);
    expect(error.message).not.toMatch(/private-secret|SyntaxError/);
  } finally { await server.stop(true); }
});

test.each(["application/json", "text/plain", "application/x-private-secret", undefined])("sniffing %s handles byte-split SSE prefixes and UTF-8", async mediaType => {
  const body = Buffer.from("\r\nevent: response.completed\n" + sse({ ...response, harmless: "é" }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of body) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(stream, mediaType));
  try {
    expect(await new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).toEqual(png);
    expect(stream.locked).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each(["application/json", "application/x-private-secret", undefined])("%s JSON handles byte-split UTF-8 and whitespace without weakening full-body parsing", async mediaType => {
  const body = Buffer.from(" \r\n\t" + JSON.stringify({ ...response, harmless: "é" }) + "\n");
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of body) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(stream, mediaType));
  try {
    expect(await new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).toEqual(png);
    expect(stream.locked).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each([
  ["missing completion", 'data: {"type":"response.output_item.done","item":' + JSON.stringify(item) + '}\n\n', "Incomplete image response stream"],
  ["unterminated event", sse().trimEnd(), "Incomplete image response stream"],
  ["malformed event", "data: {private-secret}\n\n", "Malformed image response event"],
  ["refusal event", 'data: {"type":"response.refusal.delta","delta":"private-secret"}\n\n' + sse(), "failed or was refused"],
  ["error after completion", sse() + 'data: {"type":"error","message":"private-secret"}\n\n', "Unexpected data after image response ended"],
  ["invalid UTF-8", Buffer.concat([Buffer.from("data: "), Buffer.from([0xff])]), "Malformed image response stream"],
])("mismatched-header SSE rejects %s with the existing stream checks", async (_, body, diagnostic) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(body, { headers: { "content-type": "text/plain" } }); } });
  try {
    const error = await new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`).generate(input, [], new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(ImageError);
    expect(error.message).toContain(diagnostic);
    expect(error.message).not.toContain("private-secret");
  } finally { await server.stop(true); }
});

test.each([
  ["missing-label SSE", undefined, sse()],
  ["missing-label JSON", undefined, JSON.stringify(response)],
  ["unknown-label SSE", "application/x-private-secret", sse()],
  ["unknown-label JSON", "application/x-private-secret", JSON.stringify(response)],
  ["unfamiliar SSE-like label", "text/event-stream-private-secret", sse()],
])("%s accepts only validated completion and returns exact image bytes", async (_, mediaType, body) => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(body!)); controller.close(); } });
  const result = labelledResponse(stream, mediaType);
  expect(result.headers.get("content-type")).toBe(mediaType ?? null);
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(result);
  try {
    expect(await new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).toEqual(png);
    expect(stream.locked).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each([
  ["HTML", "<html>private-secret</html>" + sse(), unknownFormat],
  ["raw image", png, unknownFormat],
  ["plain text", "private-secret", unknownFormat],
  ["generic JSON", '{"private-secret":true}', unknownFormat],
  ["event JSON instead of whole Responses object", JSON.stringify({ type: "response.completed", response }), unknownFormat],
  ["missing response discriminator", JSON.stringify({ ...response, object: undefined }), unknownFormat],
  ["missing response id", JSON.stringify({ ...response, id: undefined }), unknownFormat],
  ["empty response id", JSON.stringify({ ...response, id: "" }), unknownFormat],
  ["wrong response discriminator", JSON.stringify({ ...response, object: "image" }), unknownFormat],
  ["wrong response id type", JSON.stringify({ ...response, id: 1 }), unknownFormat],
  ["incomplete details", JSON.stringify({ ...response, incomplete_details: { reason: "private-secret" } }), unknownFormat],
  ["trailing JSON text", JSON.stringify(response) + " private-secret", unknownFormat],
  ["incomplete JSON response", JSON.stringify({ ...response, status: "in_progress" }), "did not complete correctly"],
  ["pending JSON image", JSON.stringify({ ...response, output: [{ ...item, status: "in_progress" }] }), "incomplete or oversized image result"],
  ["invalid JSON image encoding", JSON.stringify({ ...response, output: [{ ...item, result: "a===" }] }), "Invalid image encoding"],
  ["missing SSE completion", 'data: {"type":"response.output_item.done","item":' + JSON.stringify(item) + '}\n\n', "Incomplete image response stream"],
  ["SSE refusal", 'data: {"type":"response.refusal.delta","delta":"private-secret"}\n\n' + sse(), "failed or was refused"],
  ["JSON error", JSON.stringify({ error: { code: "unknown", message: "private-secret" } }), "OpenAI image generation failed; no image was saved."],
  ["classified JSON error", JSON.stringify({ ...response, error: { code: "unsupported_tool", message: "private-secret" } }), "OpenAI image request rejected: image_generation tool is unsupported; no automatic retry was attempted."],
])("unknown/missing labels refuse %s without saving or exposing body/header", async (_, body, diagnostic) => {
  for (const mediaType of [undefined, "application/x-private-secret"]) {
    const directory = await mkdtemp("/var/tmp/generate-image-format-");
    const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(body, mediaType));
    try {
      const error = await new ImageService(new CodexImageBackend(auth)).generate(directory, input, new AbortController().signal).catch(error => error);
      expect(error).toBeInstanceOf(ImageError);
      expect(error.message).toContain(diagnostic);
      expect(error.message).not.toContain("private-secret");
      expect(await readdir(directory)).toEqual([]);
      expect(stub).toHaveBeenCalledTimes(1);
    } finally { stub.mockRestore(); }
  }
});

test("JSON exactly at the wire-byte bound succeeds with the same image", async () => {
  const body = Buffer.from(JSON.stringify(response).padEnd(LIMITS.responseBytes, " "));
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
  try {
    expect(await new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).toEqual(png);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each(["application/json", "text/plain", "application/x-private-secret", undefined])("sniffing %s is limited to a 1 KiB prefix and releases the reader", async mediaType => {
  let reads = 0;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(Buffer.alloc(1024, 0x0a)); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(stream, mediaType));
  try {
    await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow(mediaType === undefined || mediaType === "application/x-private-secret" ? unknownFormat : "Unexpected image response body");
    expect(reads).toBe(1);
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each(["application/json", "text/plain", "text/event-stream", "application/x-private-secret", undefined])("%s declared response size is bounded before reading", async mediaType => {
  let reads = 0;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const result = labelledResponse(stream, mediaType);
  result.headers.set("content-length", String(LIMITS.responseBytes + 1));
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(result);
  try {
    await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow("96 MiB");
    expect(reads).toBe(0);
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  } finally { stub.mockRestore(); }
});

test.each(["application/json", "application/x-private-secret", undefined])("%s JSON streaming byte bound stops reading even without Content-Length", async mediaType => {
  let reads = 0;
  let cancelled = 0;
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  chunk[0] = 0x7b;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(chunk); }, cancel() { cancelled++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(stream, mediaType));
  try {
    await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow("96 MiB");
    expect(reads).toBe(97);
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each(["application/json", "application/x-private-secret", undefined])("%s JSON rejects oversized image results using the shared completed-event validator", async mediaType => {
  const body = { ...response, output: [{ ...item, result: "A".repeat(Math.ceil(LIMITS.imageBytes / 3) * 4 + 4) }] };
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(JSON.stringify(body), mediaType));
  try {
    await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow("oversized image result");
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});

test.each([
  ["unfinished JSON", "application/json", "{"],
  ["sniffing plain prefix", "text/plain", "da"],
  ["mislabeled SSE", "application/json", ": ready\n\n"],
  ["unknown JSON", "application/x-private-secret", "{"],
  ["missing-label sniff prefix", undefined, "da"],
  ["unknown SSE", "application/x-private-secret", ": ready\n\n"],
])("cancellation bounds %s and never waits for peer cancellation", async (_, mediaType, prefix) => {
  const reading = Promise.withResolvers<void>();
  let reads = 0;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (++reads === 1) controller.enqueue(Buffer.from(prefix));
    else reading.resolve();
  }, cancel() { cancelled++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(labelledResponse(stream, mediaType));
  try {
    const controller = new AbortController();
    const running = new CodexImageBackend(auth).generate(input, [], controller.signal);
    await reading.promise;
    controller.abort(new Error("private-secret"));
    await expect(running).rejects.toThrow(CANCELLED);
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});
