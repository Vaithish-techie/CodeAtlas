const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
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

    // Return nodes, links, and the temp directory path for AI analysis
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
    } else if (error.message.includes("timeout")) {
      errorMessage =
        "Repository clone timed out. The repository may be too large.";
    } else if (error.message.includes("Authentication")) {
      errorMessage = "Repository is private or requires authentication.";
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    // Note: We're NOT cleaning up tmpDir immediately anymore
    // It needs to persist for AI file analysis via /api/file-summary
    // In production, implement a cleanup job that removes directories older than 1 hour
    console.log(
      `[${new Date().toISOString()}] Temporary directory preserved for AI analysis: ${tmpDir}`,
    );
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
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
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
