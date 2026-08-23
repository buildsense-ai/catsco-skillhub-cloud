import assert from "node:assert/strict";
import test from "node:test";

import { searchPublishedSkills } from "../../packages/search/index.js";

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

function publishedVersion({ skillId, name, displayName = name, description = "" }) {
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
      author: {},
      runtime: {}
    }
  };
}
