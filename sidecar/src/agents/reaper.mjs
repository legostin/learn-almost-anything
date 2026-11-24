// Parent-death watchdog for a headless CLI process group.
//
// The sidecar cannot catch SIGKILL, so this tiny detached process polls the
// sidecar PID. If the sidecar disappears, it kills the CLI and all of its
// children (MCP servers included) instead of leaving them running until their
// stdout pipe closes. It exits as soon as the CLI process group is gone.

import { spawnSync } from "node:child_process";

const parentPid = Number(process.argv[2]);
const childPid = Number(process.argv[3]);
const POLL_MS = 1000;

if (
  !Number.isInteger(parentPid) ||
  parentPid <= 0 ||
  !Number.isInteger(childPid) ||
  childPid <= 0
) {
  process.exit(2);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function groupAlive() {
  if (process.platform === "win32") return alive(childPid);
  return alive(-childPid);
}

function killChildGroup() {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(childPid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-childPid, "SIGKILL");
    return;
  } catch {
    /* the group leader may already be gone; try the pid directly */
  }
  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

if (!alive(parentPid)) {
  killChildGroup();
  process.exit(0);
}

const timer = setInterval(() => {
  if (!alive(parentPid)) {
    killChildGroup();
    process.exit(0);
  }
  if (!groupAlive()) process.exit(0);
}, POLL_MS);
// Keep the interval refed: this process must stay alive while the CLI runs.
timer.ref?.();
