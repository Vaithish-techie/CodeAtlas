// ─────────────────────────────────────────────────────────────────────────────
// GitHub OAuth Routes - Add these to server.js before app.listen()
// ─────────────────────────────────────────────────────────────────────────────

// Step 1: Redirect to GitHub OAuth
app.get("/auth/github", (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(503).send(`
      <html>
        <head><title>GitHub OAuth Not Configured</title></head>
        <body style="font-family: system-ui; padding: 2rem; background: #0a0e1a; color: #e2e8f0;">
          <h1>⚠️ GitHub OAuth Not Configured</h1>
          <p>Please set the following environment variables in your <code>.env</code> file:</p>
          <pre style="background: #1a1f35; padding: 1rem; border-radius: 8px; border: 1px solid #6366f1;">
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback
          </pre>
          <p><a href="https://github.com/settings/developers" style="color: #6366f1;">Create a GitHub OAuth App</a></p>
          <p><a href="/" style="color: #6366f1;">← Back to Home</a></p>
        </body>
      </html>
    `);
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_CALLBACK_URL)}&scope=repo,user&state=${state}`;

  res.redirect(githubAuthUrl);
});

// Step 2: GitHub OAuth Callback
app.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;

  // Verify state to prevent CSRF
  if (!state || state !== req.session.oauthState) {
    return res.status(403).send("Invalid OAuth state. Possible CSRF attack.");
  }

  if (!code) {
    return res.status(400).send("No authorization code received from GitHub.");
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: GITHUB_CALLBACK_URL,
        }),
      },
    );

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error("GitHub OAuth error:", tokenData);
      return res
        .status(400)
        .send(
          `GitHub OAuth error: ${tokenData.error_description || tokenData.error}`,
        );
    }

    const accessToken = tokenData.access_token;

    // Fetch user info
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const userData = await userResponse.json();

    // Store in session
    req.session.githubToken = accessToken;
    req.session.githubUser = {
      login: userData.login,
      name: userData.name,
      avatar_url: userData.avatar_url,
      id: userData.id,
    };

    console.log(
      `[${new Date().toISOString()}] GitHub OAuth successful: ${userData.login}`,
    );

    // Redirect to landing page with success message
    res.send(`
      <html>
        <head>
          <title>GitHub Connected</title>
          <style>
            body {
              font-family: system-ui, sans-serif;
              background: linear-gradient(135deg, #0a0e1a 0%, #1a1f35 100%);
              color: #e2e8f0;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .card {
              background: rgba(15, 23, 42, 0.8);
              border: 1px solid rgba(99, 102, 241, 0.3);
              border-radius: 16px;
              padding: 3rem;
              text-align: center;
              max-width: 500px;
            }
            h1 { color: #22c55e; margin-bottom: 1rem; }
            .avatar { width: 80px; height: 80px; border-radius: 50%; margin: 1rem 0; }
            .btn {
              display: inline-block;
              margin-top: 2rem;
              padding: 1rem 2rem;
              background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✅ GitHub Connected!</h1>
            <img src="${userData.avatar_url}" alt="${userData.login}" class="avatar" />
            <p>Welcome, <strong>${userData.name || userData.login}</strong>!</p>
            <p>You can now create pull requests directly from CodeAtlas.</p>
            <a href="/landing.html" class="btn">Continue to CodeAtlas</a>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("GitHub OAuth error:", error);
    res
      .status(500)
      .send("Failed to authenticate with GitHub. Please try again.");
  }
});

// Check authentication status
app.get("/api/auth/status", (req, res) => {
  if (req.session.githubToken && req.session.githubUser) {
    res.json({
      authenticated: true,
      user: req.session.githubUser,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to logout" });
    }
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-pr — Create Pull Request with Modified Files
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/create-pr", async (req, res) => {
  const { repoUrl, files, prTitle, prBody } = req.body;

  // Validate authentication
  if (!req.session.githubToken) {
    return res.status(401).json({
      error: "Not authenticated. Please connect your GitHub account first.",
      redirectTo: "/auth/github",
    });
  }

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
    // Initialize Octokit with user's token
    const octokit = new Octokit({
      auth: req.session.githubToken,
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

// Made with Bob
