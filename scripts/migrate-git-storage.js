import fs from "node:fs/promises";
import { loadConfig } from "../packages/config/index.js";
import { closePools, createStore, ensureRuntimeDirectories } from "../packages/database/store.js";
import { commitGitVersion } from "../packages/git-storage/index.js";
import { artifactUrl, writeArtifactAtomic } from "../packages/object-storage/index.js";

const config = loadConfig();
const store = createStore(config);

await ensureRuntimeDirectories(config);

try {
  const publicRows = await store.query(`
    SELECT *
    FROM skill_versions
    WHERE storage_backend <> 'git-v1'
       OR git_commit_sha IS NULL
    ORDER BY created_at, id
  `);
  for (const row of publicRows.rows) {
    const bytes = await fs.readFile(row.package_path);
    const packageObject = JSON.parse(bytes.toString("utf8"));
    const files = packageObject?.payload?.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(`Published package has no recoverable files: ${row.skill_id}@${row.version}`);
    }
    const sourceVersion = await commitGitVersion({
      config,
      scope: "public",
      skillId: row.skill_id,
      version: row.version,
      files,
      createdAt: row.published_at || row.created_at,
      metadata: {
        imported: true,
        uploadId: row.upload_id,
        contentHash: row.content_hash,
        publisherId: row.owner_user_id,
        scanRunId: row.scan_run_id
      }
    });
    const artifact = await writeArtifactAtomic(config, bytes);
    if (artifact.artifactSha256 !== row.checksum_sha256) {
      throw new Error(`Published package checksum changed during Git migration: ${row.skill_id}@${row.version}`);
    }
    await store.query(
      `UPDATE skill_versions
       SET storage_backend = 'git-v1',
           git_repository_id = $2,
           git_commit_sha = $3,
           git_tree_sha = $4,
           git_tag = $5,
           artifact_sha256 = $6,
           package_path = $7,
           package_file = $8,
           package_url = $9,
           updated_at = now()
       WHERE id = $1`,
      [
        row.id,
        sourceVersion.repositoryId,
        sourceVersion.commitSha,
        sourceVersion.treeSha,
        sourceVersion.tag,
        artifact.artifactSha256,
        artifact.artifactPath,
        artifact.artifactFile,
        artifactUrl(config, artifact.artifactSha256)
      ]
    );
    console.log(`migrated public ${row.skill_id}@${row.version} -> ${sourceVersion.commitSha}`);
  }

  const privateRows = await store.query(`
    SELECT v.*, s.skill_id, s.authority, s.owner_bot_id, s.local_skill_id
    FROM private_skill_versions v
    JOIN private_skills s ON s.id = v.private_skill_id
    WHERE v.status = 'active'
      AND (
        v.storage_backend <> 'git-v1'
        OR v.git_commit_sha IS NULL
      )
    ORDER BY v.created_at, v.id
  `);
  for (const row of privateRows.rows) {
    const bytes = await fs.readFile(row.package_path);
    const packageObject = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(packageObject.files) || packageObject.files.length === 0) {
      throw new Error(`Private package has no recoverable files: ${row.skill_id}@${row.version}`);
    }
    const sourceVersion = await commitGitVersion({
      config,
      scope: "private",
      skillId: row.skill_id,
      version: row.version,
      files: packageObject.files,
      createdAt: row.created_at,
      metadata: {
        imported: true,
        authority: row.authority,
        ownerBotId: row.owner_bot_id,
        localSkillId: row.local_skill_id,
        contentHash: row.content_hash
      }
    });
    const artifact = await writeArtifactAtomic(config, bytes, {
      privateArtifact: true,
      extension: ".json"
    });
    if (artifact.artifactSha256 !== row.package_sha256) {
      throw new Error(`Private package checksum changed during Git migration: ${row.skill_id}@${row.version}`);
    }
    await store.query(
      `UPDATE private_skill_versions
       SET storage_backend = 'git-v1',
           git_repository_id = $2,
           git_commit_sha = $3,
           git_tree_sha = $4,
           git_tag = $5,
           artifact_sha256 = $6,
           package_path = $7,
           updated_at = now()
       WHERE id = $1`,
      [
        row.id,
        sourceVersion.repositoryId,
        sourceVersion.commitSha,
        sourceVersion.treeSha,
        sourceVersion.tag,
        artifact.artifactSha256,
        artifact.artifactPath
      ]
    );
    console.log(`migrated private ${row.skill_id}@${row.version} -> ${sourceVersion.commitSha}`);
  }

  console.log(JSON.stringify({
    ok: true,
    publicVersionsMigrated: publicRows.rowCount,
    privateVersionsMigrated: privateRows.rowCount
  }));
} finally {
  await closePools();
}
