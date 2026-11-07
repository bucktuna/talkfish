import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = path.join(process.cwd(), "scripts/sync-source.mjs");
const exporter = path.join(process.cwd(), "scripts/export-corpus.mjs");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Talkfish Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Talkfish Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(repo: string, args: string[]) {
  await exec("git", ["-C", repo, ...args], { env });
}

async function run(repo: string, args: string[]) {
  try {
    const { stdout } = await exec("node", [script, "--repo", repo, ...args], { env, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "talkfish-sync-"));
  const bare = path.join(root, "bare.git");
  const local = path.join(root, "local");
  await exec("git", ["init", "--bare", "-b", "main", bare], { env });
  await exec("git", ["init", "-b", "main", local], { env });
  await git(local, ["remote", "add", "origin", bare]);
  await writeFile(path.join(local, "README.md"), "base\n");
  await mkdir(path.join(local, "corpus"), { recursive: true });
  await writeFile(path.join(local, "corpus", "manifest.json"), '{"version":"0.1.0"}\n');
  await writeFile(path.join(local, "check.js"), "process.exit(0)\n");
  await writeFile(
    path.join(local, "update.config.json"),
    JSON.stringify({ remote: "origin", branch: "main", corpusPaths: ["corpus/"], preupdate: ["node", "check.js"] }),
  );
  await git(local, ["add", "."]);
  await git(local, ["commit", "-m", "base"]);
  await git(local, ["push", "origin", "HEAD:main"]);
  return { root, bare, local };
}

let cloneCount = 0;

async function upstreamCommit(bare: string, local: string, filename: string, contents: string) {
  cloneCount += 1;
  const other = path.join(path.dirname(local), `other-${cloneCount}`);
  await exec("git", ["clone", bare, other], { env });
  await writeFile(path.join(other, filename), contents);
  await git(other, ["add", filename]);
  await git(other, ["commit", "-m", `update ${filename}`]);
  await git(other, ["push", "origin", "HEAD:main"]);
}

describe("source and corpus sync", () => {
  it("does not contain a remote send or a hard history rewrite", async () => {
    const source = await readFile(script, "utf8");
    expect(source.includes("git push")).toBe(false);
    expect(source.includes("--force")).toBe(false);
    expect(source.includes("reset --hard")).toBe(false);
  });

  it("refuses a dirty tree and a missing remote without contacting one", async () => {
    const { local } = await fixture();
    await writeFile(path.join(local, "README.md"), "dirty\n");
    const head = (await exec("git", ["-C", local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim();
    const dirty = await run(local, ["--mode", "source"]);
    expect(dirty.code).toBe(2);
    expect((await exec("git", ["-C", local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim()).toBe(head);

    const alone = await mkdtemp(path.join(tmpdir(), "talkfish-alone-"));
    await exec("git", ["init", "-b", "main", alone], { env });
    await writeFile(path.join(alone, "update.config.json"), JSON.stringify({ remote: "github", branch: "main", corpusPaths: ["corpus/"], preupdate: ["node", "-e", "process.exit(0)"] }));
    await git(alone, ["add", "update.config.json"]);
    await git(alone, ["commit", "-m", "alone"]);
    const missing = await run(alone, ["--mode", "source"]);
    expect(missing.code).toBe(3);
    expect(missing.out).toMatch(/not configured/);
  });

  it("fast-forwards and refuses divergence or a failed check", async () => {
    const { bare, local } = await fixture();
    const before = (await exec("git", ["-C", local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim();
    await upstreamCommit(bare, local, "README.md", "forward\n");
    const updated = await run(local, ["--mode", "source"]);
    expect(updated.code).toBe(0);
    const after = (await exec("git", ["-C", local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim();
    expect(after).not.toBe(before);

    await writeFile(path.join(local, "local-only.txt"), "keep\n");
    await git(local, ["add", "local-only.txt"]);
    await git(local, ["commit", "-m", "local only"]);
    const ahead = (await exec("git", ["-C", local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim();
    await upstreamCommit(bare, local, "README.md", "diverged\n");
    const refused = await run(local, ["--mode", "source"]);
    expect(refused.code).toBe(4);
    expect((await exec("git", ["-C", local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim()).toBe(ahead);
    expect(await readFile(path.join(local, "local-only.txt"), "utf8")).toBe("keep\n");
  });

  it("keeps code updates out of corpus mode and rejects private corpus fields", async () => {
    const codeCase = await fixture();
    const codeHead = (await exec("git", ["-C", codeCase.local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim();
    await upstreamCommit(codeCase.bare, codeCase.local, "README.md", "code change\n");
    const code = await run(codeCase.local, ["--mode", "corpus"]);
    expect(code.code).toBe(5);
    expect((await exec("git", ["-C", codeCase.local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim()).toBe(codeHead);

    const poisonedCase = await fixture();
    const poisonedHead = (await exec("git", ["-C", poisonedCase.local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim();
    await upstreamCommit(poisonedCase.bare, poisonedCase.local, "corpus/manifest.json", '{"version":"0.1.1","password":"nope"}\n');
    const poisoned = await run(poisonedCase.local, ["--mode", "corpus"]);
    expect(poisoned.code).toBe(6);
    expect((await exec("git", ["-C", poisonedCase.local, "rev-parse", "HEAD"], { env, encoding: "utf8" })).stdout.trim()).toBe(poisonedHead);

    const okCase = await fixture();
    await upstreamCommit(okCase.bare, okCase.local, "corpus/manifest.json", '{"version":"0.2.0"}\n');
    const corpus = await run(okCase.local, ["--mode", "corpus"]);
    expect(corpus.code).toBe(0);
    expect(await readFile(path.join(okCase.local, "corpus", "manifest.json"), "utf8")).toContain("0.2.0");
  });

  it("exports bundled chess files and skips the operational database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "talkfish-export-"));
    const corpus = path.join(root, "corpus");
    const data = path.join(root, "data");
    const out = path.join(root, "out");
    await mkdir(corpus, { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(path.join(corpus, "manifest.json"), '{"version":"0.1.0"}\n');
    await writeFile(path.join(data, "operational.json"), '{"users":[{"password":"secret-pass","username":"ada"}]}\n');
    await exec("node", [exporter, "--from", corpus, "--out", out], { encoding: "utf8" });
    const exported = await readFile(path.join(out, "manifest.json"), "utf8");
    expect(exported).toContain("0.1.0");
    expect(exported).not.toContain("secret-pass");
    await writeFile(path.join(corpus, "positions.json"), '{"positions":[],"password":"hidden"}\n');
    await expect(exec("node", [exporter, "--from", corpus, "--out", out])).rejects.toThrow(/password/);
  });
});
