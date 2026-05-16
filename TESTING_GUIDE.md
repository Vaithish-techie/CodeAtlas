# Testing Guide - DeepSeek V4 Flash API Integration

## Quick Start Testing

### Step 1: Add Your API Key

1. **Get your OpenRouter API key:**
   - Go to https://openrouter.ai/keys
   - Sign up or log in
   - Create a new API key
   - Copy the key (format: `sk-or-v1-xxxxxxxxxxxxx`)

2. **Update your `.env` file:**
   ```bash
   # Open CodeAtlas/.env and replace the placeholder:
   OPENROUTER_API_KEY=sk-or-v1-your-actual-key-here
   ```

### Step 2: Test Your API Key

Run the test script to verify your API key works:

```bash
cd CodeAtlas
node test-api.js
```

**Expected Output (Success):**
```
🔍 Testing OpenRouter API connection...

✅ API key found in .env file
   Key starts with: sk-or-v1-xxxxx...

🚀 Sending test request to DeepSeek V4 Flash...

✅ SUCCESS! API is working correctly
📨 Response from DeepSeek: "Hello from DeepSeek!"

🎉 Your API key is valid and the integration is working!
```

**If you see errors:**
- ❌ API key not found → Add your key to `.env`
- ❌ Placeholder key → Replace `your_openrouter_api_key_here` with actual key
- ❌ 401 Unauthorized → Check your API key is correct
- ❌ 429 Rate limit → Wait a moment and try again

### Step 3: Restart Your Server

After adding your API key, restart the server:

```bash
# Stop the current server (Ctrl+C)
npm start
```

### Step 4: Test the Health Scan

1. **Open your browser:**
   ```
   http://localhost:3000
   ```

2. **Analyze a repository:**
   - Enter a GitHub repository URL (e.g., `https://github.com/expressjs/express`)
   - Click "Analyze Repository"
   - Wait for the architecture map to load

3. **Run Health Scan:**
   - Click "Health Scan Dashboard" button
   - The three AI scanners will run in parallel:
     * 💀 Dead Code Detector
     * 🧪 Missing Test Detector
     * 📝 Doc Gap Finder

4. **View Results:**
   - Check the issue counts for each category
   - Click on files to see specific issues
   - Review the AI-generated explanations

## Troubleshooting

### Error: "Cannot read properties of undefined (reading 'create')"

**Cause:** Server started before API key was added to `.env`

**Solution:**
1. Add your API key to `.env`
2. Restart the server (Ctrl+C, then `npm start`)

### Error: "OPENROUTER_API_KEY not configured"

**Cause:** API key missing or placeholder value still in `.env`

**Solution:**
1. Check `.env` file has: `OPENROUTER_API_KEY=sk-or-v1-...`
2. Make sure it's not the placeholder: `your_openrouter_api_key_here`
3. Restart the server

### Error: "Repository cache expired"

**Cause:** More than 1 hour passed since repository analysis

**Solution:**
1. Go back to Architecture Map
2. Re-analyze the repository
3. Return to Health Scan Dashboard

### Health Scan shows 0 issues

**Possible causes:**
1. **API key not working** → Run `node test-api.js` to verify
2. **Small repository** → Try a larger repository with more files
3. **Clean codebase** → The repository might actually be in good shape!

### Slow performance

**Normal behavior:**
- Each scanner analyzes up to 10 files
- Each file requires an API call to DeepSeek
- Total time: ~5-15 seconds depending on file sizes

**To speed up:**
- Reduce files scanned in `server.js` (line 444, 512, 584)
- Use smaller repositories for testing

## API Usage & Costs

### DeepSeek V4 Flash (Free Tier)
- **Model:** `deepseek/deepseek-v4-flash:free`
- **Cost:** Free (with rate limits)
- **Rate Limit:** Check OpenRouter dashboard

### Current Implementation
- **Files per scanner:** 10 (configurable)
- **Content limit:** 3000 characters per file
- **Total API calls per scan:** Up to 30 (3 scanners × 10 files)

### Monitoring Usage
1. Go to https://openrouter.ai/activity
2. View your API usage and costs
3. Check remaining credits

## Advanced Testing

### Test Individual Scanners

You can test each scanner separately by modifying the health scan endpoint:

```javascript
// In server.js, comment out scanners you don't want to test:
const [deadCodeResults, testGapResults, docGapResults] = await Promise.all([
  scanDeadCode(cachedRepoFiles.files),
  // scanMissingTests(cachedRepoFiles.files),  // Commented out
  // scanDocGaps(cachedRepoFiles.files),       // Commented out
]);
```

### Test with Different Repositories

**Good test repositories:**
- Small: `https://github.com/Vaithish-techie/CodeAtlas` (your own repo)
- Medium: `https://github.com/expressjs/express`
- Large: `https://github.com/facebook/react` (may take longer)

### Check Server Logs

Monitor the console output for detailed information:
```
[2026-05-16T10:18:58.990Z] Starting health scan with DeepSeek V4 Flash...
[2026-05-16T10:18:58.990Z] Scanning 1 files
[2026-05-16T10:18:58.994Z] Scan complete - Dead Code: 0, Missing Tests: 0, Doc Gaps: 0
```

## Next Steps

Once your API is working:

1. ✅ Test with different repositories
2. ✅ Review the AI-generated issue descriptions
3. ✅ Adjust scanner sensitivity if needed
4. ✅ Integrate with Feature 3 (Fix Generation)
5. ✅ Share with your team for feedback

## Support

- **OpenRouter Docs:** https://openrouter.ai/docs
- **DeepSeek Model:** https://openrouter.ai/models/deepseek/deepseek-v4-flash
- **API Status:** https://status.openrouter.ai
- **Get Help:** https://openrouter.ai/discord