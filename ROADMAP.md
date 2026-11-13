# Roadmap

Current status: the standalone OpenCode V2 `generate_image` plugin is implemented and live-verified against an active ChatGPT subscription (2026-10-14). It is Code Mode-only, writes one new PNG per call, and uses the active OpenAI OAuth connection without a separate login, API key, endpoint override, or automatic retry.

| Workstream | Status | Notes |
| --- | --- | --- |
| Native tool and protocol | Done | Tool `generate_image`, permission `generate_image`; Sunburst/Flare; generate/edit; SSE and strict completed-JSON responses; exactly one completed image required. |
| Authentication | Done | Per-call active connection and native resolution; OpenCode owns refresh and rotated-token persistence; no plugin credential cache, custom refresh, or auth-file access. |
| Outer Responses model | Done | Optional validated `responsesModel`: explicit override, otherwise the current OpenAI session model, otherwise `gpt-6.1-sol`. Invalid identifiers fail before OAuth. |
| Response validation and diagnostics | Done | Bounded static error classification; fail-closed handling for malformed, incomplete, refused, multiple, oversized, HTML, and raw-image bodies; fixed-key cardinality diagnostics without provider text or credentials. |
| File safety | Done | Linux `/proc/self/fd` and Windows x64 NT handle-relative access; project containment; exclusive output with owner-only permissions; no overwrite. Windows x64 remains unverified on real hardware. |
| Cancellation and concurrency | Done | Module-local FIFO around active/resolve; cancellation stops waiting on network and Sharp work; no retry; already-started native codec work may settle later. |
| Test coverage | Done | `bun run check` passed: typecheck, 352 unit tests (1,362 assertions), 5 isolated 2.0.25 host tests (40 assertions), zero failures. |
| Subscription acceptance | Verified 2026-10-14 | 10 generation POSTs; 7 diagnosed failures followed by 3 saved `1254x1254` PNGs (mode `0600`), all visually verified and independently PNG/Sharp checked. |
| Package and install docs | Done | `hffmnnj.generate-image` metadata, README, and configuration examples are in place. |

## Completed development summary

Earlier milestones are complete: the standalone plugin, isolated real-SDK host harness, synthetic OAuth refresh/rotation coverage, bounded HTTP error diagnostics, SSE and completed-JSON compatibility, cardinality instrumentation, retained done-event image support, real interrupt cancellation, and the completed-event error/incomplete guard. The live acceptance run verified the full subscription path after the retained-stream and completed-error fixes.

## Known limits

- The plugin is not a same-user filesystem sandbox. Containment assumes stable directory topology during an operation.
- The FIFO covers only calls sharing one loaded module. Ordinary model calls, separately loaded module instances, and other processes are not serialized.
- Linux and Windows x64 use different containment mechanisms. Windows x64 support is implemented but unverified on Windows hardware; other platforms fail closed.
- Native Sharp codec work may continue after cancellation, and a partially written output can remain if the exclusive write itself fails.
- A backend size discrepancy returns a warning and preserves the actual dimensions.
- There is no `transparent` input and no chroma-key/green-screen processing. Provider-returned alpha is preserved.
- Historical attempt-by-attempt logs and machine-local evidence are intentionally not part of this repository.

## Follow-ups

- Validate the Windows x64 path on real hardware before considering it supported.
- Keep behavior, security caveats, and verification results current as the plugin changes.
