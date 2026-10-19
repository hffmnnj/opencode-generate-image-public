import { abortable, CANCELLED, checkSignal, ImageError, providerErrorReason, RECONNECT } from "./errors.ts";
import { DEFAULT_RESPONSES_MODEL, IMAGE_ENDPOINT, LIMITS, responsesModelSchema, USER_AGENT, type ImageInput } from "./options.ts";

export interface ImageCredential { readonly access: string; readonly accountID?: string }
export interface ImageAuth { resolve(): Promise<ImageCredential> }
export interface ImageBackend {
  generate(input: ImageInput, references: readonly string[], signal: AbortSignal): Promise<Buffer>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Diagnostics have fixed keys and saturating counters, never provider strings.
// The existing event limit also bounds JSON-output diagnostic counters; it does
// not impose a new payload acceptance limit.
const boundedCount = (count: number) => Math.min(count, LIMITS.streamEvents);
const itemCounts = () => ({
  message: 0, reasoning: 0, function_call: 0, image_generation_call: 0, other: 0,
  image_functions: { image_generation: 0, image_gen: 0, imagegen: 0 },
});
type ItemCounts = ReturnType<typeof itemCounts>;

function countItem(counts: ItemCounts, item: unknown): void {
  switch (record(item) ? item.type : undefined) {
    case "message": counts.message = boundedCount(counts.message + 1); break;
    case "reasoning": counts.reasoning = boundedCount(counts.reasoning + 1); break;
    case "image_generation_call": counts.image_generation_call = boundedCount(counts.image_generation_call + 1); break;
    case "function_call":
      counts.function_call = boundedCount(counts.function_call + 1);
      // Local CLI hosted-tool name and Codex ext/image-generation/src/lib.rs's
      // namespace/tool constants. Exact matches only; no dynamic name buckets.
      if (record(item)) switch (item.name) {
        case "image_generation": counts.image_functions.image_generation = boundedCount(counts.image_functions.image_generation + 1); break;
        case "image_gen": counts.image_functions.image_gen = boundedCount(counts.image_functions.image_gen + 1); break;
        case "imagegen": counts.image_functions.imagegen = boundedCount(counts.image_functions.imagegen + 1); break;
      }
      break;
    default: counts.other = boundedCount(counts.other + 1);
  }
}

/** Read at most 16 KiB of error JSON; malformed/unknown bodies remain generic.
 * Reading shares the caller's cancellation/timeout. Never wait for peer cancellation.
 */
async function rejectionReason(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const maxBytes = 16 * 1024;
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => {});
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      checkSignal(signal);
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) return;
      if (next.value.byteLength) chunks.push(next.value);
    }
    checkSignal(signal);
    return providerErrorReason(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))));
  } catch {
    checkSignal(signal);
    return;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function validateResponsesModel(model: string): string {
  const parsed = responsesModelSchema.safeParse(model);
  if (!parsed.success) throw new ImageError("Invalid Responses model. Use a GPT API identifier without provider prefixes or # variants; set the generate-image plugin responsesModel option to the actual API model ID for a session alias. No endpoint, provider or authentication fallback was attempted.");
  return parsed.data;
}

export function imageRequest(input: ImageInput, references: readonly string[], responsesModel = DEFAULT_RESPONSES_MODEL) {
  // Deliberately follows an earlier image client, not Codex
  // HEAD 76ed3b484d62ccceb9fa512ff4dd139f421814c3's newer /images/generations and
  // /images/edits protocol for gpt-image-2. Only the outer Responses model selection
  // differs: the CLI's hardcoded gpt-5.5 was rejected by this subscription.
  return {
    model: validateResponsesModel(responsesModel),
    instructions: "You are an image generation assistant. Generate exactly one image.",
    input: [{ role: "user", content: [
      { type: "input_text", text: input.prompt },
      ...references.map(image_url => ({ type: "input_image", image_url, detail: "high" })),
    ] }],
    tools: [{ type: "image_generation", model: input.model, quality: input.quality,
      size: input.size, action: input.action, output_format: "png" }],
    tool_choice: { type: "image_generation" }, stream: true, store: false,
  };
}

/** Incremental SSE framing; a retained image is released only after whole-response completion. */
export class ImageStreamDecoder {
  private lineParts: string[] = [];
  private partialLine = "";
  private data: string[] = [];
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private total = 0;
  private events = 0;
  private lineCount = 0;
  private complete = false;
  private ended = false;
  private image: string | undefined;
  private readonly items = new Map<string, string>();
  private readonly doneCounts = itemCounts();
  private finalCounts: ItemCounts | null = null;
  private finalOutput: number | null = null;
  private finalImageCalls: number | null = null;
  private streamedImageItems = 0;
  private streamedImageResults = 0;

  private exactlyOneError(): ImageError {
    return new ImageError("Expected exactly one completed image; no image was saved. Image response counts: " + JSON.stringify({
      count_limit: LIMITS.streamEvents,
      final_output: this.finalOutput, final_image_generation_call: this.finalImageCalls,
      streamed_image_items: this.streamedImageItems, streamed_image_results: this.streamedImageResults,
      done: this.doneCounts, final: this.finalCounts,
    }));
  }

  push(bytes: Uint8Array): void {
    this.total += bytes.byteLength;
    if (this.total > LIMITS.responseBytes) throw new ImageError("Image response exceeds the 96 MiB limit; no image was saved.");
    try { this.lines(this.utf8.decode(bytes, { stream: true })); }
    catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageError("Malformed image response stream; no image was saved.");
    }
  }

  private lines(text: string): void {
    let cursor = 0;
    let end: number;
    while ((end = text.indexOf("\n", cursor)) !== -1) {
      if (++this.lineCount > LIMITS.streamLines) throw new ImageError("Too many image response lines; no image was saved.");
      this.partialLine += text.slice(cursor, end);
      let line = this.lineParts.length ? [...this.lineParts, this.partialLine].join("") : this.partialLine;
      this.lineParts = [];
      this.partialLine = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      cursor = end + 1;
      if (line === "") this.event();
      else if (line.startsWith("data:")) {
        if (this.data.length >= LIMITS.eventDataLines) throw new ImageError("Too many data lines in an image event; no image was saved.");
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (cursor < text.length) this.partialLine += text.slice(cursor);
    if (this.partialLine.length >= 64 * 1024) {
      // Flatten periodically: an adversarial one-byte stream must not retain millions of string ropes.
      this.lineParts.push(Buffer.from(this.partialLine).toString("utf8"));
      this.partialLine = "";
    }
  }

  private event(): void {
    if (this.data.length === 0) return;
    const data = this.data.join("\n");
    this.data = [];
    if (++this.events > LIMITS.streamEvents) throw new ImageError("Too many image response events; no image was saved.");
    if (this.ended) throw new ImageError("Unexpected data after image response ended; no image was saved.");
    if (data === "[DONE]") {
      if (!this.complete) throw new ImageError("Image response ended before completion; no image was saved.");
      this.ended = true;
      return;
    }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch { throw new ImageError("Malformed image response event; no image was saved."); }
    this.acceptEvent(event);
  }

  /** JSON success uses a synthetic completed event, not a second image validator. */
  static fromCompletedResponse(response: unknown): Buffer {
    const decoder = new ImageStreamDecoder();
    decoder.acceptEvent({ type: "response.completed", response });
    return decoder.finish();
  }

  private acceptEvent(event: unknown): void {
    if (!record(event) || typeof event.type !== "string") throw new ImageError("Malformed image response event; no image was saved.");
    if (["error", "response.failed", "response.incomplete", "response.refusal.done", "response.refusal.delta"].includes(event.type))
      throw new ImageError("OpenAI image generation failed or was refused; no image was saved.");
    if (event.type === "response.output_item.done") {
      countItem(this.doneCounts, event.item);
      this.addItem(event.item);
      // Only successfully validated streamed items count here. Final-output
      // validation must not overwrite the evidence from earlier done events.
      if (record(event.item) && event.item.type === "image_generation_call") {
        this.streamedImageItems = boundedCount(this.streamedImageItems + 1);
        this.streamedImageResults = boundedCount(this.items.size);
      }
    }
    if (event.type === "response.completed") {
      if (this.complete || !record(event.response) || event.response.status !== "completed" || !Array.isArray(event.response.output)
        || event.response.error != null || event.response.incomplete_details != null)
        throw new ImageError("Image response did not complete correctly; no image was saved.");
      this.finalOutput = boundedCount(event.response.output.length);
      this.finalCounts = itemCounts();
      for (const item of event.response.output) countItem(this.finalCounts, item);
      const finalImages = event.response.output.filter(item => record(item) && item.type === "image_generation_call");
      this.finalImageCalls = boundedCount(finalImages.length);
      for (const item of event.response.output) this.addItem(item);
      // Native Luna can omit a completed done-event image from final output.
      // CLI cli.py:593–605 likewise retains done-event results. Require whole
      // completion and scan every final item above before selecting the sole
      // validated result; final image items still require their full result.
      const image = this.items.values().next().value;
      if (finalImages.length > 1 || this.items.size !== 1 || typeof image !== "string")
        throw this.exactlyOneError();
      this.image = image;
      this.complete = true;
    }
  }

  private addItem(item: unknown): void {
    if (!record(item)) throw new ImageError("Malformed image response item; no image was saved.");
    if (item.type !== "image_generation_call") {
      if (Array.isArray(item.content) && item.content.some(part => record(part) && part.type === "refusal"))
        throw new ImageError("OpenAI image generation was refused; no image was saved.");
      return;
    }
    if (item.status !== "completed" || typeof item.result !== "string" || !item.result
      || item.result.length > Math.ceil(LIMITS.imageBytes / 3) * 4)
      throw new ImageError("Missing, incomplete or oversized image result; no image was saved.");
    const id = typeof item.id === "string" && item.id ? item.id : "image";
    const prior = this.items.get(id);
    if (prior !== undefined && prior !== item.result) throw new ImageError("Conflicting image results; no image was saved.");
    this.items.set(id, item.result);
    if (this.items.size > 1) throw this.exactlyOneError();
  }

  finish(): Buffer {
    try { this.lines(this.utf8.decode()); }
    catch { throw new ImageError("Malformed image response stream; no image was saved."); }
    if ((this.lineParts.join("") + this.partialLine).trim() || this.data.length || !this.complete || !this.image)
      throw new ImageError("Incomplete image response stream; no image was saved.");
    const encoded = this.image;
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new ImageError("Invalid image encoding; no image was saved.");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > LIMITS.imageBytes || bytes.toString("base64") !== encoded)
      throw new ImageError("Invalid or oversized image encoding; no image was saved.");
    return bytes;
  }
}

export function decodeImageStream(text: string): Buffer {
  const decoder = new ImageStreamDecoder();
  decoder.push(Buffer.from(text));
  return decoder.finish();
}

type SuccessMediaType = "text/event-stream" | "application/json" | "text/plain" | "unknown";

function successMediaType(headers: Headers): SuccessMediaType {
  const mediaType = (headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream" || mediaType === "application/json" || mediaType === "text/plain") return mediaType;
  // Never interpolate an arbitrary provider-controlled header into a tool diagnostic.
  if (mediaType === "text/html") throw new ImageError("Unsupported image response media type (text/html); no image was saved.");
  if (mediaType === "application/octet-stream") throw new ImageError("Unsupported image response media type (application/octet-stream); no image was saved.");
  if (/^image\/[a-z0-9!#$&^_.+-]+$/.test(mediaType ?? "")) throw new ImageError("Unsupported image response media type (raw image); no image was saved.");
  return "unknown";
}

/** Only the fixed authenticated Responses endpoint (or loopback fixture) uses this.
 * CLI cli.py:532–579 and Codex codex-api/src/sse/responses.rs parse SSE without a
 * media-type check. Require an explicit 1 KiB SSE prefix for mislabeled or
 * unknown/missing types, retaining every stream/payload check. JSON requires EOF
 * and a completed Responses envelope; known HTML/binary/image labels are rejected.
 */
class ImageResponseDecoder {
  private readonly stream = new ImageStreamDecoder();
  private mode: "sse" | "json" | undefined;
  private prefix = Buffer.alloc(0);
  private readonly chunks: Buffer[] = [];
  private jsonBlock: Buffer | undefined;
  private jsonUsed = 0;
  private total = 0;

  constructor(private readonly mediaType: SuccessMediaType) {
    if (mediaType === "text/event-stream") this.mode = "sse";
  }

  push(bytes: Uint8Array): void {
    this.total += bytes.byteLength;
    if (this.total > LIMITS.responseBytes) throw new ImageError("Image response exceeds the 96 MiB limit; no image was saved.");
    if (!bytes.byteLength) return;
    if (this.mode) { this.consume(bytes); return; }
    const taken = Math.min(bytes.byteLength, 1024 - this.prefix.length);
    this.prefix = Buffer.concat([this.prefix, bytes.subarray(0, taken)]);
    // latin1 preserves non-ASCII bytes rather than masking them into ASCII tokens.
    const prefix = this.prefix.toString("latin1");
    if (/^(?:\r?\n)*(?:data:|event:|:)/.test(prefix)) this.mode = "sse";
    else if ((this.mediaType === "application/json" || this.mediaType === "unknown") && /^[\x20\t\r\n]*\{/.test(prefix)) this.mode = "json";
    if (!this.mode) {
      if (this.prefix.length === 1024) throw this.formatError();
      return;
    }
    this.consume(this.prefix);
    this.prefix = Buffer.alloc(0);
    this.consume(bytes.subarray(taken));
  }

  private consume(bytes: Uint8Array): void {
    if (!bytes.byteLength) return;
    if (this.mode === "sse") this.stream.push(bytes);
    else {
      // Bound retained chunks too: one-byte JSON reads must not retain millions
      // of tiny arrays or a large backing buffer for a small slice.
      let offset = 0;
      while (offset < bytes.byteLength) {
        this.jsonBlock ??= Buffer.allocUnsafe(64 * 1024);
        const taken = Math.min(bytes.byteLength - offset, this.jsonBlock.length - this.jsonUsed);
        this.jsonBlock.set(bytes.subarray(offset, offset + taken), this.jsonUsed);
        offset += taken;
        this.jsonUsed += taken;
        if (this.jsonUsed === this.jsonBlock.length) {
          this.chunks.push(this.jsonBlock);
          this.jsonBlock = undefined;
          this.jsonUsed = 0;
        }
      }
    }
  }

  private formatError(): ImageError {
    if (this.mediaType === "unknown") return new ImageError("Response body is neither a completed Responses image object nor a complete image event stream; no image was saved.");
    return new ImageError(this.mediaType === "application/json"
      ? "Unexpected image response body for application/json; expected a completed Responses JSON object or an image event stream; no image was saved."
      : "Unexpected image response body for text/plain; expected an image event stream; no image was saved.");
  }

  finish(): Buffer {
    if (this.mode === "sse") return this.stream.finish();
    if (this.mode !== "json") throw this.formatError();
    if (this.jsonBlock) this.chunks.push(this.jsonBlock.subarray(0, this.jsonUsed));
    let response: unknown;
    try { response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.chunks))); }
    catch { throw this.mediaType === "unknown" ? this.formatError() : new ImageError("Malformed Responses JSON body; no image was saved."); }
    if (record(response) && (response.error != null || response.detail != null)) {
      const reason = providerErrorReason(response);
      throw new ImageError(reason ? `OpenAI image request rejected: ${reason}; no automatic retry was attempted.`
        : "OpenAI image generation failed; no image was saved.");
    }
    if (!record(response) || response.object !== "response" || typeof response.id !== "string" || !response.id
      || response.incomplete_details != null)
      throw this.mediaType === "unknown" ? this.formatError() : new ImageError("Invalid completed Responses JSON object; no image was saved.");
    return ImageStreamDecoder.fromCompletedResponse(response);
  }
}

/** Fixed production URL. The only override is a constructor-only loopback fixture. */
export class CodexImageBackend implements ImageBackend {
  constructor(private readonly auth: ImageAuth, private readonly endpoint: string = IMAGE_ENDPOINT,
    private readonly responsesModel: string = DEFAULT_RESPONSES_MODEL) {
    validateResponsesModel(responsesModel);
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new ImageError("Untrusted image endpoint."); }
    if (endpoint !== IMAGE_ENDPOINT && !(url.protocol === "http:" && url.hostname === "127.0.0.1"
      && url.port && url.pathname === "/responses" && !url.username && !url.password && !url.search && !url.hash))
      throw new ImageError("Untrusted image endpoint.");
  }

  async generate(input: ImageInput, references: readonly string[], signal: AbortSignal): Promise<Buffer> {
    checkSignal(signal);
    let credential: ImageCredential;
    try { credential = await abortable(this.auth.resolve(), signal); }
    catch { throw new ImageError(signal.aborted ? CANCELLED : RECONNECT); }
    checkSignal(signal);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${credential.access}`, "content-type": "application/json",
          accept: "text/event-stream", "user-agent": USER_AGENT, originator: "opencode",
          ...(credential.accountID ? { "chatgpt-account-id": credential.accountID } : {}) },
        body: JSON.stringify(imageRequest(input, references, this.responsesModel)),
      });
    } catch { throw new ImageError(signal.aborted ? CANCELLED : "Image request failed; no automatic retry was attempted."); }
    if (!response.ok) {
      // Auth/quota errors retain their established messages and need no body inspection.
      const reason = response.status === 401 || response.status === 429 ? undefined : await rejectionReason(response, signal);
      if (response.status === 401 || response.status === 429) void response.body?.cancel().catch(() => {});
      checkSignal(signal);
      throw new ImageError(response.status === 401 ? RECONNECT
        : response.status === 429 ? "ChatGPT image quota/rate limit reached; no automatic retry was attempted."
        : reason ? `OpenAI image request rejected: ${reason}; no automatic retry was attempted.`
        : `OpenAI image request failed (HTTP ${response.status}); no automatic retry was attempted.`);
    }
    let mediaType: SuccessMediaType;
    try { mediaType = successMediaType(response.headers); }
    catch (error) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > LIMITS.responseBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new ImageError("Image response exceeds the 96 MiB limit; no image was saved.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ImageError("Missing image response body; no image was saved.");
    const decoder = new ImageResponseDecoder(mediaType);
    try {
      while (true) {
        checkSignal(signal);
        const next = await abortable(reader.read(), signal);
        if (next.done) break;
        decoder.push(next.value);
      }
      checkSignal(signal);
      return decoder.finish();
    } catch (error) {
      if (signal.aborted) throw new ImageError(CANCELLED);
      if (error instanceof ImageError) throw error;
      throw new ImageError("Image response stream failed; no automatic retry was attempted.");
    } finally {
      // Do not wait indefinitely for the peer to acknowledge cancellation.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
