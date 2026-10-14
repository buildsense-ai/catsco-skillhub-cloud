import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from 'node:async_hooks';
import { validatePackagePath } from "../domain/index.js";

const ZERO_OID = "0000000000000000000000000000000000000000";
const repoQueues = new Map();
const gitSignals = new AsyncLocalStorage();
const REPOSITORY_LOCK_TIMEOUT_MS = 30_000;
const REPOSITORY_LOCK_STALE_MS = 10 * 60_000;

export async function commitGitVersion({
  config,
  scope,
  skillId,
  version,
  files,
  metadata = {},
  createdAt,
  signal
}) {
  const repository = gitRepository(config, scope, skillId);
  const tag = gitVersionTag(version);
  return gitSignals.run(signal, () => withRepositoryQueue(repository.path, () => withRepositoryFileLock(
    `${repository.path}.lock`,
    async () => {
      await ensureBareRepository(repository.path);
      const treeSha = await writeTree(config, repository.path, files);
      const existingCommit = await resolveOptional(repository.path, `refs/tags/${tag}^{commit}`);
      if (existingCommit) {
        const existingTree = await resolve(repository.path, `${existingCommit}^{tree}`);
        if (existingTree !== treeSha) {
          throw new Error(`Git version tag already exists with different content: ${skillId}@${version}`);
        }
        return {
          ...repository,
          commitSha: existingCommit,
          treeSha: existingTree,
          tag
        };
      }

      const parent = await resolveOptional(repository.path, "refs/heads/main^{commit}");
      let commitSha = null;
      if (parent) {
        const parentTree = await resolve(repository.path, `${parent}^{tree}`);
        if (parentTree === treeSha) commitSha = parent;
      }
      if (!commitSha) {
        const timestamp = canonicalGitDate(createdAt);
        const message = `${JSON.stringify({
          schema: "catsco.skillhub.git-release.v1",
          scope,
          skillId,
          version,
          ...metadata
        })}\n`;
        commitSha = (await runGit(
          repository.path,
          ["commit-tree", treeSha, ...(parent ? ["-p", parent] : [])],
          {
            input: message,
            env: {
              GIT_AUTHOR_NAME: "CatsCo SkillHub",
              GIT_AUTHOR_EMAIL: "skillhub@catsco.local",
              GIT_AUTHOR_DATE: timestamp,
              GIT_COMMITTER_NAME: "CatsCo SkillHub",
              GIT_COMMITTER_EMAIL: "skillhub@catsco.local",
              GIT_COMMITTER_DATE: timestamp
            }
          }
        )).stdout.trim();
        await runGit(
          repository.path,
          ["update-ref", "refs/heads/main", commitSha, parent || ZERO_OID]
        );
      }

      await runGit(
        repository.path,
        ["update-ref", `refs/tags/${tag}`, commitSha, ZERO_OID]
      );
      return {
        ...repository,
        commitSha,
        treeSha,
        tag
      };
    }
  )));
}

export async function assertGitVersion({
  config,
  scope,
  skillId,
  tag,
  commitSha,
  treeSha,
  signal
}) {
  return gitSignals.run(signal, async () => {
  const repository = gitRepository(config, scope, skillId);
  const actualCommit = await resolve(repository.path, `refs/tags/${tag}^{commit}`);
  if (actualCommit !== commitSha) {
    throw new Error(`Git version tag target mismatch: ${skillId}@${tag}`);
  }
  const actualTree = await resolve(repository.path, `${actualCommit}^{tree}`);
  if (actualTree !== treeSha) {
    throw new Error(`Git version tree mismatch: ${skillId}@${tag}`);
  }
  return { ...repository, commitSha: actualCommit, treeSha: actualTree, tag };
  });
}

export function gitRepository(config, scope, skillId) {
  if (!["public", "private"].includes(scope)) throw new Error(`Unsupported Git scope: ${scope}`);
  const subject = String(skillId || "");
  if (!subject) throw new Error("Git repository subject is required");
  const digest = crypto.createHash("sha256").update(`${scope}\0${subject}`).digest("hex");
  const root = scope === "public" ? config.paths.gitPublic : config.paths.gitPrivate;
  return {
    repositoryId: `git_${digest.slice(0, 32)}`,
    repositoryPath: path.join(root, `${digest}.git`),
    path: path.join(root, `${digest}.git`)
  };
}

export function gitVersionTag(version) {
  const value = String(version || "").trim();
  if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    throw new Error("Git version tag is invalid");
  }
  return `v${value}`;
}

async function ensureBareRepository(repositoryPath) {
  try {
    const stat = await fs.stat(repositoryPath);
    if (!stat.isDirectory()) throw new Error(`Git repository path is not a directory: ${repositoryPath}`);
    const bare = (await runGit(repositoryPath, ["rev-parse", "--is-bare-repository"])).stdout.trim();
    if (bare !== "true") throw new Error(`Git repository is not bare: ${repositoryPath}`);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(repositoryPath), { recursive: true, mode: 0o700 });
  const initialized = await runGit(null, ["init", "--bare", "--initial-branch=main", repositoryPath], {
    allowExitCodes: [0, 128]
  });
  if (initialized.code !== 0) {
    const bare = await runGit(repositoryPath, ["rev-parse", "--is-bare-repository"]);
    if (bare.stdout.trim() !== "true") throw new Error(`Unable to initialize Git repository: ${repositoryPath}`);
  }
}

async function writeTree(config, repositoryPath, files) {
  const normalized = normalizeFiles(files, config);
  const indexPath = path.join(config.paths.tmp, `.git-index-${crypto.randomUUID()}`);
  await fs.mkdir(config.paths.tmp, { recursive: true, mode: 0o700 });
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await runGit(repositoryPath, ["read-tree", "--empty"], { env });
    for (const file of normalized) {
      const blobSha = (await runGit(repositoryPath, ["hash-object", "-w", "--stdin"], {
        input: file.buffer
      })).stdout.trim();
      await runGit(
        repositoryPath,
        ["update-index", "--add", "--cacheinfo", "100644", blobSha, file.path],
        { env }
      );
    }
    return (await runGit(repositoryPath, ["write-tree"], { env })).stdout.trim();
  } finally {
    await fs.rm(indexPath, { force: true }).catch(() => {});
  }
}

function normalizeFiles(files, config) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Git version requires source files");
  const seen = new Set();
  return files.map((file) => {
    const filePath = validatePackagePath(file.path, {
      maxPathLength: Math.max(config.limits.maxPathLength, 1024),
      maxPathDepth: Math.max(config.limits.maxPathDepth, 64)
    });
    if (filePath.split("/").some((part) => part.toLowerCase() === ".git")) {
      throw new Error(`Git-reserved source path is not allowed: ${filePath}`);
    }
    const folded = filePath.toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw new Error(`Duplicate Git source path: ${filePath}`);
    seen.add(folded);
    return {
      path: filePath,
      buffer: Buffer.isBuffer(file.buffer)
        ? file.buffer
        : file.contentBase64
          ? Buffer.from(file.contentBase64, "base64")
          : Buffer.from(String(file.content ?? ""), "utf8")
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

async function resolve(repositoryPath, revision) {
  const result = await runGit(repositoryPath, ["rev-parse", "--verify", revision]);
  return result.stdout.trim();
}

async function resolveOptional(repositoryPath, revision) {
  const result = await runGit(
    repositoryPath,
    ["rev-parse", "--verify", "--quiet", revision],
    { allowExitCodes: [0, 1] }
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

function canonicalGitDate(value) {
  const parsed = new Date(value || Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error("Git release timestamp is invalid");
  return parsed.toISOString();
}

function withRepositoryQueue(repositoryPath, work) {
  const previous = repoQueues.get(repositoryPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  repoQueues.set(repositoryPath, current);
  return current.finally(() => {
    if (repoQueues.get(repositoryPath) === current) repoQueues.delete(repositoryPath);
  });
}

async function withRepositoryFileLock(lockPath, work) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + REPOSITORY_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockPath, { recursive: false, mode: 0o700 });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stale = await isStaleLock(lockPath);
      if (stale) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        const busy = new Error("Git repository lock is busy");
        busy.code = "GIT_REPOSITORY_BUSY";
        throw busy;
      }
      await delay(25);
    }
  }

  try {
    return await work();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function isStaleLock(lockPath) {
  const stat = await fs.stat(lockPath).catch(() => null);
  return Boolean(stat && Date.now() - stat.mtimeMs > REPOSITORY_LOCK_STALE_MS);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function runGit(repositoryPath, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const commandArgs = repositoryPath ? ["--git-dir", repositoryPath, ...args] : args;
    const child = spawn("git", commandArgs, {
      shell: false,
      windowsHide: true,
      signal: gitSignals.getStore(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let processError;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    // Keep the repository lock until the process really closes, including when
    // AbortSignal terminates Git. An early rejection could release a live writer.
    child.on("error", error => { processError = error; });
    child.stdin.on('error', error => { processError ??= error; });
    child.on("close", (code) => {
      if (processError) { reject(processError); return; }
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      const allowed = options.allowExitCodes || [0];
      if (allowed.includes(code)) {
        resolvePromise(result);
        return;
      }
      reject(new Error(`git ${args[0]} failed (${code}): ${result.stderr.trim().slice(0, 500)}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
