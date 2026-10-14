import { validatePackagePath } from '../domain/index.js';

// Pure path checks shared by Git storage and publication preflight. Call with
// the FINAL path set, including generated files; never silently drop conflicts.
export function validateGitSourcePaths(paths, limits = {}) {
  const seen = new Set();
  const normalized = paths.map(raw => {
    const filePath = validatePackagePath(raw, {
      maxPathLength: Math.max(limits.maxPathLength ?? 180, 1024),
      maxPathDepth: Math.max(limits.maxPathDepth ?? 12, 64)
    });
    if (filePath.split('/').some(part => part.toLowerCase() === '.git')) {
      throw Object.assign(new Error(`Git-reserved source path is not allowed: ${filePath}`), {code:'git.source_path_reserved'});
    }
    const folded = filePath.toLocaleLowerCase('en-US');
    if (seen.has(folded)) {
      throw Object.assign(new Error(`Duplicate Git source path: ${filePath}`), {code:'git.source_path_duplicate'});
    }
    seen.add(folded);
    return filePath;
  });
  for (const filePath of normalized) {
    const parts = filePath.toLocaleLowerCase('en-US').split('/');
    if (parts.slice(0, -1).some((_, i) => seen.has(parts.slice(0, i + 1).join('/')))) {
      throw Object.assign(new Error(`Git source file/directory conflict: ${filePath}`), {code:'git.source_path_collision'});
    }
  }
  return normalized;
}
