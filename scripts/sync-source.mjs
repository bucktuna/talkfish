#!/usr/bin/env node
/**
 * Fast-forward a local checkout to one approved remote branch, or only the
 * bundled corpus files. Refuses a dirty tree, a missing remote, and any
 * history that is not a fast-forward. Does not delete local work.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ALLOWED_GIT = new Set([
  "diff",
  "fetch",
  "merge",
  "merge-base",
  "remote",
  "rev-parse",
  "status",
  "worktree",
]);
const BLOCKED_PATH_PREFIXES = ["data/", ".env", "credentials"];

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { repo: process.cwd(), config: null, mode: "source" };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--repo") out.repo = path.resolve(value);
    else if (flag === "--config") out.config = path.resolve(value);
    else if (flag === "--mode") out.mode = value;
    else fail(1, `Unknown argument ${flag}`);
    i += 1;
  }
  if (out.mode !== "source" && out.mode !== "corpus") fail(1, "Mode must be source or corpus.");
  return out;
}

function assertToken(label, value) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("-") || value.includes("..")) {
    fail(1, `${label} is not a safe git name.`);
  }
}

async function git(repo, args) {
  if (!ALLOWED_GIT.has(args[0])) fail(1, "That git operation is not allowed.");
  const { stdout } = await exec("git", ["-C", repo, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function gitOk(repo, args) {
  try {
    await exec("git", ["-C", repo, ...args], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function forbiddenKey(value, pointer, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKey(item, `${pointer}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "password",
        "passwordhash",
        "email",
        "audio",
        "transcript",
        "userid",
        "session",
        "apikey",
        "authorization",
        "cookie",
        "secret",
        "dialogue",
        "username",
        "vote",
      ].includes(key.toLowerCase())
    ) {
      errors.push(`${pointer}.${key}`);
    }
    forbiddenKey(child, `${pointer}.${key}`, errors);
  }
}

async function scanCorpus(dir) {
  const errors = [];
  for (const name of ["manifest.json", "positions.json", "patterns.json"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      errors.push(`${name} is not valid JSON`);
      continue;
    }
    forbiddenKey(parsed, name, errors);
  }
  return errors;
}

function stopped(code, message) {
  const error = new Error(message);
  error.exitCode = code;
  return error;
}

async function runCheck(repo, command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || /[;&|`$<>\n]/.test(part))) {
    throw stopped(6, "The pre-switch check command is not a safe argument list.");
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "talkfish-sync-"));
  try {
    await git(repo, ["worktree", "add", "--detach", work, "FETCH_HEAD"]);
    const modules = path.join(repo, "node_modules");
    if (existsSync(modules) && !existsSync(path.join(work, "node_modules"))) {
      await symlink(modules, path.join(work, "node_modules"), "dir");
    }
    await exec(command[0], command.slice(1), { cwd: work, encoding: "utf8" });
    const corpusErrors = await scanCorpus(path.join(work, "corpus"));
    if (corpusErrors.length) throw stopped(6, `Incoming corpus was rejected: ${corpusErrors.join("; ")}`);
  } catch (error) {
    if (error && error.exitCode) throw error;
    const detail = error instanceof Error ? error.message.split("\n")[0] : "check failed";
    throw stopped(6, `Pre-switch check failed, so the checkout was left unchanged. ${detail}`);
  } finally {
    await gitOk(repo, ["worktree", "remove", work]);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await gitOk(repo, ["worktree", "prune"]);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ?? path.join(args.repo, "update.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assertToken("remote", config.remote);
  assertToken("branch", config.branch);
  const corpusPaths = Array.isArray(config.corpusPaths) ? config.corpusPaths : ["corpus/"];
  for (const entry of corpusPaths) assertToken("corpus path", entry.replace(/\/$/, ""));

  const dirty = await git(args.repo, ["status", "--porcelain"]);
  if (dirty) fail(2, "The worktree has uncommitted changes. Refusing to update.");

  const remoteUrl = await gitOk(args.repo, ["remote", "get-url", config.remote]);
  if (!remoteUrl) {
    fail(3, `Approved remote '${config.remote}' is not configured. No remote was contacted.`);
  }

  await git(args.repo, ["fetch", config.remote, config.branch]);
  const head = await git(args.repo, ["rev-parse", "HEAD"]);
  const fetched = await git(args.repo, ["rev-parse", "FETCH_HEAD"]);
  if (head === fetched) {
    console.log("Already current.");
    return;
  }
  const fastForward = await gitOk(args.repo, ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]);
  if (!fastForward) {
    fail(4, "The approved branch is not a fast-forward of this checkout. Local commits were left in place.");
  }

  const names = (await git(args.repo, ["diff", "--name-only", "HEAD", "FETCH_HEAD"])).split("\n").filter(Boolean);
  for (const name of names) {
    if (name.split("/").includes("..") || BLOCKED_PATH_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))) {
      fail(6, `Incoming path ${name} is not allowed into this checkout.`);
    }
  }
  if (args.mode === "corpus") {
    const outside = names.filter((name) => !corpusPaths.some((prefix) => name.startsWith(prefix)));
    if (outside.length) {
      fail(5, `Incoming changes are not limited to the corpus (${outside.join(", ")}). Use source mode for code.`);
    }
  }

  await runCheck(args.repo, config.preupdate);
  await git(args.repo, ["merge", "--ff-only", "FETCH_HEAD"]);
  console.log(`Updated ${args.mode} to ${fetched.slice(0, 12)}. Restart the server yourself if it is running.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Sync failed.");
  process.exit(error && error.exitCode ? error.exitCode : 1);
});
