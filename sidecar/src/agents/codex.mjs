// Codex backend.
//
// Codex is the reference implementation of the shared stage pipeline: the
// pipeline defaults to the Codex transport, and its model catalog / image
// generation helpers are Codex-specific. The other text backends (OpenCode,
// Command Code) reuse the same pipeline with their own transport; see
// backends.mjs and cli-agent.mjs.

export * from "./pipeline.mjs";
