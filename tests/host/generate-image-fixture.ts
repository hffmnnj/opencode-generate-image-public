import { strict as assert } from "node:assert";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { spyOn } from "bun:test";
import { isWithinOsTempDir } from "../temp-dir.ts";
// Shipped entrypoint compatibility: the host loads the real plugin code,
// not a copy. Cover both an injected loopback backend and the production
// default backend with its fixed URL intercepted into loopback only.
import { CodexImageBackend, registerImages, resolveImageCredential } from "../../src/index.ts";
import { IMAGE_ENDPOINT } from "../../src/options.ts";

const HOST_VERSION = "2.0.25";
const root = process.argv[2]!;
const mode = process.argv[3] ?? "injected";
assert(["injected", "session", "override", "fallback"].includes(mode));
const defaultBackend = mode !== "injected";
const sessionProvider = mode === "session" || mode === "override" ? "openai" : "generatetest";
const sessionModels = sessionProvider === "openai" ? ["gpt-6.1-sol", "gpt-6.1-sol-2026-10-14"] : ["fixture", "fixture"];
// OpenAI model turns can also resolve OAuth outside the image plugin's FIFO.
// Keep these model-selection scenarios fresh; the original injected/fallback
// scenarios retain the expired-token native refresh regression.
const expectedRefreshes = sessionProvider === "openai" ? 0 : 1;
const expectedModels = mode === "override" ? ["gpt-6.1-sol-override", "gpt-6.1-sol-override"]
  : mode === "session" ? sessionModels : ["gpt-6.1-sol", "gpt-6.1-sol"];
assert(isWithinOsTempDir(root), "Fixture root must be inside the OS temporary directory");
assert(process.env.HOME === join(root, "home"));
assert(!process.env.OPENCODE_DB || process.env.OPENCODE_DB.startsWith(root), "Host database must stay isolated");
const directory = join(root, "workspace");
const configDir = join(root, "config");
await mkdir(directory, { recursive: true });
await mkdir(configDir, { recursive: true });

// Small RGBA fixture: decoding must preserve real dimensions and alpha.
// The file saved by the tool is re-encoded by normalizeImage, so host
// assertions check format/dimensions, not byte equality.
const image = await sharp({
  create: { width: 8, height: 8, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 0.6 } },
}).png().toBuffer();

let step = 0;
let code = "";
let calls = 0;
let seenAuth = "";
let seenAccount = "";
let refreshed = 0;
let refreshSawInitial = "";
const seenModels: string[] = [];
const responseShapes: string[] = [];
// Settled native host cancellation (injected variant only): deterministic
// started body gate, no sleeps. The owned loopback backend holds its SSE
// stream open with no image packet until the real host session is
// interrupted. Tracks exactly one POST (no autoretry) and server-observed
// abort/stream cancellation.
let cancelArmed = false;
let cancelPosts = 0;
let cancelAuth = "";
let cancelSeenModel = "";
let cancelAborted = false;
let cancelStreamCancelled = false;
let cancelStartedResolve: (() => void) | null = null;
let cancelAbortedResolve: (() => void) | null = null;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/responses") {
      if (cancelArmed) {
        cancelPosts++;
        cancelAuth = request.headers.get("authorization") ?? "";
        assert.equal(request.headers.get("chatgpt-account-id"), "fixture-account");
        const payload = await request.json() as { model: string; tools: Array<{ model: string }> };
        cancelSeenModel = payload.model;
        assert.equal(payload.tools[0]?.model, "gpt-image-2.5-sunburst", "Cancelled call must not replace the image model");
        cancelStartedResolve?.();
        const stream = new ReadableStream({
          start(controller) {
            const mark = () => {
              cancelAborted = true;
              cancelAbortedResolve?.();
              try { controller.close(); } catch {}
            };
            if (request.signal.aborted) mark();
            else request.signal.addEventListener("abort", mark, { once: true });
          },
          cancel() {
            cancelStreamCancelled = true;
            cancelAborted = true;
            cancelAbortedResolve?.();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      calls++;
      seenAuth = request.headers.get("authorization") ?? "";
      seenAccount = request.headers.get("chatgpt-account-id") ?? "";
      assert.equal(seenAccount, "fixture-account");
      const payload = await request.json() as { model: string; tools: Array<{ model: string }> };
      seenModels.push(payload.model);
      assert.equal(payload.model, expectedModels[calls - 1], "Default registration must send the selected outer model on each invocation");
      assert.equal(payload.tools[0]?.model, "gpt-image-2.5-sunburst", "Outer selection must not replace the image model");
      const item = { id: "image1", type: "image_generation_call", status: "completed", result: image.toString("base64") };
      // Exercise both prior final-output behavior and the coordinator-observed
      // native shape: completed image + message done events, empty final output.
      const streamedOnly = calls === 2;
      responseShapes.push(streamedOnly ? "streamed-done-empty-final" : "final-output");
      const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      return new Response(
        (streamedOnly ? event({ type: "response.output_item.done", item })
          + event({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Done" }] } }) : "")
        + event({
          type: "response.completed",
          response: {
            status: "completed",
            output: streamedOnly ? [] : [item],
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const body = (await request.json()) as { stream?: boolean };
    // Single Code Mode turn per scenario: the synthetic model calls the
    // confined `execute` tool once, whose program calls our tool through its
    // exact catalog path. No namespace is registered, so qualifiedName is the
    // normalized tool name itself (variant-qxjc9qry.js qualifiedName,
    // variant-3w5fmr99.js normalizedName): tools.generate_image(...).
    // Using tools.image.generate here would fail with Unknown tool.
    const tool =
      step++ === 0
        ? { id: "image_call", type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }
        : undefined;
    const base = { id: `response_${step}`, created: 1, model: "fixture" };
    if (!body.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
      });
    return new Response(
      [
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: tool
                ? { role: "assistant", tool_calls: [{ index: 0, ...tool }] }
                : { role: "assistant", content: "Done" },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ]
        .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

// Exercise the production default constructor/registration, not an injected
// backend. Only its fixed production URL is intercepted and sent to loopback;
// all other traffic must already be loopback. No live HTTP or credentials.
const originalFetch = globalThis.fetch;
const fixtureFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url === IMAGE_ENDPOINT) {
    assert.equal(init?.redirect, "error");
    return originalFetch(`http://127.0.0.1:${server.port}/responses`, init);
  }
  assert.equal(new URL(url).hostname, "127.0.0.1", "Hermetic host must not contact external endpoints");
  return originalFetch(input, init);
}, { preconnect: originalFetch.preconnect });
const fetchFixture = defaultBackend ? spyOn(globalThis, "fetch").mockImplementation(fixtureFetch) : undefined;

const { OpenCode } = await import("@opencode/sdk");
const { Plugin, Provider, Model, Integration } = await import("@opencode/plugin");
const methodID = Integration.MethodID.make("generate-image-fixture");
const fixture = Plugin.define({
  id: "generate-image.fixture",
  async setup(ctx) {
    await ctx.session.hook("title", event => {
      event.result = "Generate image fixture";
    });
    const providerID = Provider.ID.make(sessionProvider);
    await ctx.provider.transform(editor =>
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "synthetic" },
        },
        models: [...new Set(sessionModels)].map(id => {
          const model = Model.Info.default(providerID, Model.ID.make(id));
          return { ...model, capabilities: { ...model.capabilities, tools: true }, limit: { context: 32768, output: 4096 } };
        }),
      }),
    );
    await ctx.integration.transform(editor =>
      editor.method.update({
        integrationID: "openai",
        method: { id: methodID, type: "oauth", label: "Synthetic OAuth" },
        authorize: async () => ({
          mode: "code",
          url: "https://example.invalid/oauth",
          instructions: "Hermetic test",
          callback: async () => ({
            type: "oauth",
            methodID,
            access: expectedRefreshes ? "expired-synthetic-access" : "refreshed-synthetic-access",
            refresh: expectedRefreshes ? "synthetic-refresh-0" : "rotated-refresh-1",
            expires: expectedRefreshes ? 1 : Date.now() + 3600_000,
            metadata: { accountID: "fixture-account" },
          }),
        }),
        refresh: async value => {
          refreshed++;
          refreshSawInitial = value.refresh;
          assert.equal(value.refresh.startsWith("synthetic-refresh-0") || value.refresh.startsWith("rotated-refresh-"), true);
          // Rotate BOTH tokens and set a future expiry so native persistence
          // can be proven by exactly one refresh across two sequential calls.
          return { ...value, access: "refreshed-synthetic-access", refresh: `rotated-refresh-${refreshed}`, expires: Date.now() + 3600_000 };
        },
      }),
    );
    // Both branches use shipped registration. The production default branch
    // gets real native session IDs, with only its transport redirected locally.
    if (defaultBackend) return registerImages(mode === "override" ? { ...ctx, options: { responsesModel: "gpt-6.1-sol-override" } } : ctx);
    return registerImages(ctx, new CodexImageBackend({ resolve: () => resolveImageCredential(ctx) }, `http://127.0.0.1:${server.port}/responses`));
  },
});

const host = await OpenCode.create({
  app: { name: "generate-image-host-tests", version: HOST_VERSION },
  database: { path: join(root, "host.sqlite") },
  config: {
    directory: configDir,
    project: false,
    content: JSON.stringify({ update: "disable", model: `${sessionProvider}/${sessionModels[0]}`, plugins: ["*", "-opencode.provider.*"] }),
  },
  models: { fetch: false, snapshot: false },
  fs: { filewatcher: false, fff: false },
  plugins: [fixture],
});

const noCredentials = (raw: string, scenario: string) => {
  for (const secret of ["expired-synthetic-access", "refreshed-synthetic-access", "synthetic-refresh-0", "rotated-refresh-"])
    assert(!raw.includes(secret), `${scenario}: credentials must never enter history`);
};

try {
  await host.integration.list({ location: { directory } });
  const auth = await host.integration.oauth.connect({ integrationID: "openai", methodID, location: { directory } });
  await host.integration.oauth.complete({ integrationID: "openai", attemptID: auth.data.attemptID, location: { directory }, code: "synthetic-code" });

  // 1. Catalog/discovery without a backend call. This is the second
  // compatibility check: the shipped entrypoint registers exactly
  // `generate_image` with Code Mode + permission, proven through search.
  step = 0;
  code = `return search({query:"generate_image"});`;
  {
    const before = calls;
    const session = await host.session.create({
      location: { directory },
      agent: "build",
      model: { providerID: sessionProvider, id: sessionModels[0]! },
    });
    await host.session.prompt({ sessionID: session.id, text: "List the image tool" });
    await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
    const raw = JSON.stringify(await host.session.context({ sessionID: session.id }));
    noCredentials(raw, "catalog");
    assert.equal(calls, before, "Catalog search must not call the image backend");
    assert(raw.includes("generate_image"), `Code Mode catalog must expose generate_image: ${raw.slice(0, 2000)}`);
  }

  // 2 + 3. Two sequential generations verify native tool execution and payloads.
  // Injected/fallback scenarios start expired and share one persisted refresh;
  // OpenAI model-selection scenarios start fresh to avoid model-refresh races.
  for (const [index, outputPath] of ["generate.png", "generate-again.png"].entries()) {
    step = 0;
    code = `return await tools.generate_image(${JSON.stringify({ prompt: "A red square", outputPath })});`;
    const before = calls;
    const session = await host.session.create({
      location: { directory },
      agent: "build",
      model: { providerID: sessionProvider, id: sessionModels[index]! },
    });
    await host.session.prompt({ sessionID: session.id, text: "Generate one red icon" });
    await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
    const raw = JSON.stringify(await host.session.context({ sessionID: session.id }));
    noCredentials(raw, outputPath);
    assert.equal(calls, before + 1, `${outputPath}: exact generate_image must call the backend once`);
    assert.equal(seenAuth, "Bearer refreshed-synthetic-access", `${outputPath}: rotated access must authorize the request`);
    assert.equal(seenAccount, "fixture-account", `${outputPath}: account header must be sent`);
    const bytes = await readFile(join(directory, outputPath));
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 8);
    assert(raw.includes(outputPath), "Tool must report the saved image path in native history");
    assert(raw.includes('"width":8') || raw.includes("generate_image"), `Native file result must reach history: ${raw.slice(0, 2000)}`);
    assert.equal(refreshed, expectedRefreshes, "Native refresh count must match the synthetic credential scenario");
  }
  if (expectedRefreshes) assert.equal(refreshSawInitial, "synthetic-refresh-0", "Refresh must observe the initial synthetic refresh token");
  assert.equal(calls, 2, "Two generations must produce exactly two backend calls");

  // 4. Native permission denial: no backend call, no output, no credentials.
  step = 0;
  code = `return await tools.generate_image(${JSON.stringify({ prompt: "A red square", outputPath: "denied.png" })});`;
  {
    const before = calls;
    const session = await host.session.create({
      location: { directory },
      agent: "build",
      model: { providerID: sessionProvider, id: sessionModels[0]! },
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "generate_image", resource: "*", effect: "deny" },
      ],
    });
    await host.session.prompt({ sessionID: session.id, text: "Generate one red icon" });
    await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
    const raw = JSON.stringify(await host.session.context({ sessionID: session.id }));
    noCredentials(raw, "denied");
    assert.equal(calls, before, "Denied generate_image must not call the backend");
    assert(!(await readdir(directory)).includes("denied.png"), "Denied generation must not write output");
    assert(
      /Unknown tool|Permission denied|generate_image|permission/i.test(raw),
      `Denial must be visible in history: ${raw.slice(0, 2000)}`,
    );
  }

  assert.equal(refreshed, expectedRefreshes, "Denied call must not trigger another refresh");
  // 5. Settled native host cancellation, injected variant only to avoid
  // duplicating every default-model test. Deterministic started body gate,
  // no sleeps: the owned backend holds its SSE stream open with no image
  // packet until the real host session is interrupted with continue:false
  // (resume:false). Real nativeSession/interrupt, no mocks.
  if (mode === "injected") {
    step = 0;
    code = `return await tools.generate_image(${JSON.stringify({ prompt: "A red square", outputPath: "cancelled.png" })});`;
    cancelArmed = true;
    cancelPosts = 0;
    cancelAborted = false;
    cancelStreamCancelled = false;
    cancelAuth = "";
    cancelSeenModel = "";
    const started = new Promise<void>(resolve => {
      cancelStartedResolve = resolve;
    });
    let startedTimer: ReturnType<typeof setTimeout> | undefined;
    const startedTimeout = new Promise<never>((_, reject) => {
      startedTimer = setTimeout(() => reject(new Error("Cancellation backend never received the generate_image request")), 30_000);
    });
    const aborted = new Promise<void>(resolve => {
      if (cancelAborted) resolve();
      else cancelAbortedResolve = resolve;
    });
    let abortedTimer: ReturnType<typeof setTimeout> | undefined;
    const abortedTimeout = new Promise<never>((_, reject) => {
      abortedTimer = setTimeout(() => reject(new Error("Owned backend never observed HTTP stream cancellation/abort")), 10_000);
    });
    const callsBeforeCancel = calls;
    const refreshedBeforeCancel = refreshed;
    const session = await host.session.create({
      location: { directory },
      agent: "build",
      model: { providerID: sessionProvider, id: sessionModels[0]! },
    });
    await host.session.prompt({ sessionID: session.id, text: "Generate one red icon" });
    try {
      await Promise.race([started, startedTimeout]);
    } finally {
      if (startedTimer !== undefined) clearTimeout(startedTimer);
    }
    // continue:false means do not resume after interrupt.
    const interrupted = await host.session.interrupt({ sessionID: session.id, resume: false });
    assert.equal(interrupted.interrupted, true, "Native interrupt must report interruption");
    await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
    try {
      await Promise.race([aborted, abortedTimeout]);
    } finally {
      if (abortedTimer !== undefined) clearTimeout(abortedTimer);
    }
    cancelArmed = false;
    cancelStartedResolve = null;
    cancelAbortedResolve = null;
    const raw = JSON.stringify(await host.session.context({ sessionID: session.id }));
    noCredentials(raw, "cancelled");
    assert.equal(cancelPosts, 1, "Cancelled generate_image must reach the backend exactly once with no automatic retry");
    assert.equal(calls, callsBeforeCancel, "Cancelled call must not complete as a normal backend call");
    assert.equal(cancelAuth, "Bearer refreshed-synthetic-access", "Cancelled request must carry the rotated access token");
    assert.equal(cancelSeenModel, expectedModels[0], "Cancelled request must send the selected outer model");
    assert.equal(cancelAborted, true, "Owned backend must observe HTTP stream cancellation/abort");
    assert(!(await readdir(directory)).includes("cancelled.png"), "Cancelled generation must not write output");
    assert(/interrupt|cancel|abort|error/i.test(raw), `Cancellation must be visible in history: ${raw.slice(0, 2000)}`);
    assert(!raw.includes('"width":8'), `Cancelled history must not report success dimensions: ${raw.slice(0, 2000)}`);
    assert.equal(refreshed, refreshedBeforeCancel, "Cancelled call must not trigger another refresh");
  }

  assert.equal(refreshed, expectedRefreshes, "Denied/cancelled calls must not trigger another refresh");
  assert.deepEqual(seenModels, expectedModels);
  assert.deepEqual(responseShapes, ["final-output", "streamed-done-empty-final"]);
  console.log(JSON.stringify({ status: "generate-image-native-verified", mode, calls, refreshed, seenAccount, seenModels, responseShapes, cancelPosts, cancelAborted, cancelStreamCancelled, cancelSeenModel }));
} finally {
  try {
    await host.close();
  } finally {
    await server.stop(true);
    fetchFixture?.mockRestore();
  }
}
