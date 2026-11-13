import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { CodexImageBackend, type ImageBackend, type ImageCredential } from "./api.ts";
import { abortable, ImageError, RECONNECT, safeMessage } from "./errors.ts";
import { DEFAULT_RESPONSES_MODEL, imageInputSchema, imageOptionsSchema, imageOutputSchema } from "./options.ts";
import { ImageService } from "./service.ts";

// All image locations sharing this module queue together. No credential is cached:
// each turn re-reads active state after any previous native rotation has settled.
let imageAuthQueue: Promise<void> = Promise.resolve();

/** No auth caching, auth files, refresh grants or credential persistence in this package. */
export async function resolveImageCredential(ctx: Pick<Plugin.Context, "integration">): Promise<ImageCredential> {
  const previous = imageAuthQueue;
  let release!: () => void;
  imageAuthQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const connection = await ctx.integration.connection.active("openai");
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
    if (credential?.type !== "oauth" || !Number.isFinite(credential.expires) || credential.expires <= Date.now()
      || !credential.access || credential.access.length > 16_384 || !/^[\x21-\x7e]+$/.test(credential.access))
      throw new ImageError(RECONNECT);
    const accountID = credential.metadata?.accountID;
    if (accountID !== undefined && (typeof accountID !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(accountID)))
      throw new ImageError(RECONNECT);
    return { access: credential.access, ...(typeof accountID === "string" ? { accountID } : {}) };
  } catch { throw new ImageError(RECONNECT); }
  // Outer abortable callers may stop waiting, but only native settlement releases
  // this turn. This does not serialize model requests or other processes.
  finally { release(); }
}

/** Explicit helper for isolated exact-version hosts. The default plugin has no endpoint option. */
export async function registerImages(ctx: Plugin.Context, backend?: ImageBackend): Promise<() => Promise<void>> {
  const parsed = imageOptionsSchema.safeParse(ctx.options);
  if (!parsed.success) throw new ImageError("Invalid generate_image plugin options. Only timeoutMs (1000–900000) and responsesModel (a GPT API identifier without provider prefixes, # variants or unsafe characters, at most 200 characters) are supported.");
  const shutdown = new AbortController();
  const service = backend ? new ImageService(backend) : undefined;
  const registration = await ctx.tool.transform(editor => {
    editor.add({
      name: "generate_image",
      description: "Generate or edit one GPT Image 2.5 Sunburst/Flare image using the active OpenAI ChatGPT OAuth subscription. Uses subscription quota. Sends only the prompt and up to five project/session-relative PNG/JPEG/WebP references. Writes one unique PNG inside the session project; never overwrites. No automatic retries. Native transparency/chroma-key is not supported.",
      input: imageInputSchema,
      output: imageOutputSchema,
      options: { codemode: true, permission: "generate_image" },
      execute: async (input, context) => {
        const signal = AbortSignal.any([context.signal, shutdown.signal, AbortSignal.timeout(parsed.data.timeoutMs)]);
        try {
          const session = await abortable(ctx.session.get({ sessionID: context.sessionID }), signal);
          if (session.projectID !== ctx.location.project.id) throw new ImageError("Session project changed; invoke generate_image again from its current project.");
          const invocationService = service ?? new ImageService(new CodexImageBackend(
            { resolve: () => resolveImageCredential(ctx) }, undefined,
            parsed.data.responsesModel ?? (session.model?.providerID === "openai" ? session.model.id : DEFAULT_RESPONSES_MODEL),
          ));
          const output = await invocationService.generate(session.location.directory, input, signal, ctx.location.project.directory);
          return { output, content: [
            { type: "text", text: JSON.stringify(output) },
            { type: "file", uri: output.uri, mime: "image/png" },
          ] };
        } catch (error) { throw new ToolError({ message: safeMessage(error) }); }
      },
    });
  });
  return async () => { shutdown.abort(); await registration.dispose(); };
}

export default Plugin.define({ id: "hffmnnj.generate-image", setup: ctx => registerImages(ctx) });
export { CodexImageBackend, decodeImageStream, imageRequest } from "./api.ts";
export { imageInputSchema, imageOutputSchema } from "./options.ts";
