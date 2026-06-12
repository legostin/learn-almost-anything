// Minimal MCP stdio client used to VALIDATE a server before the user saves
// it: spawn the command, run the JSON-RPC handshake (initialize →
// notifications/initialized → tools/list), report the advertised tools, kill
// the process. Newline-delimited JSON-RPC 2.0 per the MCP stdio transport.
import { spawn } from "node:child_process";

export async function probeMcp({ command, args = [], env = {} }, _ctx) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("command must be a non-empty string");
  }
  const timeoutMs = 90_000;
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, Array.isArray(args) ? args : [], {
        env: { ...process.env, ...(env && typeof env === "object" ? env : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error(`spawn failed: ${e.message}`));
      return;
    }
    let done = false;
    let buf = "";
    let stderrTail = "";
    let serverInfo = null;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("probe timed out (90s) — server never answered the MCP handshake")),
      timeoutMs
    );
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    child.on("error", (e) => finish(new Error(`spawn failed: ${e.message}`)));
    child.on("exit", (code) => {
      if (!done) {
        finish(
          new Error(
            `server exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim().slice(0, 500)}` : ""}`
          )
        );
      }
    });
    const send = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch {
        /* exit handler reports */
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // some servers log noise to stdout — skip non-JSON lines
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish(new Error(`initialize failed: ${msg.error.message || JSON.stringify(msg.error)}`));
            return;
          }
          serverInfo = msg.result?.serverInfo ?? null;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(new Error(`tools/list failed: ${msg.error.message || JSON.stringify(msg.error)}`));
            return;
          }
          const tools = (msg.result?.tools ?? []).map((t) => ({
            name: String(t.name || ""),
            description: String(t.description || "").slice(0, 200),
          }));
          finish(null, { ok: true, serverInfo, tools });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "learn-anything-probe", version: "1.0.0" },
      },
    });
  });
}
