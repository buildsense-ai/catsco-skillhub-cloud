import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { validatePackagePath, sha256 } from "../domain/index.js";

export async function saveSubmissionFiles(config, submissionId, files, limits = config.limits) {
  const root = path.join(config.paths.intake, submissionId, "files");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const seen = new Set();
  const saved = [];

  for (const file of files) {
    const packagePath = validatePackagePath(file.path, limits);
    if (seen.has(packagePath)) throw new Error(`重复文件路径: ${packagePath}`);
    seen.add(packagePath);

    const buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : file.contentBase64
        ? Buffer.from(file.contentBase64, "base64")
        : Buffer.from(String(file.content ?? ""), "utf8");

    if (buffer.length > limits.maxSingleFileBytes) {
      throw new Error(`单文件过大: ${packagePath}`);
    }

    const absolutePath = await safeJoin(root, packagePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(absolutePath, buffer, { mode: 0o600 });
    saved.push({
      path: packagePath,
      size: buffer.length,
      sha256: sha256(buffer)
    });
  }

  await fs.writeFile(path.join(config.paths.intake, submissionId, "inventory.json"), `${JSON.stringify(saved, null, 2)}\n`, {
    mode: 0o600
  });
  return saved;
}

export async function readSubmissionFiles(config, submissionId) {
  const root = path.join(config.paths.intake, submissionId, "files");
  const result = [];
  await walk(root, async (absolutePath) => {
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    const packagePath = validatePackagePath(relative, config.limits);
    const buffer = await fs.readFile(absolutePath);
    result.push({ path: packagePath, buffer, size: buffer.length, sha256: sha256(buffer) });
  });
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeReviewSnapshot(config, submissionId, report) {
  const dir = path.join(config.paths.reviews, submissionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "review.json");
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function writePackageAtomic(config, skillId, version, filename, bytes) {
  const dir = path.join(config.paths.packages, skillId, version);
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  const finalPath = path.join(dir, filename);
  try {
    await fs.stat(finalPath);
    throw new Error(`发布包已存在，不能覆盖: ${skillId}@${version}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tmp = path.join(config.paths.tmp, `${filename}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(config.paths.tmp, { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, bytes, { mode: 0o644 });
  await fs.rename(tmp, finalPath);
  return finalPath;
}

export async function writeArtifactAtomic(config, bytes, { privateArtifact = false, extension = ".skillpkg" } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const checksumSha256 = sha256(buffer);
  const root = privateArtifact ? config.paths.privateArtifacts : config.paths.artifacts;
  const dir = path.join(root, checksumSha256.slice(0, 2));
  const filename = `${checksumSha256}${extension}`;
  const finalPath = path.join(dir, filename);
  await fs.mkdir(dir, { recursive: true, mode: privateArtifact ? 0o700 : 0o755 });

  try {
    const existing = await fs.readFile(finalPath);
    if (sha256(existing) !== checksumSha256) {
      throw new Error(`Content-addressed artifact checksum mismatch: ${checksumSha256}`);
    }
    return {
      artifactPath: finalPath,
      artifactFile: filename,
      artifactSha256: checksumSha256,
      artifactBytes: existing.length
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  // Keep the temporary file in the destination directory. systemd can expose
  // storage and shared as separate writable bind mounts, where a hard link
  // from config.paths.tmp to a private artifact would fail with EXDEV.
  const tmp = path.join(dir, `.artifact-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, "wx", privateArtifact ? 0o600 : 0o644);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tmp, finalPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      const existing = await fs.readFile(finalPath);
      if (sha256(existing) !== checksumSha256) throw error;
    } else {
      throw error;
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  return {
    artifactPath: finalPath,
    artifactFile: filename,
    artifactSha256: checksumSha256,
    artifactBytes: buffer.length
  };
}

export function artifactUrl(config, checksumSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(checksumSha256 || ""))) {
    throw new Error("Artifact SHA-256 is invalid");
  }
  return `${config.packageBaseUrl.replace(/\/+$/, "")}/sha256/${checksumSha256}.skillpkg`;
}

export function packageUrl(config, skillId, version, filename) {
  const base = config.packageBaseUrl.replace(/\/+$/, "");
  const skillPath = String(skillId).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${base}/${skillPath}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;
}

export async function safeJoin(root, packagePath) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(root, ...packagePath.split("/"));
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`路径逃逸: ${packagePath}`);
  }
  return absolutePath;
}

async function walk(root, visit) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`拒绝符号链接: ${absolutePath}`);
    if (entry.isDirectory()) {
      await walk(absolutePath, visit);
    } else if (entry.isFile()) {
      await visit(absolutePath);
    }
  }
}
