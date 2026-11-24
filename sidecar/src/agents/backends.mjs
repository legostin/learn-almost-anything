// Request-scoped backend context.
//
// The stage pipeline in pipeline.mjs is shared by every agent that returns
// plain text (Codex, OpenCode, Command Code). Rather than threading a backend
// argument through ~40 stage functions, the sidecar runs each request inside
// an AsyncLocalStorage context and the pipeline's transport choke point
// (openThread) reads the backend name from here. The context is per-request, so
// concurrent calls for courses on different backends never interfere.
//
// Claude has its own module: its SDK exposes a structurally different runner,
// so it does not go through pipeline.mjs.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/** Run `fn` with `backend` visible to pipeline transports. */
export function withBackend(backend, fn) {
  return storage.run(backend, fn);
}

/** The backend of the current request, or undefined outside a request. */
export function currentBackend() {
  return storage.getStore();
}
