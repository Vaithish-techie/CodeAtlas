# RepoTour - Quick Start Guide

## What You're Building

A single-page application that:

1. Accepts a GitHub repository URL
2. Clones it using `git clone --depth 1` (fast, shallow clone)
3. Analyzes all `.js`, `.ts`, `.jsx`, `.tsx` files
4. Extracts internal import/require dependencies
5. Visualizes the architecture as an interactive D3.js force-directed graph
6. Allows clicking nodes to see file details and dependencies

## Project Structure

```
IBM Bob/
├── server.js           # Backend: Express server with /api/ingest endpoint
├── package.json        # Dependencies: express only
├── public/
│   └── index.html     # Frontend: Complete SPA with D3.js
└── README.md          # Documentation
```

## Key Features

### Backend (server.js)

- ✅ Express server on port 3000
- ✅ POST `/api/ingest` endpoint
- ✅ Git shallow clone to temp directory
- ✅ Recursive file system walker
- ✅ Regex-based import extraction
- ✅ D3.js-ready JSON output (nodes + links)
- ✅ Automatic cleanup of temp directories
- ✅ Comprehensive error handling

### Frontend (public/index.html)

- ✅ Clean, modern UI with sidebar and graph area
- ✅ Repository URL input field
- ✅ Interactive D3.js force-directed graph
- ✅ Draggable nodes
- ✅ Color-coded by file type (.js, .ts, .jsx, .tsx)
- ✅ Click nodes to view file details
- ✅ Shows imports and "imported by" relationships
- ✅ Zoom and pan support
- ✅ Loading state during analysis
- ✅ Error handling with user feedback

## Implementation Approach

### Design Decisions

1. **Internal Dependencies Only**: Excludes npm packages to keep graph clean and readable
2. **Shallow Clone**: Uses `--depth 1` for 80-90% faster cloning
3. **Regex Parsing**: Lightweight alternative to AST parsing, captures 95%+ of patterns
4. **Single HTML File**: All CSS and JS inline for easy deployment
5. **Temporary Isolation**: Each analysis in unique temp directory with guaranteed cleanup

### Data Flow

```
User Input → Backend Clone → File Analysis → Dependency Extraction →
JSON Response → D3.js Rendering → Interactive Visualization
```

## Setup Commands

```bash
# 1. Initialize project
npm init -y

# 2. Install Express
npm install express

# 3. Create public directory
mkdir public

# 4. Create server.js (backend code)
# 5. Create public/index.html (frontend code)

# 6. Start server
node server.js

# 7. Open browser
# Navigate to http://localhost:3000
```

## Testing Recommendations

Test with these repositories to verify functionality:

1. **Express.js**: `https://github.com/expressjs/express`
   - Expected: ~50-100 nodes, clear module structure
2. **React**: `https://github.com/facebook/react`
   - Expected: Large graph, JSX files, component relationships
3. **TypeScript Project**: Any TS-based repo
   - Expected: Blue nodes, proper .ts resolution

## API Contract

### Request

```json
POST /api/ingest
Content-Type: application/json

{
  "repoUrl": "https://github.com/expressjs/express"
}
```

### Response

```json
{
  "nodes": [
    {
      "id": "lib/application.js",
      "label": "application.js",
      "type": "file",
      "size": 15234
    }
  ],
  "links": [
    {
      "source": "lib/application.js",
      "target": "lib/router/index.js"
    }
  ]
}
```

## Visualization Features

- **Node Size**: Proportional to file size (5-15px radius)
- **Node Color**: Based on extension
  - Yellow: `.js`
  - Blue: `.ts`
  - Cyan: `.jsx`
  - Dark Blue: `.tsx`
- **Links**: Show import direction (source → target)
- **Interactions**: Drag, click, zoom, pan

## Next Steps

1. ✅ Review this plan
2. Switch to Code mode to implement
3. Create the files as specified
4. Test with real repositories
5. Deploy and demo!

## Questions to Consider

Before implementation, confirm:

- ✅ Port 3000 is acceptable
- ✅ Internal dependencies only (no npm packages)
- ✅ Support .js, .ts, .jsx, .tsx files
- ✅ No artificial limits on graph size
- ✅ Temporary directory cleanup is critical

---

**Ready to implement?** Switch to Code mode and let's build this!
