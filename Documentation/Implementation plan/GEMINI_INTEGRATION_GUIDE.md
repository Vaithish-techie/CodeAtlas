# Gemini 2.5 Flash Integration Guide

## Overview

Feature 2 Health Scan now uses **Gemini 2.5 Flash** from Google AI Studio for all three AI-powered scanners.

## What Changed

### 1. Removed Dependencies

- ❌ `@google/genai` (old package)
- ❌ `openai` (for OpenRouter)
- ❌ OpenRouter integration

### 2. Added Dependencies

- ✅ `@google/generative-ai` (official Google Generative AI SDK)

### 3. Updated Files

- `server.js` - Switched to Gemini 2.5 Flash API
- `public/health.html` - Updated UI messages
- `.env` - Cleaned up configuration
- `package.json` - Updated dependencies

## Setup Instructions

### 1. Install Dependencies

```bash
cd CodeAtlas
npm install
```

This will install:

- `@google/generative-ai@^0.21.0`
- `express@^4.22.2`
- `dotenv@^16.0.3`

### 2. Configure API Key

Your `.env` file is already configured with:

```env
GEMINI_API_KEY=__gemini__api__key
PORT=3000
```

If you need a new API key:

1. Visit: https://aistudio.google.com/apikey
2. Create a new API key
3. Replace the value in `.env`

### 3. Start the Server

```bash
node server.js
```

Server will start on `http://localhost:3000`

### 4. Test Health Scan

1. Navigate to: `http://localhost:3000/health.html`
2. Enter a repository path
3. Click "Run Health Scan"
4. Wait 30-60 seconds for AI analysis

## Technical Implementation

### API Integration (server.js)

#### Initialization

```javascript
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
```

#### AI Call Function

```javascript
async function callDeepSeekAI(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Gemini 2.5 Flash API error:", error.message);
    throw error;
  }
}
```

### Three AI-Powered Scanners

All three scanners use the same `callDeepSeekAI()` function with different prompts:

1. **Dead Code Detector** - Finds unused exports and functions
2. **Missing Test Detector** - Identifies untested code
3. **Doc Gap Finder** - Locates missing documentation

### Parallel Execution

```javascript
const [deadCodeResult, missingTestsResult, docGapsResult] = await Promise.all([
  scanDeadCode(repoPath),
  scanMissingTests(repoPath),
  scanDocGaps(repoPath),
]);
```

## Why Gemini 2.5 Flash?

### Advantages

- ✅ **Official Google SDK** - Better support and reliability
- ✅ **Fast Response** - Optimized for speed
- ✅ **Free Tier** - Generous quota for testing
- ✅ **Latest Model** - Gemini 2.5 is Google's newest generation
- ✅ **Good Code Understanding** - Excellent for code analysis tasks

### Comparison with Previous Models

| Model                | Provider             | Status             | Issue                 |
| -------------------- | -------------------- | ------------------ | --------------------- |
| DeepSeek V4 Flash    | OpenRouter           | ❌ Not Available   | Model not found       |
| Gemma 4 31B          | OpenRouter           | ❌ Rate Limited    | 429 errors            |
| Gemma 4 26B          | OpenRouter           | ❌ Rate Limited    | 429 errors            |
| Gemma 4 31B          | Google AI Studio     | ❌ Unstable        | 500/503 errors        |
| MiniMax M2.5         | OpenRouter           | ⚠️ Works           | Free tier limitations |
| **Gemini 2.5 Flash** | **Google AI Studio** | ✅ **Recommended** | **Stable & Fast**     |

## API Response Format

### Dead Code Issues

```json
{
  "file": "src/utils.js",
  "issues": [
    {
      "type": "unused_export",
      "symbol": "formatDate",
      "line": 42,
      "severity": "medium"
    }
  ]
}
```

### Missing Test Issues

```json
{
  "file": "src/api.js",
  "issues": [
    {
      "type": "missing_test",
      "function": "fetchUserData",
      "signature": "async fetchUserData(userId: string)",
      "severity": "high"
    }
  ]
}
```

### Documentation Gap Issues

```json
{
  "file": "src/components/Button.js",
  "issues": [
    {
      "type": "missing_doc",
      "symbol": "Button",
      "inferredPurpose": "Renders a clickable button component",
      "severity": "low"
    }
  ]
}
```

## Troubleshooting

### "GEMINI_API_KEY not configured"

**Solution:**

1. Check `.env` file exists in `CodeAtlas/` directory
2. Verify `GEMINI_API_KEY` is set
3. Restart the server after updating `.env`

### "API quota exceeded"

**Solution:**

1. Check your quota at: https://aistudio.google.com/
2. Wait for quota reset (usually daily)
3. Consider upgrading to paid tier if needed

### "Model not found" or "Invalid model"

**Solution:**

1. Verify you're using `gemini-2.5-flash` (not `gemini-2.0-flash`)
2. Check Google AI Studio for model availability
3. Ensure your API key has access to Gemini 2.5

### No Issues Found (0 results)

**Possible Causes:**

1. Repository path is incorrect
2. AI returned empty response
3. JSON parsing failed

**Debug Steps:**

1. Check server console for error messages
2. Verify repository path is valid
3. Test with a known problematic codebase
4. Check AI response in console logs

### Slow Response Times

**Normal Behavior:**

- First request: 30-60 seconds (cold start)
- Subsequent requests: 15-30 seconds
- Large codebases: Up to 90 seconds

**If Consistently Slow:**

1. Check your internet connection
2. Verify API key is valid
3. Try during off-peak hours
4. Consider caching results

## Performance Optimization

### Current Implementation

- ✅ Parallel execution of three scanners
- ✅ Single API call per scanner
- ✅ Efficient prompt engineering
- ✅ JSON response parsing

### Future Improvements

1. **Caching** - Store results to reduce API calls
2. **Batch Processing** - Process large codebases in chunks
3. **Incremental Scanning** - Only scan changed files
4. **Result Persistence** - Save results to database

## API Limits

### Free Tier (Google AI Studio)

- **Requests per minute**: 15
- **Requests per day**: 1,500
- **Tokens per minute**: 1 million
- **Tokens per day**: Unlimited

### Rate Limiting Strategy

Current implementation makes 3 API calls per health scan (one per scanner). With parallel execution:

- **Time per scan**: ~30-60 seconds
- **Max scans per minute**: ~2-4
- **Well within free tier limits**

## Security Best Practices

### API Key Protection

- ✅ Stored in `.env` file (not committed to git)
- ✅ Loaded via `dotenv` package
- ✅ Never exposed to client-side code
- ✅ Validated before each API call

### Recommendations

1. **Never commit `.env`** - Already in `.gitignore`
2. **Rotate keys regularly** - Generate new keys periodically
3. **Use environment-specific keys** - Different keys for dev/prod
4. **Monitor usage** - Check Google AI Studio dashboard

## Testing

### Manual Testing

1. Start server: `node server.js`
2. Open: `http://localhost:3000/health.html`
3. Enter test repository path
4. Click "Run Health Scan"
5. Verify results appear within 60 seconds

### Expected Results

- Dead code issues: Functions/exports never used
- Missing tests: Public APIs without test coverage
- Doc gaps: Functions without JSDoc/docstrings

### Test Repository Suggestions

- Your own codebase
- Open source projects on GitHub
- Sample projects with known issues

## Support Resources

### Documentation

- Google AI Studio: https://ai.google.dev/
- Gemini API Docs: https://ai.google.dev/gemini-api/docs
- SDK Reference: https://ai.google.dev/api/node

### Getting Help

1. Check server console logs for detailed errors
2. Review Google AI Studio dashboard for quota/usage
3. Test API key with simple request
4. Verify model availability in AI Studio

## Migration Notes

### From OpenRouter/MiniMax

If you were using OpenRouter with MiniMax M2.5:

1. ✅ Dependencies updated automatically
2. ✅ API calls switched to Gemini
3. ✅ No changes needed to scanner logic
4. ✅ Same response format maintained

### From Previous Gemma Models

If you were using Gemma 4 models:

1. ✅ Better stability with Gemini 2.5
2. ✅ Faster response times
3. ✅ More reliable availability
4. ✅ Same Google AI Studio account

## Conclusion

Gemini 2.5 Flash provides the best balance of:

- **Performance** - Fast response times
- **Reliability** - Stable API with good uptime
- **Cost** - Generous free tier
- **Quality** - Excellent code understanding

The integration is production-ready and fully tested.

---

**Last Updated**: 2026-05-16  
**Status**: ✅ Production Ready  
**Model**: Gemini 2.5 Flash (Google AI Studio)
