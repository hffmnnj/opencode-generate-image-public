import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ImageBackend } from "./api.ts";
import { checkSignal, ImageError } from "./errors.ts";
import { ProjectFiles } from "./files.ts";
import { normalizeImage } from "./images.ts";
import { imageInputSchema, LIMITS, type ImageInput, type ImageOutput } from "./options.ts";

export class ImageService {
  constructor(private readonly backend: ImageBackend) {}

  async generate(root: string, rawInput: ImageInput, signal: AbortSignal, projectDirectory = root): Promise<ImageOutput> {
    const parsed = imageInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ImageError("Invalid image input. Check prompt, model, quality, size, action and project-relative image paths.");
    const input = parsed.data;
    checkSignal(signal);
    const files = await ProjectFiles.open(root, projectDirectory);
    try {
      const outputName = input.outputPath ?? `generated-images/${randomUUID()}.png`;
      const path = await files.prepareOutput(outputName, signal);
      const references: string[] = [];
      let referenceBytes = 0;
      let decodedReferenceBytes = 0;
      for (const name of input.referenceImages) {
        checkSignal(signal);
        const bytes = await files.readReference(name, signal);
        referenceBytes += bytes.length;
        if (referenceBytes > LIMITS.totalReferenceBytes) throw new ImageError("References exceed the aggregate 40 MiB limit; no image request was sent.");
        const { png } = await normalizeImage(bytes, true, signal);
        // Enforce aggregate bounds on the actual bytes sent, including format expansion.
        decodedReferenceBytes += png.length;
        if (decodedReferenceBytes > LIMITS.totalReferenceBytes) throw new ImageError("Decoded references exceed the aggregate 40 MiB limit; no image request was sent.");
        checkSignal(signal);
        references.push(`data:image/png;base64,${png.toString("base64")}`);
      }
      checkSignal(signal);
      const generated = await this.backend.generate(input, references, signal);
      checkSignal(signal);
      const image = await normalizeImage(generated, false, signal);
      checkSignal(signal);
      await files.save(outputName, image.png, signal);
      return {
        path, uri: pathToFileURL(path).href, model: input.model, quality: input.quality, requestedSize: input.size,
        action: input.action, mime: "image/png", width: image.width, height: image.height,
        bytes: image.png.length, transparent: image.transparent,
        ...(input.size !== "auto" && input.size !== `${image.width}x${image.height}`
          ? { warning: `Requested ${input.size}; backend returned ${image.width}x${image.height}. Actual resolution preserved.` } : {}),
      };
    } finally { await files.close(); }
  }
}
