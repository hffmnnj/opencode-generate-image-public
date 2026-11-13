# Verification

Status: live-verified subscription acceptance, 2026-10-14.

## Configuration under test

- Standalone plugin id `generate-image` is loaded in OpenCode V2 global config from a local package folder with an object entry. Existing settings and the primary model entry are unchanged; a reversible config backup was taken before the change.
- Tool `generate_image` is registered Code Mode only with permission `generate_image`. `/api/plugin` showed `generate-image` active from `index.ts`.
- The wrapper `responsesModel` is outer-Responses configuration only; the image `model` argument remains `gpt-image-2.5-sunburst` (default) or `gpt-image-2.5-flare`.
- Live acceptance used the existing authenticated ChatGPT OAuth connection; no separate login, API key, or credential copy.

## Hermetic checks

- `bun run typecheck` passed.
- `bun test tests/unit`: 352 passed, 0 failed (1,362 assertions), covering protocol, options and auth boundary, filesystem, FIFO auth gate, Sharp cancellation, response compatibility, and the completed-error guard.
- `bun test tests/host`: 5 passed (40 assertions) against an isolated real 2.0.25 host. Coverage includes synthetic expired OAuth refresh, rotation and persistence, Code Mode execution, permission denial, session/override/default model bodies, root-folder lifecycle, and real `session.interrupt` cancellation. The host uses loopback `/responses` only, with isolated HOME, config, and database; no production HTTP.
- Independent review reproduced four completed-event counterexamples; all now reject. Focused 270 tests (1,180 assertions) passed with no new blocking defect.
- Security findings are resolved or documented: module-local FIFO with no credential cache, custom refresh, or platform singleflight claim; Sharp awaits are abortable while native work may settle; root-entry folder loading is verified; stable-topology assumption is not a same-user sandbox; Linux `/proc/self/fd` and Windows x64 containment are implemented, with Windows x64 still unverified on real hardware; a partially written output can remain if the exclusive write itself fails; a backend size discrepancy yields a warning while preserving actual dimensions; no `transparent` input.

## Live acceptance

- 10 native generation POSTs were made. The first 7 failed during development: three HTTP 400 responses (the third classified as unsupported outer `gpt-5.5`), media-format gates, and cardinality. The seventh showed the root cause with safe counts `final_output: 0` and `streamed_image_results: 1`: the image arrived in `response.output_item.done` while `response.completed.output` was empty.
- The retained-stream fix releases that image only after successful whole completion with refusal, exactly-one-image, canonical-base64, bounds, PNG, and shared completed-error safeguards.
- The final three calls saved a Flare `low` generation (orange circle), a Sunburst `low` reference edit (blue circle), and a default Sunburst `auto` generation (green triangle) after the completed-error guard.
- Each saved image is `1254x1254` with mode `0600` under `generated-images/`. All three were visually verified and independently PNG/Sharp checked.
- Two additional native preflight rejections (existing output and traversal) never issued POSTs and are not counted in the 10.
- Cancellation is proven by real host `session.interrupt` (`resume: false`) with server-observed `request.signal` abort: one POST, no retry, no file, and no history leak. Coverage asserts pre-request and in-flight abort; later native codec stages are not independently timed, and already-started work may settle in the background.
- Refresh, rotation, and persistence were tested with a synthetic expired credential in the isolated host, not by forcing real credential expiration.
- Raw acceptance logs, hashes, and machine-local artifact paths are intentionally not part of this repository.

## Sources

- OpenCode V2 plugin guide: https://opencode.ai/v2/docs/build/plugins
- OpenAI Codex at commit `76ed3b484d62ccceb9fa512ff4dd139f421814c3` (Responses and SSE structure only; not evidence of a live response format)
- Local Python CLI reference (`cli.py`): Responses plus Sunburst/Flare protocol, including the `593-621` done-first and fallback ordering; no refresh-token grant
- `src/api.ts`, `src/service.ts`, and the unit and host tests in this repository for implemented behavior

## Historical note

Earlier six- and seven-attempt blocked, pending, and unknown-cause statements are superseded diagnostic history and are intentionally not reproduced here. The current status is the verified acceptance above.
