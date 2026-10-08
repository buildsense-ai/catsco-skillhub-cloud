import { compareSemver, sha256, ValidationError } from "../domain/index.js";
import { PRESENTATION_CATEGORIES } from "../presentations/index.js";

const catalogueCategories = new Set(PRESENTATION_CATEGORIES.map(({ id }) => id));

export function searchPublishedSkills(packageVersions, query = "", options = {}) {
  return rankedPublishedSkills(packageVersions, query, options, true)
    .filter(({ version }) => matchesCategory(version, options.category))
    .slice(0, options.limit ?? 30)
    .map(({ version }) => toRegistryEntry(version));
}

// Opt-in pagination: existing registry consumers keep their array response and limit.
export function searchPublishedSkillsPage(packageVersions, query = "", options = {}) {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("Catalogue limit must be an integer between 1 and 100.", "catalogue.limit_invalid");
  }
  const searchMode = options.searchMode === "name" ? "name" : "discovery";
  const category = String(options.category ?? "").trim();
  const filters = sha256(JSON.stringify({
    query: searchMode === "name" ? normalizeNameSearchText(query) : String(query ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    searchMode,
    category,
    platform: normalizePlatform(options.platform),
    limit
  }));
  const ranked = rankedPublishedSkills(packageVersions, query, { ...options, platform: normalizePlatform(options.platform) });
  const counts = new Map();
  for (const { version } of ranked) {
    const value = catalogueCategory(version);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const snapshot = sha256(JSON.stringify(ranked.map(({ version, score }) => ({
    skillId: version.skillId, version: version.version, contentHash: version.contentHash,
    publishedAt: version.publishedAt, score, primaryCategory: catalogueCategory(version),
    presentation: version.presentationSummary ?? null
  }))));
  let offset = 0;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
    const cursor = decodeCursor(options.cursor);
    if (cursor.filters !== filters) {
      throw new ValidationError("Catalogue filters changed; restart pagination.", "catalogue.cursor_filters", 409);
    }
    if (cursor.snapshot !== snapshot) {
      throw new ValidationError("Catalogue changed; restart pagination.", "catalogue.cursor_stale", 409);
    }
    offset = cursor.offset;
  }
  const matched = ranked.filter(({ version }) => !category || catalogueCategory(version) === category);
  if (offset > matched.length) throw invalidCursor();
  const end = offset + limit;
  return {
    skills: matched.slice(offset, end).map(({ version }) => ({
      ...toRegistryEntry(version), primaryCategory: catalogueCategory(version)
    })),
    total: matched.length,
    nextCursor: end < matched.length
      ? Buffer.from(JSON.stringify({ v: 1, filters, snapshot, offset: end })).toString("base64url") : null,
    categoryCounts: [...counts].sort(([a], [b]) => compareText(a, b)).map(([category, count]) => ({ category, count }))
  };
}

function invalidCursor() {
  return new ValidationError("Invalid catalogue cursor.", "catalogue.cursor_invalid");
}

function decodeCursor(value) {
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw invalidCursor();
    const cursor = JSON.parse(bytes.toString("utf8"));
    if (!cursor || cursor.v !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset <= 0
      || !/^[a-f0-9]{64}$/.test(cursor.filters) || !/^[a-f0-9]{64}$/.test(cursor.snapshot)
      || Object.keys(cursor).sort().join(",") !== "filters,offset,snapshot,v") throw invalidCursor();
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function catalogueCategory(version) {
  const primary = version.presentationSummary?.primaryCategory;
  if (catalogueCategories.has(primary)) return primary;
  return (version.manifest.categories ?? []).find((category) => catalogueCategories.has(category)) || "other";
}

function matchesCategory(version, category) {
  return !category || (version.manifest.categories ?? []).includes(category);
}

function rankedPublishedSkills(packageVersions, query, options, platformFallback = false) {
  const searchMode = options.searchMode === "name" ? "name" : "discovery";
  const normalizedQuery = searchMode === "name"
    ? normalizeNameSearchText(query)
    : String(query ?? "").trim().toLowerCase();
  const terms = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
  const versions = packageVersions
    .filter((version) => version.status === "published" && !version.yankedAt)
    // Legacy registry search deliberately discovers the newest compatible release.
    // Catalogue pages instead classify the current release, never an older one.
    .filter((version) => !platformFallback || compatible(version.manifest, options.agentVersion, options.platform));

  const latestBySkill = new Map();
  for (const version of versions) {
    const existing = latestBySkill.get(version.skillId);
    if (!existing || compareSemver(version.version, existing.version) > 0) {
      latestBySkill.set(version.skillId, version);
    }
  }

  return [...latestBySkill.values()]
    .filter((version) => compatible(version.manifest, options.agentVersion, options.platform))
    .map((version) => ({
      version,
      score: searchMode === "name"
        ? scoreVersionName(version, terms, normalizedQuery)
        : scoreVersion(version, terms)
    }))
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score
      || compareText(b.version.publishedAt ?? "", a.version.publishedAt ?? "")
      || compareText(a.version.skillId, b.version.skillId));
}

export function toRegistryEntry(version) {
  const namespace = String(version.skillId || "").split("/")[0] || "";
  const author = version.manifest.author || {};
  const authorName = String(author.name || "").trim();
  const publisherDisplayName = String(version.publisherDisplayName || "").trim();
  const catsCoUid = catsCoUidFromContact(version.publisherContact);
  return {
    skillId: version.skillId,
    name: version.skillName,
    displayName: version.displayName,
    description: version.manifest.description,
    latestVersion: version.version,
    categories: version.manifest.categories,
    ...(version.presentationSummary ? {
      primaryCategory: version.presentationSummary.primaryCategory || version.manifest.categories?.[0] || null,
      presentationSummary: version.presentationSummary
    } : {}),
    tags: version.manifest.tags,
    keywords: version.manifest.keywords,
    triggerExamples: version.manifest.triggerExamples,
    author: {
      ...author,
      name: authorName && authorName !== "Unknown" ? authorName : (namespace || "Unknown"),
      ...(publisherDisplayName ? { displayName: publisherDisplayName } : {}),
      ...(catsCoUid ? { catsCoUid } : {})
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

function catsCoUidFromContact(contact) {
  const match = /^catsco:(\d+)$/.exec(String(contact || "").trim());
  return match?.[1] || "";
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

function scoreVersion(version, terms) {
  const manifest = version.manifest;
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

function scoreVersionName(version, terms, normalizedQuery) {
  const manifest = version.manifest;
  if (!terms.length) return 1;
  const fields = [
    [version.displayName || manifest.displayName, 10],
    [version.skillName || manifest.name, 8]
  ].map(([value, weight]) => [normalizeNameSearchText(value), weight]);
  if (!terms.every((term) => fields.some(([field]) => field.includes(term)))) return 0;

  let score = 0;
  for (const [field, weight] of fields) {
    if (field === normalizedQuery) score += 100 + weight;
    else if (field.startsWith(normalizedQuery)) score += 50 + weight;
    else if (field.includes(normalizedQuery)) score += 20 + weight;
    for (const term of terms) {
      if (field.includes(term)) score += weight;
    }
  }
  return score;
}

function normalizeNameSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}
