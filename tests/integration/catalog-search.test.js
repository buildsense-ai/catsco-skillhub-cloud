import assert from "node:assert/strict";
import test from "node:test";

import { searchPublishedSkills, searchPublishedSkillsPage, toRegistryEntry } from "../../packages/search/index.js";
import { ValidationError } from "../../packages/domain/index.js";

test("name search excludes description-only substring matches", () => {
  const versions = [
    publishedVersion({
      skillId: "tools/read-pdf",
      name: "read-pdf",
      description: "Read and inspect PDF files."
    }),
    publishedVersion({
      skillId: "tools/cloud-html-artifact",
      name: "cloud-html-artifact",
      description: "Publish an already-built browser artifact."
    }),
    publishedVersion({
      skillId: "tools/officecli",
      name: "officecli",
      description: "Create, proofread, and modify Office documents."
    })
  ];

  assert.deepEqual(
    searchPublishedSkills(versions, "read").map((skill) => skill.name).sort(),
    ["cloud-html-artifact", "officecli", "read-pdf"]
  );
  assert.deepEqual(
    searchPublishedSkills(versions, "read", { searchMode: "name" }).map((skill) => skill.name),
    ["read-pdf"]
  );
});

test("name search matches technical and display names with separator normalization", () => {
  const versions = [
    publishedVersion({
      skillId: "tools/read-pdf",
      name: "read-pdf",
      displayName: "PDF Reader"
    }),
    publishedVersion({
      skillId: "tools/pdf-author-editor",
      name: "pdf_author_editor",
      displayName: "PDF Author Editor"
    })
  ];

  assert.deepEqual(
    searchPublishedSkills(versions, "read pdf", { searchMode: "name" }).map((skill) => skill.name),
    ["read-pdf"]
  );
  assert.deepEqual(
    searchPublishedSkills(versions, "pdf author", { searchMode: "name" }).map((skill) => skill.name),
    ["pdf_author_editor"]
  );
  assert.deepEqual(
    searchPublishedSkills(versions, "read editor", { searchMode: "name" }),
    []
  );
});

test("registry entries expose the current CatsCo display name and stable UID without replacing the namespace", () => {
  const version = publishedVersion({
    skillId: "arrowhaken/test-skill",
    name: "test-skill",
    authorName: "arrowhaken",
    publisherDisplayName: "arrowhaken1",
    publisherContact: "catsco:85"
  });

  assert.deepEqual(toRegistryEntry(version).author, {
    name: "arrowhaken",
    displayName: "arrowhaken1",
    catsCoUid: "85"
  });
});

test("registry entries do not expose non-CatsCo publisher contact values", () => {
  const version = publishedVersion({
    skillId: "tools/test-skill",
    name: "test-skill",
    publisherDisplayName: "Test User",
    publisherContact: "private@example.com"
  });

  assert.deepEqual(toRegistryEntry(version).author, {
    name: "tools",
    displayName: "Test User"
  });
});

test("category is a filter even when the query is empty, applied to the latest version", () => {
  const older = publishedVersion({ skillId: "a/read", name: "read" });
  older.manifest.categories = ["office"];
  const latest = { ...older, version: "2.0.0", manifest: { ...older.manifest, categories: ["research"] } };
  for (const searchMode of ["name", "discovery"]) {
    assert.deepEqual(searchPublishedSkills([older, latest], "", { category: "office", searchMode }), []);
    assert.deepEqual(searchPublishedSkills([older, latest], "read", { category: "office", searchMode }), []);
    assert.equal(searchPublishedSkills([older, latest], "", { category: "research", searchMode })[0].latestVersion, "2.0.0");
  }
});

test("legacy search retains platform fallback while catalogue reflects only the current release", () => {
  const older = publishedVersion({ skillId: "tools/read", name: "read" });
  older.manifest.categories = ["office"];
  older.manifest.runtime.platforms = ["windows"];
  const latest = { ...older, version: "2.0.0", manifest: {
    ...older.manifest, categories: ["research"], runtime: { platforms: ["linux"] }
  } };
  const versions = [latest, older];
  assert.equal(searchPublishedSkills(versions, "", { platform: "win32", category: "office" })[0].latestVersion, "1.0.0");
  assert.equal(searchPublishedSkills(versions, "", { platform: "linux" })[0].latestVersion, "2.0.0");
  assert.deepEqual(searchPublishedSkillsPage(versions, "", { platform: "win32" }), {
    skills: [], total: 0, nextCursor: null, categoryCounts: []
  });
  assert.equal(searchPublishedSkillsPage(versions, "", { platform: "linux" }).skills[0].latestVersion, "2.0.0");
});

test("paginated catalogue enumerates over 30 skills deterministically without collapsing publishers", () => {
  const versions = Array.from({ length: 75 }, (_, index) => publishedVersion({
    skillId: `author-${String(index).padStart(2, "0")}/read`, name: "read"
  }));
  assert.equal(searchPublishedSkills(versions).length, 30);
  const seen = [];
  let cursor;
  do {
    const page = searchPublishedSkillsPage([...versions].reverse(), "", { limit: 20, cursor });
    assert.equal(page.total, 75);
    seen.push(...page.skills.map((skill) => skill.skillId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, versions.map((version) => version.skillId));
  assert.equal(new Set(seen).size, 75);
  assert.equal(searchPublishedSkillsPage(versions).skills.length, 30);
});

test("category counts use all matching latest published skills before the category and page filters", () => {
  const make = (id, category, extra = {}) => {
    const version = publishedVersion({ skillId: id, name: id.split("/")[1] });
    version.manifest.categories = [category, category];
    return { ...version, ...extra };
  };
  const versions = [
    make("a/read", "office"),
    make("a/read", "research", { version: "2.0.0" }),
    make("b/read", "office"),
    make("c/draw", "images"),
    make("d/read", "office", { yankedAt: "2026-10-01" }),
    make("e/read", "office", { status: "deprecated" }),
    make("f/read", "office")
  ];
  versions.at(-1).manifest.runtime.platforms = ["linux"];
  const page = searchPublishedSkillsPage(versions, "read", { category: "other", platform: "win32", limit: 1 });
  assert.deepEqual(page.skills.map((skill) => skill.skillId), ["b/read"]);
  assert.equal(page.total, 1);
  assert.deepEqual(page.categoryCounts, [{ category: "other", count: 1 }, { category: "research", count: 1 }]);
  assert.equal(page.nextCursor, null);
});

test("presentation category overrides legacy classification without mutating signed manifests", () => {
  const version = publishedVersion({ skillId: "a/read", name: "read" });
  version.manifest.categories = ["office"];
  const originalManifest = structuredClone(version.manifest);
  version.presentationSummary = { primaryCategory: "research", summary: "Read documents", revision: 2 };
  const page = searchPublishedSkillsPage([version], "", { category: "research" });
  assert.equal(page.skills[0].primaryCategory, "research");
  assert.deepEqual(page.skills[0].categories, ["office"]);
  assert.deepEqual(page.skills[0].presentationSummary, version.presentationSummary);
  assert.deepEqual(page.categoryCounts, [{ category: "research", count: 1 }]);
  assert.equal(searchPublishedSkillsPage([version], "", { category: "office" }).total, 0);
  assert.equal(searchPublishedSkills([version], "", { category: "office" }).length, 1);
  assert.equal(searchPublishedSkills([version], "", { category: "research" }).length, 0);
  assert.deepEqual(version.manifest, originalManifest);
  delete version.presentationSummary;
  assert.equal(searchPublishedSkillsPage([version], "", { category: "other" }).total, 1);
  assert.equal("primaryCategory" in toRegistryEntry(version), false);
  assert.equal("presentationSummary" in toRegistryEntry(version), false);
  version.presentationSummary = { primaryCategory: null, summary: "Example", revision: 3 };
  assert.equal(toRegistryEntry(version).primaryCategory, "office");
  assert.equal(searchPublishedSkillsPage([version], "", { category: "other" }).total, 1);
});

test("catalogue exposes one canonical category per skill, leaving unknown legacy classifications pending", () => {
  const versions = [
    ["a/legacy", ["office", "legal"]],
    ["b/mixed", ["office", "documents", "data"]],
    ["c/empty", []],
    ["d/research", ["research", "research"]]
  ].map(([skillId, categories]) => {
    const version = publishedVersion({ skillId, name: skillId.split("/")[1] });
    version.manifest.categories = categories;
    return version;
  });
  const page = searchPublishedSkillsPage(versions);
  assert.deepEqual(page.skills.map((skill) => skill.primaryCategory), ["other", "documents", "other", "research"]);
  assert.deepEqual(page.categoryCounts, [
    { category: "documents", count: 1 }, { category: "other", count: 2 }, { category: "research", count: 1 }
  ]);
  assert.equal(page.categoryCounts.reduce((sum, item) => sum + item.count, 0), page.total);
  assert.deepEqual(page.skills[0].categories, ["office", "legal"]);
  assert.equal(searchPublishedSkillsPage(versions, "", { category: "legal" }).total, 0);
  assert.equal(searchPublishedSkills(versions, "", { category: "legal" }).length, 1);
  assert.equal("primaryCategory" in searchPublishedSkills(versions)[0], false);
});

test("cursor rejects dataset and presentation changes instead of silently skipping rows", () => {
  const versions = ["a", "b", "c"].map((name) => publishedVersion({ skillId: `${name}/read`, name: "read" }));
  const cursor = searchPublishedSkillsPage(versions, "", { limit: 1 }).nextCursor;
  const stale = (input) => assert.throws(() => searchPublishedSkillsPage(input, "", { limit: 1, cursor }),
    (error) => error instanceof ValidationError && error.status === 409 && error.code === "catalogue.cursor_stale");
  stale(versions.slice(1));
  stale([...versions, publishedVersion({ skillId: "d/read", name: "read" })]);
  stale(versions.map((version, index) => index ? version : { ...version, version: "2.0.0" }));
  stale(versions.map((version, index) => index ? version : {
    ...version, presentationSummary: { primaryCategory: "office", summary: "Example", revision: 1 }
  }));
  versions[0].presentationSummary = { primaryCategory: "office", summary: "Example", revision: 1 };
  const updatedCursor = searchPublishedSkillsPage(versions, "", { limit: 1 }).nextCursor;
  versions[0].presentationSummary.revision = 2;
  assert.throws(() => searchPublishedSkillsPage(versions, "", { limit: 1, cursor: updatedCursor }),
    { code: "catalogue.cursor_stale", status: 409 });
});

test("cursor binds normalized filters, while platform aliases and name separators are equivalent", () => {
  const versions = ["a", "b"].map((name) => publishedVersion({ skillId: `${name}/read-pdf`, name: "read-pdf" }));
  const cursor = searchPublishedSkillsPage(versions, "READ_PDF", { searchMode: "name", platform: "win32", limit: 1 }).nextCursor;
  assert.equal(searchPublishedSkillsPage(versions, "read pdf", { searchMode: "name", platform: "windows", limit: 1, cursor }).skills.length, 1);
  for (const changed of [{ category: "office" }, { limit: 2 }, { platform: "linux" }, { searchMode: "discovery" }]) {
    assert.throws(() => searchPublishedSkillsPage(versions, "read-pdf", { searchMode: "name", platform: "windows", limit: 1, cursor, ...changed }),
      { code: "catalogue.cursor_filters", status: 409 });
  }
  assert.throws(() => searchPublishedSkillsPage(versions, "different", { searchMode: "name", platform: "windows", limit: 1, cursor }),
    { code: "catalogue.cursor_filters", status: 409 });
});

test("catalogue pagination rejects malformed cursors and out-of-bound limits", () => {
  for (const cursor of ["!", "a".repeat(1025), "e30", "bnVsbA", 5, {}, Buffer.from('{"v":1,"offset":-1}').toString("base64url")]) {
    assert.throws(() => searchPublishedSkillsPage([], "", { cursor }),
      (error) => error instanceof ValidationError && error.status === 400 && error.code === "catalogue.cursor_invalid");
  }
  for (const limit of [0, -1, 101, 1.5, "5", NaN, Infinity, true, {}, []]) {
    assert.throws(() => searchPublishedSkillsPage([], "", { limit }), { code: "catalogue.limit_invalid", status: 400 });
  }
  assert.deepEqual(searchPublishedSkillsPage([], "", { limit: 100 }), { skills: [], total: 0, nextCursor: null, categoryCounts: [] });
});

test("Unicode display names and full-width name queries preserve pagination and exact categories", () => {
  const versions = ["甲", "乙"].map((publisher) => {
    const version = publishedVersion({ skillId: `${publisher}/read-pdf`, name: "read-pdf", displayName: "石墨文档读取" });
    version.presentationSummary = { primaryCategory: "documents", summary: "提取文档要点📄", revision: 1 };
    return version;
  });
  const first = searchPublishedSkillsPage(versions, "ＲＥＡＤ＿ＰＤＦ", {
    searchMode: "name", category: "documents", platform: "  ", limit: 1
  });
  const second = searchPublishedSkillsPage([...versions].reverse(), "read pdf", {
    searchMode: "name", category: "documents", platform: "", limit: 1, cursor: first.nextCursor
  });
  assert.equal(first.total, 2);
  assert.notEqual(first.skills[0].skillId, second.skills[0].skillId);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(first.categoryCounts, [{ category: "documents", count: 2 }]);
  assert.equal(searchPublishedSkillsPage(versions, "石墨", { searchMode: "name" }).total, 2);
});

function publishedVersion({
  skillId,
  name,
  displayName = name,
  description = "",
  authorName = "",
  publisherDisplayName = "",
  publisherContact = ""
}) {
  return {
    skillId,
    skillName: name,
    displayName,
    version: "1.0.0",
    status: "published",
    yankedAt: null,
    publishedAt: "2026-08-23T00:00:00.000Z",
    manifest: {
      name,
      displayName,
      description,
      keywords: [],
      tags: [],
      triggerExamples: [],
      categories: [],
      author: authorName ? { name: authorName } : {},
      runtime: {}
    },
    publisherDisplayName,
    publisherContact
  };
}
