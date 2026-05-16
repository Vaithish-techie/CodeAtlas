/**
 * services/dead-code-scanner.js
 *
 * Scanner 1 — Dead Code Detector
 * Uses madge to detect:
 *   1. Orphan files  → never imported by anything else in the repo
 *   2. Circular deps → import chains that form a cycle
 *
 * Exports: scanDeadCode(repoPath) → Promise<Issue[]>
 *
 * Issue shape:
 *   { type, severity, filePath, line, symbol, description, bobSummary }
 */

const madge = require("madge");
const path = require("path");

// Directories to exclude from analysis
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "test",
  "tests",
  "spec",
  "__tests__",
  "coverage",
  ".git",
  "out",
]);

/**
 * Returns true if any segment of the given relative file path belongs to a
 * directory we want to skip.
 *
 * @param {string} relPath - Relative path as returned by madge (forward-slash separated)
 * @returns {boolean}
 */
function shouldSkip(relPath) {
  const parts = relPath.split("/");
  // Check every directory segment (all parts except the last, which is the filename)
  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIRS.has(parts[i])) return true;
  }
  // Also skip if the filename itself looks like a test file
  const filename = parts[parts.length - 1];
  if (/\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename)) return true;
  if (/\.(test|spec)$/.test(filename.replace(/\.(js|ts|jsx|tsx)$/, "")))
    return true;
  return false;
}

/**
 * Run the dead-code scan on an already-cloned repository.
 *
 * @param {string} repoPath - Absolute path to the cloned repo root
 * @returns {Promise<Array>} Array of issue objects (may be empty)
 */
async function scanDeadCode(repoPath) {
  const issues = [];

  try {
    console.log(`[DeadCode] Starting madge scan on: ${repoPath}`);

    const res = await madge(repoPath, {
      fileExtensions: ["js", "ts", "jsx", "tsx"],
      excludeRegExp: [
        /node_modules/,
        /dist\//,
        /build\//,
        /\.next\//,
        /\/(test|tests|spec|__tests__)\//,
        /\.(test|spec)\.(js|ts|jsx|tsx)$/,
        /coverage\//,
      ],
    });

    // ── 1. Orphan files ──────────────────────────────────────────────────────
    const orphans = res.orphans();
    console.log(`[DeadCode] Orphan files found: ${orphans.length}`);

    for (const relPath of orphans) {
      if (shouldSkip(relPath)) continue;

      const filename = path.basename(relPath);
      issues.push({
        type: "dead_code",
        severity: "high",
        filePath: relPath,
        line: null,
        symbol: "entire file",
        description: `This file is never imported by any other module in the repository. It may be dead code that can be safely removed.`,
        bobSummary: null,
      });
    }

    // ── 2. Circular dependencies ─────────────────────────────────────────────
    const circular = res.circular();
    console.log(`[DeadCode] Circular dependency chains found: ${circular.length}`);

    for (const chain of circular) {
      // chain is an array of relative file paths forming the cycle
      const filteredChain = chain.filter((p) => !shouldSkip(p));
      if (filteredChain.length < 2) continue; // degenerate / fully-skipped chain

      issues.push({
        type: "circular_dep",
        severity: "medium",
        filePath: filteredChain[0],
        line: null,
        symbol: filteredChain.join(" → "),
        description: `Circular dependency chain detected: ${filteredChain.join(" → ")}. Circular imports can cause initialisation order bugs and make tree-shaking impossible.`,
        bobSummary: null,
      });
    }

    console.log(`[DeadCode] Total issues: ${issues.length} (${orphans.length} orphans, ${circular.length} circular)`);
  } catch (err) {
    console.warn(`[DeadCode] Scanner failed — returning empty results. Reason: ${err.message}`);
  }

  return issues;
}

module.exports = { scanDeadCode };
