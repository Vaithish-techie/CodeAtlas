# GitHub Integration & Landing Page Setup Guide

This guide covers the new GitHub OAuth authentication and Pull Request creation features added to CodeAtlas.

## 🎯 New Features

### 1. **Landing Page** (`/landing.html`)

- Modern, dark-themed developer landing page
- Hero section with GitHub repo URL input
- Feature showcase grid
- Supported ecosystems display (JS, TS, JSX, TSX)
- GitHub OAuth connection button

### 2. **GitHub OAuth Authentication**

- Secure OAuth 2.0 flow
- Session-based authentication
- User profile storage
- Auto-redirect after successful login

### 3. **Pull Request Creation Engine** (`POST /api/create-pr`)

- Automated PR creation from modified files
- Branch creation with timestamp
- Commit creation with custom messages
- Full GitHub API integration via Octokit

## 📋 Prerequisites

1. **Node.js** >= 14.0.0
2. **GitHub OAuth App** (create at https://github.com/settings/developers)
3. **Gemini API Key** (for AI features)

## 🔧 Setup Instructions

### Step 1: Install Dependencies

The required packages are already added to `package.json`:

- `express-session` - Session management
- `@octokit/rest` - GitHub API client

They were installed via:

```bash
npm install express-session @octokit/rest
```

### Step 2: Create GitHub OAuth App

1. Go to https://github.com/settings/developers
2. Click **"New OAuth App"**
3. Fill in the details:
   - **Application name**: CodeAtlas
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
4. Click **"Register application"**
5. Copy the **Client ID** and generate a **Client Secret**

### Step 3: Configure Environment Variables

Create a `.env` file in the project root (use `.env.example` as template):

```env
# Gemini AI Configuration
GEMINI_API_KEY=your_actual_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

# GitHub OAuth Configuration
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

# Session Secret (generate a random string)
SESSION_SECRET=generate_a_random_32_character_string

# Server Configuration
PORT=3000
NODE_ENV=development
```

**Generate a secure session secret:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Start the Server

```bash
npm start
```

The server will start on `http://localhost:3000`

## 🚀 Usage Guide

### Accessing the Landing Page

Navigate to: `http://localhost:3000/landing.html`

### Connecting GitHub Account

1. Click **"Connect to GitHub"** button
2. Authorize CodeAtlas to access your repositories
3. You'll be redirected back with a success message

### Creating a Pull Request

Use the `/api/create-pr` endpoint:

```javascript
const response = await fetch("/api/create-pr", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    repoUrl: "https://github.com/username/repo",
    files: [
      {
        path: "src/utils.js",
        content: "// Updated file content here",
      },
      {
        path: "src/config.js",
        content: "// Another updated file",
      },
    ],
    prTitle: "✨ CodeAtlas Auto-Refactor",
    prBody: "Optional custom PR description",
  }),
});

const result = await response.json();
console.log("PR created:", result.pullRequest.url);
```

### Response Format

**Success (200):**

```json
{
  "success": true,
  "pullRequest": {
    "number": 42,
    "url": "https://github.com/username/repo/pull/42",
    "title": "✨ CodeAtlas Auto-Refactor",
    "branch": "codeatlas-refactor-1234567890"
  }
}
```

**Error (401 - Not Authenticated):**

```json
{
  "error": "Not authenticated. Please connect your GitHub account first.",
  "redirectTo": "/auth/github"
}
```

**Error (403 - Insufficient Permissions):**

```json
{
  "error": "Insufficient permissions. Make sure you have write access to this repository."
}
```

## 🔐 Security Features

1. **CSRF Protection**: OAuth state parameter validation
2. **Session Security**: HTTP-only cookies, secure flag in production
3. **Token Storage**: GitHub access tokens stored in server-side sessions
4. **Scope Limitation**: Only requests `repo` and `user` scopes

## 📡 API Endpoints

### Authentication Endpoints

| Endpoint                | Method | Description                 |
| ----------------------- | ------ | --------------------------- |
| `/auth/github`          | GET    | Initiates GitHub OAuth flow |
| `/auth/github/callback` | GET    | OAuth callback handler      |
| `/api/auth/status`      | GET    | Check authentication status |
| `/api/auth/logout`      | POST   | Destroy session and logout  |

### Pull Request Endpoint

| Endpoint         | Method | Auth Required | Description                   |
| ---------------- | ------ | ------------- | ----------------------------- |
| `/api/create-pr` | POST   | ✅ Yes        | Create PR with modified files |

## 🎨 Frontend Integration Example

```javascript
// Check if user is authenticated
async function checkAuth() {
  const res = await fetch("/api/auth/status");
  const data = await res.json();

  if (data.authenticated) {
    console.log("Logged in as:", data.user.login);
    // Show PR creation UI
  } else {
    // Show "Connect GitHub" button
  }
}

// Create a pull request
async function createPR(repoUrl, modifiedFiles) {
  try {
    const res = await fetch("/api/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl,
        files: modifiedFiles,
        prTitle: "✨ CodeAtlas Auto-Refactor",
      }),
    });

    const data = await res.json();

    if (data.success) {
      alert(`PR created! ${data.pullRequest.url}`);
      window.open(data.pullRequest.url, "_blank");
    } else if (data.redirectTo) {
      // Not authenticated, redirect to OAuth
      window.location.href = data.redirectTo;
    }
  } catch (error) {
    console.error("PR creation failed:", error);
  }
}
```

## 🐛 Troubleshooting

### "GitHub OAuth Not Configured" Error

**Cause**: Missing `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` in `.env`

**Solution**:

1. Create a GitHub OAuth App
2. Add credentials to `.env` file
3. Restart the server

### "Invalid OAuth state" Error

**Cause**: Session expired or CSRF attack detected

**Solution**: Clear cookies and try authenticating again

### "Insufficient permissions" Error

**Cause**: User doesn't have write access to the repository

**Solution**:

1. Ensure you're the repo owner or have write permissions
2. Check if the repository is private and you have access

### PR Creation Fails with 404

**Cause**: Repository not found or invalid URL

**Solution**: Verify the GitHub URL format: `https://github.com/owner/repo`

## 📝 File Structure

```
CodeAtlas/
├── server.js                          # Main server with OAuth routes
├── public/
│   ├── landing.html                   # New landing page
│   ├── index.html                     # Main app (architecture map)
│   └── health.html                    # Health scan dashboard
├── .env                               # Environment variables (create this)
├── .env.example                       # Environment template
├── github-oauth-routes.js             # OAuth routes reference
└── GITHUB_INTEGRATION_README.md       # This file
```

## 🔄 Workflow Example

1. User visits `/landing.html`
2. Clicks "Connect to GitHub"
3. Authorizes CodeAtlas
4. Returns to landing page (authenticated)
5. Enters a GitHub repo URL
6. App analyzes the codebase
7. AI suggests refactorings
8. User clicks "Create PR"
9. PR is automatically created on GitHub
10. User reviews and merges the PR

## 🎯 Next Steps

- [ ] Add frontend UI for PR creation button
- [ ] Integrate with existing "Blast Radius" feature
- [ ] Add PR preview before creation
- [ ] Support for multiple file types
- [ ] Add PR template customization
- [ ] Implement PR status tracking

## 📚 Additional Resources

- [GitHub OAuth Documentation](https://docs.github.com/en/developers/apps/building-oauth-apps)
- [Octokit REST API](https://octokit.github.io/rest.js/)
- [Express Session Guide](https://github.com/expressjs/session)

## 🤝 Contributing

When adding new features:

1. Update this README
2. Add environment variables to `.env.example`
3. Document new API endpoints
4. Add error handling examples

---

**Built for CodeAtlas Hackathon** 🚀
