import { compareSemver } from "../domain/index.js";

export function searchPublishedSkills(packageVersions, query = "", options = {}) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const terms = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
  const versions = packageVersions
    .filter((version) => version.status === "published" && !version.yankedAt)
    .filter((version) => compatible(version.manifest, options.agentVersion, options.platform));

  const latestBySkill = new Map();
  for (const version of versions) {
    const existing = latestBySkill.get(version.skillId);
    if (!existing || compareSemver(version.version, existing.version) > 0) {
      latestBySkill.set(version.skillId, version);
    }
  }

  return [...latestBySkill.values()]
    .map((version) => ({ version, score: scoreVersion(version, terms, options.category) }))
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || b.version.publishedAt.localeCompare(a.version.publishedAt))
    .slice(0, options.limit ?? 30)
    .map(({ version }) => toRegistryEntry(version));
}

export function toRegistryEntry(version) {
  const namespace = String(version.skillId || "").split("/")[0] || "";
  const author = version.manifest.author || {};
  const authorName = String(author.name || "").trim();
  return {
    skillId: version.skillId,
    name: version.skillName,
    displayName: version.displayName,
    description: version.manifest.description,
    latestVersion: version.version,
    categories: version.manifest.categories,
    tags: version.manifest.tags,
    keywords: version.manifest.keywords,
    triggerExamples: version.manifest.triggerExamples,
    author: {
      ...author,
      name: authorName && authorName !== "Unknown" ? authorName : (namespace || "Unknown")
    },
    permissions: version.manifest.permissions,
    runtime: version.manifest.runtime,
    riskLevel: version.manifest.riskLevel ?? "low",
    packageUrl: version.packageUrl,
    contentHash: version.contentHash,
    checksumSha256: version.checksumSha256,
    signature: version.signature,
    sourceVersion: version.storageBackend === "git-v1" ? {
      model: "git",
      repositoryId: version.gitRepositoryId,
      commitSha: version.gitCommitSha,
      treeSha: version.gitTreeSha,
      tag: version.gitTag
    } : undefined,
    publishedAt: version.publishedAt,
    downloadCount: version.downloadCount ?? 0
  };
}

function compatible(manifest, agentVersion, platform) {
  // Search remains discovery-oriented: runtime.minAgentVersion is advisory here so older clients can still find shared skills.
  const platforms = manifest.runtime?.platforms;
  if (!platform || !Array.isArray(platforms) || platforms.length === 0) return true;
  const requested = normalizePlatform(platform);
  return platforms.map(normalizePlatform).includes(requested);
}

function normalizePlatform(platform) {
  const value = String(platform ?? "").trim().toLowerCase();
  if (["win32", "windows", "win", "win64"].includes(value)) return "windows";
  if (["darwin", "macos", "mac", "osx"].includes(value)) return "macos";
  if (["linux", "linux2"].includes(value)) return "linux";
  return value;
}

function scoreVersion(version, terms, category) {
  const manifest = version.manifest;
  if (category && !(manifest.categories ?? []).includes(category)) return 0;
  if (!terms.length) return 1;
  const fields = [
    [manifest.displayName, 10],
    [manifest.name, 8],
    [manifest.description, 6],
    [(manifest.keywords ?? []).join(" "), 7],
    [(manifest.tags ?? []).join(" "), 5],
    [(manifest.triggerExamples ?? []).join(" "), 4],
    [(manifest.categories ?? []).join(" "), 3]
  ];
  let score = 0;
  for (const term of terms) {
    for (const [field, weight] of fields) {
      if (String(field ?? "").toLowerCase().includes(term)) score += weight;
    }
  }
  return score;
}
