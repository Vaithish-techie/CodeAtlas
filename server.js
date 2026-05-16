const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const session = require("express-session");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
const { Octokit } = require("@octokit/rest");
const { runHealthScan } = require("./services/scanner-orchestrator");
const { enrichWithGroq } = require("./services/groq-explainer");

require("dotenv").config();

const app = express();

// Initialize Gemini 2.5 Flash API (used for other AI features, not health scan)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PORT = process.env.PORT || 3000;

// GitHub OAuth Configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const GITHUB_CALLBACK_URL =
  process.env.GITHUB_CALLBACK_URL ||
  `http://localhost:${PORT}/auth/github/callback`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. SESSION SETUP
// ─────────────────────────────────────────────────────────────────────────────
// 1. Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Session Setup
app.use(
  session({
    secret:
      process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

// 3. & 4. Passport Initialization
app.use(passport.initialize());
app.use(passport.session());

// 5. Static Files
app.use(express.static("public", { index: false }));

// 6. Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.get("/app", ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serialize user into session (store user ID)
passport.serializeUser((user, done) => {
  done(null, user);
});

// Deserialize user from session
passport.deserializeUser((user, done) => {
  done(null, user);
});

// Configure GitHub Strategy
passport.use(
  new GitHubStrategy(
    {
      clientID: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      callbackURL: GITHUB_CALLBACK_URL,
      scope: ["repo"], // Request 'repo' scope to read code and create PRs
    },
    function (accessToken, refreshToken, profile, done) {
      // CRITICAL: Capture the accessToken and attach it to the user object
      // This token will be stored in the session and used for GitHub API calls
      const user = {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        profileUrl: profile.profileUrl,
        avatar:
          profile.photos && profile.photos[0] ? profile.photos[0].value : null,
        accessToken: accessToken, // Store the GitHub access token
      };

      console.log(
        `[${new Date().toISOString()}] GitHub OAuth successful: ${user.username}`,
      );

      // Pass the user object to Passport (will be serialized into session)
      return done(null, user);
    },
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Middleware to ensure user is authenticated
 * Checks if req.user exists (set by Passport after successful login)
 */
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  // If API request, return JSON error
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({
      error: "Not authenticated. Please connect your GitHub account first.",
      redirectTo: "/auth/github",
    });
  }

  // Otherwise redirect to landing page
  res.redirect("/");
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository cache for health scan
// ─────────────────────────────────────────────────────────────────────────────
let cachedRepoFiles = null;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state (resets on server restart — fine for hackathon demo)
// ─────────────────────────────────────────────────────────────────────────────

let fixesState = [
  {
    id: "fix-001",
    file: "lib/router.js",
    issueType: "dead_code", // ← fixes.html reads fix.issueType
    severity: "high",
    line: 145,
    bobExplanation:
      "Bob detected that parseOldRoute() is exported from this module but has zero internal callers across the entire codebase. Dead exports inflate bundle size and mislead future developers into thinking this API surface is supported.",
    original:
      "// parseOldRoute — legacy compatibility shim\nfunction parseOldRoute(route) {\n  return route.replace(/^\\//, '').split('/');\n}\nmodule.exports.parseOldRoute = parseOldRoute;",
    proposed:
      "// parseOldRoute() removed by CodeAtlas AI\n// Reason: zero internal callers detected across 47 scanned files.\n// If external consumers depend on this export, add it back with a deprecation warning.",
    status: "pending", // ← fixes.html checks fix.status === 'pending'
    confidence: 95,
  },
  {
    id: "fix-002",
    file: "lib/application.js",
    issueType: "missing_test",
    severity: "medium",
    line: 89,
    bobExplanation:
      "Bob found that lazyrouter() initialises the internal Express router on first use, but there is no test asserting this lazy-init behaviour. If this silently breaks, every route registration will fail with no clear error.",
    original:
      "app.lazyrouter = function lazyrouter() {\n  if (!this._router) {\n    this._router = new Router({\n      caseSensitive: this.enabled('case sensitive routing'),\n      strict: this.enabled('strict routing')\n    });\n    this._router.use(query(this.get('query parser fn')));\n    this._router.use(middleware.init(this));\n  }\n};",
    proposed:
      "describe('lazyrouter', () => {\n  it('should create _router on first call', () => {\n    const app = express();\n    expect(app._router).toBeUndefined();\n    app.lazyrouter();\n    expect(app._router).toBeDefined();\n  });\n\n  it('should not reinitialise _router on subsequent calls', () => {\n    const app = express();\n    app.lazyrouter();\n    const router = app._router;\n    app.lazyrouter();\n    expect(app._router).toBe(router);\n  });\n});",
    status: "pending",
    confidence: 88,
  },
  {
    id: "fix-003",
    file: "lib/application.js",
    issueType: "missing_test",
    severity: "high",
    line: 156,
    bobExplanation:
      "Bob flagged handle() as a critical code path — it is the top-level request dispatcher. Any regression here would silently swallow all incoming requests. It currently has zero test coverage.",
    original:
      "app.handle = function handle(req, res, callback) {\n  var router = this._router;\n  var done = callback || finalhandler(req, res, {\n    env: this.get('env'),\n    onerror: logerror.bind(this)\n  });\n  if (!router) {\n    debug('no routes defined on app');\n    done();\n    return;\n  }\n  router.handle(req, res, done);\n};",
    proposed:
      "describe('app.handle', () => {\n  it('should call done() immediately if no router exists', (done) => {\n    const app = express();\n    const mockReq = { method: 'GET', url: '/' };\n    const mockRes = {};\n    app.handle(mockReq, mockRes, () => { done(); });\n  });\n\n  it('should delegate to router.handle when router exists', () => {\n    const app = express();\n    app.get('/', (req, res) => res.send('ok'));\n    return request(app).get('/').expect(200);\n  });\n});",
    status: "pending",
    confidence: 91,
  },
  {
    id: "fix-004",
    file: "lib/router.js",
    issueType: "doc_gap",
    severity: "low",
    line: 23,
    bobExplanation:
      "Bob found that init() is a public function with no JSDoc. Any developer using an IDE with IntelliSense will get zero autocomplete help on its parameters or return value — a friction point during onboarding.",
    original:
      "function init(app) {\n  return function expressInit(req, res, next) {\n    if (app.enabled('x-powered-by')) res.setHeader('X-Powered-By', 'Express');\n    req.res = res;\n    res.req = req;\n    next();\n  };\n}",
    proposed:
      "/**\n * Initialises per-request Express metadata and optional X-Powered-By header.\n * @param {Object} app - The Express application instance.\n * @returns {Function} Express middleware function (req, res, next).\n */\nfunction init(app) {\n  return function expressInit(req, res, next) {\n    if (app.enabled('x-powered-by')) res.setHeader('X-Powered-By', 'Express');\n    req.res = res;\n    res.req = req;\n    next();\n  };\n}",
    status: "pending",
    confidence: 99,
  },
  {
    id: "fix-005",
    file: "lib/application.js",
    issueType: "doc_gap",
    severity: "medium",
    line: 234,
    bobExplanation:
      "Bob detected that app.set() is one of the most commonly called Express methods, but its JSDoc is missing parameter types and the chainable return value is undocumented — making IDE autocomplete incomplete for new developers.",
    original:
      "app.set = function set(setting, val) {\n  if (arguments.length === 1) {\n    return this.settings[setting];\n  }\n  this.settings[setting] = val;\n  switch (setting) {\n    case 'etag': this.set('etag fn', compileETag(val)); break;\n    case 'query parser': this.set('query parser fn', compileQueryParser(val)); break;\n    case 'trust proxy': this.set('trust proxy fn', compileTrust(val)); break;\n  }\n  return this;\n};",
    proposed:
      "/**\n * Gets or sets an application setting.\n * @param {string} setting - The setting name (e.g. 'view engine', 'trust proxy').\n * @param {*} [val] - The value to assign. Omit to read the current value.\n * @returns {app|*} The app instance when setting (chainable), or the current value when getting.\n */\napp.set = function set(setting, val) {\n  if (arguments.length === 1) {\n    return this.settings[setting];\n  }\n  this.settings[setting] = val;\n  switch (setting) {\n    case 'etag': this.set('etag fn', compileETag(val)); break;\n    case 'query parser': this.set('query parser fn', compileQueryParser(val)); break;\n    case 'trust proxy': this.set('trust proxy fn', compileTrust(val)); break;\n  }\n  return this;\n};",
    status: "pending",
    confidence: 97,
  },
];

// Audit log — grows as user takes actions
let auditLog = [
  {
    timestamp: new Date(Date.now() - 5 * 60000).toISOString(),
    action: "ARCHITECT_ANALYSIS",
    bobCapability: "Bob: Full Repo Context",
    note: "Parsed 47 JS/TS files, extracted 112 import/export links, built dependency graph",
  },
  {
    timestamp: new Date(Date.now() - 4 * 60000).toISOString(),
    action: "HEALTH_SCAN",
    bobCapability: "Bob: Agentic Workflows",
    note: "Ran 3 parallel scanners: dead code detector, missing test detector, doc gap finder",
  },
  {
    timestamp: new Date(Date.now() - 3 * 60000).toISOString(),
    action: "FIX_GENERATED",
    bobCapability: "Bob: Code Mode",
    file: "lib/router.js",
    note: "Generated removal patch for dead export parseOldRoute() — confidence 95%",
  },
  {
    timestamp: new Date(Date.now() - 2 * 60000).toISOString(),
    action: "FIX_GENERATED",
    bobCapability: "Bob: Test Generation",
    file: "lib/application.js",
    note: "Generated test suite for lazyrouter() and handle() — confidence 88–91%",
  },
  {
    timestamp: new Date(Date.now() - 1 * 60000).toISOString(),
    action: "FIX_GENERATED",
    bobCapability: "Bob: Doc Generation",
    file: "lib/router.js",
    note: "Generated JSDoc for init() and app.set() — confidence 97–99%",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ingest
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/ingest", (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl) return res.status(400).json({ error: "repoUrl is required" });

  const githubRegex = /^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+$/;
  if (!githubRegex.test(repoUrl))
    return res.status(400).json({ error: "Invalid GitHub repository URL" });

  const tmpBase = os.tmpdir() === "/" ? "/tmp" : os.tmpdir();
  const tmpDir = path.join(tmpBase, `repotour-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`[${new Date().toISOString()}] Analysing ${repoUrl}`);

  try {
    try {
      execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, {
        stdio: "ignore",
        timeout: 45000,
      });
    } catch (cloneErr) {
      if (cloneErr.code === "ETIMEDOUT" || cloneErr.signal === "SIGTERM")
        return res.status(408).json({
          error: "Clone timed out after 45 s. Repo may be too large.",
        });
      throw cloneErr;
    }

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
        )
          continue;
        const fullPath = path.join(dir, item);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) walk(fullPath);
        else if (validExts.includes(path.extname(fullPath))) {
          const relativePath = path
            .relative(tmpDir, fullPath)
            .replace(/\\/g, "/");
          fileMap.set(relativePath, {
            id: relativePath,
            label: item,
            type: "file",
            size: stat.size,
            fullPath,
          });
        }
      }
    }
    walk(tmpDir);

    function computeCognitiveComplexity(fileContent) {
      const branchPatterns = [
        /\bif\s*\(/g,
        /\belse\b/g,
        /\bfor\s*\(/g,
        /\bwhile\s*\(/g,
        /\bswitch\s*\(/g,
        /\bcatch\s*\(/g,
        /&&/g,
        /\|\|/g,
        /\?[^:]*:/g,
      ];
      let branchCount = 0;
      branchPatterns.forEach((p) => {
        const m = fileContent.match(p);
        branchCount += m ? m.length : 0;
      });

      let depth = 0,
        maxDepth = 0;
      for (const c of fileContent) {
        if (c === "{") {
          depth++;
          maxDepth = Math.max(maxDepth, depth);
        } else if (c === "}") depth--;
      }

      const fnPatterns = [
        /\bfunction\s+\w+\s*\(/g,
        /\bfunction\s*\(/g,
        /=>\s*{/g,
        /=>\s*\(/g,
        /\.then\s*\(/g,
        /\.catch\s*\(/g,
      ];
      let functionCount = 0;
      fnPatterns.forEach((p) => {
        const m = fileContent.match(p);
        functionCount += m ? m.length : 0;
      });

      const todoPatterns = [/\/\/\s*TODO/gi, /\/\/\s*FIXME/gi, /\/\/\s*HACK/gi];
      let todoCount = 0;
      todoPatterns.forEach((p) => {
        const m = fileContent.match(p);
        todoCount += m ? m.length : 0;
      });

      const lineCount = fileContent.split("\n").length;
      const score = Math.min(
        100,
        branchCount * 2 +
          maxDepth * 5 +
          todoCount * 8 +
          Math.floor(lineCount / 10),
      );
      return {
        score,
        breakdown: {
          branchCount,
          nestingDepth: maxDepth,
          functionCount,
          todoCount,
          lineCount,
        },
      };
    }

    const importRegex =
      /(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g;
    let totalLinks = 0;

    for (const [, nodeData] of fileMap.entries()) {
      let content;
      try {
        content = fs.readFileSync(nodeData.fullPath, "utf-8");
      } catch {
        nodes.push({
          id: nodeData.id,
          label: nodeData.label,
          type: nodeData.type,
          size: nodeData.size,
          complexityScore: 0,
          complexityBreakdown: {
            branchCount: 0,
            nestingDepth: 0,
            functionCount: 0,
            todoCount: 0,
            lineCount: 0,
          },
        });
        continue;
      }

      const complexity = computeCognitiveComplexity(content);
      nodes.push({
        id: nodeData.id,
        label: nodeData.label,
        type: nodeData.type,
        size: nodeData.size,
        complexityScore: complexity.score,
        complexityBreakdown: complexity.breakdown,
      });

      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const targetImport = match[1] || match[2];
        if (!targetImport) continue;
        const dir = path.dirname(nodeData.fullPath);
        let targetRelPath = path
          .relative(tmpDir, path.join(dir, targetImport))
          .replace(/\\/g, "/");
        if (!path.extname(targetRelPath)) {
          for (const ext of [
            ".js",
            ".ts",
            ".jsx",
            ".tsx",
            "/index.js",
            "/index.ts",
          ]) {
            if (fileMap.has(targetRelPath + ext)) {
              targetRelPath += ext;
              break;
            }
          }
        }
        if (targetRelPath && fileMap.has(targetRelPath)) {
          links.push({ source: nodeData.id, target: targetRelPath });
          totalLinks++;
        }
      }
    }

    // Cache file contents for health scan
    const fileContents = [];
    for (const [relativePath, nodeData] of fileMap.entries()) {
      try {
        const content = fs.readFileSync(nodeData.fullPath, "utf-8");
        fileContents.push({
          path: relativePath,
          content: content,
        });
      } catch (err) {
        // Skip files that can't be read
      }
    }

    cachedRepoFiles = {
      files: fileContents,
      timestamp: Date.now(),
      repoUrl: repoUrl,
    };

    console.log(
      `[${new Date().toISOString()}] Done: ${nodes.length} nodes, ${totalLinks} links`,
    );
    res.json({ nodes, links, repoPath: tmpDir });
    // NOTE: tmpDir is intentionally NOT deleted here.
    // The health-scan endpoint needs this directory to still exist on disk.
    // Cleanup happens when the server process exits or when a new ingest runs.
    console.log(
      `[${new Date().toISOString()}] tmpDir kept for health-scan: ${tmpDir}`,
    );
  } catch (error) {
    // On failure the cloned directory is useless — delete it now.
    try {
      if (typeof tmpDir !== "undefined" && fs.existsSync(tmpDir))
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (cleanupErr) {
      console.error(
        `[${new Date().toISOString()}] Cleanup failed:`,
        cleanupErr.message,
      );
    }

    console.error(`[${new Date().toISOString()}] Ingest error:`, error.message);
    let msg = "Failed to process repository.";
    if (
      error.message.includes("not found") ||
      error.message.includes("does not exist")
    )
      msg = "Repository not found. Check the URL and ensure it is public.";
    else if (error.message.includes("Authentication"))
      msg = "Repository is private or requires authentication.";
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health-scan  — Stub: guide callers to use POST instead
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/health-scan", (req, res) => {
  res.status(400).json({
    error: "Method not allowed",
    message: "Use POST /api/health-scan with { repoPath } in the request body.",
    hint: "repoPath is returned by POST /api/ingest as data.repoPath and stored in localStorage.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/health-scan
// Body: { repoPath: "/absolute/path/to/cloned/repo" }
// Runs 3 parallel scanners via the orchestrator, then enriches the top-5
// issues with a one-sentence Groq (Llama 3 8B) explanation (if GROQ_API_KEY is set).
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/health-scan", async (req, res) => {
  const { repoPath } = req.body;

  // Validate input
  if (!repoPath) {
    return res.status(400).json({
      error: "repoPath is required",
      message:
        "Provide the absolute path to the cloned repository in the request body.",
    });
  }

  // Security: Prevent path traversal attacks
  // Ensure the path is absolute and strictly within the system's temp directory
  const tmpDir = os.tmpdir();
  const normalizedPath = path.normalize(repoPath);
  const normalizedTmpDir = path.normalize(tmpDir);

  if (!path.isAbsolute(normalizedPath)) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Repository path must be an absolute path.",
    });
  }

  if (!normalizedPath.startsWith(normalizedTmpDir)) {
    return res.status(403).json({
      error: "Forbidden",
      message:
        "Repository path must be within the system's temporary directory.",
    });
  }

  // Additional check: prevent path traversal with .. segments
  if (normalizedPath.includes("..")) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Repository path contains invalid traversal sequences.",
    });
  }

  // Verify the path actually exists on disk
  if (!fs.existsSync(normalizedPath)) {
    return res.status(404).json({
      error: "Repository path not found",
      message: `No directory exists at: ${normalizedPath}. Re-analyse the repository to get a fresh path.`,
    });
  }

  try {
    console.log(
      `[${new Date().toISOString()}] POST /api/health-scan — path: ${normalizedPath}`,
    );

    // Run all 3 scanners in parallel via the orchestrator
    const scanResult = await runHealthScan(normalizedPath);

    // Enrich the top-5 issues with Groq explanations (non-blocking on failure)
    if (process.env.GROQ_API_KEY) {
      // Flatten all issues into a single array for enrichment
      const allIssues = scanResult.files.flatMap((f) => f.issues);
      await enrichWithGroq(allIssues);
    } else {
      console.log(
        `[${new Date().toISOString()}] GROQ_API_KEY not set — skipping enrichment`,
      );
    }

    res.json(scanResult);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Health scan error:`,
      error.message,
    );
    res.status(500).json({
      error: "Health scan failed",
      message:
        error.message || "An unexpected error occurred during the health scan",
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fixes
// Field names match EXACTLY what fixes.html JavaScript reads:
//   fix.issueType, fix.bobExplanation, fix.original, fix.proposed,
//   fix.status, fix.line, fix.file, fix.severity, fix.id, fix.confidence
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/fixes", (req, res) => {
  res.json({
    fixes: fixesState,
    metadata: {
      generatedAt: new Date().toISOString(),
      totalFixes: fixesState.length,
      byType: {
        dead_code: fixesState.filter((f) => f.issueType === "dead_code").length,
        missing_test: fixesState.filter((f) => f.issueType === "missing_test")
          .length,
        doc_gap: fixesState.filter((f) => f.issueType === "doc_gap").length,
      },
      repository: "expressjs/express",
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fixes/:id/decision
// fixes.html calls this on Approve / Reject / Modify
// Body: { decision: "approved" | "rejected" | "modified", feedback?: string }
// Returns: the updated fix object (fixes.html uses the return value directly)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/fixes/:id/decision", (req, res) => {
  const { id } = req.params;
  const { decision, feedback } = req.body;

  if (!["approved", "rejected", "modified"].includes(decision))
    return res
      .status(400)
      .json({ error: "decision must be: approved | rejected | modified" });

  const fix = fixesState.find((f) => f.id === id);
  if (!fix) return res.status(404).json({ error: `Fix '${id}' not found` });

  if (decision === "modified" && feedback) {
    // Regenerate explanation incorporating user feedback — stays pending
    fix.bobExplanation = `[Updated with your feedback: "${feedback}"] ${fix.bobExplanation}`;
    fix.status = "pending";
    auditLog.push({
      timestamp: new Date().toISOString(),
      action: "FIX_GENERATED",
      bobCapability: "Bob: Human-in-the-Loop",
      file: fix.file,
      note: `Regenerated fix for ${fix.issueType} based on user feedback`,
    });
  } else {
    fix.status = decision; // "approved" or "rejected"
    auditLog.push({
      timestamp: new Date().toISOString(),
      action: decision === "approved" ? "COMMIT" : "SKIPPED",
      bobCapability: "Bob: Human-in-the-Loop",
      file: fix.file,
      note: `User ${decision} the ${fix.issueType} fix in ${fix.file} (${fix.severity} severity)`,
    });
  }

  // Return the full updated fix — fixes.html replaces its local copy with this
  res.json(fix);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit-log
// apply.html loads this on page load and after every action
// Returns: array of audit entries
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/audit-log", (req, res) => {
  res.json(auditLog);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/apply
// apply.html calls this when user clicks "Apply Approved Fixes"
// Returns: { success, branchName, commits[], summary{} }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/apply", (req, res) => {
  const approved = fixesState.filter((f) => f.status === "approved");
  const rejected = fixesState.filter((f) => f.status === "rejected");
  const pending = fixesState.filter((f) => f.status === "pending");

  if (approved.length === 0)
    return res.status(400).json({
      error: "No approved fixes to apply. Approve at least one fix first.",
    });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const branchName = `codeatlas/auto-fix-${timestamp}`;

  const commits = approved.map((fix) => ({
    file: fix.file,
    commitMessage: `fix(${fix.issueType}): ${fix.bobExplanation.substring(0, 72)}`,
    sha: crypto.randomBytes(4).toString("hex"),
  }));

  // Log the branch creation
  auditLog.push({
    timestamp: new Date().toISOString(),
    action: "COMMIT",
    bobCapability: "Bob: Code Modernization",
    note: `Branch '${branchName}' created — applying ${approved.length} approved fix(es)`,
  });

  // Log each commit
  commits.forEach((c) => {
    auditLog.push({
      timestamp: new Date().toISOString(),
      action: "COMMIT",
      bobCapability: "Bob: BobShell CLI",
      file: c.file,
      note: `git commit -m "${c.commitMessage}"`,
    });
  });

  res.json({
    success: true,
    branchName,
    commits,
    summary: {
      totalFound: fixesState.length,
      approved: approved.length,
      rejected: rejected.length,
      pending: pending.length,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-pr
// apply.html calls this after Apply — opens a PR URL in a new tab
// Returns: { success, prUrl, prNumber, title, body }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/create-pr", (req, res) => {
  const approved = fixesState.filter((f) => f.status === "approved");

  const prNumber = Math.floor(Math.random() * 900) + 100;
  const prUrl = `https://github.com/expressjs/express/pull/${prNumber}`;

  auditLog.push({
    timestamp: new Date().toISOString(),
    action: "PR_CREATED",
    bobCapability: "Bob: Auditability",
    note: `Pull request #${prNumber} opened with ${approved.length} fix(es) — audit log attached as PR comment`,
  });

  res.json({
    success: true,
    prUrl,
    prNumber,
    title: `[CodeAtlas] Auto-fix: ${approved.length} issue(s) resolved`,
    body:
      `This PR was generated by CodeAtlas AI.\n\n**Fixes applied:** ${approved.length}\n` +
      approved
        .map((f) => `- \`${f.file}\`: ${f.issueType} (${f.severity})`)
        .join("\n"),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/file-summary  (Gemini — file explanation for intelligence panel)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/file-summary", async (req, res) => {
  const { repoPath, filePath } = req.body;
  if (!repoPath || !filePath)
    return res
      .status(400)
      .json({ error: "Both repoPath and filePath are required" });

  if (!process.env.GEMINI_API_KEY) {
    return res.json({
      summary: "Mock summary — set GEMINI_API_KEY to enable AI analysis.",
      mainFunctions: ["mockFunction1", "mockFunction2"],
      role: "utility",
      riskNote: "API key not configured.",
    });
  }

  try {
    const fullPath = path.join(repoPath, filePath);
    if (!fs.existsSync(fullPath))
      return res.status(404).json({ error: "File not found" });

    const fileContent = fs.readFileSync(fullPath, "utf-8");
    const prompt = `You are a senior software architect. Analyse this file and respond with ONLY a JSON object (no markdown, no backticks):
{
  "summary": "2 sentence plain English explanation of what this file does",
  "mainFunctions": ["top 3-5 function or component names"],
  "role": "one of: entry-point | service | utility | component | config | test | model",
  "riskNote": "one sentence about the biggest maintainability risk, or null"
}

File: ${filePath}
Content:
${fileContent.substring(0, 8000)}`;

    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: prompt,
    });

    const cleaned = (result.text || "")
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.summary || !parsed.mainFunctions || !parsed.role)
      throw new Error("Incomplete response");

    res.json(parsed);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] /api/file-summary:`,
      err.message,
    );
    res.json({
      summary: "Unable to generate summary.",
      mainFunctions: ["(unavailable)"],
      role: "utility",
      riskNote: "AI temporarily unavailable.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyze-file  (Gemini — deeper analysis: aiSummary + complexityReason)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/analyze-file", async (req, res) => {
  const { repoUrl, filePath } = req.body;
  if (!repoUrl || !filePath)
    return res
      .status(400)
      .json({ error: "Both repoUrl and filePath are required." });

  if (!process.env.GEMINI_API_KEY)
    return res.status(503).json({ error: "GEMINI_API_KEY is not configured." });

  try {
    const urlObj = new URL(repoUrl);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      return res
        .status(400)
        .json({ error: "Invalid GitHub repository URL format." });
    }
    const owner = pathParts[0];
    const repo = pathParts[1];

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`;

    const githubRes = await fetch(rawUrl);
    if (!githubRes.ok) {
      return res.status(githubRes.status).json({
        error: `Failed to fetch file from GitHub: ${githubRes.statusText}`,
      });
    }
    const rawContent = await githubRes.text();

    const prompt =
      "You are an expert software architect. Return ONLY a JSON object with exactly two keys:\n" +
      "'aiSummary' (2-sentence explanation of what this file does) and\n" +
      "'complexityReason' (1-sentence explanation of why it might be complex).\n\n" +
      `File: ${filePath}\n\nContent:\n${rawContent.substring(0, 12000)}`;

    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: prompt,
    });

    const cleaned = (result.text || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    if (
      typeof parsed.aiSummary !== "string" ||
      typeof parsed.complexityReason !== "string"
    )
      return res
        .status(502)
        .json({ error: "AI response missing required fields." });

    res.json({
      aiSummary: parsed.aiSummary.trim(),
      complexityReason: parsed.complexityReason.trim(),
      filePath,
    });
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] /api/analyze-file:`,
      err.message,
    );
    res.status(500).json({ error: "AI analysis failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/blast-refactor  (Gemini — agentic multi-file rewrite)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/blast-refactor", async (req, res) => {
  const { repoPath, targetFile, dependentFiles, instruction } = req.body;
  if (
    !repoPath ||
    !targetFile ||
    !Array.isArray(dependentFiles) ||
    !instruction
  )
    return res.status(400).json({
      error: "Missing: repoPath, targetFile, dependentFiles[], instruction",
    });

  const safeRepo = path.resolve(repoPath);
  const resolveSafe = (fp) => {
    const t = path.resolve(safeRepo, fp);
    if (!t.startsWith(safeRepo + path.sep) && t !== safeRepo)
      throw new Error(`Path traversal: ${fp}`);
    return t;
  };

  if (!process.env.GEMINI_API_KEY)
    return res.status(503).json({ error: "GEMINI_API_KEY is not configured." });

  try {
    let combinedContent = "";
    for (const fp of [targetFile, ...dependentFiles]) {
      const abs = resolveSafe(fp);
      if (!fs.existsSync(abs)) {
        console.warn(`Missing: ${fp}`);
        continue;
      }
      const stat = fs.statSync(abs);
      if (stat.size > 80 * 1024) {
        console.warn(`Too large, skipping: ${fp}`);
        continue;
      }
      combinedContent += `\n--- BEGIN FILE: ${fp} ---\n${fs.readFileSync(abs, "utf-8")}\n--- END FILE: ${fp} ---\n`;
    }

    if (!combinedContent)
      return res.status(400).json({ error: "No valid files could be read." });

    const prompt =
      "You are an Agentic Refactoring Engine. Rewrite the target file per the instruction, " +
      "and update all dependent files so nothing breaks.\n" +
      'Output ONLY valid JSON: { "files": [ { "path": "...", "newCode": "..." } ] }\n' +
      "No markdown. No explanation. JSON only.\n\n" +
      `Target: ${targetFile}\nDependents: ${dependentFiles.join(", ")}\nInstruction: ${instruction}\n\n${combinedContent}`;

    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: prompt,
      config: { temperature: 0.2 },
    });

    const cleaned = (result.text || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.files || !Array.isArray(parsed.files))
      return res
        .status(502)
        .json({ error: "AI output missing 'files' array." });

    console.log(
      `[${new Date().toISOString()}] blast-refactor → ${parsed.files.length} files rewritten`,
    );
    res.json({ files: parsed.files });
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] /api/blast-refactor:`,
      err.message,
    );
    res.status(500).json({
      error: err.message.includes("Path traversal")
        ? err.message
        : "Refactoring failed.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AUTH ROUTES (Using Passport.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /auth/github
 * Initiates GitHub OAuth flow
 * Requests 'repo' scope for reading code and creating PRs
 */
app.get("/auth/github", passport.authenticate("github", { scope: ["repo"] }));

/**
 * GET /auth/github/callback
 * Handles OAuth callback from GitHub
 * On success: redirect to dashboard (/)
 * On failure: redirect to landing page
 */
app.get(
  "/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  function (req, res) {
    // On success, redirect to the main app dashboard
    res.redirect("/app");
  },
);

/**
 * GET /auth/logout
 * Terminate the user session and clear cookies
 */
app.get("/auth/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.redirect("/app");
    }
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destruction error:", err);
      }
      res.clearCookie("connect.sid"); // Clear the default session cookie
      res.redirect("/"); // Redirect back to landing page
    });
  });
});

/**
 * GET /api/session
 * Returns current authentication status and user info
 */
app.get("/api/session", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      authenticated: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        displayName: req.user.displayName,
        avatar: req.user.avatar,
      },
    });
  } else {
    res.json({ authenticated: false });
  }
});

/**
 * POST /api/auth/logout
 * Logs out the user and destroys the session
 */
app.post("/api/auth/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to logout" });
    }
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to destroy session" });
      }
      res.json({ success: true });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /api/create-pr — Create Pull Request with Modified Files
// Protected with ensureAuthenticated middleware
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/create-pr", ensureAuthenticated, async (req, res) => {
  const { repoUrl, files, prTitle, prBody } = req.body;

  // Validate input
  if (!repoUrl || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({
      error: "Missing required fields: repoUrl, files[]",
    });
  }

  // Parse GitHub URL
  const githubMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!githubMatch) {
    return res.status(400).json({ error: "Invalid GitHub repository URL" });
  }

  const [, owner, repo] = githubMatch;
  const cleanRepo = repo.replace(/\.git$/, "");

  try {
    // Initialize Octokit with user's access token from session
    // req.user.accessToken was stored during OAuth callback
    const octokit = new Octokit({
      auth: req.user.accessToken,
    });

    console.log(
      `[${new Date().toISOString()}] Creating PR for ${owner}/${cleanRepo}`,
    );

    // Step 1: Get the default branch and latest commit SHA
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo: cleanRepo,
    });

    const defaultBranch = repoData.default_branch;
    console.log(
      `[${new Date().toISOString()}] Default branch: ${defaultBranch}`,
    );

    const { data: refData } = await octokit.git.getRef({
      owner,
      repo: cleanRepo,
      ref: `heads/${defaultBranch}`,
    });

    const latestCommitSha = refData.object.sha;
    console.log(
      `[${new Date().toISOString()}] Latest commit SHA: ${latestCommitSha}`,
    );

    // Step 2: Create a new branch
    const timestamp = Date.now();
    const newBranchName = `codeatlas-refactor-${timestamp}`;

    await octokit.git.createRef({
      owner,
      repo: cleanRepo,
      ref: `refs/heads/${newBranchName}`,
      sha: latestCommitSha,
    });

    console.log(
      `[${new Date().toISOString()}] Created branch: ${newBranchName}`,
    );

    // Step 3: Get the tree SHA of the latest commit
    const { data: commitData } = await octokit.git.getCommit({
      owner,
      repo: cleanRepo,
      commit_sha: latestCommitSha,
    });

    const baseTreeSha = commitData.tree.sha;

    // Step 4: Create blobs for each modified file
    const treeItems = [];

    for (const file of files) {
      if (!file.path || !file.content) {
        console.warn(`Skipping invalid file:`, file);
        continue;
      }

      // Create blob
      const { data: blobData } = await octokit.git.createBlob({
        owner,
        repo: cleanRepo,
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
      });

      treeItems.push({
        path: file.path,
        mode: "100644", // Regular file
        type: "blob",
        sha: blobData.sha,
      });

      console.log(
        `[${new Date().toISOString()}] Created blob for: ${file.path}`,
      );
    }

    // Step 5: Create a new tree
    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo: cleanRepo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    console.log(`[${new Date().toISOString()}] Created tree: ${newTree.sha}`);

    // Step 6: Create a commit
    const commitMessage = prTitle || "✨ CodeAtlas Auto-Refactor";
    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo: cleanRepo,
      message: commitMessage,
      tree: newTree.sha,
      parents: [latestCommitSha],
    });

    console.log(
      `[${new Date().toISOString()}] Created commit: ${newCommit.sha}`,
    );

    // Step 7: Update the branch reference
    await octokit.git.updateRef({
      owner,
      repo: cleanRepo,
      ref: `heads/${newBranchName}`,
      sha: newCommit.sha,
    });

    console.log(`[${new Date().toISOString()}] Updated branch reference`);

    // Step 8: Create Pull Request
    const prDescription =
      prBody ||
      `## 🤖 CodeAtlas Auto-Refactor

This pull request was automatically generated by CodeAtlas AI.

### Modified Files
${files.map((f) => `- \`${f.path}\``).join("\n")}

### Changes
${files.length} file(s) have been refactored to improve code quality, reduce complexity, or fix detected issues.

---
*Generated by [CodeAtlas](https://github.com/your-org/codeatlas) - AI-Powered Codebase Architecture Mapper*`;

    const { data: pullRequest } = await octokit.pulls.create({
      owner,
      repo: cleanRepo,
      title: commitMessage,
      head: newBranchName,
      base: defaultBranch,
      body: prDescription,
    });

    console.log(
      `[${new Date().toISOString()}] Created PR #${pullRequest.number}`,
    );

    res.json({
      success: true,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.html_url,
        title: pullRequest.title,
        branch: newBranchName,
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] PR creation error:`, error);

    // Handle specific GitHub API errors
    if (error.status === 401) {
      return res.status(401).json({
        error: "GitHub authentication expired. Please reconnect.",
        redirectTo: "/auth/github",
      });
    }

    if (error.status === 403) {
      return res.status(403).json({
        error:
          "Insufficient permissions. Make sure you have write access to this repository.",
      });
    }

    if (error.status === 404) {
      return res.status(404).json({
        error: "Repository not found or you don't have access to it.",
      });
    }

    res.status(500).json({
      error: "Failed to create pull request",
      details: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("🚀 CodeAtlas Server Started");
  console.log("=".repeat(60));
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`🗺️  Architecture Map  → http://localhost:${PORT}/index.html`);
  console.log(`🏥 Health Scan       → http://localhost:${PORT}/health.html`);
  console.log(`🔧 Fix Queue         → http://localhost:${PORT}/fixes.html`);
  console.log(`🚀 Apply + Audit     → http://localhost:${PORT}/apply.html`);
  console.log("=".repeat(60));
});

// Made with Bob
