const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");

// Load environment variables
require("dotenv").config();

const app = express();
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY || "");
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.post("/api/ingest", (req, res) => {
  const { repoUrl } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: "repoUrl is required" });
  }

  // 1. Strict URL Sanitization to prevent Command Injection
  const githubRegex = /^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+$/;
  if (!githubRegex.test(repoUrl)) {
    return res.status(400).json({ error: "Invalid strictly formatted GitHub repository URL" });
  }

  // 3. Cloud-Safe Temp Storage (Guaranteed /tmp partition with UUID)
  const tmpBase = os.tmpdir() === '/' ? '/tmp' : os.tmpdir();
  const tmpDir = path.join(tmpBase, `repotour-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`[${new Date().toISOString()}] Starting analysis of ${repoUrl}`);
  console.log(`[${new Date().toISOString()}] Allocated temporary directory: ${tmpDir}`);

  try {
    console.log(`[${new Date().toISOString()}] Cloning repository...`);
    
    // 2. Process Timeouts (45 seconds strict limit)
    try {
      execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, {
        stdio: "ignore",
        timeout: 45000, 
      });
    } catch (cloneErr) {
      if (cloneErr.code === 'ETIMEDOUT' || cloneErr.signal === 'SIGTERM') {
        return res.status(408).json({ error: "Repository clone timed out after 45 seconds. The repository is too large." });
      }
      throw cloneErr; // Let the general error handler catch authentication/not-found issues
    }

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
    console.log(`[${new Date().toISOString()}] Found ${fileMap.size} files to analyze`);

    // Cognitive Complexity Scoring Function
    function computeCognitiveComplexity(fileContent) {
      // Count branching keywords
      const branchingPatterns = [
        /\bif\s*\(/g,
        /\belse\b/g,
        /\bfor\s*\(/g,
        /\bwhile\s*\(/g,
        /\bswitch\s*\(/g,
        /\bcatch\s*\(/g,
        /&&/g,
        /\|\|/g,
        /\?[^:]*:/g, // ternary operator
      ];

      let branchCount = 0;
      branchingPatterns.forEach((pattern) => {
        const matches = fileContent.match(pattern);
        branchCount += matches ? matches.length : 0;
      });

      // Compute max nesting depth by tracking { and }
      let nestingDepth = 0;
      let maxNestingDepth = 0;
      for (let char of fileContent) {
        if (char === "{") {
          nestingDepth++;
          maxNestingDepth = Math.max(maxNestingDepth, nestingDepth);
        } else if (char === "}") {
          nestingDepth--;
        }
      }

      // Count function definitions
      const functionPatterns = [
        /\bfunction\s+\w+\s*\(/g,
        /\bfunction\s*\(/g,
        /=>\s*{/g,
        /=>\s*\(/g,
        /\.then\s*\(/g,
        /\.catch\s*\(/g,
      ];

      let functionCount = 0;
      functionPatterns.forEach((pattern) => {
        const matches = fileContent.match(pattern);
        functionCount += matches ? matches.length : 0;
      });

      // Count TODO/FIXME/HACK comments
      const todoPatterns = [
        /\/\/\s*TODO/gi,
        /\/\/\s*FIXME/gi,
        /\/\/\s*HACK/gi,
        /\/\*[\s\S]*?TODO[\s\S]*?\*\//gi,
        /\/\*[\s\S]*?FIXME[\s\S]*?\*\//gi,
        /\/\*[\s\S]*?HACK[\s\S]*?\*\//gi,
      ];

      let todoCount = 0;
      todoPatterns.forEach((pattern) => {
        const matches = fileContent.match(pattern);
        todoCount += matches ? matches.length : 0;
      });

      // Count total lines
      const lineCount = fileContent.split("\n").length;

      // Compute weighted score (0-100)
      const score = Math.min(
        100,
        branchCount * 2 +
          maxNestingDepth * 5 +
          todoCount * 8 +
          Math.floor(lineCount / 10),
      );

      return {
        score,
        breakdown: {
          branchCount,
          nestingDepth: maxNestingDepth,
          functionCount,
          todoCount,
          lineCount,
        },
      };
    }

    const importRegex =
      /(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g;

    console.log(`[${new Date().toISOString()}] Extracting dependencies...`);
    let totalLinks = 0;

    for (const [relPath, nodeData] of fileMap.entries()) {
      let content;
      try {
        content = fs.readFileSync(nodeData.fullPath, "utf-8");
      } catch (err) {
        // If we can't read the file, add node without complexity data
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

      // Compute cognitive complexity
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

    // Return nodes, links, and the temp directory path
    res.json({ nodes, links, repoPath: tmpDir });
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
    } else if (error.message.includes("Authentication")) {
      errorMessage = "Repository is private or requires authentication.";
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    // 4. Failsafe Teardown: Guarantee disk space is freed
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
        console.log(`[${new Date().toISOString()}] Cleaned up temporary directory: ${tmpDir}`);
      }
    } catch (cleanupErr) {
      console.error(`[${new Date().toISOString()}] CRITICAL: Failed to clean up ${tmpDir}`, cleanupErr.message);
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

// File Summary Endpoint - AI-powered file analysis using Gemini
app.post("/api/file-summary", async (req, res) => {
  const { repoPath, filePath } = req.body;

  if (!repoPath || !filePath) {
    return res.status(400).json({
      error: "Both repoPath and filePath are required",
    });
  }

  // Check if Gemini API key is configured
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "[WARNING] GEMINI_API_KEY not configured, returning mock response",
    );
    return res.json({
      summary:
        "This is a mock summary. Configure GEMINI_API_KEY to enable AI analysis.",
      mainFunctions: ["mockFunction1", "mockFunction2", "mockFunction3"],
      role: "utility",
      riskNote:
        "Unable to analyze - API key not configured. This is a fallback response.",
    });
  }

  try {
    // Read the file content
    const fullPath = path.join(repoPath, filePath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({
        error: "File not found at the specified path",
      });
    }

    const fileContent = fs.readFileSync(fullPath, "utf-8");

    // Prepare the prompt for Gemini
    const systemPrompt = `You are a senior software architect. Analyse this file and respond with ONLY a JSON object (no markdown, no backticks) with these fields:
{
  "summary": "2 sentence plain English explanation of what this file does",
  "mainFunctions": ["list", "of", "top", "3-5", "function or component names"],
  "role": "one of: entry-point | service | utility | component | config | test | model",
  "riskNote": "one sentence about the biggest maintainability risk in this file, or null if none"
}`;

    const userPrompt = `File: ${filePath}\n\nContent:\n${fileContent.substring(0, 8000)}`; // Limit to 8000 chars

    // Call Gemini API
    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `${systemPrompt}\n\n${userPrompt}`,
    });
    const responseText = result.text;

    // Try to parse the JSON response
    let parsedResponse;
    try {
      // Remove markdown code blocks if present
      const cleanedText = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsedResponse = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error("Failed to parse Gemini response:", responseText);
      throw new Error("Invalid JSON response from AI");
    }

    // Validate response structure
    if (
      !parsedResponse.summary ||
      !parsedResponse.mainFunctions ||
      !parsedResponse.role
    ) {
      throw new Error("Incomplete response from AI");
    }

    res.json(parsedResponse);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in file-summary:`,
      error.message,
    );

    // Return graceful fallback response
    res.json({
      summary:
        "Unable to generate AI summary at this time. The file appears to be a code module with standard functionality.",
      mainFunctions: ["(analysis unavailable)"],
      role: "utility",
      riskNote: "AI analysis temporarily unavailable. Please try again later.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyze-file
// Real Gemini-powered analysis: returns { aiSummary, complexityReason }
// Body: { repoPath: string, filePath: string }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/analyze-file", async (req, res) => {
  const { repoPath, filePath } = req.body;

  // ── Validate required fields ──────────────────────────────────────────────
  if (!repoPath || !filePath) {
    return res.status(400).json({
      error: "Both repoPath and filePath are required.",
    });
  }

  // ── Security: prevent path traversal ─────────────────────────────────────
  // Resolve the absolute target and confirm it is still inside repoPath
  const safeRepo = path.resolve(repoPath);
  const safeTarget = path.resolve(safeRepo, filePath);
  if (!safeTarget.startsWith(safeRepo + path.sep) && safeTarget !== safeRepo) {
    return res.status(403).json({ error: "Access denied: path traversal detected." });
  }

  // ── Check API key ─────────────────────────────────────────────────────────
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "GEMINI_API_KEY is not configured on the server.",
    });
  }

  try {
    // ── Read file ──────────────────────────────────────────────────────────
    if (!fs.existsSync(safeTarget)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const stat = fs.statSync(safeTarget);
    const MAX_BYTES = 50 * 1024; // 50 KB hard cap
    if (stat.size > MAX_BYTES) {
      return res.status(413).json({
        error: `File is too large for analysis (${(stat.size / 1024).toFixed(1)} KB). Limit is 50 KB.`,
      });
    }

    const rawContent = fs.readFileSync(safeTarget, "utf-8");

    console.log(
      `[${new Date().toISOString()}] /api/analyze-file → ${filePath} (${stat.size} bytes)`,
    );

    // ── Build Gemini prompt ────────────────────────────────────────────────
    const SYSTEM_PROMPT =
      "You are an expert MERN stack architect. Read the provided file content. " +
      "Return ONLY a JSON object with two keys: " +
      "'aiSummary' (a 2-sentence explanation of what this file actually does in the system) " +
      "and 'complexityReason' (a 1-sentence explanation of why this file might be complex, " +
      "referencing specific things like deep nesting, large switch statements, or heavy DB usage).";

    const USER_PROMPT =
      `File path: ${filePath}\n\n` +
      `Content:\n${rawContent.substring(0, 12000)}`; // ~3k tokens max

    // ── Call Gemini ────────────────────────────────────────────────────────
    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `${SYSTEM_PROMPT}\n\n${USER_PROMPT}`,
    });

    const rawText = (result.text || "").trim();

    // ── Parse JSON response ────────────────────────────────────────────────
    // Gemini sometimes wraps output in markdown fences — strip them
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error(`[${new Date().toISOString()}] Gemini returned non-JSON:\n${rawText}`);
      return res.status(502).json({
        error: "AI returned an unexpected format. Please try again.",
        raw: rawText.substring(0, 300), // partial preview for debugging
      });
    }

    // ── Validate shape ─────────────────────────────────────────────────────
    if (typeof parsed.aiSummary !== "string" || typeof parsed.complexityReason !== "string") {
      return res.status(502).json({
        error: "AI response is missing required fields (aiSummary, complexityReason).",
      });
    }

    console.log(`[${new Date().toISOString()}] /api/analyze-file → success for ${filePath}`);

    return res.json({
      aiSummary: parsed.aiSummary.trim(),
      complexityReason: parsed.complexityReason.trim(),
      filePath,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /api/analyze-file error:`, err.message);

    // Surface a clean error — never leak full stack to client
    return res.status(500).json({
      error: "AI analysis failed. Please try again in a moment.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/blast-refactor
// Agentic multi-file refactoring tool.
// Body: { repoPath: string, targetFile: string, dependentFiles: string[], instruction: string }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/blast-refactor", async (req, res) => {
  const { repoPath, targetFile, dependentFiles, instruction } = req.body;

  if (!repoPath || !targetFile || !Array.isArray(dependentFiles) || !instruction) {
    return res.status(400).json({
      error: "Missing required fields: repoPath, targetFile, dependentFiles (array), or instruction.",
    });
  }

  // Security: Prevent path traversal
  const safeRepo = path.resolve(repoPath);
  
  const resolveSafe = (filePath) => {
    const safeTarget = path.resolve(safeRepo, filePath);
    if (!safeTarget.startsWith(safeRepo + path.sep) && safeTarget !== safeRepo) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    return safeTarget;
  };

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "GEMINI_API_KEY is not configured." });
  }

  try {
    const allFiles = [targetFile, ...dependentFiles];
    let combinedContent = "";

    // Read all files securely
    for (const filePath of allFiles) {
      const absolutePath = resolveSafe(filePath);
      if (!fs.existsSync(absolutePath)) {
        console.warn(`[WARNING] File not found for refactor: ${filePath}`);
        continue;
      }
      
      const stat = fs.statSync(absolutePath);
      // Skip excessively large files to avoid blowing up the token window
      if (stat.size > 80 * 1024) {
        console.warn(`[WARNING] Skipping large file: ${filePath} (${stat.size} bytes)`);
        continue;
      }

      const content = fs.readFileSync(absolutePath, "utf-8");
      combinedContent += `\n--- BEGIN FILE: ${filePath} ---\n${content}\n--- END FILE: ${filePath} ---\n`;
    }

    if (!combinedContent) {
      return res.status(400).json({ error: "No valid files could be read for refactoring." });
    }

    // Prepare Prompt
    const SYSTEM_PROMPT = `You are an Agentic Refactoring Engine. The user is modifying a core file. You must rewrite the core file based on their instruction, AND you must rewrite all dependent files so they do not break. Output ONLY a valid JSON object.
The JSON object MUST follow this exact format:
{
  "files": [
    {
      "path": "path/to/file.js",
      "newCode": "the complete rewritten code for this file"
    }
  ]
}
Do not include any markdown fences outside the JSON object. Do not explain your changes. Only output the JSON.`;

    const USER_PROMPT = `Target File to Refactor: ${targetFile}
Dependent Files that might need updates: ${dependentFiles.join(", ")}
User Instruction: ${instruction}

File Contents:
${combinedContent}`;

    // Call Gemini API
    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `${SYSTEM_PROMPT}\n\n${USER_PROMPT}`,
      config: {
          temperature: 0.2
      }
    });

    const rawText = (result.text || "").trim();

    // Parse Response
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error(`[${new Date().toISOString()}] Failed to parse refactor JSON:\n${rawText}`);
      return res.status(502).json({ error: "Failed to parse AI output. Please try again." });
    }

    if (!parsed.files || !Array.isArray(parsed.files)) {
      return res.status(502).json({ error: "AI output is missing the 'files' array." });
    }

    console.log(`[${new Date().toISOString()}] /api/blast-refactor → Success for ${targetFile} (${parsed.files.length} files updated)`);
    
    return res.json({ files: parsed.files });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] /api/blast-refactor error:`, err.message);
    return res.status(500).json({
      error: err.message.includes("Path traversal") ? err.message : "Refactoring failed due to a server error.",
    });
  }
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
