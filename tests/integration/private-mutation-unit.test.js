import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../packages/config/index.js";
import { sha256 } from "../../packages/domain/index.js";
import { mutationVersionReference, parsePrivateSkillMutation } from "../../packages/private-mutations/index.js";

const config = loadConfig({
  nodeEnv: "test",
  privateSkillMaxFiles: 10,
  privateSkillMaxSingleFileBytes: 1024,
  privateSkillMaxTotalBytes: 4096,
  privateSkillMaxRequestBytes: 8192
});

test("private mutation parser normalizes the C1 writer envelope", () => {
  const bytes = Buffer.from("# Review\n");
  const hash = sha256(bytes);
  const body = {
    mutationId: 42,
    grantId: "smg_test",
    botUid: 1001,
    localSkillId: "review-pr",
    actorUserUid: 7,
    sourceTopicId: "p2p_7_1001",
    sourceMessageId: 99,
    runtimeBodyId: "body-prod",
    clientRequestId: "request-42",
    operation: "create",
    candidateContentHash: sha256(JSON.stringify([{ path: "SKILL.md", size: bytes.length, sha256: hash }])),
    candidateSizeBytes: bytes.length,
    files: [{ path: "SKILL.md", size: bytes.length, sha256: hash, contentBase64: bytes.toString("base64") }]
  };
  const parsed = parsePrivateSkillMutation(body, config);
  assert.equal(parsed.mutationId, 42);
  assert.equal(parsed.botUid, "1001");
  assert.equal(parsed.candidateSizeBytes, bytes.length);
  assert.equal(parsed.operation, "create");
  assert.match(parsed.requestFingerprint, /^[a-f0-9]{64}$/);
});

test("private mutation parser requires exact previous facts for replacement", () => {
  const bytes = Buffer.from("# Review v2\n");
  const hash = sha256(bytes);
  const contentHash = sha256(JSON.stringify([{ path: "SKILL.md", size: bytes.length, sha256: hash }]));
  const base = {
    mutationId: 43,
    grantId: "smg_test",
    botUid: "1001",
    localSkillId: "review-pr",
    actorUserUid: 7,
    sourceTopicId: "p2p_7_1001",
    sourceMessageId: 100,
    runtimeBodyId: "body-prod",
    clientRequestId: "request-43",
    operation: "replace",
    candidateContentHash: contentHash,
    candidateSizeBytes: bytes.length,
    expectedPreviousHash: "a".repeat(64),
    beforeReference: {
      source: "skillhub",
      skillId: "review-pr",
      version: "v_previous",
      contentHash: "a".repeat(64)
    },
    files: [{ path: "SKILL.md", size: bytes.length, sha256: hash, contentBase64: bytes.toString("base64") }]
  };
  const parsed = parsePrivateSkillMutation(base, config);
  assert.equal(parsed.beforeReference.skillId, "review-pr");
  assert.throws(
    () => parsePrivateSkillMutation({ ...base, expectedPreviousHash: "b".repeat(64) }, config),
    (error) => error.code === "MUTATION_PREVIOUS_VERSION_INVALID"
  );
});

test("mutation response references the logical local skill id", () => {
  assert.deepEqual(
    mutationVersionReference({ localSkillId: "review-pr", version: "v_123", contentHash: "a".repeat(64) }),
    { source: "skillhub", skillId: "review-pr", version: "v_123", contentHash: "a".repeat(64) }
  );
});
