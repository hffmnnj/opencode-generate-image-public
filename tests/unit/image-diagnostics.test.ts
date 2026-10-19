import { expect, spyOn, test } from "bun:test";
import { CodexImageBackend, decodeImageStream } from "../../src/api.ts";
import { ImageError } from "../../src/errors.ts";
import { imageInputSchema, LIMITS } from "../../src/options.ts";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = (item: unknown) => event({ type: "response.output_item.done", item });
const completed = (output: unknown[]) => event({ type: "response.completed", response: { status: "completed", output } });
const image = { type: "image_generation_call", id: "private-image-id", status: "completed", result: "YWJj" };
const emptyCounts = {
  message: 0, reasoning: 0, function_call: 0, image_generation_call: 0, other: 0,
  image_functions: { image_generation: 0, image_gen: 0, imagegen: 0 },
};

function diagnostics(error: unknown) {
  expect(error).toBeInstanceOf(ImageError);
  const message = (error as Error).message;
  expect(message).toStartWith("Expected exactly one completed image; no image was saved.");
  expect(message.length).toBeLessThan(1024);
  const marker = "Image response counts: ";
  expect(message).toContain(marker);
  return JSON.parse(message.slice(message.indexOf(marker) + marker.length));
}

function streamError(stream: string): unknown {
  try { decodeImageStream(stream); } catch (error) { return error; }
  throw new Error("Expected an image-count failure, not image bytes");
}

test("text-only completed output reports no streamed or final image without exposing text", () => {
  const message = { type: "message", content: [{ type: "output_text", text: "PRIVATE_PROMPT Bearer secret" }] };
  const error = streamError(done(message) + completed([message]));
  expect(diagnostics(error)).toEqual({
    count_limit: LIMITS.streamEvents, final_output: 1, final_image_generation_call: 0,
    streamed_image_items: 0, streamed_image_results: 0,
    done: { ...emptyCounts, message: 1 }, final: { ...emptyCounts, message: 1 },
  });
  expect((error as Error).message).not.toMatch(/PRIVATE_PROMPT|Bearer|secret/);
});

test("streamed validated image survives empty final output only after completed response", () => {
  expect(decodeImageStream(done(image) + completed([]))).toEqual(Buffer.from("abc"));
});

test("duplicate streamed image events distinguish validated items from unique results", () => {
  // Duplicate done events may deduplicate, but duplicate final image entries
  // must still fail even when they share the same ID and result.
  const counts = diagnostics(streamError(done(image) + done(image) + completed([image, image])));
  expect(counts.streamed_image_items).toBe(2);
  expect(counts.streamed_image_results).toBe(1);
  expect(counts.done.image_generation_call).toBe(2);
});

test("function requests count only exact static image names and known item types", () => {
  const secret = "PRIVATE_PROMPT Bearer secret access_token=secret refresh_token=secret private-model private-id YWJj";
  const items = [
    ...["image_generation", "image_gen", "imagegen", "image_generation.extra", "IMAGE_GEN", secret].map(name =>
      ({ type: "function_call", name, arguments: secret, call_id: secret, id: secret })),
    { type: "message", content: [{ type: "output_text", text: secret }] },
    { type: "reasoning", summary: secret }, { type: secret },
  ];
  const error = streamError(items.map(done).join("") + completed(items));
  const counts = { ...emptyCounts, message: 1, reasoning: 1, function_call: 6, other: 1,
    image_functions: { image_generation: 1, image_gen: 1, imagegen: 1 } };
  expect(diagnostics(error)).toEqual({
    count_limit: LIMITS.streamEvents, final_output: 9, final_image_generation_call: 0,
    streamed_image_items: 0, streamed_image_results: 0, done: counts, final: counts,
  });
  expect((error as Error).message).not.toMatch(/PRIVATE_PROMPT|Bearer|secret|access_token|refresh_token|private-model|private-id|YWJj|image_generation\.extra|IMAGE_GEN/);
});

test("multiple final images report both final calls before rejecting", () => {
  const counts = diagnostics(streamError(completed([image, { ...image, id: "second-private-id" }])));
  expect(counts.final_output).toBe(2);
  expect(counts.final_image_generation_call).toBe(2);
  expect(counts.final.image_generation_call).toBe(2);
  expect(counts.streamed_image_results).toBe(0);
});

test("conflicting streamed cardinality reports prior validated results and an unseen final output", () => {
  const counts = diagnostics(streamError(done(image) + done({ ...image, id: "second-private-id" })));
  expect(counts.final_output).toBeNull();
  expect(counts.final_image_generation_call).toBeNull();
  expect(counts.final).toBeNull();
  expect(counts.streamed_image_items).toBe(1);
  expect(counts.streamed_image_results).toBe(1);
  expect(counts.done.image_generation_call).toBe(2);
});

test("stream/final identity mismatch includes counts at the final validation failure", () => {
  const counts = diagnostics(streamError(done(image) + completed([{ ...image, id: "second-private-id" }])));
  expect(counts.final_image_generation_call).toBe(1);
  expect(counts.streamed_image_results).toBe(1);
  expect(counts.done.image_generation_call).toBe(1);
});

test("many distinct provider strings cannot grow count diagnostics or create dynamic buckets", () => {
  const stream = Array.from({ length: LIMITS.streamEvents - 1 }, (_, index) =>
    done({ type: "function_call", name: `secret-${index}`, arguments: "Bearer secret" })).join("") + completed([]);
  const error = streamError(stream);
  const counts = diagnostics(error);
  expect(counts.done).toEqual({ ...emptyCounts, function_call: LIMITS.streamEvents - 1 });
  expect((error as Error).message).not.toContain("secret");
});

test("final counts saturate at the existing event limit without altering cardinality rejection", () => {
  const counts = diagnostics(streamError(completed(Array(LIMITS.streamEvents + 1).fill({ type: "provider-private-type" }))));
  expect(counts.final_output).toBe(LIMITS.streamEvents);
  expect(counts.final.other).toBe(LIMITS.streamEvents);
  expect(counts.final_image_generation_call).toBe(0);
});

test("backend JSON no-image failure exposes the same safe counts with one request", async () => {
  const response = { object: "response", id: "private-response-id", status: "completed", output: [
    { type: "function_call", name: "image_generation", arguments: "PRIVATE_PROMPT Bearer secret" },
  ] };
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response));
  try {
    const input = imageInputSchema.parse({ prompt: "PRIVATE_PROMPT" });
    const error = await new CodexImageBackend({ resolve: async () => ({ access: "synthetic-only" }) })
      .generate(input, [], new AbortController().signal).catch(error => error);
    const counts = diagnostics(error);
    expect(counts.final.function_call).toBe(1);
    expect(counts.final.image_functions.image_generation).toBe(1);
    expect(counts.done).toEqual(emptyCounts);
    expect((error as Error).message).not.toMatch(/PRIVATE_PROMPT|Bearer|secret|private-response-id/);
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});
