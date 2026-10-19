# opencode-generate-image

Native OpenCode V2 `generate_image` tool using the already-authenticated OpenAI ChatGPT subscription. No separate CLI login, credential copies, or API-key billing fallback.

- Plugin id `generate-image`, tool `generate_image`, permission `generate_image`, Code Mode only (`codemode: true`).
- Pinned to OpenCode V2 / `@opencode/plugin` / `@opencode/sdk` `2.0.25`.
- Fixed subscription endpoint `https://chatgpt.com/backend-api/codex/responses`; no endpoint option, no redirects, no arbitrary downloads.
- Outer Responses model: explicit plugin `responsesModel`, otherwise the current OpenAI session model ID, otherwise `gpt-6.1-sol`. The Sunburst/Flare image tool model is independent.
- Linux only for file I/O (`/proc/self/fd` descriptor-relative access).
- Settled deployment 2026-10-14, live-verified: the standalone `generate-image` plugin is live in global config as an object entry for the package folder (`file:///home/example/Documents/opencode-generate-image`) with `options.responsesModel: "gpt-6-luna"`; the primary model entry remains `openai/gpt-6.1-sol`. The exact pre-Luna config diff is backed up at `/home/example/.config/opencode-v2/backups/opencode.json.pre-generate-image-luna-20261014T164604Z`. Per-call native auth, config loading, and subscription image generation are verified; `/api/plugin` shows `generate-image` active from `index.ts` (see Verification).

## Usage

Add one plugin entry pointing at this package **folder**, not `src/index.ts` (coordinator owns global config; preserve unrelated settings with a reversible backup). The root `index.ts` exposes the shipped default plugin to OpenCode's local-folder resolver:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///home/example/Documents/opencode-generate-image",
      "options": { "responsesModel": "gpt-6-luna" }
    }
  ]
}
```

Append that object entry to existing `plugins`; do not replace unrelated entries. This matches the installed entry (wrapper `responsesModel: "gpt-6-luna"`). That wrapper is plugin configuration for the outer Responses call only — do not pass it as the `generate_image` `model` argument, which remains `gpt-image-2.5-sunburst` (default) or `gpt-image-2.5-flare`. Then, in Code Mode:

```js
return await tools.generate_image({
  prompt: "A red square app icon",
  outputPath: "assets/icon.png",
});
```

Only `prompt` and `referenceImages` are sent, never session history. The tool writes one new PNG inside the session project and returns its path, `file://` URI, actual dimensions, and `image/png` file content. It never overwrites.

## Parameters

Input (`src/options.ts`, strict; unknown keys such as `endpoint`, `transparent`, or `responsesModel` are rejected):

| Field | Type / constraints | Default |
| --- | --- | --- |
| `prompt` | trimmed string, 1–32,000 chars | required |
| `model` | `gpt-image-2.5-sunburst` \| `gpt-image-2.5-flare` | `gpt-image-2.5-sunburst` |
| `quality` | `auto` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `auto` |
| `size` | `auto` or `WxH` with each edge divisible by 16, 655,360–8,294,400 px total, max edge 3840, max 3:1 aspect | `1024x1024` |
| `referenceImages` | 0–5 project/session-relative `.png`/`.jpg`/`.jpeg`/`.webp` files; no hidden, empty, backslash, traversal, or absolute segments; max 240 chars and 32 segments | `[]` |
| `outputPath` | project/session-relative `.png`, same path rules; must not exist | `generated-images/<uuid>.png` |
| `action` | `generate` \| `edit` \| `auto`; `edit` requires at least one reference | `generate` |

Plugin options (strict; only these keys are supported):

| Field | Constraints | Default |
| --- | --- | --- |
| `timeoutMs` | integer 1,000–900,000 | 600,000 |
| `responsesModel` | optional lowercase GPT API identifier, `gpt-` prefix, letters/digits/dot/underscore/hyphen only, at most 200 chars; no provider prefix, whitespace or `#` variant | current OpenAI session model ID; `gpt-6.1-sol` for a non-OpenAI/unset session model |

Set `responsesModel` in the plugin's options, not in `tools.generate_image` input. Omission does not insert a schema default: the plugin reads the current session and creates the default backend for **each invocation**. A syntactically invalid OpenAI alias or variant fails before OAuth resolution or POST with instructions to set the actual API model ID explicitly; a syntactically valid alias may still be rejected by the provider. There is no silent model, endpoint, provider or authentication fallback after either rejection. An explicit override can select the actual API ID without changing the endpoint or credentials. Direct `CodexImageBackend` / `imageRequest` callers default to `DEFAULT_RESPONSES_MODEL = "gpt-6.1-sol"` and validate explicit outer IDs too.

Output includes `path`, `uri`, `model`, `quality`, `requestedSize`, `action`, `mime: "image/png"`, real `width`/`height`/`bytes`, `transparent` (whether the returned PNG has alpha), and an optional `warning` when the backend resolution differs from the requested size. Actual provider resolution is always preserved.

There is no `transparent` input and no chroma-key/green-screen processing; that scope is deliberately omitted. Alpha is preserved when the provider returns it, but it cannot be requested.

## Security and files

Linux-only: `ProjectFiles` opens every path component with `O_NOFOLLOW` under `/proc/self/fd`, rejects symlinked ancestors/parents, hidden/traversal segments, hardlinked references, and non-regular files. References are capped (20 MiB each, 40 MiB aggregate including decoded expansion); responses are bounded (96 MiB wire, 32 MiB image, 20,000 events, 100,000 lines). Output uses `O_CREAT | O_EXCL | O_NOFOLLOW` with mode `0600` and is revalidated after the network call, so two concurrent generations for the same new path resolve to exactly one winner. Errors are sanitized through `safeMessage`; provider text and credentials never cross the tool boundary.

Containment assumes **stable directory topology during the operation**. Descriptor-relative access pins authorized inodes; a same-user process that can rename an already-open directory outside the project can relocate that inode after a containment check. This plugin is not a sandbox against arbitrary same-user filesystem mutation.

Cancellation stops waiting on Sharp metadata, PNG encoding and alpha inspection, as well as OAuth/network work; byte/pixel limits still apply. Native codec work already started may continue to settle in the background. Cancellation prevents subsequent image requests/output writes; it does not claim native codec termination or undo a request/write that already started.

## Response compatibility

Response media types are case-insensitive with surrounding whitespace normalized. `text/event-stream` uses the incremental SSE decoder. `application/json` may supply a whole valid UTF-8 Responses object with `object: "response"`, a nonempty string `id`, completed status/output, no error/incomplete details, and exactly one completed `image_generation_call`. It must reach EOF without malformed or trailing non-JSON data. A synthetic completed event passes through the **same** completion, refusal, cardinality, base64 and 32 MiB image checks as SSE. Sharp still validates actual image bytes before any output is saved.

The local CLI and Codex SSE client parse success bytes without gating on Content-Type. For compatibility with that behavior, `application/json`, `text/plain`, and unknown/missing labels may also supply SSE if the first nonempty line starts with `data:`, `event:`, or comment `:` within a **1 KiB sniff prefix**. Those bytes then enter the existing incremental decoder; completion, failure/refusal, framing, UTF-8 and stream limits are unchanged. Unknown/missing labels may instead supply the strict whole completed Responses JSON object described above, never generic JSON. JSON under `text/plain` remains rejected. Known `text/html`, `application/octet-stream`, and raw `image/*` labels are rejected before body parsing, even if their body resembles a valid response. HTML, raw images and arbitrary text under unknown labels also fail closed. This changes no outgoing header, authentication or endpoint checks.

JSON reads retain bounded 64 KiB blocks (not one array per tiny read), with the same 96 MiB total-byte limit and cancellation/reader-release policy. HTTP 200 JSON error envelopes never supply an image; recognized errors use the existing finite static classifier. Unsupported types and unrecognized bodies use owned static diagnostics, naming only whitelisted media types, never arbitrary headers or provider text. Unknown/missing-label format failures report: `Response body is neither a completed Responses image object nor a complete image event stream; no image was saved.`

## Auth, retries, refresh

Each invocation resolves the active `openai` connection via `ctx.integration.connection.active("openai")` + `resolve`, with no caching. Only fresh OAuth (`type: "oauth"`, finite future `expires`, printable access, optional `accountID` header) is accepted; API keys, expired credentials, and missing connections all yield the reconnect message. The `chatgpt-account-id` header is sent when present. There is no API-key fallback and no automatic retry of quota-consuming POSTs; HTTP 401 maps to reconnect, 429 to quota/rate-limit, other statuses to sanitized errors. Cancellation and `timeoutMs` abort promptly without duplicating the platform-owned resolver.

Native 2.0.25 refresh happens inside `connection.resolve` at `expires <= now + 5 minutes` and persists rotated access/refresh plus expiry via `credentials.update`. There is no platform-wide singleflight guarantee (the provider semaphore only serializes Switched-triggered registry loads). Image auth calls sharing this module use a FIFO gate around the **entire active lookup, native resolution and validation**. Each queued call re-reads active state; no credentials are cached or coalesced and the plugin never refreshes tokens itself. A cancelled generation stops waiting, but its gate stays held until underlying native resolution settles. This is plugin-local serialization only: ordinary model calls, separately loaded module instances and other processes are **not protected**.

## Verification

- `bun run typecheck`
- `bun test tests/unit` (protocol, options/auth boundary, filesystem)
- `bun test tests/host` (isolated exact-version host: synthetic expired OAuth `expires: 1` refreshes once and rotates both tokens with future expiry; `tools.generate_image` executes twice with the rotated bearer and `fixture-account` header; real 8×8 PNGs saved `0600` and reported in history; `generate_image` deny performs no backend call/output; credentials never enter history)
- Native default-backend host scenarios intercept only the fixed production URL into loopback, verifying the actual outgoing body for two different OpenAI session IDs, an explicit plugin override, and the non-OpenAI default. No production HTTP is sent. OpenAI model scenarios use fresh synthetic OAuth to isolate model selection from ordinary model-call refresh concurrency; the original injected-backend and non-OpenAI default scenarios retain expired-token refresh checks.
- `bun run check` runs all three. An additional isolated host loads the actual package folder via a native `file://` config entry, confirms its default plugin is active with the root entrypoint, and closes the host without image generation.

Auth regression tests explicitly gate active lookup/native resolution and synthetic token rotation, checking FIFO fresh state across locations, failure release, and no resolver overlap after generation cancellation. Normalization tests use real Sharp with pre-aborts and cancellation during its first native await; existing codec/size bounds remain exercised. They do not independently measure cancellation at every later native codec stage or promise that native work is terminated.

Verified 2026-10-14 final acceptance: fresh `bun run check` passed typecheck, **352 unit tests (1,362 assertions) and 5 isolated real 2.0.25 host tests (40 assertions)**, zero failures; log `/var/tmp/generate-image-final-coordinator-check-20261014.log`. Coverage includes protocol, options/auth boundary, filesystem, FIFO auth gate, Sharp cancellation, response compatibility, and the final shared completed-error guard. The independent reviewer (`ses_example_session`) verified completed `response.error`/`incomplete_details` now reject: 4 original counterexamples reject, focused 270 tests (1,180 assertions) passed with no new blocking defect. Earlier intermediate counts (for example 276/1,058 and 194/876) are historical and preserved in `ROADMAP.md`/`SPEC.md`.

Isolation: host fixtures run in a subprocess with `HOME`, `XDG_*`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`, and `TMPDIR` under `mkdtemp /var/tmp/generate-image-host-`, using `database.path` under the same root. They never touch the user's database or credentials and never call the real subscription backend (loopback `/responses` only). Synthetic expired OAuth (`expires: 1`) refresh/rotation/persistence is tested in the isolated host; live calls used the current authenticated OAuth connection (no separate login, API key, or credential copy), without forcing real credential expiration. Cancellation is proven by a real host `session.interrupt` (`resume: false`): server-observed `request.signal` abort, one POST with no retry, no output file, no history leak. Native codec work already started may settle in the background; a partially written output can remain if the exclusive write itself fails.

Live-verified subscription acceptance (coordinator; immutable report `/var/tmp/generate-image-final-verification-20261014.json`, prior first-two report retained at `/var/tmp/generate-image-live-verification-20261014.json`): **10 native generation POSTs**. The first 7 failed with diagnosed issues; the 7th supplied the root-cause counts (`final_output: 0`, `streamed_image_results: 1`) — the image arrived in `response.output_item.done` while `response.completed.output` was empty, and the old final-output requirement discarded the retained result. The fix releases the retained image only after successful whole completion, keeping refusal, exactly-one-image, canonical-base64, bounds, and PNG safeguards plus the final shared completed-error guard. Then #8 (Flare `low` generation, orange circle), #9 (Sunburst `low` reference edit, blue circle), and #10 (default Sunburst `auto` generation, green triangle, after the final guard) each saved a `1254x1254` PNG with mode `0600`:
- `/home/example/.config/opencode-v2/generated-images/generate-image-luna-working-20261014.png`
- `/home/example/.config/opencode-v2/generated-images/generate-image-luna-reference-edit-20261014.png`
- `/home/example/.config/opencode-v2/generated-images/generate-image-luna-defaults-verified-20261014.png`
Full bytes/SHA-256/mode/dimensions are in the final report (primary model unchanged `openai/gpt-6.1-sol`, plugin `responsesModel: "gpt-6-luna"`). All three were visually verified and independently PNG/Sharp checked. Two additional native preflight rejections (existing output, traversal) never POSTed and are not counted in the 10; the original first-output hash was verified unchanged today. The native goal remains paused after restart (no resume/reset/budget change); this does not claim goal completion.

Limits retained: Linux-only `/proc/self/fd` I/O; stable directory topology assumed (not a same-user sandbox); module-local FIFO only (no platform singleflight); backend size discrepancy yields a warning with actual resolution preserved; no `transparent` input. Concise evidence, gaps and sources are summarized in `docs/verification.md`.

## Research sources

- `/var/tmp/generate-image-research-20261014.md`
- Codex `76ed3b484d62ccceb9fa512ff4dd139f421814c3` (`/images/generations` + `/images/edits` for `gpt-image-2`; not used here)
- Local CLI `local image CLI` (Responses + `gpt-5.5` + Sunburst/Flare; no refresh-token grant)
- CLI `cli.py:532–579` and Codex `codex-api/src/endpoint/responses.rs:135–157`, `sse/responses.rs:38–100,548` consume success SSE without a Content-Type gate. Installed `@opencode/ai/dist/protocols/open-responses.js:254–277` models `response.id/output/error/incomplete_details`; Codex `sse/responses.rs:1067,1370–1380` documents the Responses `id/object/status/error/incomplete_details` envelope. These sources explain protocol structure, not the fourth or fifth live response's unknown format.
- Prior Relay `src/image-*.ts` + `tests/host/images-fixture.ts` (namespaced `tools.image.generate`); this package follows the CLI protocol per `src/api.ts` with top-level `tools.generate_image`
