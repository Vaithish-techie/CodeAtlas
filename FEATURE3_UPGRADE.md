# Feature 3 Upgrade: OpenAI GPT Integration

## Overview

Feature 3 (Auto-Fix Queue) has been upgraded to use **live OpenAI GPT API** instead of hardcoded data. The system now dynamically generates code fixes using AI and supports intelligent regeneration based on developer feedback.

## What Changed

### Before (Hardcoded)
- Fixed array of 5 hardcoded fix objects
- Simple text prepending for "modified" decisions
- No real AI involvement

### After (OpenAI GPT)
- Dynamic fix generation from health scan issues using GPT
- Real AI regeneration with developer feedback
- In-memory caching (one generation per server session)
- Graceful fallback when API key is missing/invalid

## Architecture

### Key Components

1. **OpenAI Integration Functions**
   - `isOpenAIConfigured()` - Checks if API key is valid
   - `generateFixWithGPT(issue)` - Generates a single fix using GPT
   - `buildPromptForIssue(issue)` - Creates type-specific prompts
   - `getFallbackFix(issue)` - Returns hardcoded data when API unavailable
   - `generateAllFixes()` - Generates all 5 fixes from health issues
   - `regenerateFixWithFeedback(fix, feedback)` - Regenerates with user input

2. **Caching System**
   - `fixesCache` - In-memory array of generated fixes
   - `cacheTimestamp` - When fixes were generated
   - Cache persists for entire server session
   - Cleared on server restart

3. **Health Issues**
   - 5 predefined issues from Express.js codebase:
     - `lib/router.js` - Dead code (parseOldRoute)
     - `lib/router.js` - Doc gap (init function)
     - `lib/application.js` - Missing test (lazyrouter)
     - `lib/application.js` - Missing test (handle)
     - `lib/application.js` - Doc gap (set method)

### API Endpoints Updated

#### GET /api/fixes
- **Before**: Returned hardcoded `fixesState` array
- **After**: 
  - Checks cache, generates if empty
  - Calls `generateAllFixes()` on first request
  - Returns cached fixes on subsequent requests
  - Includes `aiProvider` in metadata

#### POST /api/fixes/:id/decision
- **Before**: Simple text prepending for "modified"
- **After**:
  - Uses `fixesCache` instead of `fixesState`
  - Calls `regenerateFixWithFeedback()` for "modified" decisions
  - Updates cache with regenerated fix
  - Full GPT integration with user feedback

#### POST /api/apply
- **After**: Uses `fixesCache` instead of `fixesState`

#### POST /api/create-pr (legacy)
- **After**: Uses `fixesCache` instead of `fixesState`

## Environment Variables

### Required for OpenAI Integration

```bash
# OpenAI Configuration
OPENAI_API_KEY=sk-proj-...your-key-here
OPENAI_MODEL=gpt-4o-mini  # or gpt-4, gpt-3.5-turbo, etc.
```

### Fallback Behavior

If `OPENAI_API_KEY` is:
- **Missing**: Uses fallback data
- **Set to "dummy"**: Uses fallback data
- **Invalid/expired**: Attempts API call, falls back on error

## GPT Prompts

### Fix Generation Prompts

Each issue type has a specialized prompt:

**Dead Code:**
```
Explains why code is dead and safe to remove
Shows original code
Proposes removal strategy with comments
Provides confidence score
```

**Missing Test:**
```
Explains importance of testing
Shows original function
Proposes complete Jest test suite
Provides confidence score
```

**Doc Gap:**
```
Explains importance of documentation
Shows original function
Proposes function with JSDoc comments
Provides confidence score
```

### Regeneration Prompt

When user provides feedback:
```
Includes original fix details
Incorporates developer feedback
Regenerates all fields (explanation, original, proposed, confidence)
Returns updated JSON
```

## Response Format

GPT returns JSON in this exact format:

```json
{
  "bobExplanation": "2-3 sentence explanation",
  "original": "original code snippet",
  "proposed": "proposed fix or new code",
  "confidence": 85
}
```

## Error Handling

### API Errors
- Network failures → fallback data
- Invalid responses → fallback data
- Missing fields → fallback data
- Rate limits → fallback data

### Validation
- Checks for required JSON fields
- Validates confidence is a number
- Ensures non-empty strings

### Logging
All errors logged with timestamps:
```
[2026-05-16T16:22:11.487Z] OpenAI API error: 401 Unauthorized
[2026-05-16T16:22:11.487Z] Error calling OpenAI API: Invalid API key
```

## Testing

### With OpenAI API Key

1. Set valid `OPENAI_API_KEY` in `.env`
2. Start server: `npm start`
3. Navigate to `http://localhost:3000/fixes.html`
4. Observe console logs showing GPT generation
5. Test "Modify" with feedback to see regeneration

### Without OpenAI API Key

1. Set `OPENAI_API_KEY=dummy` in `.env`
2. Start server: `npm start`
3. Navigate to `http://localhost:3000/fixes.html`
4. System uses fallback data (no API calls)
5. "Modify" prepends feedback to explanation

### Verify Caching

1. Load fixes page (generates fixes)
2. Refresh page (uses cached fixes)
3. Check console: "Returning cached fixes from [timestamp]"
4. Restart server to clear cache

## Performance

### API Calls
- **First request**: 5 sequential GPT calls (~5-10 seconds)
- **Subsequent requests**: Instant (cached)
- **Regeneration**: 1 GPT call per modified fix (~1-2 seconds)

### Caching Benefits
- No repeated API calls
- Faster page loads
- Reduced API costs
- Consistent fixes during session

## Cost Estimation

Using `gpt-4o-mini` (cheapest model):

- **Input**: ~500 tokens per fix × 5 = 2,500 tokens
- **Output**: ~300 tokens per fix × 5 = 1,500 tokens
- **Cost per session**: ~$0.001 (less than a penny)
- **Regeneration**: ~$0.0002 per fix

## Compatibility

### Feature 2 Integration
- Health scan issues feed into fix generation
- Same issue structure expected
- No changes to Feature 2 implementation

### Frontend Compatibility
- `fixes.html` unchanged
- Same JSON structure returned
- Additional `aiProvider` field in metadata

## Migration Notes

### Breaking Changes
- None - fully backward compatible
- Falls back to hardcoded data if API unavailable

### Deprecated
- `fixesState` array still exists but unused
- Kept for reference only

## Future Enhancements

1. **Dynamic Health Issues**: Generate fixes from actual health scan results
2. **Streaming Responses**: Show fixes as they're generated
3. **Model Selection**: Allow users to choose GPT model
4. **Batch Processing**: Generate all fixes in parallel
5. **Persistent Cache**: Store fixes in database
6. **Custom Prompts**: Allow users to customize fix generation

## Troubleshooting

### "Failed to generate fixes"
- Check `OPENAI_API_KEY` is valid
- Verify API key has credits
- Check network connectivity
- Review server logs for details

### "No fixes available"
- Call `GET /api/fixes` first
- Check server logs for generation errors
- Verify cache wasn't cleared

### Slow Generation
- Normal for first request (5-10 seconds)
- Consider using faster model (gpt-3.5-turbo)
- Check OpenAI API status

### Fallback Data Always Used
- Verify `OPENAI_API_KEY` is not "dummy"
- Check API key format (starts with "sk-")
- Review console logs for API errors

## Support

For issues or questions:
1. Check server console logs
2. Verify `.env` configuration
3. Test with `OPENAI_API_KEY=dummy` for fallback mode
4. Review OpenAI API documentation

## Credits

- **OpenAI GPT**: Code fix generation
- **Feature 2**: Health scan integration
- **Express.js**: Example codebase for fixes