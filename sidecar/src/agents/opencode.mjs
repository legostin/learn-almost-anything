// OpenCode backend.
//
// Reuses the shared stage pipeline, with the OpenCode CLI as the transport.
// Image generation is Codex-only, so the uniform dispatcher gets a stub.

import { listCliModels } from "./cli-agent.mjs";
export * from "./pipeline.mjs";

export async function listModels() {
  return await listCliModels("opencode");
}

export async function generateImage() {
  throw new Error("image generation is not supported by the opencode agent");
}
