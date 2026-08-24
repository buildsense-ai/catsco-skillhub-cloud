import assert from "node:assert/strict";
import test from "node:test";

import { normalizeManifest, ValidationError } from "../../packages/domain/index.js";

test("accepts a concise non-empty Skill description", () => {
  const manifest = normalizeManifest({
    name: "ocr",
    version: "1.0.0",
    description: "图片 OCR"
  });

  assert.equal(manifest.description, "图片 OCR");
});

test("rejects a blank Skill description", () => {
  assert.throws(
    () => normalizeManifest({
      name: "missing-description",
      version: "1.0.0",
      description: "   "
    }),
    (error) => (
      error instanceof ValidationError
      && error.code === "manifest.description"
      && /description 不能为空/.test(error.message)
    )
  );
});
