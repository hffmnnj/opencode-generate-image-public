import { describe, expect, spyOn, test } from "bun:test";
import sharp from "sharp";
import { createServer } from "node:net";
import { CodexImageBackend, decodeImageStream, imageRequest, ImageStreamDecoder } from "../../src/api.ts";
import { imageInputSchema, LIMITS, USER_AGENT } from "../../src/options.ts";

const image = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
const item = { id: "image-1", type: "image_generation_call", status: "completed", result: image.toString("base64") };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (output: unknown[] = [item]) => event({ type: "response.completed", response: { status: "completed", output } });
const input = imageInputSchema.parse({ prompt: "A cobalt bicycle", model: "gpt-image-2.5-flare", quality: "xhigh", size: "1536x1024", action: "auto" });
const auth = { resolve: async () => ({ access: "synthetic-access", accountID: "fixture-account" }) };
const generic400 = "OpenAI image request failed (HTTP 400); no automatic retry was attempted.";
const rejected = (reason: string) => `OpenAI image request rejected: ${reason}; no automatic retry was attempted.`;

describe("complete Responses image streams", () => {
  test("extracts one authoritative final image and deduplicates output_item.done", () => {
    const stream = event({ type: "response.output_item.done", item }) + completed() + "data: [DONE]\n\n";
    expect(decodeImageStream(stream)).toEqual(image);
  });

  test("handles split UTF-8, CRLF, multiline data and ignored SSE comments", () => {
    const stream = ": heartbeat\r\n\r\nevent: response.completed\r\ndata: {\r\ndata: \"type\": \"response.completed\",\r\ndata: \"response\": "
      + JSON.stringify({ status: "completed", output: [item], harmless: "é" }) + "}\r\n\r\n";
    const decoder = new ImageStreamDecoder();
    for (const byte of Buffer.from(stream)) decoder.push(Uint8Array.of(byte));
    expect(decoder.finish()).toEqual(image);
  });

  test.each([
    ["item without terminal completion", event({ type: "response.output_item.done", item })],
    ["partial event", event({ type: "response.image_generation_call.partial_image", partial_image_b64: item.result })],
    ["missing final image", completed([])],
    ["multiple final images", completed([item, { ...item, id: "image-2" }])],
    ["unterminated SSE event", completed().trimEnd()],
    ["missing final output", event({ type: "response.completed", response: { status: "completed" } })],
    ["failed response", event({ type: "response.failed", error: { message: "Bearer synthetic-secret" } })],
    ["incomplete response", event({ type: "response.incomplete" })],
    ["provider error", event({ type: "error", message: "refresh_token=synthetic-secret" })],
    ["refusal delta", event({ type: "response.refusal.delta", delta: "secret" })],
    ["refusal content", completed([{ ...item }, { type: "message", content: [{ type: "refusal", refusal: "secret" }] }])],
    ["malformed JSON", "data: {not-json}\n\n"],
    ["non-object event", "data: []\n\n"],
    ["bad base64", completed([{ ...item, result: "a===" }])],
    ["noncanonical base64", completed([{ ...item, result: "AB==" }])],
    ["pending image", completed([{ ...item, status: "in_progress" }])],
    ["conflicting duplicate", event({ type: "response.output_item.done", item }) + completed([{ ...item, result: "YWJj" }])],
    ["error after completion", completed() + event({ type: "error", message: "secret" })],
    ["data after DONE", completed() + "data: [DONE]\n\n" + event({ type: "ignored" })],
  ])("rejects %s without exposing provider text", (_, stream) => {
    let message = "";
    try { decodeImageStream(stream); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/image|Image|OpenAI/);
    expect(message).not.toMatch(/secret|Bearer|refresh_token/);
  });

  test("rejects invalid UTF-8 rather than replacing it", () => {
    const decoder = new ImageStreamDecoder();
    expect(() => decoder.push(Uint8Array.from([0xff]))).toThrow("Malformed image response stream");
  });

  test("bounds total bytes even when SSE lines carry no data", () => {
    const decoder = new ImageStreamDecoder();
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    chunk[chunk.length - 1] = 0x0a;
    for (let index = 0; index < 96; index++) decoder.push(chunk);
    expect(() => decoder.push(Uint8Array.of(0x20))).toThrow("96 MiB");
  });

  test("bounds event count, including small irrelevant events", () => {
    const decoder = new ImageStreamDecoder();
    const bytes = Buffer.from(event({ type: "heartbeat" }));
    for (let index = 0; index < LIMITS.streamEvents; index++) decoder.push(bytes);
    expect(() => decoder.push(bytes)).toThrow("Too many image response events");
  });

  test("rejects a result above the 32 MiB image bound even inside an otherwise bounded stream", () => {
    const encoded = "A".repeat(Math.ceil(LIMITS.imageBytes / 3) * 4 + 4);
    expect(() => decodeImageStream(completed([{ ...item, result: encoded }]))).toThrow("oversized image result");
  });

  test("bounds multiline event and comment-line overhead, not just payload bytes", () => {
    const multiline = new ImageStreamDecoder();
    for (let index = 0; index < LIMITS.eventDataLines; index++) multiline.push(Buffer.from("data: \n"));
    expect(() => multiline.push(Buffer.from("data: \n"))).toThrow("Too many data lines");
    const comments = new ImageStreamDecoder();
    for (let index = 0; index < LIMITS.streamLines; index++) comments.push(Buffer.from(":\n"));
    expect(() => comments.push(Buffer.from(":\n"))).toThrow("Too many image response lines");
  });
});

describe("subscription adapter", () => {
  test.each([undefined, "gpt-6.1-sol", "gpt-6.1-sol-2026-10-14"])("sends selected Responses model %s, account header and explicit references only", async responsesModel => {
    let requests = 0;
    let body: unknown;
    let headers: Headers | undefined;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests++;
      headers = request.headers;
      body = await request.json();
      return new Response(completed(), { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`, responsesModel);
      const reference = "data:image/png;base64," + image.toString("base64");
      expect(await backend.generate(input, [reference], new AbortController().signal)).toEqual(image);
      expect(requests).toBe(1);
      expect(headers?.get("authorization")).toBe("Bearer synthetic-access");
      expect(headers?.get("chatgpt-account-id")).toBe("fixture-account");
      expect(headers?.get("user-agent")).toBe(USER_AGENT);
      expect(body).toEqual({
        model: responsesModel ?? "gpt-6.1-sol", instructions: "You are an image generation assistant. Generate exactly one image.",
        input: [{ role: "user", content: [
          { type: "input_text", text: "A cobalt bicycle" },
          { type: "input_image", image_url: reference, detail: "high" },
        ] }],
        tools: [{ type: "image_generation", model: "gpt-image-2.5-flare", quality: "xhigh", size: "1536x1024", action: "auto", output_format: "png" }],
        tool_choice: { type: "image_generation" }, stream: true, store: false,
      });
    } finally { await server.stop(true); }
  });

  test("imageRequest selects the outer model without changing the image tool model", () => {
    expect(imageRequest(input, []).model).toBe("gpt-6.1-sol");
    const request = imageRequest(input, [], "gpt-6.1-sol-2026-10-14");
    expect(request.model).toBe("gpt-6.1-sol-2026-10-14");
    expect(request.tools[0]?.model).toBe("gpt-image-2.5-flare");
  });

  test.each(["gpt-6.1-sol#max", "openai/gpt-6.1-sol", "https://example.invalid", "gpt-6.1-sol\r\nInjected:yes", "gpt-", "claude-sonnet", " gpt-6.1-sol", "gpt-6.1-sol ", "gpt-" + "x".repeat(200)])("rejects unsafe outer model %j before auth or HTTP", responsesModel => {
    let resolved = 0;
    const unusedAuth = { resolve: async () => { resolved++; return { access: "synthetic" }; } };
    expect(() => new CodexImageBackend(unusedAuth, undefined, responsesModel)).toThrow("Responses model");
    expect(() => imageRequest(input, [], responsesModel)).toThrow("Responses model");
    expect(resolved).toBe(0);
  });

  test.each([401, 429, 500])("HTTP %s is sanitized and never retried", async status => {
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      return new Response("Bearer secret access_token=secret refresh_token=secret", { status });
    } });
    try {
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
      const result = await backend.generate(input, [], new AbortController().signal).then(() => "unexpected success", error => (error as Error).message);
      expect(result).toMatch(status === 401 ? /reconnect/i : status === 429 ? /quota\/rate limit/ : /HTTP 500/);
      expect(result).not.toMatch(/Bearer|secret|access_token|refresh_token/);
      expect(calls).toBe(1);
    } finally { await server.stop(true); }
  });

  test.each([
    [{ error: { code: "unsupported_tool", message: "private prompt" } }, "image_generation tool is unsupported"],
    [{ detail: "Tool 'image_generation' is not supported" }, "image_generation tool is unsupported"],
    [{ error: { type: "invalid_request_error", message: "Unsupported tool type: image_generation" } }, "image_generation tool is unsupported"],
    [{ error: { code: "unsupported_model", message: "private prompt" } }, "requested model is unsupported"],
    [{ detail: { message: "The model 'gpt-5.5' is not supported" } }, "Responses model gpt-5.5 is unsupported"],
    [{ detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." }, "Responses model gpt-5.5 is unsupported"],
    [{ error: { message: "The model 'gpt-5.5' is unsupported" } }, "Responses model gpt-5.5 is unsupported"],
    [{ error: { message: "The model 'gpt-image-2.5-flare' is not supported" } }, "image model gpt-image-2.5-flare is unsupported"],
    [{ detail: { message: "The model gpt-image-2.5-sunburst is not supported" } }, "image model gpt-image-2.5-sunburst is unsupported"],
    [{ detail: "The 'gpt-image-2.5-flare' model is unsupported" }, "image model gpt-image-2.5-flare is unsupported"],
    [{ detail: { message: "The 'gpt-image-2.5-sunburst' model is not supported" } }, "image model gpt-image-2.5-sunburst is unsupported"],
    [{ error: { message: "The model 'gpt-9999' is not supported" } }, "requested model is unsupported"],
    [{ detail: "The model 'sk-probe-secret' is not supported" }, "requested model is unsupported"],
    [{ error: { code: "model_not_found", message: "private prompt" } }, "requested model was not found or is inaccessible"],
    [{ error: { message: "The model `gpt-image-2.5-flare` does not exist or you do not have access to it" } }, "requested model was not found or is inaccessible"],
    [{ error: { message: "Model not found gpt-5.5", type: "invalid_request_error", param: "model", code: null } }, "requested model was not found or is inaccessible"],
    [{ error: { code: "unsupported_value", param: "tools[0].model" } }, "requested model is unsupported"],
    [{ error: { code: "invalid_parameter", param: "tool_choice" } }, "tool_choice was rejected"],
    [{ detail: { type: "invalid_request_error", param: "tool_choice", message: "Invalid value" } }, "tool_choice was rejected"],
    [{ detail: "Invalid parameter: tool_choice" }, "tool_choice was rejected"],
    [{ error: { code: "invalid_value", param: "tools[0].quality" } }, "image quality was rejected"],
    [{ error: { message: "Invalid quality: low" } }, "image quality was rejected"],
    [{ detail: { code: "unsupported_value", param: "tools[0].size" } }, "image size was rejected"],
    [{ detail: "Invalid size: 1024x1024" }, "image size was rejected"],
    [{ error: { code: "unsupported_parameter", param: "tools[0].action" } }, "an image request parameter was rejected"],
    [{ error: { code: "subscription_required" } }, "active subscription does not support this image request"],
    [{ detail: "Image generation is not available for your subscription" }, "active subscription does not support this image request"],
  ])("classifies provider-shaped error %j using owned text only", async (payload, reason) => {
    let calls = 0;
    const sensitive = "orange circle PRIVATE_PROMPT Bearer synthetic-access access_token=secret refresh_token=secret https://user:password@example.invalid";
    const polluted = JSON.parse(JSON.stringify(payload, (key, value) =>
      (key === "message" || key === "detail") && typeof value === "string" ? `${value}; ${sensitive}` : value));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      return Response.json({ ...polluted, prompt: sensitive, credential: sensitive }, { status: 400 });
    } });
    try {
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
      const message = await backend.generate({ ...input, prompt: sensitive }, [], new AbortController().signal).then(() => "unexpected success", error => (error as Error).message);
      expect(message).toBe(rejected(reason));
      expect(message).not.toMatch(/orange circle|PRIVATE_PROMPT|Bearer|synthetic-access|access_token|refresh_token|secret|password|example\.invalid/);
      expect(calls).toBe(1);
    } finally { await server.stop(true); }
  });

  test("unknown or credential-like model identifiers stay generic without echoing provider text", async () => {
    const cases: Array<[unknown, string[]]> = [
      [{ error: { message: "The model 'gpt-9999' is not supported" } }, ["gpt-9999"]],
      [{ detail: { message: "The model 'sk-live-abc123' is unsupported" } }, ["sk-live-abc123"]],
      [{ detail: "The model 'GPT-5.5' is not supported" }, ["GPT-5.5"]],
    ];
    for (const [payload, forbidden] of cases) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        return Response.json(payload, { status: 400 });
      } });
      try {
        const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
        const message = await backend.generate(input, [], new AbortController().signal).then(() => "unexpected success", error => (error as Error).message);
        expect(message).toBe(rejected("requested model is unsupported"));
        for (const value of forbidden) expect(message).not.toContain(value);
        expect(message).not.toMatch(/sk-live|GPT-5\.5/);
      } finally { await server.stop(true); }
    }
  });

  test.each([
    "not JSON Bearer secret",
    JSON.stringify({ error: { code: "unknown_code", param: "quality", message: "private prompt" } }),
    JSON.stringify({ error: { code: "invalid_parameter", param: "private_prompt_access_token" } }),
    JSON.stringify({ detail: [{ message: "Invalid quality: low" }] }),
    JSON.stringify({ error: { code: ["unsupported_model"] } }),
    JSON.stringify({ error: { code: "unsupported_model", message: { prompt: "Bearer secret" } } }),
    JSON.stringify({ prompt: "Unsupported tool type: image_generation", message: "Invalid size: 1024x1024" }),
    JSON.stringify({ error: { message: "Draw a model not found on Mars with invalid quality written underneath" } }),
    Buffer.concat([Buffer.from('{"error":{"code":"unsupported_model","message":"'), Buffer.from([0xff]), Buffer.from('"}}')]),
  ])("unknown or malformed provider body retains generic status", async body => {
    const fetchStub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 400 }));
    try {
      const backend = new CodexImageBackend(auth);
      await expect(backend.generate(input, [], new AbortController().signal)).rejects.toThrow(generic400);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { fetchStub.mockRestore(); }
  });

  test("a failed error-body read falls back to generic status without exposing its cause", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("private-prompt Bearer secret refresh_token=secret")); } }, { highWaterMark: 0 });
    const fetchStub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 400 }));
    try {
      await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow(generic400);
      expect(stream.locked).toBe(false);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { fetchStub.mockRestore(); }
  });

  test("oversized declared error length cancels before reading", async () => {
    let reads = 0;
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const fetchStub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 400, headers: { "content-length": String(16 * 1024 + 1) } }));
    try {
      await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow(generic400);
      expect(reads).toBe(0);
      expect(cancelled).toBe(1);
      expect(stream.locked).toBe(false);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { fetchStub.mockRestore(); }
  });

  test("error JSON at the 16 KiB boundary is accepted and its reader is released", async () => {
    const body = JSON.stringify({ error: { code: "unsupported_model" } }).padEnd(16 * 1024, " ");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(body)); controller.close(); } });
    const fetchStub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 400 }));
    try {
      await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow(rejected("requested model is unsupported"));
      expect(stream.locked).toBe(false);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { fetchStub.mockRestore(); }
  });

  test("oversized error body is not classified, stops reading and cancels without waiting on the peer", async () => {
    let reads = 0;
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(reads === 1 ? Buffer.from('{"error":{"code":"unsupported_model"}}') : Buffer.alloc(16 * 1024));
      },
      cancel() { cancelled++; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    const fetchStub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 400 }));
    try {
      await expect(new CodexImageBackend(auth).generate(input, [], new AbortController().signal)).rejects.toThrow(generic400);
      expect(reads).toBe(2);
      expect(cancelled).toBe(1);
      expect(stream.locked).toBe(false);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { fetchStub.mockRestore(); }
  });

  test("cancellation bounds an unfinished non-2xx body and cancels its reader", async () => {
    const reading = Promise.withResolvers<void>();
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const fetchStub = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 400 }));
    try {
      const controller = new AbortController();
      const running = new CodexImageBackend(auth).generate(input, [], controller.signal);
      await reading.promise;
      controller.abort(new Error("Bearer private-prompt refresh_token=secret"));
      await expect(running).rejects.toThrow("Image generation cancelled or timed out; no automatic retry was attempted.");
      expect(cancelled).toBe(1);
      expect(stream.locked).toBe(false);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { fetchStub.mockRestore(); }
  });

  test("does not follow redirects or forward a bearer to the redirect target", async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { destinationCalls++; return new Response(completed()); } });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${destination.port}/stolen` } }); } });
    try {
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
      const message = await backend.generate(input, [], new AbortController().signal).then(() => "unexpected success", error => (error as Error).message);
      expect(destinationCalls).toBe(0);
      expect(message).toContain("Image request failed");
    } finally { await server.stop(true); await destination.stop(true); }
  });

  test("rejects untrusted constructor endpoints", () => {
    for (const endpoint of ["https://example.com/responses", "http://localhost:1234/responses", "http://127.0.0.1:1234/responses?token=x", "http://user:pass@127.0.0.1:1234/responses", "http://127.0.0.1:1234/other", "https://chatgpt.com/backend-api/codex/responses?x=1"])
      expect(() => new CodexImageBackend(auth, endpoint)).toThrow("Untrusted image endpoint");
  });

  test("cancels a hanging stream after headers arrive without retrying", async () => {
    let calls = 0;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const arrived = Promise.withResolvers<void>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        streamController = controller;
        controller.enqueue(Buffer.from(": ready\n\n"));
        arrived.resolve();
      } }), { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const controller = new AbortController();
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
      const running = backend.generate(input, [], controller.signal);
      await arrived.promise;
      controller.abort(new Error("refresh_token=secret"));
      await expect(running).rejects.toThrow("cancelled or timed out");
      expect(calls).toBe(1);
    } finally { try { streamController?.close(); } catch {} await server.stop(true); }
  });

  test("timeout also bounds a stream whose peer never closes", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(": ready\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${server.port}/responses`);
      await expect(backend.generate(input, [], AbortSignal.timeout(50))).rejects.toThrow("cancelled or timed out");
    } finally { await server.stop(true); }
  });

  test("cancellation does not wait for or duplicate the native credential resolver", async () => {
    let resolved = 0;
    const pending = Promise.withResolvers<{ access: string }>();
    const controller = new AbortController();
    const backend = new CodexImageBackend({ resolve() { resolved++; return pending.promise; } }, "http://127.0.0.1:9/responses");
    const running = backend.generate(input, [], controller.signal);
    controller.abort();
    await expect(running).rejects.toThrow("cancelled or timed out");
    pending.resolve({ access: "synthetic" });
    expect(resolved).toBe(1);
  });

  test("rejects oversized Content-Length before reading and rejects unrecognized JSON bodies", async () => {
    let length = true;
    // Bun.serve rewrites Content-Length to the actual body size; use a wire-level fixture here.
    const server = createServer(socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\n"
        + (length ? `Content-Type: text/event-stream\r\nContent-Length: ${LIMITS.responseBytes + 1}\r\n`
          : "Content-Type: application/json\r\nContent-Length: 6\r\n") + "\r\nsecret"));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP fixture address");
    try {
      const backend = new CodexImageBackend(auth, `http://127.0.0.1:${address.port}/responses`);
      await expect(backend.generate(input, [], new AbortController().signal)).rejects.toThrow("96 MiB");
      length = false;
      await expect(backend.generate(input, [], new AbortController().signal)).rejects.toThrow("Unexpected image response body for application/json");
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
