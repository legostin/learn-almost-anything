import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createCliThread, resetCliCaches, __test } from "../src/agents/cli-agent.mjs";

const root = mkdtempSync(join(tmpdir(), "laa-cli-test-"));
const opencodeStub = join(root, "opencode");
const commandCodeStub = join(root, "commandcode");
const recordPath = join(root, "commandcode-record.json");
const opencodeRecordPath = join(root, "opencode-record.json");

writeFileSync(
  opencodeStub,
  `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  if (process.env.LAA_STUB_VERSION_FAIL === "1") process.exit(1);
  console.log(process.env.LAA_STUB_OPENCODE_VERSION || "1.18.31");
  process.exit(0);
}
if (args[0] === "debug") {
  if (process.env.LAA_STUB_MCP_FAIL === "1") {
    console.error("boom");
    process.exit(1);
  }
  console.log(JSON.stringify({ mcp: { personal: { type: "local", command: ["true"] } } }));
  process.exit(0);
}
if (args[0] === "models") {
  console.log("test/model");
  console.log("{");
  console.log('  "name": "Test Model",');
  console.log('  "variants": { "low": {}, "high": {} }');
  console.log("}");
  process.exit(0);
}
if (process.env.LAA_TEST_OPENCODE_RECORD) {
  writeFileSync(process.env.LAA_TEST_OPENCODE_RECORD, JSON.stringify({ cwd: process.cwd(), args }));
}
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const events = [
    { type: "step_start", part: { messageID: "m1" } },
    { type: "text", part: { id: "p1", messageID: "m1", type: "text", text: '{"answer":"hel' } },
    { type: "text", part: { id: "p2", messageID: "m1", type: "text", text: 'lo"}' } },
    { type: "step_finish", part: { messageID: "m1" } },
  ];
  for (const event of events) console.log(JSON.stringify(event));
});
`,
  { mode: 0o755 }
);
chmodSync(opencodeStub, 0o755);

writeFileSync(
  commandCodeStub,
  `#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  console.log("test/model  Test model");
  process.exit(0);
}
if (process.env.LAA_TEST_RECORD) {
  const attachments = existsSync(join(process.cwd(), "attachments"))
    ? readdirSync(join(process.cwd(), "attachments"))
    : [];
  writeFileSync(process.env.LAA_TEST_RECORD, JSON.stringify({ cwd: process.cwd(), args, attachments }));
}
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: '{"ok":' } }));
  console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "true}" } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", finalText: '{"ok":true}' }));
});
`,
  { mode: 0o755 }
);
chmodSync(commandCodeStub, 0o755);

const originalOpencode = process.env.LEARN_ANYTHING_OPENCODE_CLI;
const originalCommandCode = process.env.LEARN_ANYTHING_COMMANDCODE_CLI;
const originalRecord = process.env.LAA_TEST_RECORD;
const originalMcpFail = process.env.LAA_STUB_MCP_FAIL;
const originalOpencodeVersion = process.env.LAA_STUB_OPENCODE_VERSION;
const originalVersionFail = process.env.LAA_STUB_VERSION_FAIL;
const originalOpencodeRecord = process.env.LAA_TEST_OPENCODE_RECORD;

test.before(() => {
  process.env.LEARN_ANYTHING_OPENCODE_CLI = opencodeStub;
  process.env.LEARN_ANYTHING_COMMANDCODE_CLI = commandCodeStub;
  process.env.LAA_TEST_RECORD = recordPath;
  process.env.LAA_TEST_OPENCODE_RECORD = opencodeRecordPath;
});

test.beforeEach(() => {
  delete process.env.LAA_STUB_MCP_FAIL;
  delete process.env.LAA_STUB_OPENCODE_VERSION;
  delete process.env.LAA_STUB_VERSION_FAIL;
  process.env.LAA_TEST_RECORD = recordPath;
  process.env.LAA_TEST_OPENCODE_RECORD = opencodeRecordPath;
  resetCliCaches();
});

test.after(() => {
  if (originalOpencode === undefined) delete process.env.LEARN_ANYTHING_OPENCODE_CLI;
  else process.env.LEARN_ANYTHING_OPENCODE_CLI = originalOpencode;
  if (originalCommandCode === undefined) delete process.env.LEARN_ANYTHING_COMMANDCODE_CLI;
  else process.env.LEARN_ANYTHING_COMMANDCODE_CLI = originalCommandCode;
  if (originalRecord === undefined) delete process.env.LAA_TEST_RECORD;
  else process.env.LAA_TEST_RECORD = originalRecord;
  if (originalMcpFail === undefined) delete process.env.LAA_STUB_MCP_FAIL;
  else process.env.LAA_STUB_MCP_FAIL = originalMcpFail;
  if (originalOpencodeVersion === undefined) delete process.env.LAA_STUB_OPENCODE_VERSION;
  else process.env.LAA_STUB_OPENCODE_VERSION = originalOpencodeVersion;
  if (originalVersionFail === undefined) delete process.env.LAA_STUB_VERSION_FAIL;
  else process.env.LAA_STUB_VERSION_FAIL = originalVersionFail;
  if (originalOpencodeRecord === undefined) delete process.env.LAA_TEST_OPENCODE_RECORD;
  else process.env.LAA_TEST_OPENCODE_RECORD = originalOpencodeRecord;
  rmSync(root, { recursive: true, force: true });
});

test("extractJsonText handles whole values, prose, fences, and arrays", () => {
  assert.equal(__test.extractJsonText('[{"a":1},{"b":2}]'), '[{"a":1},{"b":2}]');
  assert.equal(__test.extractJsonText("Use {braces} carefully. {\"ok\":true}"), '{"ok":true}');
  assert.equal(
    __test.extractJsonText('{"content":"inline ```5``` fence"}'),
    '{"content":"inline ```5``` fence"}'
  );
  assert.equal(
    __test.extractJsonText("Per the docs [1], here: {\"a\":1}", { type: "object" }),
    '{"a":1}'
  );
});

test("OpenCode text parts in one message are concatenated, new messages reset", () => {
  const state = { backend: "opencode", final: "" };
  __test.parseOpencodeLine(
    JSON.stringify({ type: "text", part: { id: "p1", messageID: "m1", type: "text", text: "hello " } }),
    state
  );
  __test.parseOpencodeLine(
    JSON.stringify({ type: "text", part: { id: "p2", messageID: "m1", type: "text", text: "world" } }),
    state
  );
  assert.equal(state.final, "hello world");
  __test.parseOpencodeLine(
    JSON.stringify({ type: "text", part: { id: "p3", messageID: "m2", type: "text", text: "final" } }),
    state
  );
  assert.equal(state.final, "final");
});

test("Command Code text resets between assistant messages", () => {
  const state = { backend: "commandcode", final: "" };
  __test.parseCommandCodeLine(
    JSON.stringify({ type: "event", event: { type: "text_delta", delta: "draft " } }),
    state
  );
  __test.parseCommandCodeLine(JSON.stringify({ type: "event", event: { type: "message_start" } }), state);
  __test.parseCommandCodeLine(
    JSON.stringify({ type: "event", event: { type: "text_delta", delta: "final" } }),
    state
  );
  assert.equal(state.final, "final");
});

test("MCP environment values are redacted from the OpenCode config", () => {
  const { servers, env } = __test.redactMcpEnv({
    custom: { command: "true", env: { API_KEY: "secret", OTHER: "v" } },
  });
  assert.equal(servers.custom.env.API_KEY, "{env:LAA_OPENCODE_MCP_0_API_KEY}");
  assert.equal(servers.custom.env.OTHER, "{env:LAA_OPENCODE_MCP_1_OTHER}");
  assert.equal(env.LAA_OPENCODE_MCP_0_API_KEY, "secret");
  assert.equal(env.LAA_OPENCODE_MCP_1_OTHER, "v");

  // OpenCode injects the env value into the config text before JSON parsing.
  const tricky = 'a"b\\c\nd';
  const redacted = __test.redactMcpEnv({ custom: { command: "true", env: { VALUE: tricky } } });
  const json = `{"value":"${redacted.env.LAA_OPENCODE_MCP_0_VALUE}"}`;
  assert.equal(JSON.parse(json).value, tricky);
});

test("OpenCode permission is a deny-first allowlist", () => {
  const permission = __test.opencodePermission(
    { context7: {}, "my-server": {} },
    ["/data/space"],
    ["/tmp/opencode.json"]
  );
  assert.equal(permission["**"], "deny");
  assert.equal(permission.edit, undefined);
  assert.equal(permission.bash, undefined);
  assert.equal(permission["context7_*"], "allow");
  assert.equal(permission["my-server_*"], "allow");
  assert.equal(permission["read*"]["*"], "allow");
  assert.equal(permission["read*"]["*.env"], "deny");
  assert.equal(permission["external_directory*"]["*"], "deny");
  assert.equal(permission["external_directory*"]["/data/space/*"], "allow");
  assert.equal(permission["read*"]["/tmp/opencode.json"], "deny");
});

test("OpenCode config disables personal MCP and defines a run-only agent", () => {
  const config = __test.opencodeConfig(
    { context7: { command: "true" } },
    ["personal"],
    [],
    "laa-test",
    ["/tmp/opencode.json"]
  );
  assert.equal(config.mcp.personal.enabled, false);
  assert.equal(config.permission["**"], "deny");
  assert.equal(config.agent["laa-test"].permission["**"], "deny");
  assert.equal(config.agent["laa-test"].permission["context7_*"], "allow");
  assert.equal(config.agent["laa-test"].permission["read*"]["/tmp/opencode.json"], "deny");
  assert.equal(config.agent.build, undefined);
});

test("OpenCode MCP discovery fails closed and retries", async () => {
  process.env.LAA_STUB_MCP_FAIL = "1";
  await assert.rejects(__test.opencodeGlobalMcpNames(), /Refusing to run OpenCode/);
  delete process.env.LAA_STUB_MCP_FAIL;
  resetCliCaches();
  assert.deepEqual(await __test.opencodeGlobalMcpNames(), ["personal"]);
});

test("reasoning values are validated before becoming CLI flags", () => {
  assert.equal(__test.reasoningVariant("--print-logs", "test/model"), null);
  assert.equal(__test.reasoningVariant("high", "test/model"), "high");
  assert.equal(__test.commandCodeEffort("--print-logs"), null);
  assert.equal(__test.commandCodeEffort("high"), "high");
});

test("Command Code args use dont-ask mode and deduplicate added dirs", () => {
  const args = __test.commandCodeArgs(
    { modelConfig: { model: "test/model", reasoning: "--print-logs" } },
    ["/a", "/a/", "/b"]
  );
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dont-ask");
  assert.ok(!args.includes("--effort"));
  assert.equal(args.filter((arg) => arg === "--add-dir").length, 2);
});

test("Command Code allow rules are read-only and cover attached MCP servers", () => {
  const rules = __test.commandCodeAllowRules({ context7: {}, "my-server": {} });
  assert.ok(rules.includes("read_file"));
  assert.ok(rules.includes("web_fetch"));
  assert.ok(rules.includes("search_tools"));
  assert.ok(rules.includes("mcp__context7__*"));
  assert.ok(rules.includes("mcp__my-server__*"));
  assert.ok(!rules.some((rule) => /write|edit|shell|bash|agent/.test(rule)));
});

test("OpenCode transport concatenates split JSON and runs in a temp cwd", async () => {
  const thread = createCliThread("opencode", {
    modelConfig: { model: "test/model" },
    dirs: [join(root, "space")],
  });
  const result = await thread.run("hello", { outputSchema: { type: "object" } });
  assert.equal(result.finalResponse, '{"answer":"hello"}');

  const record = JSON.parse(readFileSync(opencodeRecordPath, "utf8"));
  assert.ok(record.cwd.startsWith(tmpdir()));
  assert.ok(!record.args.includes("--dir"));
  assert.match(record.args[record.args.indexOf("--agent") + 1], /^laa-ro-/);
});

test("a failed OpenCode version probe is not cached", async () => {
  process.env.LAA_STUB_VERSION_FAIL = "1";
  resetCliCaches();
  await assert.rejects(__test.opencodeVersion(), /Could not determine the OpenCode version/);
  delete process.env.LAA_STUB_VERSION_FAIL;
  assert.equal((await __test.opencodeVersion()).major, 1);
});

test("OpenCode v2 fails with an actionable error", async () => {
  process.env.LAA_STUB_OPENCODE_VERSION = "2.0.0";
  resetCliCaches();
  const thread = createCliThread("opencode", { modelConfig: { model: "test/model" } });
  await assert.rejects(thread.run("hello"), /not supported yet/);
});

test("Command Code transport uses a temp workspace and grants real dirs", async () => {
  const space = join(root, "space");
  const imageDir = join(root, "images");
  const image = join(imageDir, "one.png");
  mkdirSync(space, { recursive: true });
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(image, "not-a-real-png");

  const thread = createCliThread("commandcode", {
    modelConfig: { model: "test/model" },
    dirs: [space],
    imagePaths: [image],
  });
  const result = await thread.run("hello", { outputSchema: { type: "object" } });
  assert.equal(result.finalResponse, '{"ok":true}');

  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.notEqual(record.cwd, "/");
  assert.notEqual(record.cwd, homedir());
  assert.ok(record.cwd.startsWith(tmpdir()));
  assert.ok(record.args.includes(space));
  assert.ok(!record.args.includes(imageDir));
  assert.ok(record.args.includes("--permission-mode"));
  assert.equal(record.attachments.length, 1);
  assert.match(record.attachments[0], /one\.png$/);
});

test("Windows command lines escape cmd.exe metacharacters", () => {
  const line = __test.windowsCommandLine("C:\\Program Files\\nodejs\\commandcode.cmd", [
    "--model",
    "a b",
    "%PATH%",
  ]);
  assert.match(line, /\^%PATH\^%/);
  assert.match(line, /\^ /);
});
