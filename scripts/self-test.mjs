#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import undoRedo, { ShadowGit } from "../src/extension.ts";

const settings = { enabled: true, storageDir: "", largeFileLimitBytes: 1024 * 1024, gitTimeoutMs: 30_000 };

async function main() {
  testActivation();
  await testGitSnapshot();
  await testNonGitTouchedPaths();
  console.log("self-test passed");
}

function testActivation() {
  const events = [];
  const commands = [];
  undoRedo({
    on: (name) => events.push(name),
    registerCommand: (name) => commands.push(name),
    appendEntry: () => undefined,
  });
  for (const command of ["undo", "redo", "undo-cleanup"]) {
    assert(commands.includes(command), `missing command ${command}`);
  }
  for (const event of ["session_start", "before_agent_start", "message_start", "agent_end", "tool_call"]) {
    assert(events.includes(event), `missing event ${event}`);
  }
}

async function testGitSnapshot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-git-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);

    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    assert(await snap.available(), "git snapshotter should be available");
    const before = await snap.track();
    writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    writeFileSync(path.join(root, "shell-new.txt"), "created\n");
    const after = await snap.track();
    const files = await snap.patchFiles(before);
    assert(files.includes("tracked.txt"), "git patch should include tracked modify");
    assert(files.includes("shell-new.txt"), "git patch should include ordinary untracked file");
    await snap.revertFiles(before, files);
    assert(readFileSync(path.join(root, "tracked.txt"), "utf8") === "base\n", "git undo tracked content");
    assert(!existsSync(path.join(root, "shell-new.txt")), "git undo removes new file");
    await snap.revertFiles(after, files);
    assert(readFileSync(path.join(root, "tracked.txt"), "utf8") === "changed\n", "git redo tracked content");
    assert(readFileSync(path.join(root, "shell-new.txt"), "utf8") === "created\n", "git redo new file");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testNonGitTouchedPaths() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-nongit-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    writeFileSync(path.join(root, "target.txt"), "base\n");
    writeFileSync(path.join(root, "sentinel.txt"), "sentinel\n");
    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    assert(await snap.available(), "non-git snapshotter should be available");
    assert(!(await snap.isGitMode()), "non-git mode expected");

    const emptyBefore = await snap.track();
    let before = await snap.capturePathBefore("target.txt", emptyBefore);
    writeFileSync(path.join(root, "target.txt"), "changed\n");
    const after = await snap.track(["target.txt"]);
    const files = await snap.patchFiles(before, ["target.txt"]);
    assert(files.length === 1 && files[0] === "target.txt", "non-git patch limited to explicit path");
    await snap.revertFiles(before, files);
    assert(readFileSync(path.join(root, "target.txt"), "utf8") === "base\n", "non-git undo explicit file");
    assert(readFileSync(path.join(root, "sentinel.txt"), "utf8") === "sentinel\n", "non-git leaves sentinel untouched");
    await snap.revertFiles(after, files);
    assert(readFileSync(path.join(root, "target.txt"), "utf8") === "changed\n", "non-git redo explicit file");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
