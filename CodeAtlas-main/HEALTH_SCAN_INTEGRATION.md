# Health Scan AI Integration Guide

## 🎯 Purpose

This document provides step-by-step instructions for swapping the Health Scan dashboard from **mock data** to **live AI-powered scanning** using IBM Bob's agentic workflows.

## ⚠️ Critical: When to Swap

**DO NOT swap until Sunday (Demo Day)**

- **Development Phase**: Use mock data (0 Bobcoins)
- **Demo Day**: Swap to live AI (40 Bobcoins budget)

## 🔄 The Swap Process

### Current State (Mock)

```javascript
// server.js - Line ~196
app.get('/api/health-scan', (req, res) => {
  res.json({
    summary: { totalIssues: 5, deadCode: 1, missingTests: 2, docGaps: 2 },
    files: [/* hardcoded mock data */],
    metadata: { scanDuration: "0ms (mock)" }
  });
});
```

### Target State (Live AI)

```javascript
// server.js - Line ~196
app.get('/api/health-scan', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Get repository files from session or re-analyze
    const repoFiles = await getRepositoryFiles();
    
    // Run three AI scanners in parallel
    const [deadCodeResults, testGapResults, docGapResults] = await Promise.all([
      runDeadCodeScanner(repoFiles),
      runMissingTestScanner(repoFiles),
      runDocGapScanner(repoFiles)
    ]);
    
    // Aggregate and format results
    const healthScanData = aggregateResults(
      deadCodeResults,
      testGapResults,
      docGapResults
    );
    
    const scanDuration = Date.now() - startTime;
    healthScanData.metadata.scanDuration = `${scanDuration}ms`;
    
    res.json(healthScanData);
  } catch (error) {
    console.error('Health scan error:', error);
    res.status(500).json({ error: 'Health scan failed', details: error.message });
  }
});
```

## 🤖 Three AI Scanner Implementations

### Scanner 1: Dead Code Detector

**Goal**: Find exported symbols that are never imported

**Algorithm**:
1. Parse all files to extract exports
2. Search all files for imports of each export
3. Flag exports with zero imports as "dead code"

**Implementation**:

```javascript
async function runDeadCodeScanner(files) {
  const issues = [];
  
  for (const file of files) {
    // Extract all exports from this file
    const exports = await extractExports(file);
    
    // For each export, check if it's imported anywhere
    for (const exportSymbol of exports) {
      const isUsed = await checkIfImported(exportSymbol, files);
      
      if (!isUsed) {
        issues.push({
          path: file.path,
          type: 'dead_code',
          severity: 'high',
          description: `Function '${exportSymbol.name}' is exported but never used internally.`,
          line: exportSymbol.line,
          symbol: exportSymbol.name
        });
      }
    }
  }
  
  return issues;
}

async function extractExports(file) {
  // Use AI to parse file and extract exports
  const prompt = `
    Analyze this JavaScript/TypeScript file and list all exported symbols:
    
    ${file.content}
    
    Return JSON array: [{ name: "functionName", line: 42, type: "function" }]
  `;
  
  const response = await callBobAI(prompt);
  return JSON.parse(response);
}

async function checkIfImported(exportSymbol, files) {
  // Search all files for imports of this symbol
  const searchPattern = new RegExp(`import.*${exportSymbol.name}.*from|require.*${exportSymbol.name}`);
  
  for (const file of files) {
    if (searchPattern.test(file.content)) {
      return true;
    }
  }
  
  return false;
}
```

**AI Prompt Template**:
```
You are a code analyzer. Extract all exported symbols from this file:

FILE: {filename}
CONTENT:
{file_content}

Return JSON array with this structure:
[
  {
    "name": "functionName",
    "line": 42,
    "type": "function|class|variable"
  }
]

Only include exports (export, module.exports, exports.x).
```

### Scanner 2: Missing Test Detector

**Goal**: Identify public functions without test coverage

**Algorithm**:
1. Extract all public functions from source files
2. Find corresponding test files
3. Check if function names appear in test files
4. Flag functions with no test mentions

**Implementation**:

```javascript
async function runMissingTestScanner(files) {
  const issues = [];
  
  // Separate source files from test files
  const sourceFiles = files.filter(f => !f.path.match(/\.(test|spec)\.(js|ts)$/));
  const testFiles = files.filter(f => f.path.match(/\.(test|spec)\.(js|ts)$/));
  
  for (const sourceFile of sourceFiles) {
    // Extract public functions
    const publicFunctions = await extractPublicFunctions(sourceFile);
    
    // Find corresponding test file
    const testFile = findTestFile(sourceFile, testFiles);
    
    for (const func of publicFunctions) {
      const isTested = testFile 
        ? await checkIfTested(func, testFile)
        : false;
      
      if (!isTested) {
        const severity = func.isPublicAPI ? 'high' : 'medium';
        issues.push({
          path: sourceFile.path,
          type: 'missing_test',
          severity: severity,
          description: `Function '${func.name}' has no corresponding test case.`,
          line: func.line,
          symbol: func.name
        });
      }
    }
  }
  
  return issues;
}

async function extractPublicFunctions(file) {
  const prompt = `
    Analyze this file and list all PUBLIC functions (exported or used externally):
    
    ${file.content}
    
    Return JSON: [{ name: "funcName", line: 42, isPublicAPI: true }]
  `;
  
  const response = await callBobAI(prompt);
  return JSON.parse(response);
}

function findTestFile(sourceFile, testFiles) {
  // Look for test file matching source file name
  const baseName = sourceFile.path.replace(/\.(js|ts|jsx|tsx)$/, '');
  
  return testFiles.find(tf => 
    tf.path.includes(baseName) || 
    tf.path.includes(sourceFile.path.split('/').pop().replace(/\.(js|ts)$/, ''))
  );
}

async function checkIfTested(func, testFile) {
  // Check if function name appears in test file
  const pattern = new RegExp(`(describe|it|test).*${func.name}`, 'i');
  return pattern.test(testFile.content);
}
```

**AI Prompt Template**:
```
You are a test coverage analyzer. List all public functions in this file:

FILE: {filename}
CONTENT:
{file_content}

Return JSON array:
[
  {
    "name": "functionName",
    "line": 42,
    "isPublicAPI": true,
    "complexity": "high|medium|low"
  }
]

Only include functions that are exported or used by other modules.
Mark critical functions (error handling, security) as isPublicAPI: true.
```

### Scanner 3: Doc Gap Finder

**Goal**: Find undocumented public functions

**Algorithm**:
1. Extract all public functions/classes
2. Check for JSDoc/docstring comments
3. Flag functions without documentation
4. Use AI to infer function purpose

**Implementation**:

```javascript
async function runDocGapScanner(files) {
  const issues = [];
  
  for (const file of files) {
    // Extract public functions and their documentation status
    const functions = await extractFunctionsWithDocs(file);
    
    for (const func of functions) {
      if (!func.hasDocumentation) {
        // Use AI to infer what the function does
        const inferredPurpose = await inferFunctionPurpose(func, file);
        
        const severity = func.isPublicAPI ? 'medium' : 'low';
        issues.push({
          path: file.path,
          type: 'doc_gap',
          severity: severity,
          description: `Public function '${func.name}' is missing JSDoc documentation. Inferred purpose: ${inferredPurpose}`,
          line: func.line,
          symbol: func.name
        });
      }
    }
  }
  
  return issues;
}

async function extractFunctionsWithDocs(file) {
  const prompt = `
    Analyze this file and list all public functions with their documentation status:
    
    ${file.content}
    
    Return JSON: [{ 
      name: "funcName", 
      line: 42, 
      hasDocumentation: false,
      isPublicAPI: true 
    }]
    
    A function has documentation if there's a JSDoc comment (/** ... */) immediately above it.
  `;
  
  const response = await callBobAI(prompt);
  return JSON.parse(response);
}

async function inferFunctionPurpose(func, file) {
  const prompt = `
    Based on this function's code, infer its purpose in one sentence:
    
    Function: ${func.name}
    Context:
    ${file.content.substring(func.startPos, func.endPos)}
    
    Return a single sentence describing what this function does.
  `;
  
  const response = await callBobAI(prompt);
  return response.trim();
}
```

**AI Prompt Template**:
```
You are a documentation analyzer. For each public function in this file, check if it has JSDoc:

FILE: {filename}
CONTENT:
{file_content}

Return JSON array:
[
  {
    "name": "functionName",
    "line": 42,
    "hasDocumentation": false,
    "isPublicAPI": true,
    "parameters": ["param1", "param2"]
  }
]

A function has documentation if there's a /** ... */ comment directly above it.
Mark exported functions as isPublicAPI: true.
```

## 🔧 Helper Functions

### Repository File Management

```javascript
// Store repository files in memory after /api/ingest
let cachedRepoFiles = null;

app.post('/api/ingest', async (req, res) => {
  // ... existing clone and analysis code ...
  
  // After analysis, cache files for health scan
  cachedRepoFiles = {
    files: fileContents,
    timestamp: Date.now(),
    repoUrl: req.body.repoUrl
  };
  
  res.json({ nodes, links });
});

async function getRepositoryFiles() {
  if (!cachedRepoFiles) {
    throw new Error('No repository analyzed yet. Run /api/ingest first.');
  }
  
  // Check if cache is stale (older than 1 hour)
  const cacheAge = Date.now() - cachedRepoFiles.timestamp;
  if (cacheAge > 3600000) {
    throw new Error('Repository cache expired. Please re-analyze.');
  }
  
  return cachedRepoFiles.files;
}
```

### Result Aggregation

```javascript
function aggregateResults(deadCode, testGaps, docGaps) {
  // Combine all issues
  const allIssues = [...deadCode, ...testGaps, ...docGaps];
  
  // Group by file
  const fileMap = new Map();
  
  for (const issue of allIssues) {
    if (!fileMap.has(issue.path)) {
      fileMap.set(issue.path, {
        path: issue.path,
        issues: []
      });
    }
    fileMap.get(issue.path).issues.push(issue);
  }
  
  // Calculate summary
  const summary = {
    totalIssues: allIssues.length,
    deadCode: deadCode.length,
    missingTests: testGaps.length,
    docGaps: docGaps.length
  };
  
  return {
    summary,
    files: Array.from(fileMap.values()),
    metadata: {
      scannedAt: new Date().toISOString(),
      repository: cachedRepoFiles?.repoUrl || 'unknown',
      filesScanned: fileMap.size,
      scanDuration: '0ms' // Will be updated by caller
    }
  };
}
```

### IBM Bob AI Integration

```javascript
// Placeholder for IBM Bob AI calls
async function callBobAI(prompt) {
  // TODO: Replace with actual IBM Bob API integration
  // This is where you'll integrate with Bob's agentic workflows
  
  const response = await fetch('https://bob-api.ibm.com/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.BOB_API_KEY}`
    },
    body: JSON.stringify({
      prompt: prompt,
      model: 'bob-code-analyzer',
      temperature: 0.1 // Low temperature for consistent analysis
    })
  });
  
  const data = await response.json();
  return data.result;
}
```

## 📊 Cost Management

### Bobcoin Budget: 40 coins

**Estimated Costs**:
- Dead Code Scanner: ~10 Bobcoins (1 call per file)
- Missing Test Scanner: ~15 Bobcoins (2 calls per file: extract + check)
- Doc Gap Scanner: ~15 Bobcoins (2 calls per file: extract + infer)

**Optimization Strategies**:

1. **Batch Processing**: Analyze multiple files in one AI call
2. **Caching**: Store results for 1 hour to avoid re-scanning
3. **Selective Scanning**: Only scan changed files
4. **Fallback**: If budget exceeded, return partial results

```javascript
async function runScannersWithBudget(files, maxBobcoins = 40) {
  let coinsUsed = 0;
  const results = { deadCode: [], testGaps: [], docGaps: [] };
  
  // Prioritize critical files first
  const sortedFiles = prioritizeFiles(files);
  
  for (const file of sortedFiles) {
    if (coinsUsed >= maxBobcoins) {
      console.warn('Bobcoin budget exceeded. Returning partial results.');
      break;
    }
    
    // Run scanners and track cost
    const [dead, test, doc] = await Promise.all([
      runDeadCodeScanner([file]),
      runMissingTestScanner([file]),
      runDocGapScanner([file])
    ]);
    
    results.deadCode.push(...dead);
    results.testGaps.push(...test);
    results.docGaps.push(...doc);
    
    coinsUsed += 3; // Estimate 3 coins per file
  }
  
  return results;
}

function prioritizeFiles(files) {
  // Prioritize by importance: lib/ > src/ > test/
  return files.sort((a, b) => {
    const scoreA = getFileImportance(a.path);
    const scoreB = getFileImportance(b.path);
    return scoreB - scoreA;
  });
}

function getFileImportance(path) {
  if (path.startsWith('lib/')) return 10;
  if (path.startsWith('src/')) return 5;
  if (path.includes('index')) return 8;
  if (path.includes('test')) return 1;
  return 3;
}
```

## 🧪 Testing the Swap

### Pre-Demo Checklist

Before swapping to live AI on demo day:

1. **Test with Small Repository**
   ```bash
   # Use a tiny repo first (5-10 files)
   curl -X POST http://localhost:3000/api/ingest \
     -H "Content-Type: application/json" \
     -d '{"repoUrl": "https://github.com/expressjs/body-parser"}'
   
   # Then test health scan
   curl http://localhost:3000/api/health-scan
   ```

2. **Monitor Bobcoin Usage**
   - Log each AI call
   - Track cumulative cost
   - Set hard limit at 40 coins

3. **Verify Response Format**
   - Ensure JSON matches mock structure
   - Check all required fields present
   - Validate severity values

4. **Test Error Handling**
   - What if AI call fails?
   - What if budget exceeded?
   - What if no repository cached?

### Rollback Plan

If live AI fails during demo:

```javascript
// Add feature flag
const USE_LIVE_AI = process.env.USE_LIVE_AI === 'true';

app.get('/api/health-scan', async (req, res) => {
  if (USE_LIVE_AI) {
    // Try live AI
    try {
      const results = await runLiveAIScans();
      res.json(results);
    } catch (error) {
      console.error('Live AI failed, falling back to mock:', error);
      res.json(mockHealthScanData);
    }
  } else {
    // Use mock data
    res.json(mockHealthScanData);
  }
});
```

Start server with: `USE_LIVE_AI=true node server.js`

## 📝 Implementation Timeline

### Friday (Development)
- ✅ Build with mock data
- ✅ Test all UI interactions
- ✅ Perfect the user experience

### Saturday (Preparation)
- 🔧 Implement AI scanner functions
- 🧪 Test with small repositories
- 📊 Verify Bobcoin usage

### Sunday (Demo Day)
- 🚀 Set `USE_LIVE_AI=true`
- 🎯 Test with Express.js repo
- 🎬 Demo to audience
- 🔄 Rollback to mock if needed

## 🎯 Success Criteria

- ✅ Scans complete in <30 seconds
- ✅ Stay within 40 Bobcoin budget
- ✅ Accurate issue detection (>80% precision)
- ✅ Professional presentation
- ✅ Smooth fallback if issues arise

---

**Remember**: The mock implementation is production-ready. The AI integration is the cherry on top for the demo!