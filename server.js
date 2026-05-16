const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.post("/api/ingest", (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: "repoUrl is required" });
  }

  if (!repoUrl.match(/^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+/)) {
    return res.status(400).json({ error: "Invalid GitHub repository URL" });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repotour-"));

  console.log(`[${new Date().toISOString()}] Starting analysis of ${repoUrl}`);
  console.log(`[${new Date().toISOString()}] Temporary directory: ${tmpDir}`);

  try {
    console.log(`[${new Date().toISOString()}] Cloning repository...`);
    execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, {
      stdio: "ignore",
      timeout: 60000,
    });
    console.log(`[${new Date().toISOString()}] Clone completed successfully`);

    const nodes = [];
    const links = [];
    const validExts = [".js", ".ts", ".jsx", ".tsx"];
    const fileMap = new Map();

    function walk(dir) {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        if (
          [
            ".git",
            "node_modules",
            "dist",
            "build",
            "coverage",
            ".next",
            "out",
          ].includes(item)
        ) {
          continue;
        }

        const fullPath = path.join(dir, item);
        let stat;

        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
          continue;
        }

        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (validExts.includes(path.extname(fullPath))) {
          const relativePath = path
            .relative(tmpDir, fullPath)
            .replace(/\\/g, "/");
          fileMap.set(relativePath, {
            id: relativePath,
            label: item,
            type: "file",
            size: stat.size,
            fullPath: fullPath,
          });
        }
      }
    }

    console.log(`[${new Date().toISOString()}] Analyzing file structure...`);
    walk(tmpDir);
    console.log(
      `[${new Date().toISOString()}] Found ${fileMap.size} files to analyze`,
    );

    const importRegex =
      /(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g;

    console.log(`[${new Date().toISOString()}] Extracting dependencies...`);
    let totalLinks = 0;

    for (const [relPath, nodeData] of fileMap.entries()) {
      nodes.push({
        id: nodeData.id,
        label: nodeData.label,
        type: nodeData.type,
        size: nodeData.size,
      });

      let content;
      try {
        content = fs.readFileSync(nodeData.fullPath, "utf-8");
      } catch (err) {
        continue;
      }

      let match;

      while ((match = importRegex.exec(content)) !== null) {
        const targetImport = match[1] || match[2];

        if (targetImport) {
          const dir = path.dirname(nodeData.fullPath);
          const targetFullPath = path.join(dir, targetImport);
          let targetRelPath = path
            .relative(tmpDir, targetFullPath)
            .replace(/\\/g, "/");

          if (!path.extname(targetRelPath)) {
            if (fileMap.has(targetRelPath + ".js")) {
              targetRelPath += ".js";
            } else if (fileMap.has(targetRelPath + ".ts")) {
              targetRelPath += ".ts";
            } else if (fileMap.has(targetRelPath + ".jsx")) {
              targetRelPath += ".jsx";
            } else if (fileMap.has(targetRelPath + ".tsx")) {
              targetRelPath += ".tsx";
            } else if (fileMap.has(targetRelPath + "/index.js")) {
              targetRelPath += "/index.js";
            } else if (fileMap.has(targetRelPath + "/index.ts")) {
              targetRelPath += "/index.ts";
            }
          }

          if (targetRelPath && fileMap.has(targetRelPath)) {
            links.push({
              source: nodeData.id,
              target: targetRelPath,
            });
            totalLinks++;
          }
        }
      }
    }

    console.log(
      `[${new Date().toISOString()}] Analysis complete: ${nodes.length} nodes, ${totalLinks} links`,
    );

    res.json({ nodes, links });
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error processing repository:`,
      error.message,
    );

    let errorMessage = "Failed to process repository.";

    if (
      error.message.includes("not found") ||
      error.message.includes("does not exist")
    ) {
      errorMessage =
        "Repository not found. Please check the URL and ensure it is public.";
    } else if (error.message.includes("timeout")) {
      errorMessage =
        "Repository clone timed out. The repository may be too large.";
    } else if (error.message.includes("Authentication")) {
      errorMessage = "Repository is private or requires authentication.";
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log(
          `[${new Date().toISOString()}] Cleaned up temporary directory: ${tmpDir}`,
        );
      }
    } catch (cleanupError) {
      console.error(
        `[${new Date().toISOString()}] Failed to cleanup ${tmpDir}:`,
        cleanupError.message,
      );
    }
  }
});

// Health check endpoint (for monitoring)
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Health Scan Dashboard - Mock Data Endpoint
// TODO: Replace with live AI scanners before demo (see HEALTH_SCAN_INTEGRATION.md)
app.get("/api/health-scan", (req, res) => {
  // Mock health scan data for Express.js repository
  const mockHealthScanData = {
    summary: {
      totalIssues: 5,
      deadCode: 1,
      missingTests: 2,
      docGaps: 2,
    },
    files: [
      {
        path: "lib/router.js",
        issues: [
          {
            type: "dead_code",
            severity: "high",
            description:
              "Function 'parseOldRoute()' is exported but never used internally.",
            line: 145,
            symbol: "parseOldRoute",
          },
          {
            type: "doc_gap",
            severity: "low",
            description:
              "Public function 'init()' is missing JSDoc documentation.",
            line: 23,
            symbol: "init",
          },
        ],
      },
      {
        path: "lib/application.js",
        issues: [
          {
            type: "missing_test",
            severity: "medium",
            description:
              "Function 'lazyrouter()' has no corresponding test case.",
            line: 89,
            symbol: "lazyrouter",
          },
          {
            type: "missing_test",
            severity: "high",
            description: "Critical function 'handle()' lacks test coverage.",
            line: 156,
            symbol: "handle",
          },
          {
            type: "doc_gap",
            severity: "medium",
            description:
              "Public method 'set()' is missing parameter documentation.",
            line: 234,
            symbol: "set",
          },
        ],
      },
    ],
    metadata: {
      scannedAt: new Date().toISOString(),
      repository: "expressjs/express",
      filesScanned: 2,
      scanDuration: "0ms (mock)",
    },
  };

  res.json(mockHealthScanData);
});
// Feature 3: Auto-Fix Queue + Diff Viewer
// In-memory store for fixes (seeded with mock data on first call)
let fixStore = null;

// Feature 4: Apply + Audit Trail + Branch Creation
// In-memory stores for apply results and audit log
const auditLog = [];
const applyResult = { ran: false, branchName: null, commits: [], summary: {} };

app.get("/api/fixes", (req, res) => {
  // Initialize fixStore with mock data on first call
  if (!fixStore) {
    fixStore = {
      "fix-001": {
        id: "fix-001",
        file: "lib/router.js",
        issueType: "dead_code",
        severity: "high",
        symbol: "parseOldRoute",
        line: 145,
        issueDescription: "Function 'parseOldRoute()' is exported but never used internally.",
        status: "pending",
        original: "function parseOldRoute(path) {\n  return path.replace(/\\/+/g, '/');\n}\nmodule.exports.parseOldRoute = parseOldRoute;",
        proposed: "// parseOldRoute() removed — confirmed unused export.\n// Zero import references found across entire repository.",
        bobExplanation: "Exported via module.exports but has zero import references across the repository. Safe to remove."
      },
      "fix-002": {
        id: "fix-002",
        file: "lib/router.js",
        issueType: "doc_gap",
        severity: "low",
        symbol: "init",
        line: 23,
        issueDescription: "Public function 'init()' is missing JSDoc documentation.",
        status: "pending",
        original: "Router.prototype.init = function init(options) {\n  this.stack = [];\n  this.options = options || {};\n};",
        proposed: "/**\n * Initialises the router, resetting the middleware stack.\n * @param {Object} [options] - Configuration options.\n * @param {boolean} [options.strict] - Enable strict routing.\n */\nRouter.prototype.init = function init(options) {\n  this.stack = [];\n  this.options = options || {};\n};",
        bobExplanation: "JSDoc inferred from usage patterns found in router/layer.js and application.js."
      },
      "fix-003": {
        id: "fix-003",
        file: "lib/application.js",
        issueType: "missing_test",
        severity: "medium",
        symbol: "lazyrouter",
        line: 89,
        issueDescription: "Function 'lazyrouter()' has no corresponding test case.",
        status: "pending",
        original: "// No test exists for app.lazyrouter()",
        proposed: "describe('app.lazyrouter()', function() {\n  it('should initialise the router only once', function() {\n    const app = express();\n    app.lazyrouter();\n    const r1 = app._router;\n    app.lazyrouter();\n    assert.strictEqual(app._router, r1);\n  });\n});",
        bobExplanation: "Covers the singleton-initialisation path. Matches test/app.js style."
      },
      "fix-004": {
        id: "fix-004",
        file: "lib/application.js",
        issueType: "missing_test",
        severity: "high",
        symbol: "handle",
        line: 156,
        issueDescription: "Critical function 'handle()' lacks test coverage.",
        status: "pending",
        original: "// No test exists for app.handle()",
        proposed: "describe('app.handle()', function() {\n  it('should respond on matched route', function(done) {\n    const app = express();\n    app.use(function(req, res) { res.send('ok'); });\n    request(app).get('/').expect(200, 'ok', done);\n  });\n  it('should return 404 for unhandled routes', function(done) {\n    const app = express();\n    request(app).get('/missing').expect(404, done);\n  });\n});",
        bobExplanation: "Uses supertest (existing devDependency). Covers both primary code paths."
      },
      "fix-005": {
        id: "fix-005",
        file: "lib/application.js",
        issueType: "doc_gap",
        severity: "medium",
        symbol: "set",
        line: 234,
        issueDescription: "Public method 'set()' is missing parameter documentation.",
        status: "pending",
        original: "app.set = function set(setting, val) {\n  if (arguments.length === 1) { return this.settings[setting]; }\n  this.settings[setting] = val;\n  return this;\n};",
        proposed: "/**\n * Sets a config value, or retrieves it when called with one argument.\n * @param {string} setting - Setting name.\n * @param {*} [val] - Value to assign. Omit to use as getter.\n * @returns {app|*} App instance when setting; value when getting.\n */\napp.set = function set(setting, val) {\n  if (arguments.length === 1) { return this.settings[setting]; }\n  this.settings[setting] = val;\n  return this;\n};",
        bobExplanation: "Documents the dual getter/setter pattern. Return type confirmed by tracing all call sites."
      }
    };
  }

  // Convert fixStore object to array format
  const fixes = Object.values(fixStore);
  res.json({ fixes });
});

app.post("/api/fixes/:id/decision", (req, res) => {
  const { id } = req.params;
  const { decision, feedback } = req.body;

  // Validate fix exists
  if (!fixStore || !fixStore[id]) {
    return res.status(404).json({ error: "Fix not found" });
  }

  // Validate decision
  if (!["approved", "rejected", "modified"].includes(decision)) {
    return res.status(400).json({ error: "Invalid decision. Must be 'approved', 'rejected', or 'modified'" });
  }

  const fix = fixStore[id];

  // Update status based on decision
  fix.status = decision;

  // Handle modified decision with feedback
  if (decision === "modified" && feedback) {
    // MOCK API CALL — replace this block with a real IBM Bob API call before the demo.
    // Prompt to send: fix.proposed + req.body.feedback
    fix.bobExplanation = fix.bobExplanation + ' (regenerated with feedback: ' + feedback + ')';
  }

  res.json(fix);
});

// Feature 4: Apply + Audit Trail + Branch Creation Routes

// ROUTE 1: POST /api/apply
// Applies approved fixes to a simulated Git branch
app.post("/api/apply", (req, res) => {
  // Filter approved fixes
  const approvedFixes = Object.values(fixStore || {}).filter(
    (fix) => fix.status === "approved"
  );

  if (approvedFixes.length === 0) {
    return res.status(400).json({ error: "No approved fixes to apply." });
  }

  // Generate branch name
  const date = new Date().toISOString().slice(0, 10);
  const branchName = `reporevive/fixes-${date}`;
  applyResult.branchName = branchName;

  // Clear previous commits
  applyResult.commits = [];

  // Process each approved fix
  approvedFixes.forEach((fix) => {
    const commitMessage = `fix(${fix.file}): ${fix.issueType} — ${fix.symbol} [Bob-assisted]`;
    
    // Add to audit log
    auditLog.push({
      timestamp: new Date().toISOString(),
      action: "COMMIT",
      bobCapability: "Code Mode",
      file: fix.file,
      symbol: fix.symbol,
      issueType: fix.issueType,
      commitMessage: commitMessage,
      decision: "approved",
      humanApproved: true,
    });

    // Add to commits array
    applyResult.commits.push({
      timestamp: new Date().toISOString(),
      action: "COMMIT",
      bobCapability: "Code Mode",
      file: fix.file,
      symbol: fix.symbol,
      issueType: fix.issueType,
      commitMessage: commitMessage,
      decision: "approved",
      humanApproved: true,
    });
  });

  // Process rejected fixes
  const rejectedFixes = Object.values(fixStore || {}).filter(
    (fix) => fix.status === "rejected"
  );

  rejectedFixes.forEach((fix) => {
    auditLog.push({
      timestamp: new Date().toISOString(),
      action: "SKIPPED",
      bobCapability: "Code Mode",
      file: fix.file,
      symbol: fix.symbol,
      issueType: fix.issueType,
      commitMessage: null,
      decision: "rejected",
      humanApproved: false,
    });
  });

  // Build summary
  const allFixes = Object.values(fixStore || {});
  const pendingCount = allFixes.filter((f) => f.status === "pending").length;
  
  applyResult.summary = {
    totalFound: allFixes.length,
    approved: approvedFixes.length,
    rejected: rejectedFixes.length,
    pending: pendingCount,
    branchName: branchName,
    prUrl: `https://github.com/expressjs/express/compare/${branchName}?expand=1&title=RepoRevive+Auto+Fixes&body=Generated+by+RepoRevive+%2B+IBM+Bob`,
  };

  applyResult.ran = true;

  res.json(applyResult);
});

// ROUTE 2: GET /api/audit-log
// Returns the full audit log with seeded history
app.get("/api/audit-log", (req, res) => {
  // Seed audit log with mock history on first call
  if (auditLog.length === 0) {
    const seedData = [
      {
        timestamp: "2026-05-15T09:01:04Z",
        action: "ARCHITECT_ANALYSIS",
        bobCapability: "Architect Mode",
        file: "expressjs/express (full repo)",
        symbol: null,
        issueType: null,
        commitMessage: null,
        decision: "completed",
        humanApproved: null,
        note: "Bob read full repository. Generated architecture map and import/export graph.",
      },
      {
        timestamp: "2026-05-15T09:01:31Z",
        action: "HEALTH_SCAN",
        bobCapability: "Agentic Workflows",
        file: "expressjs/express (full repo)",
        symbol: null,
        issueType: "dead_code",
        commitMessage: null,
        decision: "completed",
        humanApproved: null,
        note: "Dead code scanner completed. 2 unused exports identified.",
      },
      {
        timestamp: "2026-05-15T09:01:33Z",
        action: "HEALTH_SCAN",
        bobCapability: "Agentic Workflows",
        file: "expressjs/express (full repo)",
        symbol: null,
        issueType: "missing_test",
        commitMessage: null,
        decision: "completed",
        humanApproved: null,
        note: "Test gap scanner completed. 2 untested critical functions identified.",
      },
      {
        timestamp: "2026-05-15T09:01:35Z",
        action: "HEALTH_SCAN",
        bobCapability: "Agentic Workflows",
        file: "expressjs/express (full repo)",
        symbol: null,
        issueType: "doc_gap",
        commitMessage: null,
        decision: "completed",
        humanApproved: null,
        note: "Doc gap scanner completed. 2 undocumented public functions identified.",
      },
      {
        timestamp: "2026-05-15T09:02:10Z",
        action: "FIX_GENERATED",
        bobCapability: "Code Mode",
        file: "lib/router.js",
        symbol: "parseOldRoute",
        issueType: "dead_code",
        commitMessage: null,
        decision: "generated",
        humanApproved: null,
        note: "Bob generated removal patch. Zero import references confirmed across repo.",
      },
      {
        timestamp: "2026-05-15T09:02:12Z",
        action: "FIX_GENERATED",
        bobCapability: "Doc Generation",
        file: "lib/router.js",
        symbol: "init",
        issueType: "doc_gap",
        commitMessage: null,
        decision: "generated",
        humanApproved: null,
        note: "JSDoc inferred from usage patterns in router/layer.js and application.js.",
      },
      {
        timestamp: "2026-05-15T09:02:15Z",
        action: "FIX_GENERATED",
        bobCapability: "Test Generation",
        file: "lib/application.js",
        symbol: "lazyrouter",
        issueType: "missing_test",
        commitMessage: null,
        decision: "generated",
        humanApproved: null,
        note: "Test written to match test/app.js style. Covers singleton-initialisation path.",
      },
      {
        timestamp: "2026-05-15T09:02:18Z",
        action: "FIX_GENERATED",
        bobCapability: "Test Generation",
        file: "lib/application.js",
        symbol: "handle",
        issueType: "missing_test",
        commitMessage: null,
        decision: "generated",
        humanApproved: null,
        note: "Two test cases generated using supertest (existing devDependency).",
      },
      {
        timestamp: "2026-05-15T09:02:20Z",
        action: "FIX_GENERATED",
        bobCapability: "Doc Generation",
        file: "lib/application.js",
        symbol: "set",
        issueType: "doc_gap",
        commitMessage: null,
        decision: "generated",
        humanApproved: null,
        note: "Dual getter/setter return type confirmed by tracing all call sites.",
      },
    ];

    auditLog.push(...seedData);
  }

  res.json(auditLog);
});

// ROUTE 3: POST /api/create-pr
// Simulates PR creation and logs the action
app.post("/api/create-pr", (req, res) => {
  if (!applyResult.ran) {
    return res.status(400).json({ error: "Apply fixes first before creating a PR." });
  }

  // Add PR creation entry to audit log
  auditLog.push({
    timestamp: new Date().toISOString(),
    action: "PR_CREATED",
    bobCapability: "BobShell",
    file: null,
    symbol: null,
    issueType: null,
    commitMessage: null,
    decision: "completed",
    humanApproved: true,
    note: "Pull request created. Audit log attached as PR comment.",
  });

  res.json({
    prUrl: applyResult.summary.prUrl,
    branchName: applyResult.branchName,
    message: "Pull request opened successfully.",
    auditEntries: auditLog.length,
  });
});


app.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("🚀 RepoTour Server Started");
  console.log("=".repeat(60));
  console.log(`📍 Server running at: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📊 API endpoint: POST http://localhost:${PORT}/api/ingest`);
  console.log("=".repeat(60));
  console.log("Ready to analyze repositories! 🎉");
  console.log("");
});

// Made with Bob
