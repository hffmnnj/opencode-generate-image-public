import { z } from "zod";

export const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_RESPONSES_MODEL = "gpt-6.1-sol";
export const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";
export const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const;
export const LIMITS = Object.freeze({
  responseBytes: 96 * 1024 * 1024,
  imageBytes: 32 * 1024 * 1024,
  referenceBytes: 20 * 1024 * 1024,
  totalReferenceBytes: 40 * 1024 * 1024,
  pixels: 16_777_216,
  streamEvents: 20_000,
  streamLines: 100_000,
  eventDataLines: 256,
});

// The end assertion rejects even a trailing newline (which JavaScript's $ permits).
export const responsesModelSchema = z.string().max(200).regex(/^gpt-[a-z0-9][a-z0-9._-]*(?![\s\S])/,
  "Use a GPT API model identifier without provider prefixes, # variants, whitespace or unsafe characters");

export const imageOptionsSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(900_000).default(600_000),
  responsesModel: responsesModelSchema.optional(),
}).strict();
export type ImageOptions = z.infer<typeof imageOptionsSchema>;

export function validSize(size: string): boolean {
  if (size === "auto") return true;
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) return false;
  const [width, height] = size.split("x").map(Number) as [number, number];
  return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840
    && Math.max(width, height) <= 3 * Math.min(width, height)
    && width * height >= 655_360 && width * height <= 8_294_400;
}

/** Validate raw segments BEFORE any path normalization: a/../b and a/.secret/../b are invalid. */
export function validRelativePath(path: string): boolean {
  return path.length <= 240 && !/[\x00-\x1f\x7f\\:]/.test(path)
    && path.split("/").every(part => part.length > 0 && !part.startsWith("."));
}
const localPath = z.string().min(1).max(240).refine(validRelativePath,
  "Use a project-relative path without hidden, empty, backslash or traversal segments");

export const imageInputSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  model: z.enum(IMAGE_MODELS).default(IMAGE_MODELS[0]),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).default("auto"),
  size: z.string().max(9).refine(validSize,
    "Use auto or dimensions divisible by 16, 655360–8294400 pixels, at most 3840 per edge and 3:1 aspect ratio").default("1024x1024"),
  referenceImages: z.array(localPath.refine(path => /\.(png|jpe?g|webp)$/i.test(path),
    "References must end in .png, .jpg, .jpeg or .webp")).max(5).default([])
    .describe("Project/session-relative PNG, JPEG or WebP files. Only these references and the prompt are sent."),
  outputPath: localPath.refine(path => path.endsWith(".png"), "Output must end in .png").optional()
    .describe("A new project/session-relative .png file; never overwrites. Default: generated-images/<unique-id>.png."),
  action: z.enum(["generate", "edit", "auto"]).default("generate"),
}).strict().refine(input => input.action !== "edit" || input.referenceImages.length > 0,
  "Editing requires at least one reference image");
export type ImageInput = z.infer<typeof imageInputSchema>;

export const imageOutputSchema = z.object({
  path: z.string(),
  uri: z.string(),
  model: z.enum(IMAGE_MODELS),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]),
  requestedSize: z.string(),
  action: z.enum(["generate", "edit", "auto"]),
  mime: z.literal("image/png"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  transparent: z.boolean(),
  warning: z.string().optional(),
});
export type ImageOutput = z.infer<typeof imageOutputSchema>;
