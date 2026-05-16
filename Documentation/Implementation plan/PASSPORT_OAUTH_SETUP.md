# Passport.js GitHub OAuth Implementation Guide

This document explains the complete Passport.js GitHub OAuth setup for CodeAtlas, replacing the manual OAuth implementation with a more secure and maintainable solution.

## 🎯 What Changed

### Before (Manual OAuth)

- Manual token exchange with GitHub API
- Custom session management
- Manual CSRF protection with state parameter
- Direct fetch calls to GitHub OAuth endpoints

### After (Passport.js)

- ✅ Passport.js handles OAuth flow automatically
- ✅ Built-in session serialization/deserialization
- ✅ Cleaner, more maintainable code
- ✅ Industry-standard authentication pattern
- ✅ Access token stored securely in session via `req.user.accessToken`

---

## 📦 Dependencies

```json
{
  "express-session": "^1.17.3",
  "passport": "^0.6.0",
  "passport-github2": "^0.1.12",
  "@octokit/rest": "^22.0.1"
}
```

Install with:

```bash
npm install express-session passport passport-github2 @octokit/rest
```

---

## 🔧 Implementation Breakdown

### 1. Session Setup

```javascript
app.use(
  session({
    secret:
      process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // HTTPS only in production
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);
```

**Key Points:**

- `resave: false` - Don't save session if unmodified
- `saveUninitialized: false` - Don't create session until something is stored
- `secure: true` in production - Requires HTTPS
- Session expires after 24 hours

---

### 2. Passport Configuration

#### Initialize Passport

```javascript
app.use(passport.initialize());
app.use(passport.session());
```

#### Serialize/Deserialize User

```javascript
// Store user in session
passport.serializeUser((user, done) => {
  done(null, user);
});

// Retrieve user from session
passport.deserializeUser((user, done) => {
  done(null, user);
});
```

**Note:** For a hackathon demo, we store the entire user object in the session. In production, you'd typically store only the user ID and fetch the full user from a database.

#### Configure GitHub Strategy

```javascript
passport.use(
  new GitHubStrategy(
    {
      clientID: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      callbackURL: GITHUB_CALLBACK_URL,
      scope: ["repo"], // Request 'repo' scope
    },
    function (accessToken, refreshToken, profile, done) {
      // CRITICAL: Capture the accessToken
      const user = {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        profileUrl: profile.profileUrl,
        avatar:
          profile.photos && profile.photos[0] ? profile.photos[0].value : null,
        accessToken: accessToken, // Store token for GitHub API calls
      };

      console.log(
        `[${new Date().toISOString()}] GitHub OAuth successful: ${user.username}`,
      );

      return done(null, user);
    },
  ),
);
```

**Critical Detail:** The `accessToken` parameter in the verify callback is the GitHub access token. We attach it to the user object so it's stored in the session and available via `req.user.accessToken` in protected routes.

---

### 3. Auth Routes

#### Initiate OAuth Flow

```javascript
app.get("/auth/github", passport.authenticate("github", { scope: ["repo"] }));
```

**What happens:**

1. User clicks "Connect to GitHub"
2. Passport redirects to GitHub OAuth page
3. User authorizes CodeAtlas
4. GitHub redirects back to callback URL

#### Handle OAuth Callback

```javascript
app.get(
  "/auth/github/callback",
  passport.authenticate("github", {
    successRedirect: "/",
    failureRedirect: "/landing.html",
  }),
);
```

**What happens:**

1. GitHub redirects here with authorization code
2. Passport exchanges code for access token
3. Passport calls the verify callback with the token
4. User object (with token) is stored in session
5. User is redirected to dashboard

#### Check Auth Status

```javascript
app.get("/api/auth/status", (req, res) => {
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
```

**Note:** `req.isAuthenticated()` is a Passport method that checks if the user is logged in.

#### Logout

```javascript
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
```

**Note:** `req.logout()` is a Passport method that removes `req.user` and clears the login session.

---

### 4. Auth Middleware

```javascript
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
  res.redirect("/landing.html");
}
```

**Usage:**

- Apply to any route that requires authentication
- Checks if user is logged in via `req.isAuthenticated()`
- Returns appropriate response based on request type (API vs page)

---

### 5. Protected Route Example (PR Creation)

```javascript
app.post("/api/create-pr", ensureAuthenticated, async (req, res) => {
  const { repoUrl, files, prTitle, prBody } = req.body;

  // Validate input
  if (!repoUrl || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({
      error: "Missing required fields: repoUrl, files[]",
    });
  }

  try {
    // Use the access token from req.user
    const octokit = new Octokit({
      auth: req.user.accessToken, // ← Token stored during OAuth
    });

    // Create PR using Octokit...
    // (rest of PR creation logic)
  } catch (error) {
    // Error handling...
  }
});
```

**Key Changes:**

1. Added `ensureAuthenticated` middleware
2. Changed `req.session.githubToken` to `req.user.accessToken`
3. Removed manual authentication check (middleware handles it)

---

## 🔐 Security Features

### 1. CSRF Protection

Passport handles CSRF protection automatically through the OAuth state parameter.

### 2. Session Security

- HTTP-only cookies (not accessible via JavaScript)
- Secure flag in production (HTTPS only)
- Session expiration (24 hours)
- Session secret from environment variable

### 3. Token Storage

- Access token stored server-side in session
- Never exposed to client-side JavaScript
- Automatically included in `req.user` for authenticated requests

### 4. Scope Limitation

- Only requests `repo` scope (read code, create PRs)
- Doesn't request unnecessary permissions

---

## 🚀 Testing the Implementation

### 1. Start the Server

```bash
npm start
```

### 2. Test OAuth Flow

1. Visit `http://localhost:3000/landing.html`
2. Click "Connect to GitHub"
3. Authorize CodeAtlas on GitHub
4. Should redirect to dashboard (`/`)

### 3. Test Auth Status

```bash
curl http://localhost:3000/api/auth/status
```

**Expected Response (Authenticated):**

```json
{
  "authenticated": true,
  "user": {
    "id": "12345",
    "username": "yourusername",
    "displayName": "Your Name",
    "avatar": "https://avatars.githubusercontent.com/..."
  }
}
```

### 4. Test Protected Route

```bash
curl -X POST http://localhost:3000/api/create-pr \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/owner/repo",
    "files": [{"path": "test.js", "content": "console.log(\"test\");"}],
    "prTitle": "Test PR"
  }'
```

**Expected Response (Not Authenticated):**

```json
{
  "error": "Not authenticated. Please connect your GitHub account first.",
  "redirectTo": "/auth/github"
}
```

### 5. Test Logout

```bash
curl -X POST http://localhost:3000/api/auth/logout
```

**Expected Response:**

```json
{
  "success": true
}
```

---

## 🐛 Troubleshooting

### Issue: "Cannot GET /auth/github"

**Cause:** Passport not initialized or routes not registered

**Solution:** Ensure this order in `server.js`:

1. Session middleware
2. `passport.initialize()`
3. `passport.session()`
4. Strategy configuration
5. Route definitions

### Issue: "req.user is undefined"

**Cause:** User not authenticated or session expired

**Solution:**

- Check if user completed OAuth flow
- Verify session secret is set
- Check session cookie in browser DevTools

### Issue: "Invalid callback URL"

**Cause:** Mismatch between GitHub OAuth App settings and `GITHUB_CALLBACK_URL`

**Solution:**

- Go to https://github.com/settings/developers
- Edit your OAuth App
- Ensure callback URL matches exactly: `http://localhost:3000/auth/github/callback`

### Issue: "Access token not working"

**Cause:** Token not stored correctly or expired

**Solution:**

- Check `req.user.accessToken` exists
- Verify token is passed to Octokit correctly
- Re-authenticate if token expired

---

## 📊 Session Data Structure

After successful authentication, `req.user` contains:

```javascript
{
  id: "12345678",
  username: "yourusername",
  displayName: "Your Name",
  profileUrl: "https://github.com/yourusername",
  avatar: "https://avatars.githubusercontent.com/u/12345678",
  accessToken: "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

## 🔄 Migration Checklist

If migrating from manual OAuth to Passport:

- [x] Install `passport` and `passport-github2`
- [x] Add Passport initialization middleware
- [x] Configure GitHub Strategy with token capture
- [x] Replace manual OAuth routes with Passport routes
- [x] Create `ensureAuthenticated` middleware
- [x] Update protected routes to use middleware
- [x] Change `req.session.githubToken` to `req.user.accessToken`
- [x] Update logout to use `req.logout()`
- [x] Test complete OAuth flow
- [x] Test protected routes
- [x] Update documentation

---

## 📚 Additional Resources

- [Passport.js Documentation](http://www.passportjs.org/docs/)
- [passport-github2 Strategy](https://github.com/cfsghost/passport-github)
- [GitHub OAuth Documentation](https://docs.github.com/en/developers/apps/building-oauth-apps)
- [Express Session Guide](https://github.com/expressjs/session)

---

## 🎓 Key Takeaways

1. **Passport simplifies OAuth** - No need to manually handle token exchange
2. **Access token in verify callback** - Critical to capture and store it
3. **req.user.accessToken** - Use this for GitHub API calls
4. **ensureAuthenticated middleware** - Protects routes elegantly
5. **Session-based auth** - User stays logged in across requests

---

**Implementation Complete!** ✅

Your Express server now uses industry-standard Passport.js for GitHub OAuth authentication with secure token storage and clean middleware-based route protection.
