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
// FEATURE 3: OpenAI GPT Integration for Auto-Fix Queue
// ─────────────────────────────────────────────────────────────────────────────

// OpenAI Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_ENDPOINT = `${OPENAI_BASE_URL}/chat/completions`;

// In-memory cache for GPT-generated fixes (persists per server session)
let fixesCache = null;
let cacheTimestamp = null;

// Health scan issues to generate fixes for
const HEALTH_ISSUES = [
  {
    file: "lib/router.js",
    type: "dead_code",
    severity: "high",
    description:
      "Function 'parseOldRoute()' is exported but never used internally.",
    line: 145,
    symbol: "parseOldRoute",
  },
  {
    file: "lib/router.js",
    type: "doc_gap",
    severity: "low",
    description: "Public function 'init()' is missing JSDoc documentation.",
    line: 23,
    symbol: "init",
  },
  {
    file: "lib/application.js",
    type: "missing_test",
    severity: "medium",
    description: "Function 'lazyrouter()' has no corresponding test case.",
    line: 89,
    symbol: "lazyrouter",
  },
  {
    file: "lib/application.js",
    type: "missing_test",
    severity: "high",
    description: "Critical function 'handle()' lacks test coverage.",
    line: 156,
    symbol: "handle",
  },
  {
    file: "lib/application.js",
    type: "doc_gap",
    severity: "medium",
    description: "Public method 'set()' is missing parameter documentation.",
    line: 234,
    symbol: "set",
  },
];

/**
 * Check if OpenAI API is properly configured
 */
function isOpenAIConfigured() {
  return OPENAI_API_KEY && OPENAI_API_KEY !== "dummy" && OPENAI_API_KEY.length > 0;
}

/**
 * Call the AI API to generate a fix for one issue.
 * Passes the real extracted code snippet so the model reasons about actual code.
 * Returns { bobExplanation, proposed, confidence } or null on any failure.
 * Null signals the caller to use the template fallback — never throws.
 *
 * @param {Object} issue       - Issue metadata from the scanner
 * @param {string} codeSnippet - Real code extracted by extractCodeSnippet()
 * @returns {Promise<{bobExplanation:string, proposed:string, confidence:number}|null>}
 */
async function generateFixWithGPT(issue, codeSnippet) {
  if (!isOpenAIConfigured()) return null;

  try {
    const prompt = buildPromptForIssue(issue, codeSnippet);
    console.log(`[${new Date().toISOString()}] AI fix: ${issue.type} → ${issue.filePath || issue.file}`);

    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are Bob, an expert software architect AI. Respond with pure JSON only — no markdown fences, no backticks, no extra text.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] AI API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    let raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    // Strip markdown fences if the model wrapped the JSON anyway
    raw = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

    const parsed = JSON.parse(raw);
    if (!parsed.bobExplanation || !parsed.proposed) return null;

    return {
      bobExplanation: parsed.bobExplanation,
      proposed: parsed.proposed,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 80,
    };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] AI fix failed (${issue.type}):`, err.message);
    return null;
  }
}

/**
 * Build a code-aware prompt for the AI.
 * Embeds the actual extracted source code so the model reasons about real code,
 * not just metadata.
 *
 * @param {Object} issue       - Issue metadata
 * @param {string} codeSnippet - Real code from extractCodeSnippet()
 * @returns {string}
 */
function buildPromptForIssue(issue, codeSnippet) {
  const filePath = issue.filePath || issue.file;
  const symbol   = issue.symbol || "unknown";

  // Strip any metadata header that extractCodeSnippet() prepends so the AI
  // receives only real source code — not our own annotation comments.
  // Patterns to strip (always the first line):
  //   "// path/to/file  (lines N–M)"     ← specific line window
  //   "// (No specific line — ..."        ← no line number, first-20-lines fallback
  const lines = codeSnippet.split("\n");
  // Matches both header formats produced by extractCodeSnippet():
  //   "// path/to/file  (lines N–M)"  ← specific line window
  //   "// (No specific line — ..."     ← first-20-lines fallback
  if (
    lines.length > 0 &&
    (lines[0].match(/^\/\/ .+\(lines \d+/) ||
      lines[0].startsWith("// (No specific line"))
  ) {
    lines.shift();
  }

  // Cap to 60 lines to stay within token budget
  const cappedCode = lines.slice(0, 60).join("\n").trim();

  const JSON_FORMAT = `Respond with ONLY this JSON (no markdown, no backticks, no extra text):
{
  "bobExplanation": "2-3 sentences specific to this file and its actual code",
  "proposed": "the actual fix as runnable code, not prose",
  "confidence": 80
}`;

  switch (issue.type) {
    case "dead_code":
      return `You are Bob, a senior software architect AI reviewing a JS/TS codebase.

The static analyser flagged \`${filePath}\` as an ORPHAN FILE — nothing imports it.

ACTUAL FILE CONTENT:
${cappedCode}

IMPORTANT: Orphaned ≠ always dead. Read the code and decide:
- SCENARIO A: Truly unused legacy/experimental code → propose removing/commenting it out.
- SCENARIO B: Useful code that is simply missing an import → propose the import statement that should be added to the correct consumer file.

${JSON_FORMAT}`;


    case "missing_test":
      return `You are Bob, a senior software architect AI.

\`${symbol}\` in \`${filePath}\` has no test coverage.

ACTUAL SOURCE CODE:
${cappedCode}

Write a complete, runnable Jest test suite based on what this code ACTUALLY DOES.
Do NOT use placeholder comments. Write real test cases covering happy path, edge cases, and error paths visible in the code.

${JSON_FORMAT}`;

    case "doc_gap":
      return `You are Bob, a senior software architect AI.

\`${symbol}\` exported from \`${filePath}\` has no JSDoc.

ACTUAL CODE:
${cappedCode}

Write an accurate JSDoc block for this symbol based on what it actually does.
Return the JSDoc block placed immediately above the original code — both together as the proposed value.

${JSON_FORMAT}`;

    case "circular_dep":
      return `You are Bob, a senior software architect AI.

Circular import chain detected: ${symbol}

Starting file \`${filePath}\` content:
${cappedCode}

Suggest a concrete refactor to break this cycle (extract shared module, dependency injection, or restructure exports). Show actual code in the proposed field.

${JSON_FORMAT}`;

    default:
      return `You are Bob, a senior software architect AI.
File: ${filePath}, Issue: ${issue.type} (${issue.severity})

CODE:
${cappedCode}

Analyse and provide a fix.

${JSON_FORMAT}`;
  }
}


/**
 * Get fallback fix data when OpenAI is not available
 */
function getFallbackFix(issue) {
  const fallbacks = {
    dead_code: {
      bobExplanation:
        "Bob detected that this function is exported but has zero internal callers across the entire codebase. Dead exports inflate bundle size and mislead future developers into thinking this API surface is supported.",
      original: `// ${issue.symbol} — legacy compatibility shim\nfunction ${issue.symbol}(route) {\n  return route.replace(/^\\//, '').split('/');\n}\nmodule.exports.${issue.symbol} = ${issue.symbol};`,
      proposed: `// ${issue.symbol}() removed by CodeAtlas AI\n// Reason: zero internal callers detected across scanned files.\n// If external consumers depend on this export, add it back with a deprecation warning.`,
      confidence: 85,
    },
    missing_test: {
      bobExplanation:
        "Bob found that this function has critical logic but no test coverage. If this silently breaks, it could cause cascading failures with no clear error message.",
      original: `app.${issue.symbol} = function ${issue.symbol}() {\n  // Function implementation\n  if (!this._router) {\n    this._router = new Router();\n  }\n};`,
      proposed: `describe('${issue.symbol}', () => {\n  it('should initialize on first call', () => {\n    const app = express();\n    expect(app._router).toBeUndefined();\n    app.${issue.symbol}();\n    expect(app._router).toBeDefined();\n  });\n\n  it('should not reinitialize on subsequent calls', () => {\n    const app = express();\n    app.${issue.symbol}();\n    const router = app._router;\n    app.${issue.symbol}();\n    expect(app._router).toBe(router);\n  });\n});`,
      confidence: 88,
    },
    doc_gap: {
      bobExplanation:
        "Bob found that this is a public function with no JSDoc. Any developer using an IDE with IntelliSense will get zero autocomplete help on its parameters or return value — a friction point during onboarding.",
      original: `function ${issue.symbol}(app) {\n  return function expressInit(req, res, next) {\n    if (app.enabled('x-powered-by')) res.setHeader('X-Powered-By', 'Express');\n    req.res = res;\n    res.req = req;\n    next();\n  };\n}`,
      proposed: `/**\n * Initializes per-request Express metadata and optional X-Powered-By header.\n * @param {Object} app - The Express application instance.\n * @returns {Function} Express middleware function (req, res, next).\n */\nfunction ${issue.symbol}(app) {\n  return function expressInit(req, res, next) {\n    if (app.enabled('x-powered-by')) res.setHeader('X-Powered-By', 'Express');\n    req.res = res;\n    res.req = req;\n    next();\n  };\n}`,
      confidence: 95,
    },
  };

  return (
    fallbacks[issue.type] || {
      bobExplanation: "Fix generation unavailable. OpenAI API key not configured.",
      original: `// Original code for ${issue.symbol}`,
      proposed: `// Proposed fix for ${issue.symbol}`,
      confidence: 50,
    }
  );
}

/**
 * Extract a code snippet for a given file path and line number.
 * Tries the in-memory cachedRepoFiles first, then falls back to reading
 * directly from disk using repoPath (handles server-restart cache loss).
 *
 * @param {string} filePath   - Repo-relative path
 * @param {number|string} lineNumber - 1-based line number, or "-" / null
 * @param {string} [repoPath] - Absolute path to cloned repo root (disk fallback)
 * @returns {string}
 */
function extractCodeSnippet(filePath, lineNumber, repoPath) {
  // ── 1. Try in-memory cache ─────────────────────────────────────────────────
  let fileContent = null;

  if (cachedRepoFiles && Array.isArray(cachedRepoFiles.files)) {
    const cached = cachedRepoFiles.files.find((f) => f.path === filePath);
    if (cached) fileContent = cached.content;
  }

  // ── 2. Disk fallback (cache miss after server restart) ────────────────────
  if (!fileContent && repoPath) {
    try {
      fileContent = fs.readFileSync(path.join(repoPath, filePath), "utf-8");
    } catch (_) {
      // file unreadable — handled below
    }
  }

  if (!fileContent) {
    return `// Source unavailable for: ${filePath}\n// Re-analyse the repository to populate the code cache.`;
  }

  const lines = fileContent.split("\n");

  // No line number reported → show first 20 lines as a file preview
  if (!lineNumber || lineNumber === "-" || lineNumber === null) {
    const preview = lines.slice(0, 20).join("\n");
    return `// (No specific line — showing first 20 lines of ${filePath})\n${preview}`;
  }

  const idx   = Math.max(0, Number(lineNumber) - 1);
  const start = Math.max(0, idx - 5);
  const end   = Math.min(lines.length, idx + 6);
  const lineLabel = `// ${filePath}  (lines ${start + 1}–${end})`;
  return `${lineLabel}\n${lines.slice(start, end).join("\n")}`;
}

/**
 * Build a meaningful `proposed` string for a fix based on issue type and the
 * extracted original code snippet. No external API calls — pure string logic.
 *
 * @param {string} issueType - "dead_code" | "circular_dep" | "missing_test" | "doc_gap"
 * @param {string} symbol    - The reported symbol name (e.g. "parseOldRoute")
 * @param {string} filePath  - Repo-relative file path
 * @param {string} original  - The extracted code snippet from extractCodeSnippet()
 * @returns {string}
 */
function buildProposedFix(issueType, symbol, filePath, original) {
  // Strip the leading comment line that extractCodeSnippet prepends
  const codeOnly = original
    .split("\n")
    .filter((l) => !l.startsWith("// ") || l.startsWith("// TODO") || l.startsWith("// NOTE"))
    .join("\n")
    .trim();

  switch (issueType) {
    case "dead_code": {
      // Comment out every line of the dead code block with a removal note
      const commented = codeOnly
        .split("\n")
        .map((l) => `// ${l}`)
        .join("\n");
      return (
        `// ─── REMOVED BY CodeAtlas ───────────────────────────────────────\n` +
        `// Symbol '${symbol}' has no callers — safe to delete.\n` +
        `// Original code preserved below for reference:\n` +
        `//\n` +
        `${commented}\n` +
        `// ─────────────────────────────────────────────────────────────────`
      );
    }

    case "circular_dep": {
      // For circular deps the symbol field contains the full chain string
      const chain = symbol; // e.g. "a.js → b.js → a.js"
      return (
        `// ─── CIRCULAR DEPENDENCY DETECTED ───────────────────────────────\n` +
        `// Chain: ${chain}\n` +
        `//\n` +
        `// Suggested fix: introduce a shared module for the common logic\n` +
        `// and have both ends import from it instead of from each other.\n` +
        `//\n` +
        `// Example refactor:\n` +
        `//   shared/${symbol.split(" → ")[0].replace(/\//g, "-").replace(/\.[jt]sx?$/, "")}-shared.js\n` +
        `//     └─ export the shared function/constant\n` +
        `//   ${symbol.split(" → ")[0]}  → imports from shared module\n` +
        `//   ${symbol.split(" → ")[1] || "…"} → imports from shared module`
      );
    }

    case "doc_gap": {
      // Prepend a JSDoc template above the real code
      const jsdocTemplate =
        `/**\n` +
        ` * TODO: Describe what '${symbol}' does.\n` +
        ` *\n` +
        ` * @param {*} args - Describe parameters here\n` +
        ` * @returns {*} Describe the return value here\n` +
        ` */`;
      return `${jsdocTemplate}\n${codeOnly}`;
    }

    case "missing_test": {
      // Derive a human-readable test file name from the source path
      const baseName = filePath.split("/").pop().replace(/\.[jt]sx?$/, "");
      return (
        `// ─── SUGGESTED TEST FILE: ${baseName}.test.js ───────────────────\n` +
        `const { ${symbol} } = require("./${baseName}");\n` +
        `\n` +
        `describe("${symbol}", () => {\n` +
        `  it("should exist and be a function", () => {\n` +
        `    expect(typeof ${symbol}).toBe("function");\n` +
        `  });\n` +
        `\n` +
        `  it("should handle the happy path", () => {\n` +
        `    // TODO: arrange inputs, call ${symbol}(), assert the result\n` +
        `    // const result = ${symbol}(/* args */);\n` +
        `    // expect(result).toBe(/* expected */);\n` +
        `  });\n` +
        `\n` +
        `  it("should handle edge cases", () => {\n` +
        `    // TODO: test null/undefined inputs, boundary values, error paths\n` +
        `  });\n` +
        `});`
      );
    }

    default:
      return `// No automated fix template available for issue type: ${issueType}`;
  }
}

/**
 * Severity sort weight — lower number = higher priority.
 */
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * Build a specific, file-aware explanation for a fix.
 * This replaces the generic scanner description with a sentence that names
 * the actual file and symbol so every card reads differently.
 *
 * @param {string} type     - Issue type
 * @param {string} symbol   - Reported symbol (or "entire file")
 * @param {string} filePath - Repo-relative file path
 * @param {string} severity - "high" | "medium" | "low"
 * @returns {string}
 */
function buildBobExplanation(type, symbol, filePath, severity) {
  const file = filePath.split("/").pop(); // just the filename for readability

  switch (type) {
    case "dead_code":
      return (
        `\`${filePath}\` is never imported by any other module in this repository — ` +
        `it's a completely orphaned file. Nothing depends on it, so deleting it ` +
        `won't break anything. Keeping it around only adds confusion for anyone ` +
        `trying to understand the codebase structure.`
      );

    case "circular_dep": {
      // symbol holds the full chain, e.g. "a.js → b.js → a.js"
      const parts = symbol.split(" → ");
      const first = parts[0] ? parts[0].split("/").pop() : filePath;
      const second = parts[1] ? parts[1].split("/").pop() : "another module";
      return (
        `\`${first}\` and \`${second}\` form a circular import chain. ` +
        `Circular dependencies cause unpredictable initialisation order — one ` +
        `module may see an incomplete version of the other at startup. They also ` +
        `prevent bundlers from tree-shaking dead code and make unit testing harder.`
      );
    }

    case "missing_test":
      return (
        `\`${symbol}\` inside \`${file}\` has no test file associated with it. ` +
        `If this code breaks silently — due to a refactor or a dependency upgrade — ` +
        `there's nothing to catch it before it reaches production. ` +
        `${severity === "high" ? "This path is marked HIGH risk, meaning it is likely business-critical logic." : "Adding even a basic smoke test will significantly improve reliability."}`
      );

    case "doc_gap":
      return (
        `\`${symbol}\` is exported from \`${file}\` but has no JSDoc comment. ` +
        `Any developer using an IDE will get zero autocomplete or parameter hints ` +
        `when calling this function — a friction point during onboarding and code review. ` +
        `Adding a /** ... */ block takes minutes and pays off indefinitely.`
      );

    default:
      return `Issue detected in \`${filePath}\` (${type}, ${severity} severity): see the diff below for details.`;
  }
}

/**
 * Generate fix objects from health scan issues.
 *
 * Selection: up to 3 per category, sorted high → medium → low.
 * Each fix uses real extracted code. AI is called per-issue;
 * templates are used as fallback when AI is unavailable or fails.
 *
 * @param {Object} healthScanData - Output of runHealthScan()
 * @param {string} repoPath       - Absolute path to the cloned repo (for disk fallback)
 */
async function generateAllFixes(healthScanData, repoPath) {
  console.log(
    `[${new Date().toISOString()}] Generating fixes (up to 3/category, AI + template fallback)...`,
  );

  // ── Step 1: Flatten all issues ────────────────────────────────────────────
  const allIssues = [];
  for (const file of healthScanData.files) {
    for (const issue of file.issues) {
      allIssues.push({ ...issue, filePath: file.path });
    }
  }

  // ── Step 2: Group by type ─────────────────────────────────────────────────
  const TYPES = ["dead_code", "circular_dep", "missing_test", "doc_gap"];
  const grouped = {};
  for (const type of TYPES) {
    grouped[type] = allIssues.filter((i) => i.type === type);
  }

  // ── Step 3: Sort each group high → medium → low ───────────────────────────
  for (const type of TYPES) {
    grouped[type].sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
    );
  }

  // ── Step 4: Take up to 3 per group, call AI, fall back to templates ───────
  const MAX_PER_CATEGORY = 3;
  const fixes = [];
  let fixIndex = 0;

  for (const type of TYPES) {
    const selected = grouped[type].slice(0, MAX_PER_CATEGORY);

    for (const issue of selected) {
      fixIndex++;

      // Real code from cache or disk
      const original = extractCodeSnippet(issue.filePath, issue.line, repoPath);

      // Try AI first
      let bobExplanation, proposed;
      const aiResult = await generateFixWithGPT(issue, original);

      if (aiResult) {
        bobExplanation = aiResult.bobExplanation;
        proposed       = aiResult.proposed;
        console.log(`[${new Date().toISOString()}] ✓ AI fix: ${issue.type} → ${issue.filePath}`);
      } else {
        // Template fallback
        proposed       = buildProposedFix(issue.type, issue.symbol || "unknown", issue.filePath, original);
        bobExplanation = buildBobExplanation(issue.type, issue.symbol || "unknown", issue.filePath, issue.severity);
        console.log(`[${new Date().toISOString()}] ↩ Template fallback: ${issue.type} → ${issue.filePath}`);
      }

      fixes.push({
        id:               `fix-${fixIndex}`,
        file:             issue.filePath,
        issueType:        issue.type,
        severity:         issue.severity,
        symbol:           issue.symbol || "unknown",
        line:             issue.line || "-",
        issueDescription: issue.description,
        status:           "pending",
        original,
        proposed,
        bobExplanation,
      });
    }
  }

  console.log(
    `[${new Date().toISOString()}] Generated ${fixes.length} fixes — ` +
      TYPES.map((t) => `${t}: ${grouped[t].slice(0, MAX_PER_CATEGORY).length}`).join(", "),
  );

  return fixes;
}

/**
 * Regenerate a specific fix with user feedback using GPT
 */
async function regenerateFixWithFeedback(fix, feedback) {
  if (!isOpenAIConfigured()) {
    // Fallback: just prepend feedback to explanation
    return {
      ...fix,
      bobExplanation: `[Updated with your feedback: "${feedback}"] ${fix.bobExplanation}`,
      status: "pending",
    };
  }

  try {
    const prompt = `You are Bob, an expert software architect AI. A developer has requested modifications to a code fix.

Original Fix:
File: ${fix.file}
Issue Type: ${fix.issueType}
Severity: ${fix.severity}
Line: ${fix.line}

Current Explanation: ${fix.bobExplanation}
Current Original Code: ${fix.original}
Current Proposed Fix: ${fix.proposed}
Current Confidence: ${fix.confidence}%

Developer Feedback: "${feedback}"

Please regenerate the fix incorporating the developer's feedback. Respond with ONLY a JSON object (no markdown, no backticks):
{
  "bobExplanation": "updated explanation incorporating feedback",
  "original": "original code (may be same or updated)",
  "proposed": "updated proposed fix based on feedback",
  "confidence": 90
}`;

    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are Bob, an expert software architect AI. Regenerate code fixes based on developer feedback. Return only JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.4,
        max_tokens: 1200,
      }),
    });

    if (!response.ok) {
      console.error(
        `[${new Date().toISOString()}] OpenAI API error during regeneration: ${response.status}`,
      );
      // Fallback
      return {
        ...fix,
        bobExplanation: `[Updated with your feedback: "${feedback}"] ${fix.bobExplanation}`,
        status: "pending",
      };
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("Empty response from OpenAI");
    }

    const parsed = JSON.parse(content);

    return {
      ...fix,
      bobExplanation: parsed.bobExplanation,
      original: parsed.original,
      proposed: parsed.proposed,
      confidence: parsed.confidence,
      status: "pending",
    };
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error regenerating fix with GPT:`,
      error.message,
    );
    // Fallback
    return {
      ...fix,
      bobExplanation: `[Updated with your feedback: "${feedback}"] ${fix.bobExplanation}`,
      status: "pending",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy hardcoded fixes state - DEPRECATED, kept for reference only
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

  // Verify the path actually exists on disk
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({
      error: "Repository path not found",
      message: `No directory exists at: ${repoPath}. Re-analyse the repository to get a fresh path.`,
    });
  }

  try {
    console.log(
      `[${new Date().toISOString()}] POST /api/health-scan — path: ${repoPath}`,
    );

    // Run all 3 scanners in parallel via the orchestrator
    const scanResult = await runHealthScan(repoPath);

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
app.get("/api/fixes", async (req, res) => {
  try {
    const { repoPath } = req.query;

    // Validate repoPath
    if (!repoPath) {
      return res.status(400).json({
        error: "repoPath is required",
        message: "Provide repoPath as a query parameter (e.g., /api/fixes?repoPath=/path/to/repo)",
      });
    }

    // Verify the path exists
    if (!fs.existsSync(repoPath)) {
      return res.status(404).json({
        error: "Repository path not found",
        message: `No directory exists at: ${repoPath}`,
      });
    }

    console.log(
      `[${new Date().toISOString()}] GET /api/fixes — generating fixes for: ${repoPath}`,
    );

    // Run health scan to get real issues
    const healthScanData = await runHealthScan(repoPath);

    // Generate fixes from the health scan data — pass repoPath for disk fallback
    fixesCache = await generateAllFixes(healthScanData, repoPath);
    cacheTimestamp = new Date().toISOString();

    res.json({
      fixes: fixesCache,
      metadata: {
        generatedAt: cacheTimestamp,
        totalFixes: fixesCache.length,
        byType: {
          dead_code: fixesCache.filter((f) => f.issueType === "dead_code")
            .length,
          missing_test: fixesCache.filter(
            (f) => f.issueType === "missing_test",
          ).length,
          doc_gap: fixesCache.filter((f) => f.issueType === "doc_gap").length,
          circular_dep: fixesCache.filter((f) => f.issueType === "circular_dep").length,
        },
        repository: repoPath,
        aiProvider: isOpenAIConfigured() ? "OpenAI GPT" : "Fallback Data",
      },
    });
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in GET /api/fixes:`,
      error.message,
    );
    res.status(500).json({
      error: "Failed to generate fixes",
      message: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fixes/:id/decision
// fixes.html calls this on Approve / Reject / Modify
// Body: { decision: "approved" | "rejected" | "modified", feedback?: string }
// Returns: the updated fix object (fixes.html uses the return value directly)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/fixes/:id/decision", async (req, res) => {
  const { id } = req.params;
  const { decision, feedback } = req.body;

  if (!["approved", "rejected", "modified"].includes(decision))
    return res
      .status(400)
      .json({ error: "decision must be: approved | rejected | modified" });

  // Ensure fixes are loaded
  if (!fixesCache) {
    return res.status(400).json({
      error: "No fixes available. Call GET /api/fixes first.",
    });
  }

  const fix = fixesCache.find((f) => f.id === id);
  if (!fix) return res.status(404).json({ error: `Fix '${id}' not found` });

  try {
    if (decision === "modified" && feedback) {
      console.log(
        `[${new Date().toISOString()}] Regenerating fix ${id} with feedback: "${feedback}"`,
      );

      // Regenerate fix using GPT with user feedback
      const updatedFix = await regenerateFixWithFeedback(fix, feedback);

      // Update the fix in cache
      const index = fixesCache.findIndex((f) => f.id === id);
      if (index !== -1) {
        fixesCache[index] = updatedFix;
      }

      auditLog.push({
        timestamp: new Date().toISOString(),
        action: "FIX_REGENERATED",
        bobCapability: "Bob: Human-in-the-Loop",
        file: fix.file,
        note: `Regenerated fix for ${fix.issueType} based on user feedback: "${feedback.substring(0, 50)}${feedback.length > 50 ? "..." : ""}"`,
      });

      res.json(updatedFix);
    } else {
      // Approve or reject
      fix.status = decision; // "approved" or "rejected"
      auditLog.push({
        timestamp: new Date().toISOString(),
        action: decision === "approved" ? "COMMIT" : "SKIPPED",
        bobCapability: "Bob: Human-in-the-Loop",
        file: fix.file,
        note: `User ${decision} the ${fix.issueType} fix in ${fix.file} (${fix.severity} severity)`,
      });

      res.json(fix);
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in POST /api/fixes/:id/decision:`,
      error.message,
    );
    res.status(500).json({
      error: "Failed to process decision",
      message: error.message,
    });
  }
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
  if (!fixesCache) {
    return res.status(400).json({
      error: "No fixes available. Call GET /api/fixes first.",
    });
  }

  const approved = fixesCache.filter((f) => f.status === "approved");
  const rejected = fixesCache.filter((f) => f.status === "rejected");
  const pending = fixesCache.filter((f) => f.status === "pending");

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
      totalFound: fixesCache.length,
      approved: approved.length,
      rejected: rejected.length,
      pending: pending.length,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-pr (Legacy endpoint - kept for backward compatibility)
// apply.html calls this after Apply — opens a PR URL in a new tab
// Returns: { success, prUrl, prNumber, title, body }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/create-pr", (req, res) => {
  if (!fixesCache) {
    return res.status(400).json({
      error: "No fixes available.",
    });
  }

  const approved = fixesCache.filter((f) => f.status === "approved");

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
