<p align="center">
  <img src="https://unpkg.com/hffmnnj.generate-image/assets/banner.png" alt="Generate Image for OpenCode" width="100%">
</p>

# Generate Image for OpenCode

Native OpenCode V2 image generation and editing through the active OpenAI ChatGPT OAuth connection. One call generates or edits one image. There is no separate CLI login, API key, endpoint override, or API-key billing path.

- npm package and plugin ID: `hffmnnj.generate-image`
- Tool `generate_image`, permission `generate_image`; Code Mode only (`codemode: true`)
- Built for OpenCode V2 with `@opencode/plugin` 2.0.25
- Fixed endpoint `https://chatgpt.com/backend-api/codex/responses`
- Image models: `gpt-image-2.5-sunburst` (default) and `gpt-image-2.5-flare`

## Requirements

An active OpenAI connection in OpenCode with a fresh ChatGPT OAuth credential is required for every call. The connected subscription must allow image generation. API keys and expired credentials are rejected with a reconnect message. Image generation consumes subscription quota.

OpenCode owns sign-in, token refresh, and credential storage. This plugin reads the active connection, does not create accounts or accept credentials directly, and does not persist credentials itself.

## Install

Add this object entry to the existing `plugins` array in your OpenCode config. Keep unrelated entries unchanged.
If upgrading from a local checkout, replace its existing entry rather than
loading both copies.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "hffmnnj.generate-image"
    }
  ]
}
```

Plugin options are optional:

```json
{
  "package": "hffmnnj.generate-image",
  "options": { "responsesModel": "gpt-6.1-sol" }
}
```

`responsesModel` controls the outer Responses API model only. If it is omitted, the plugin uses the current OpenAI session model ID; for a non-OpenAI or unset session model it uses `gpt-6.1-sol`. If your session uses an alias that is not a valid API model ID, set the actual ID explicitly. An invalid session ID fails before OAuth resolution instead of silently falling back. No model, endpoint, provider, or authentication fallback is attempted after a rejection.

## Usage

In Code Mode:

```js
const image = await tools.generate_image({
  prompt: "A red square app icon on a white background",
  outputPath: "assets/icons/red-square.png",
});
return image;
```

Generate from a reference image:

```js
return await tools.generate_image({
  prompt: "Change the background to deep blue",
  action: "edit",
  referenceImages: ["assets/icons/red-square.png"],
});
```

Only the prompt and the listed reference images are sent. Session history is not included. The tool writes one new PNG inside the session project and returns its path, `file://` URI, actual dimensions, byte size, and `image/png` file content. It never overwrites an existing file.

## Parameters

Input is strict. Unknown keys such as `endpoint`, `transparent`, or `responsesModel` are rejected.

| Field | Type and constraints | Default |
| --- | --- | --- |
| `prompt` | trimmed string, 1 to 32,000 characters | required |
| `model` | `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` | `gpt-image-2.5-sunburst` |
| `quality` | `auto`, `low`, `medium`, `high`, `xhigh`, or `max` | `auto` |
| `size` | `auto` or `WxH` with each edge divisible by 16, 655,360 to 8,294,400 total pixels, maximum edge 3840, maximum 3:1 aspect ratio | `1024x1024` |
| `referenceImages` | 0 to 5 session/project-relative `.png`, `.jpg`, `.jpeg`, or `.webp` files; no hidden, empty, absolute, backslash, or traversal segments; at most 240 characters and 32 segments | `[]` |
| `outputPath` | new session/project-relative `.png`; same path rules; must not exist | `generated-images/<uuid>.png` |
| `action` | `generate`, `edit`, or `auto`; `edit` requires at least one reference | `generate` |

Plugin options are also strict:

| Option | Constraints | Default |
| --- | --- | --- |
| `timeoutMs` | integer from 1,000 to 900,000 milliseconds | `600000` |
| `responsesModel` | GPT API identifier with a `gpt-` prefix, letters/digits/dot/underscore/hyphen only, at most 200 characters; no provider prefix, whitespace, or `#` variant | current OpenAI session model ID, otherwise `gpt-6.1-sol` |

Set `responsesModel` in plugin options, not in `tools.generate_image` input. A syntactically valid model alias can still be rejected by the provider. An explicit override changes only the outer Responses model ID; it does not change the endpoint, credentials, or image model.

## Output

The result contains `path`, `uri`, `model`, `quality`, `requestedSize`, `action`, `mime: "image/png"`, actual `width`, `height`, `bytes`, and `transparent` (whether the returned PNG has alpha). If the backend resolves to a different size than requested, `warning` says so and the actual resolution is preserved.

There is no `transparent` input and no chroma-key or green-screen processing. Alpha is preserved when the provider returns it, but it cannot be requested.

## Platform and file safety

Safe file access is implemented for Linux using `/proc/self/fd` descriptor-relative traversal and for Windows x64 on local NTFS volumes using NT handle-relative access. Other platforms fail closed. Windows requires x64 and a local NTFS volume; UNC and network drives are rejected. Windows x64 support is implemented but remains unverified on Windows; treat it as experimental and validate it on your own host before relying on it.

Paths are resolved inside the session project. Hidden, empty, absolute, backslash, and traversal segments are rejected. Symlinked or reparse-point ancestors, hardlinked references, and non-regular files are rejected. Output is created exclusively with mode `0600` on Linux and an owner-only DACL on Windows. A pre-existing output is never replaced, and output parents are checked again after the network call.

The plugin is not a sandbox against arbitrary same-user or privileged filesystem mutation. Containment assumes stable directory topology during an operation: a same-user process can rename an already-open directory outside the project on Linux. On Windows, reparse-point checks are not atomic with subsequent opens or I/O, and a sufficiently timed mutation and restoration can evade them.

References are capped at 20 MiB each and 40 MiB aggregate, including decoded expansion. Responses are capped at 96 MiB on the wire, 32 MiB for the image, 20,000 events, and 100,000 lines. Decoded images are limited to 16 megapixels.

## Authorization, retries, and refresh

Each invocation reads the active `openai` connection and resolves a fresh credential. Only OAuth credentials with a finite future expiry and printable access token are accepted. API keys, missing connections, and expired credentials produce a reconnect message. The `chatgpt-account-id` header is sent when the credential supplies an account ID.

OpenCode performs native refresh at its own expiry window and persists rotated tokens. This plugin never refreshes tokens, persists credentials, or logs them. Calls within one loaded module use a local FIFO gate around the active lookup and native resolution, so each queued call re-reads active state. This is not a platform-wide singleflight guarantee: ordinary model calls, separately loaded module instances, and other processes are not serialized.

The endpoint is fixed. Redirects and arbitrary downloads are not followed. HTTP 401 maps to reconnect, 429 to quota or rate limiting, and other statuses to sanitized errors. Quota-consuming POSTs are not automatically retried. There is no API-key fallback, no alternate endpoint, and no automatic provider fallback. Tool errors are sanitized; provider text and credentials do not cross the tool boundary.

## Cancellation

Cancellation or `timeoutMs` stops waiting on OAuth work, network work, Sharp metadata, PNG encoding, and alpha inspection. It also prevents later image requests and output writes. Native codec work that has already started may continue settling in the background. A partially written output can remain if the exclusive write itself fails. No automatic retry is attempted.

## Response compatibility

Success responses may arrive as an SSE stream or as a strict whole completed Responses JSON object. Unsupported content types, HTML, raw images, and unrecognized bodies fail closed. Exactly one completed image is required. Provider error or incomplete envelopes never produce a saved image, and Sharp validates the actual bytes before any output is written.

## Development

```sh
bun install
bun run typecheck
bun test tests/unit
```
