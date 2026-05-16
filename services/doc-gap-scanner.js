/**
 * services/doc-gap-scanner.js
 *
 * Scanner 3 - Documentation Gap Finder
 * Walks the repository, finds exported symbols (ES-module and CommonJS),
 * and checks whether the 1-3 lines immediately above each export contain
 * a closing JSDoc tag, @param, or @returns.
 *
 * Exports: scanDocGaps(repoPath) -> Promise<Issue[]>
 *
 * Issue shape:
 *   { type, severity, filePath, line, symbol, description, bobSummary }
 */

const fs   = require("fs");
const path = require("path");

// Hard cap on reported issues
const MAX_ISSUES = 15;

// Source file extensions we care about
const SOURCE_EXTS = new Set([".js", ".ts", ".jsx", ".tsx"]);

// Directories to skip entirely during the walk
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

// ---------------------------------------------------------------------------
// Export-detection patterns
// ---------------------------------------------------------------------------

/**
 * Pattern 1 - ES module named/default exports
 * e.g. export function foo(), export default class Bar, export const baz
 * Capture group 3 -> symbol name
 */
const ES_EXPORT_RE =
  /^export\s+(default\s+)?(function|class|const|let|var)\s+(\w+)/gm;

/**
 * Pattern 2 - CJS module.exports = { a, b, c }
 * Capture group 1 -> brace contents; individual names parsed below.
 */
const CJS_EXPORTS_OBJECT_RE = /^module\.exports\s*=\s*\{([^}]+)\}/gm;

/**
 * Pattern 3 - CJS exports.name = ...
 * Capture group 1 -> symbol name
 */
const CJS_EXPORTS_PROP_RE = /^exports\.(\w+)\s*=/gm;

// ---------------------------------------------------------------------------
// JSDoc presence check
// ---------------------------------------------------------------------------

/**
 * Returns true if any of the 1-3 lines immediately above the export line
 * contain a JSDoc closing marker or common JSDoc tags.
 *
 * @param {string[]} lines       - All lines of the file
 * @param {number}   exportIndex - 0-based line index of the export statement
 * @returns {boolean}
 */
function hasJSDoc(lines, exportIndex) {
  const start = Math.max(0, exportIndex - 3);
  for (let i = start; i < exportIndex; i++) {
    const trimmed = lines[i].trim();
    // Check for closing JSDoc tag (*/) or common annotation tags
    if (
      trimmed.endsWith("*/") ||
      trimmed.includes("@param") ||
      trimmed.includes("@returns")
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/**
 * Recursively walk `dir` and collect all source files to analyse.
 *
 * @param {string}   dir      - Absolute directory to walk
 * @param {string}   repoRoot - Absolute repo root
 * @param {string[]} out      - Collector for relative paths
 */
function walk(dir, repoRoot, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable - skip silently
  }

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(absPath, repoRoot, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!SOURCE_EXTS.has(ext)) continue;

      // Skip test / spec files
      if (/\.(test|spec)\.(js|ts|jsx|tsx)$/.test(entry.name)) continue;
      if (/[-_](test|spec)\.(js|ts|jsx|tsx)$/.test(entry.name)) continue;

      const relPath = path.relative(repoRoot, absPath).replace(/\\/g, "/");
      out.push(relPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

/**
 * Analyse a single source file and return doc-gap issues found within it.
 *
 * @param {string} absPath  - Absolute path to the file
 * @param {string} relPath  - Repo-relative path (for issue reporting)
 * @param {number} budget   - Max number of issues we can still add
 * @returns {Array}
 */
function analyseFile(absPath, relPath, budget) {
  const issues = [];

  let content;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    return issues; // unreadable - skip silently
  }

  const lines = content.split("\n");

  /** Helper: push an issue if still under budget */
  function push(lineNumber, symbol) {
    if (issues.length >= budget) return;
    issues.push({
      type: "doc_gap",
      severity: "low",
      filePath: relPath,
      line: lineNumber,
      symbol,
      description: "Exported symbol '" + symbol + "' has no JSDoc. Add a /** ... */ block immediately above the export so tools and teammates understand its purpose.",
      bobSummary: null,
    });
  }

  // Pattern 1: ES module exports
  {
    let m;
    ES_EXPORT_RE.lastIndex = 0;
    while ((m = ES_EXPORT_RE.exec(content)) !== null && issues.length < budget) {
      const symbol = m[3];
      const lineIndex = content.slice(0, m.index).split("\n").length - 1;
      if (!hasJSDoc(lines, lineIndex)) {
        push(lineIndex + 1, symbol);
      }
    }
  }

  // Pattern 2: module.exports = { a, b, c }
  {
    let m;
    CJS_EXPORTS_OBJECT_RE.lastIndex = 0;
    while ((m = CJS_EXPORTS_OBJECT_RE.exec(content)) !== null && issues.length < budget) {
      const lineIndex = content.slice(0, m.index).split("\n").length - 1;
      const names = m[1]
        .split(",")
        .map(function(s) { return s.trim().split(":")[0].trim(); })
        .filter(function(s) { return /^\w+$/.test(s); });

      for (let ni = 0; ni < names.length; ni++) {
        if (issues.length >= budget) break;
        if (!hasJSDoc(lines, lineIndex)) {
          push(lineIndex + 1, names[ni]);
        }
      }
    }
  }

  // Pattern 3: exports.name = ...
  {
    let m;
    CJS_EXPORTS_PROP_RE.lastIndex = 0;
    while ((m = CJS_EXPORTS_PROP_RE.exec(content)) !== null && issues.length < budget) {
      const symbol = m[1];
      const lineIndex = content.slice(0, m.index).split("\n").length - 1;
      if (!hasJSDoc(lines, lineIndex)) {
        push(lineIndex + 1, symbol);
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the doc-gap scan on an already-cloned repository.
 *
 * @param {string} repoPath - Absolute path to the cloned repo root
 * @returns {Promise<Array>} Array of issue objects (capped at MAX_ISSUES)
 */
async function scanDocGaps(repoPath) {
  const issues = [];

  try {
    console.log("[DocGaps] Starting scan on: " + repoPath);

    const sourceFiles = [];
    walk(repoPath, repoPath, sourceFiles);

    console.log("[DocGaps] Source files to analyse: " + sourceFiles.length);

    for (let i = 0; i < sourceFiles.length; i++) {
      if (issues.length >= MAX_ISSUES) break;

      const relPath   = sourceFiles[i];
      const absPath   = path.join(repoPath, relPath);
      const budget    = MAX_ISSUES - issues.length;
      const fileIssues = analyseFile(absPath, relPath, budget);
      for (let j = 0; j < fileIssues.length; j++) {
        issues.push(fileIssues[j]);
      }
    }

    const cappedMsg = issues.length === MAX_ISSUES ? " (capped at " + MAX_ISSUES + ")" : "";
    console.log("[DocGaps] Issues reported: " + issues.length + cappedMsg);
  } catch (err) {
    console.warn("[DocGaps] Scanner failed - returning empty results. Reason: " + err.message);
  }

  return issues;
}

module.exports = { scanDocGaps };
