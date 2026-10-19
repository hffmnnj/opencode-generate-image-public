/** Only errors constructed here cross the native tool boundary. Never expose causes. */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

export const RECONNECT = "Connect or reconnect ChatGPT OAuth for OpenAI in OpenCode. Image generation requires an active, unexpired OAuth connection, not an API key.";
export const CANCELLED = "Image generation cancelled or timed out; no automatic retry was attempted.";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Finite diagnostic vocabulary, not a provider-text sanitizer. No captured text is returned.
 * Only error.{code,type,param,message} and detail (string or those same fields) are read.
 * These are compatibility patterns, not evidence of which rejection occurred live.
 */
export function providerErrorReason(body: unknown): string | undefined {
  if (!object(body)) return;
  const error = object(body.error) ? body.error : object(body.detail) ? body.detail
    : typeof body.detail === "string" ? { message: body.detail } : undefined;
  if (!error) return;
  if (["code", "type", "param", "message"].some(field => error[field] != null && typeof error[field] !== "string")) return;
  const code = typeof error.code === "string" ? error.code : "";
  const param = typeof error.param === "string" ? error.param : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (code === "unsupported_tool") return "image_generation tool is unsupported";
  if (code === "unsupported_model") return "requested model is unsupported";
  if (code === "model_not_found") return "requested model was not found or is inaccessible";
  if (code === "subscription_required") return "active subscription does not support this image request";

  // Anchored reason phrases, not keyword searches over arbitrary echoed prompts.
  if (/^(?:unsupported tool(?: type)\s*:\s*[`'"]?image_generation\b|(?:the )?tool\s+[`'"]?image_generation[`'"]?\s+(?:is not supported|is unsupported|does not support))/i.test(message))
    return "image_generation tool is unsupported";
  // Codex core/tests/suite/compact.rs documents both detail-string model rejection
  // ("The '...' model is not supported ...") and error-record "Model not found ...".
  // Only the three known model constants map to owned static messages; any other
  // identifier stays generic and is never echoed.
  const modelRejection = /^(?:the )?(?:model\s+[`'"]?([a-z0-9._-]+)[`'"]?|[`'"]([a-z0-9._-]+)[`'"]\s+model)\s+(?:is not supported|is unsupported)\b/i.exec(message);
  if (modelRejection) {
    const identifier = modelRejection[1] ?? modelRejection[2] ?? "";
    if (identifier === "gpt-5.5") return "Responses model gpt-5.5 is unsupported";
    if (identifier === "gpt-image-2.5-sunburst") return "image model gpt-image-2.5-sunburst is unsupported";
    if (identifier === "gpt-image-2.5-flare") return "image model gpt-image-2.5-flare is unsupported";
    return "requested model is unsupported";
  }
  if (/^(?:(?:the )?model\s+[`'"]?[a-z0-9._-]+[`'"]?\s+(?:does not exist|was not found)\b|model not found\b)/i.test(message))
    return "requested model was not found or is inaccessible";
  if (/^(?:invalid|unsupported) (?:parameter|value)\s*:\s*[`'"]?tool_choice\b/i.test(message)) return "tool_choice was rejected";
  if (/^(?:invalid|unsupported) quality\s*:/i.test(message)) return "image quality was rejected";
  if (/^(?:invalid|unsupported) size\s*:/i.test(message)) return "image size was rejected";
  if (/^image generation is (?:not available|not supported) (?:for|with) (?:your|this) (?:subscription|plan)\b/i.test(message))
    return "active subscription does not support this image request";

  // Exact field names only: never echo a param, model name or supplied value.
  if (["invalid_parameter", "invalid_value", "unsupported_parameter", "unsupported_value"].includes(code)
    || error.type === "invalid_request_error") {
    if (param === "tool_choice") return "tool_choice was rejected";
    if (["quality", "tools[0].quality"].includes(param)) return "image quality was rejected";
    if (["size", "tools[0].size"].includes(param)) return "image size was rejected";
    if (["model", "tools[0].model"].includes(param) && code === "unsupported_value") return "requested model is unsupported";
    if (["model", "tools", "tools[0]", "tools[0].type", "tools[0].model", "tools[0].action", "tools[0].output_format"].includes(param))
      return "an image request parameter was rejected";
  }
}

export function safeMessage(error: unknown): string {
  return error instanceof ImageError ? error.message : "Image generation failed; no automatic retry was attempted. No provider error details or credentials were logged.";
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new ImageError(CANCELLED);
}

/** Stop waiting; underlying native work (OAuth refresh or codec) still settles. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(new ImageError(CANCELLED));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
