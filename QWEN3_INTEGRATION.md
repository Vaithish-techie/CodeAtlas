# Qwen3 Next 80B A3B Integration Guide

## Overview

This document explains the integration of Qwen3 Next 80B A3B (free version) via OpenRouter for ALL three Health Scan features:
1. **Dead Code Detection** - Finds unused exports
2. **Missing Test Coverage** - Identifies untested functions (optimized with batching)
3. **Documentation Gaps** - Finds undocumented functions

## What's New

### 1. **Qwen3 Next 80B A3B Integration**
- Uses the free `qwen/qwen3-next-80b-a3b-instruct:free` model via OpenRouter
- 80B parameter model for superior code analysis
- Fast response times with intelligent batching
- Cost-effective solution (free tier)

### 2. **Intelligent Batching Strategy**
ALL three scanners implement smart batching:

**Dead Code Scanner:**
- **Batch Size**: 5 files per batch
- **Total Files**: Up to 15 files
- **Parallel Processing**: Files within each batch processed in parallel

**Missing Tests Scanner:**
- **Batch Size**: 5 files per batch
- **Total Files**: Up to 20 files
- **Parallel Processing**: Files within each batch processed in parallel

**Documentation Gap Scanner:**
- **Batch Size**: 5 files per batch
- **Total Files**: Up to 15 files
- **Parallel Processing**: Files within each batch processed in parallel

### 3. **Performance Optimization**

**Before (Sequential Processing):**
```
Dead Code:  10 files × ~3s each = ~30s
Missing Tests: 10 files × ~3s each = ~30s
Doc Gaps:   10 files × ~3s each = ~30s
Total: ~90s for 30 files
```

**After (Parallel Batching with Qwen3):**
```
Dead Code:  15 files in 3 batches × ~3s = ~9s
Missing Tests: 20 files in 4 batches × ~3s = ~12s
Doc Gaps:   15 files in 3 batches × ~3s = ~9s
Total: ~30s for 50 files
```

**Result**: ~70% faster with 67% more files analyzed!

## Setup Instructions

### Step 1: Get Your OpenRouter API Key
1. Visit https://openrouter.ai/keys
2. Sign up or log in
3. Create a new API key
4. Copy the key (starts with `sk-or-v1-...`)

### Step 2: Configure Environment
Add your API key to `.env`:
```env
OPENROUTER_API_KEY=sk-or-v1-your-actual-key-here
```

### Step 3: Test the Integration
Run the test script to verify everything works:
```bash
node test-qwen3.js
```

Expected output:
```
✅ API key found in .env file
✅ OpenRouter client initialized successfully
🚀 Sending test request to Qwen3 Next 80B A3B...
✅ SUCCESS! API is working correctly
📨 Response from Qwen3 Next 80B: {...}
🎉 Qwen3 Next 80B integration is working!
```

### Step 4: Start the Server
```bash
npm start
```

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Health Scan Endpoint                      │
│                   /api/health-scan (GET)                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │     Run 3 Scanners in Parallel          │
        │  ┌──────────┬──────────┬──────────┐    │
        │  │ Dead Code│ Missing  │   Doc    │    │
        │  │ Scanner  │  Tests   │   Gaps   │    │
        │  │ (Qwen3)  │ (Qwen3)  │ (Qwen3)  │    │
        │  └──────────┴──────────┴──────────┘    │
        └─────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │      Each Scanner (Optimized)            │
        │                                          │
        │  1. Filter relevant files               │
        │  2. Select files to scan                │
        │  3. Create batches of 5 files           │
        │  4. Process batches sequentially:       │
        │     - Files in batch → parallel         │
        │     - Call Qwen3 Next 80B               │
        │     - Parse JSON responses              │
        │  5. Aggregate all results               │
        └─────────────────────────────────────────┘
```

### Batching Logic

```javascript
// Example: 17 files to scan
Files: [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17]

// Split into batches of 5
Batch 1: [f1, f2, f3, f4, f5]     → Process in parallel → ~3s
Batch 2: [f6, f7, f8, f9, f10]    → Process in parallel → ~3s
Batch 3: [f11, f12, f13, f14, f15] → Process in parallel → ~3s
Batch 4: [f16, f17]                → Process in parallel → ~3s

Total Time: ~12s (vs ~51s sequential)
```

### API Call Details

Each file analysis makes one API call to Qwen3 Next 80B:

```javascript
const completion = await openrouter.chat.completions.create({
  model: "qwen/qwen3-next-80b-a3b-instruct:free",
  messages: [
    { 
      role: "system", 
      content: "You are a code analyzer. Respond only with valid JSON." 
    },
    { 
      role: "user", 
      content: `Analyze this source file...` 
    }
  ],
  temperature: 0.3,
  max_tokens: 4000,
});
```

## Response Format

Qwen3 Next 80B returns JSON in this format:

```json
{
  "functions": [
    {
      "name": "calculateTotal",
      "line": 45,
      "isCritical": true,
      "reason": "Handles financial calculations without validation tests"
    },
    {
      "name": "formatDate",
      "line": 78,
      "isCritical": false,
      "reason": "No tests for edge cases like invalid dates"
    }
  ]
}
```

## Benefits

### 1. **Superior Analysis Quality**
- 80B parameter model provides better code understanding
- More accurate detection of issues
- Better reasoning about code context

### 2. **Speed Improvement**
- **Before**: Sequential processing = slow
- **After**: Parallel batching = 70% faster

### 3. **Better Coverage**
- **Before**: 30 files analyzed
- **After**: 50 files analyzed (67% more)

### 4. **Cost Effective**
- Uses free tier of Qwen3 Next 80B
- No API costs for basic usage

### 5. **Reliability**
- Batch processing prevents rate limit issues
- Error handling per file (one failure doesn't stop others)
- Detailed logging for debugging

## Monitoring & Debugging

### Console Logs
The scanners provide detailed progress logs:

```
[Dead Code] Processing 15 files in 3 batches of 5
[Dead Code] Processing batch 1/3...
[Dead Code] Batch 1 complete. Found 2 issues.
[Missing Tests] Processing 20 files in 4 batches of 5
[Missing Tests] Processing batch 1/4...
[Missing Tests] Batch 1 complete. Found 3 issues.
[Doc Gaps] Processing 15 files in 3 batches of 5
[Doc Gaps] Processing batch 1/3...
[Doc Gaps] Batch 1 complete. Found 1 issues.
```

### Error Handling
- Individual file failures are logged but don't stop the batch
- API errors are caught and logged with helpful messages
- JSON parsing errors are handled gracefully

## Troubleshooting

### Issue: "OPENROUTER_API_KEY not configured"
**Solution**: Add your API key to `.env` file

### Issue: API calls failing with 401
**Solution**: 
1. Verify your API key is correct
2. Check if you have credits on OpenRouter
3. Ensure the key hasn't expired

### Issue: Rate limit errors (429)
**Solution**: 
- The batch size (5) is optimized to avoid rate limits
- If you still hit limits, reduce `BATCH_SIZE` in the code

### Issue: Slow performance
**Solution**:
- Check your internet connection
- Verify OpenRouter service status
- The batching should already provide optimal speed

## Configuration Options

You can adjust these parameters in `server.js`:

```javascript
// Dead Code Scanner
const filesToScan = files.slice(0, 15);  // Max files
const BATCH_SIZE = 5;                    // Files per batch

// Missing Tests Scanner
const filesToScan = sourceFiles.slice(0, 20);  // Max files
const BATCH_SIZE = 5;                          // Files per batch

// Doc Gaps Scanner
const filesToScan = files.slice(0, 15);  // Max files
const BATCH_SIZE = 5;                    // Files per batch
```

**Recommendations**:
- **Small repos (<50 files)**: Keep defaults
- **Medium repos (50-200 files)**: Increase file limits by 50%
- **Large repos (>200 files)**: Consider increasing batch size to 8

## Why Qwen3 Next 80B?

1. **Large Model**: 80B parameters provide superior understanding
2. **Free Tier**: Available for free via OpenRouter
3. **Fast**: Optimized for quick responses
4. **Accurate**: Better code analysis than smaller models
5. **JSON Support**: Reliable structured output

## Support

For issues or questions:
1. Check the console logs for detailed error messages
2. Run `node test-qwen3.js` to verify API connectivity
3. Review OpenRouter documentation: https://openrouter.ai/docs

---

**Made with ❤️ using Qwen3 Next 80B A3B**