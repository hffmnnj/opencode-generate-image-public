import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { registerImages } from "../../src/index.ts";
import { imageInputSchema } from "../../src/options.ts";

test.each(["gpt-6.1-sol#max", "working-model-alias", "openai/gpt-6.1-sol", "gpt-6.1-sol\n"])("native registration explains invalid OpenAI session identifier %j before resolving OAuth", async id => {
  let tool: Info | undefined;
  let authCalls = 0;
  const ctx = {
    options: {},
    location: { project: { id: "project", directory: "/unused-project" } },
    session: { get: async () => ({ projectID: "project", location: { directory: "/unused-project" }, model: { providerID: "openai", id } }) },
    integration: { connection: { active: async () => { authCalls++; throw new Error("must not resolve"); } } },
    tool: { transform: async (edit: (editor: { add(value: Info): void }) => void) => {
      edit({ add: value => { tool = value; } });
      return { dispose: async () => {} };
    } },
  } as unknown as Plugin.Context;
  const dispose = await registerImages(ctx);
  try {
    expect(tool?.name).toBe("generate_image");
    if (!tool) throw new Error("Missing registered tool");
    const result = tool.execute(imageInputSchema.parse({ prompt: "A red square" }), {
      sessionID: "session", signal: new AbortController().signal,
    } as unknown as ToolContext);
    await expect(result).rejects.toThrow("set the generate-image plugin responsesModel option to the actual API model ID");
    await expect(result).rejects.toThrow("No endpoint, provider or authentication fallback was attempted");
    expect(authCalls).toBe(0);
  } finally { await dispose(); }
});

test.each([{ responsesModel: "gpt-6.1-sol#max" }, { endpoint: "https://example.invalid" }, { refresh: true }])("native registration rejects strict plugin options with supported-controls explanation %j", async options => {
  await expect(registerImages({ options } as unknown as Plugin.Context)).rejects.toThrow("Only timeoutMs (1000–900000) and responsesModel");
});
