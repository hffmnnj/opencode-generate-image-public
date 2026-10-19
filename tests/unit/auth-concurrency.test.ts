import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { setImmediate } from "node:timers/promises";
import { CodexImageBackend, resolveImageCredential } from "../../src/index.ts";
import { imageInputSchema } from "../../src/options.ts";

const context = (connection: unknown) => ({ integration: { connection } }) as Pick<Plugin.Context, "integration">;
const credential = (version: number) => ({ type: "oauth", access: `rotated-${version}`, expires: Date.now() + 3600_000 });

test("concurrent locations read rotated state in FIFO order without overlapping active or resolution", async () => {
  const activeEntered = Promise.withResolvers<void>();
  const releaseActive = Promise.withResolvers<void>();
  const resolveEntered = Promise.withResolvers<void>();
  const releaseResolve = Promise.withResolvers<void>();
  let version = 0;
  const reads: string[] = [];
  const connection = (location: string) => ({
    async active() {
      const selected = version;
      reads.push(`${location}:${selected}`);
      if (location === "first") { activeEntered.resolve(); await releaseActive.promise; }
      return { selected };
    },
    async resolve({ selected }: { selected: number }) {
      if (location === "first") { resolveEntered.resolve(); await releaseResolve.promise; }
      if (selected !== version) throw new Error("Native refresh used stale rotation");
      return credential(++version);
    },
  });
  const first = resolveImageCredential(context(connection("first")));
  await activeEntered.promise;
  const second = resolveImageCredential(context(connection("second")));
  const third = resolveImageCredential(context(connection("third")));
  const settled = Promise.allSettled([first, second, third]);
  // Drain runnable work while the first native boundary is explicitly held.
  await setImmediate();
  const readsWhileActiveHeld = [...reads];
  releaseActive.resolve();
  await resolveEntered.promise;
  await setImmediate();
  const readsWhileResolveHeld = [...reads];
  releaseResolve.resolve();
  const results = await settled;
  expect(readsWhileActiveHeld).toEqual(["first:0"]);
  expect(readsWhileResolveHeld).toEqual(["first:0"]);
  expect(reads).toEqual(["first:0", "second:1", "third:2"]);
  expect(results).toEqual([
    { status: "fulfilled", value: { access: "rotated-1" } },
    { status: "fulfilled", value: { access: "rotated-2" } },
    { status: "fulfilled", value: { access: "rotated-3" } },
  ]);
});

test("failed native resolution releases the queue for the next fresh lookup", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  const failed = resolveImageCredential(context({
    async active() { reads++; return {}; },
    async resolve() { entered.resolve(); await release.promise; throw new Error("synthetic-native-failure"); },
  })).catch((error: Error) => error.message);
  await entered.promise;
  const next = resolveImageCredential(context({
    async active() { reads++; return {}; },
    async resolve() { return credential(7); },
  }));
  await setImmediate();
  const readsBeforeSettlement = reads;
  release.resolve();
  expect(await failed).toContain("reconnect ChatGPT OAuth");
  expect(await next).toEqual({ access: "rotated-7" });
  expect(readsBeforeSettlement).toBe(1);
  expect(reads).toBe(2);
});

test("cancelled generation stops waiting but cannot unlock an unsettled native resolver", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  let resolving = 0;
  let maxResolving = 0;
  let version = 0;
  let requests = 0;
  let seenAuth = "";
  const ctx = context({
    async active() { reads++; return {}; },
    async resolve() {
      maxResolving = Math.max(maxResolving, ++resolving);
      try {
        if (version === 0) { entered.resolve(); await release.promise; }
        return credential(++version);
      } finally { resolving--; }
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    seenAuth = request.headers.get("authorization") ?? "";
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"image_generation_call","status":"completed","result":"eA=="}]}}\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  const backend = new CodexImageBackend({ resolve: () => resolveImageCredential(ctx) }, `http://127.0.0.1:${server.port}/responses`);
  const input = imageInputSchema.parse({ prompt: "Synthetic cancellation" });
  const controller = new AbortController();
  try {
    const cancelled = backend.generate(input, [], controller.signal).catch((error: Error) => error.message);
    await entered.promise;
    controller.abort();
    expect(await cancelled).toContain("cancelled or timed out");
    expect(requests).toBe(0);
    const next = backend.generate(input, [], new AbortController().signal);
    await setImmediate();
    const readsBeforeSettlement = reads;
    release.resolve();
    expect(await next).toEqual(Buffer.from("x"));
    expect(readsBeforeSettlement).toBe(1);
    expect(maxResolving).toBe(1);
    expect(requests).toBe(1);
    expect(seenAuth).toBe("Bearer rotated-2");
  } finally { release.resolve(); await server.stop(true); }
});
