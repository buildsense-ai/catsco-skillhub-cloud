import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../../packages/config/index.js";
import { ensureRuntimeDirectories } from "../../packages/database/store.js";
import {
  assertGitVersion,
  commitGitVersion,
  gitRepository
} from "../../packages/git-storage/index.js";
import { artifactUrl, writeArtifactAtomic } from "../../packages/object-storage/index.js";

let root;
let config;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "catsco-skillhub-git-"));
  config = loadConfig({
    root,
    storageRoot: path.join(root, "storage"),
    logsRoot: path.join(root, "logs"),
    sharedRoot: path.join(root, "shared"),
    nodeEnv: "test"
  });
  await ensureRuntimeDirectories(config);
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("each Skill uses an isolated bare Git repository with immutable version tags", async () => {
  const firstFiles = files("# Git-backed Skill v1\n");
  const first = await commitGitVersion({
    config,
    scope: "public",
    skillId: "alice/git-demo",
    version: "1.0.0",
    files: firstFiles,
    createdAt: "2026-07-30T00:00:00.000Z",
    metadata: { contentHash: "a".repeat(64) }
  });
  assert.equal(first.tag, "v1.0.0");
  assert.match(first.commitSha, /^[a-f0-9]{40}$/);
  assert.match(first.treeSha, /^[a-f0-9]{40}$/);
  assert.equal(first.repositoryId, gitRepository(config, "public", "alice/git-demo").repositoryId);
  assert.equal((await fs.stat(first.repositoryPath)).isDirectory(), true);

  const idempotent = await commitGitVersion({
    config,
    scope: "public",
    skillId: "alice/git-demo",
    version: "1.0.0",
    files: firstFiles,
    createdAt: "2026-07-30T00:00:00.000Z",
    metadata: { contentHash: "a".repeat(64) }
  });
  assert.equal(idempotent.commitSha, first.commitSha);

  const second = await commitGitVersion({
    config,
    scope: "public",
    skillId: "alice/git-demo",
    version: "1.0.1",
    files: files("# Git-backed Skill v2\n"),
    createdAt: "2026-07-30T00:01:00.000Z",
    metadata: { contentHash: "b".repeat(64) }
  });
  assert.notEqual(second.commitSha, first.commitSha);
  assert.notEqual(second.treeSha, first.treeSha);
  await assertGitVersion({
    config,
    scope: "public",
    skillId: "alice/git-demo",
    tag: first.tag,
    commitSha: first.commitSha,
    treeSha: first.treeSha
  });

  await assert.rejects(
    commitGitVersion({
      config,
      scope: "public",
      skillId: "alice/git-demo",
      version: "1.0.0",
      files: files("# Attempted tag rewrite\n"),
      createdAt: "2026-07-30T00:02:00.000Z"
    }),
    /already exists with different content/
  );

  const other = await commitGitVersion({
    config,
    scope: "public",
    skillId: "bob/git-demo",
    version: "1.0.0",
    files: firstFiles,
    createdAt: "2026-07-30T00:00:00.000Z"
  });
  assert.notEqual(other.repositoryId, first.repositoryId);
  assert.notEqual(other.repositoryPath, first.repositoryPath);
});

test("signed package artifacts are content-addressed instead of version-directory-addressed", async () => {
  const bytes = Buffer.from('{"signed":true}\n');
  const first = await writeArtifactAtomic(config, bytes);
  const second = await writeArtifactAtomic(config, bytes);
  assert.equal(first.artifactPath, second.artifactPath);
  assert.equal(first.artifactSha256, second.artifactSha256);
  assert.equal(await fs.readFile(first.artifactPath, "utf8"), bytes.toString("utf8"));
  assert.equal(
    artifactUrl({ ...config, packageBaseUrl: "https://skillhub.example/packages" }, first.artifactSha256),
    `https://skillhub.example/packages/sha256/${first.artifactSha256}.skillpkg`
  );
  assert.equal(first.artifactPath.includes(path.join("packages", "alice", "git-demo", "1.0.0")), false);
});

function files(markdown) {
  return [
    { path: "SKILL.md", buffer: Buffer.from(markdown) },
    { path: "docs/README.md", buffer: Buffer.from("Git storage test\n") }
  ];
}
