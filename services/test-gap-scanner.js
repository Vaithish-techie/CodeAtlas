/**
 * services/test-gap-scanner.js
 *
 * Scanner 2 — Missing Test Detector
 * Walks the repository filesystem, pairs every source file against test files,
 * and reports source files that have no matching test.
 *
 * Exports: scanTestGaps(repoPath) → Promise<Issue[]>
 *
 * Issue shape:
 *   { type, severity, filePath, line, symbol, description, bobSummary }
 */

const fs = require("fs");
const path = require("path");
const ignore = require("ignore");

// Hard cap on reported issues so the UI doesn't get overwhelmed
const MAX_ISSUES = 20;

// Source file extensions we care about
const SOURCE_EXTS = new Set([".js", ".ts", ".jsx", ".tsx"]);

// Directories to skip entirely during the walk
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".git",
  "out",
]);

/**
 * Returns true if this file path looks like a test / spec file.
 *
 * Matches patterns like:
 *   foo.test.js   foo.spec.ts   __tests__/foo.js
 *   foo-test.js   foo_spec.jsx
 *
 * @param {string} relPath - Relative path (forward-slash separated)
 * @returns {boolean}
 */
function isTestFile(relPath) {
  // Any segment named __tests__ or spec or test (directory convention)
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (
      seg === "__tests__" ||
      seg === "test" ||
      seg === "tests" ||
      seg === "spec"
    ) {
      return true;
    }
  }

  // Filename-level: *.test.*, *.spec.*, *-test.*, *_spec.*
  const filename = segments[segments.length - 1];
  return (
    /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename) ||
    /[-_](test|spec)\.(js|ts|jsx|tsx)$/.test(filename)
  );
}

/**
 * Recursively walk `dir`, collecting all JS/TS source files.
 * Populates `sourceFiles` and `testFiles` in-place.
 *
 * @param {string} dir        - Absolute directory to walk
 * @param {string} repoRoot   - Absolute repo root (for computing relative paths)
 * @param {string[]} sourceFiles
 * @param {string[]} testFiles
 * @param {Object|null} ig    - ignore instance (from .gitignore) or null
 */
function walk(dir, repoRoot, sourceFiles, testFiles, ig) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(repoRoot, absPath).replace(/\\/g, "/");

    // Check .gitignore rules if available
    if (ig && ig.ignores(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(absPath, repoRoot, sourceFiles, testFiles, ig);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!SOURCE_EXTS.has(ext)) continue;

      if (isTestFile(relPath)) {
        testFiles.push(relPath);
      } else {
        sourceFiles.push(relPath);
      }
    }
  }
}

/**
 * Given a source file's relative path, derive the bare stem used when
 * searching for a matching test file.
 *
 * e.g.  "src/utils/auth.js"  →  "auth"
 *       "lib/router/index.ts" → "router"  (index files use the parent dir name)
 *
 * @param {string} relPath
 * @returns {string}
 */
function stemFor(relPath) {
  const parts = relPath.split("/");
  const filename = parts[parts.length - 1];
  const nameWithoutExt = filename.replace(/\.(js|ts|jsx|tsx)$/, "");

  // For index files, use the parent directory name instead — it's more meaningful
  if (nameWithoutExt === "index" && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return nameWithoutExt;
}

/**
 * Returns true if any test file path "covers" the given source file.
 * Coverage is determined by checking whether the test file path contains
 * the source file's stem as a word boundary substring.
 *
 * @param {string} sourceStem     - Bare filename stem (no extension)
 * @param {string} sourceRelPath  - Full relative source path
 * @param {string[]} testFiles    - All test file relative paths
 * @returns {boolean}
 */
function hasMatchingTest(sourceStem, sourceRelPath, testFiles) {
  const stemLower = sourceStem.toLowerCase();

  for (const tf of testFiles) {
    const tfLower = tf.toLowerCase();

    // Check the test file's path segments for the stem
    // Use word-boundary-style matching to avoid false positives
    // e.g. stem "auth" should match "auth.test.js" but not "authorization.test.js"
    const regex = new RegExp(
      `(^|[\\/._-])${escapeRegex(stemLower)}([\\/._-]|$)`,
    );
    if (regex.test(tfLower)) return true;

    // Also allow: source path is fully contained in test path
    // e.g. source "src/utils/auth.js" → test "src/utils/__tests__/auth.test.js"
    const sourceDir = sourceRelPath.substring(
      0,
      sourceRelPath.lastIndexOf("/"),
    );
    if (sourceDir && tfLower.includes(sourceDir.toLowerCase())) {
      // Within the same directory scope, check the stem
      if (tfLower.includes(stemLower)) return true;
    }
  }
  return false;
}

/** Escape a string for safe use inside a RegExp */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run the test-gap scan on an already-cloned repository.
 *
 * @param {string} repoPath - Absolute path to the cloned repo root
 * @returns {Promise<Array>} Array of issue objects (capped at MAX_ISSUES)
 */
async function scanTestGaps(repoPath) {
  const issues = [];

  try {
    console.log(`[TestGaps] Starting filesystem walk on: ${repoPath}`);

    // Load .gitignore if it exists
    let ig = null;
    const gitignorePath = path.join(repoPath, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      try {
        const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
        ig = ignore().add(gitignoreContent);
        console.log(`[TestGaps] Loaded .gitignore rules`);
      } catch (err) {
        console.warn(`[TestGaps] Failed to read .gitignore: ${err.message}`);
      }
    }

    const sourceFiles = [];
    const testFiles = [];

    walk(repoPath, repoPath, sourceFiles, testFiles, ig);

    console.log(
      `[TestGaps] Found ${sourceFiles.length} source files, ${testFiles.length} test files`,
    );

    for (const relPath of sourceFiles) {
      if (issues.length >= MAX_ISSUES) break;

      const stem = stemFor(relPath);

      if (!hasMatchingTest(stem, relPath, testFiles)) {
        issues.push({
          type: "missing_test",
          severity: "medium",
          filePath: relPath,
          line: null,
          symbol: stem,
          description: `No test file found for '${stem}'. Add a test file such as '${stem}.test.js' to improve code reliability and catch regressions.`,
          bobSummary: null,
        });
      }
    }

    console.log(
      `[TestGaps] Issues reported: ${issues.length}` +
        (issues.length === MAX_ISSUES ? ` (capped at ${MAX_ISSUES})` : ""),
    );
  } catch (err) {
    console.warn(
      `[TestGaps] Scanner failed — returning empty results. Reason: ${err.message}`,
    );
  }

  return issues;
}

module.exports = { scanTestGaps };
