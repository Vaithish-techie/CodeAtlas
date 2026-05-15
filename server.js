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

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
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
