/**
 * services/scanner-orchestrator.js
 *
 * Health-Scan Orchestrator
 * Runs all three code-quality scanners in parallel (Promise.all) and
 * aggregates their results into a single structured report.
 *
 * Exports: runHealthScan(repoPath) → Promise<HealthScanReport>
 *
 * HealthScanReport shape:
 * {
 *   summary: {
 *     totalIssues  : number,
 *     deadCode     : number,   // orphan files
 *     circularDeps : number,   // circular dependency chains
 *     missingTests : number,
 *     docGaps      : number,
 *   },
 *   files: [
 *     { path: string, issues: Issue[] },
 *     …
 *   ],
 *   metadata: {
 *     scannedAt    : string,   // ISO timestamp
 *     filesScanned : number,   // unique files that surfaced at least one issue
 *     scanDuration : string,   // e.g. "1234ms"
 *   }
 * }
 */

const { scanDeadCode  } = require("./dead-code-scanner");
const { scanTestGaps  } = require("./test-gap-scanner");
const { scanDocGaps   } = require("./doc-gap-scanner");

/**
 * Run all three scanners in parallel and return a structured health-scan report.
 *
 * @param {string} repoPath - Absolute path to the already-cloned repository root
 * @returns {Promise<HealthScanReport>}
 */
async function runHealthScan(repoPath) {
  const startTime = Date.now();

  console.log(`[Orchestrator] Starting health scan on: ${repoPath}`);

  // ── Run all 3 scanners concurrently ──────────────────────────────────────
  const [deadCodeIssues, testGapIssues, docGapIssues] = await Promise.all([
    scanDeadCode(repoPath),
    scanTestGaps(repoPath),
    scanDocGaps(repoPath),
  ]);

  const scanDuration = Date.now() - startTime;

  console.log(
    `[Orchestrator] Scan complete in ${scanDuration}ms — ` +
      `Dead/Circular: ${deadCodeIssues.length}, ` +
      `Missing Tests: ${testGapIssues.length}, ` +
      `Doc Gaps: ${docGapIssues.length}`
  );

  // ── Tally by sub-type ────────────────────────────────────────────────────
  const deadCodeCount    = deadCodeIssues.filter(i => i.type === "dead_code").length;
  const circularDepCount = deadCodeIssues.filter(i => i.type === "circular_dep").length;
  const missingTestCount = testGapIssues.length;
  const docGapCount      = docGapIssues.length;

  const allIssues = [...deadCodeIssues, ...testGapIssues, ...docGapIssues];

  // ── Group issues by filePath ──────────────────────────────────────────────
  // Preserves insertion order so the heaviest-hit files (which tend to surface
  // issues from multiple scanners) cluster naturally.
  const fileMap = new Map(); // filePath → Issue[]

  for (const issue of allIssues) {
    const key = issue.filePath;
    if (!fileMap.has(key)) {
      fileMap.set(key, []);
    }
    fileMap.get(key).push(issue);
  }

  const files = Array.from(fileMap.entries()).map(([filePath, issues]) => ({
    path: filePath,
    issues,
  }));

  // ── Assemble final report ────────────────────────────────────────────────
  return {
    summary: {
      totalIssues  : allIssues.length,
      deadCode     : deadCodeCount,
      circularDeps : circularDepCount,
      missingTests : missingTestCount,
      docGaps      : docGapCount,
    },
    files,
    metadata: {
      scannedAt    : new Date().toISOString(),
      filesScanned : fileMap.size,
      scanDuration : `${scanDuration}ms`,
    },
  };
}

module.exports = { runHealthScan };
