# RepoRevive — Project Description
### IBM Bob Hackathon Submission

---

## One-Line Pitch

> A developer pastes a GitHub URL and gets back an interactive codebase map, a full health scan, AI-generated fixes with a diff viewer, and one-click branch creation — all powered by IBM Bob at every step.

---

## Problem Statement

Every development team faces the same silent killers:

- **New developers take weeks** to understand an existing codebase — reading files one by one with no map.
- **Technical debt accumulates invisibly** — dead code, missing tests, undocumented functions pile up sprint after sprint.
- **Code reviews are slow and inconsistent** — what one reviewer catches, another misses.
- **Fixing debt is high-risk** — teams avoid it because touching old code without tests is dangerous.

These aren't rare problems. They slow every team, every day. And they're all symptoms of the same root cause: **developers lack a trusted partner who has read the entire codebase and can reason about it holistically**.

IBM Bob is exactly that partner. RepoRevive puts Bob to work on these four problems simultaneously.

---

## Solution Overview

**RepoRevive** is a web application where a developer submits a GitHub repository URL and receives:

1. An **interactive architecture map** of the codebase — visual, clickable, file-by-file
2. A **health scan dashboard** — dead code, missing tests, and documentation gaps detected in parallel
3. An **auto-fix queue** — Bob generates fixes for every issue, displayed in a side-by-side diff viewer with human approval controls
4. **One-click branch creation** — approved fixes are committed to a new Git branch with a full BobShell audit trail

Every feature is powered by a different IBM Bob capability. This is not a wrapper around Bob — Bob is the engine of every step.

---

## The Four Features

---

### Feature 1 — Repo Ingestion + Architecture Map
**Owned by: Person A (Full-stack lead)**
**Bob capabilities: Architect Mode, Full Repo Context**

**What it does:**
The user pastes a GitHub repository URL. The backend clones the repo, walks the entire file tree, and parses the import/export graph across all files. Bob is invoked in **Architect Mode** to read the full repository and generate a structured summary: what each module does, how they connect, and what the key entry points are.

The frontend renders this as an **interactive D3.js node map** — each file is a node, edges represent import relationships, and clicking any node opens a side panel showing:
- What this file does (Bob's plain-English explanation)
- What imports it
- What it imports
- Its main exported functions

**Why this showcases Bob:**
This is only possible because Bob has read the *entire repo*, not just one file. The explanation of each file is contextual — Bob knows what `auth.service.ts` does *because* it knows about `user.controller.ts` and `jwt.strategy.ts`. A file-by-file tool cannot do this.

**Day 1 tasks:**
- NestJS endpoint: clone repo + walk file tree
- Parse import/export graph → clean JSON output
- Use Bob to generate AST parsing logic

**Day 2 tasks:**
- D3.js interactive node map on the frontend
- File detail side panel (what it does, dependencies, functions)

---

### Feature 2 — Health Scan (3 Parallel Scanners)
**Owned by: Person B (Backend / AI pipelines)**
**Bob capabilities: Agentic Workflows, Security Scanning**

**What it does:**
Bob runs three specialised agents in parallel, each scanning the entire codebase for a different category of health issue:

**Scanner 1 — Dead Code Detector**
Finds functions and files that are exported but never imported, or defined but never called. Reports by file with the specific unused symbol names.

**Scanner 2 — Missing Test Detector**
Identifies public functions and classes that have no corresponding test file or test case. Reports coverage gaps at the function level, not just the file level.

**Scanner 3 — Doc Gap Finder**
Scans all public functions and classes for missing JSDoc / docstrings. Reports which functions are undocumented and what their inferred purpose is (from Bob's reading of the code).

Results are displayed on a **health dashboard** with:
- Issue count by category (dead code / test gaps / doc gaps)
- Severity breakdown (high / medium / low)
- File-level drill-down: click any file to see its specific issues

**Why this showcases Bob:**
The three scanners run as Bob's **agentic workflows** — coordinated, parallel, specialised. Bob doesn't just find issues; it *understands* them. When Bob flags a function as undocumented, it already knows what the function does and will carry that understanding into the fix generation step.

**Day 1 tasks:**
- Dead code scanner service (unused exports, unreachable functions)
- Test coverage gap detector (functions with no test file)

**Day 2 tasks:**
- Doc gap finder (public functions with no JSDoc/docstring)
- Health dashboard UI — counts, severity, file breakdown

---

### Feature 3 — Auto-Fix Queue + Diff Viewer
**Owned by: Person C (Frontend / UX)**
**Bob capabilities: Code Mode, Test Generation, Doc Generation, Human-in-the-Loop**

**What it does:**
For every issue found in the health scan, Bob generates a specific fix:

- **For a dead code issue** → Bob suggests removing the dead symbol and checks if it affects any downstream logic
- **For a missing test** → Bob writes a complete unit test for the function, following the patterns it found in the existing test files
- **For a doc gap** → Bob writes a JSDoc comment for the function, accurate because it has read the entire codebase for context

All fixes appear in a **review queue**: a list of proposed changes, each with:
- The issue it addresses
- A **side-by-side diff viewer** (Monaco editor or diff2html) showing original vs proposed
- Three buttons: **Approve**, **Reject**, **Modify**
- If Modify is clicked, a text field lets the developer give Bob feedback ("make the test cover edge cases too"), and Bob regenerates

**Nothing is applied until the developer approves it.** This is the Human-in-the-Loop principle in action — Bob proposes, humans decide.

**Why this showcases Bob:**
Bob's generated tests are not generic. Because Bob has read the entire repo, the test it writes for `calculateDiscount()` will import the same test utilities, use the same mock patterns, and follow the same file naming conventions as every other test in the project. That is only possible with full repo context.

**Day 1 tasks:**
- Bob integration: generate fixes for each issue type
- Fix queue data model + API endpoint

**Day 2 tasks:**
- Side-by-side diff viewer UI (Monaco editor or diff2html)
- Approve / Reject / Modify buttons + feedback loop to Bob

---

### Feature 4 — Apply + Audit Trail + Branch Creation
**Owned by: Person D (DevOps / Integration)**
**Bob capabilities: BobShell CLI, Auditability, Code Modernization**

**What it does:**
Once the developer has approved their fixes, they click **"Apply Approved Fixes"**. The system:

1. Writes all approved changes to the repository files
2. Creates a new Git branch via the GitHub API (named `reporevive/fixes-YYYYMMDD`)
3. Commits each fix as a separate commit with a descriptive message generated by Bob
4. **Generates a BobShell audit log** — a structured, timestamped record of every action Bob took: what it read, what it decided, what it generated, and when
5. Displays a **final report**: *"12 issues found. 8 fixed. 4 pending. 2 rejected."*
6. Shows a **"Open Pull Request"** button that creates a PR on GitHub with the audit log attached as a comment

**The audit trail contains:**
- Timestamp of every Bob API call
- The prompt sent to Bob
- The capability used (Architect Mode, Code Mode, etc.)
- The output Bob generated
- The human decision (Approved / Rejected / Modified)

**Why this showcases Bob:**
BobShell's self-documenting, traceable workflow is one of Bob's most enterprise-distinctive features. The audit log proves that every change was AI-assisted but human-approved — exactly the governance model that makes Bob enterprise-grade.

**Day 1 tasks:**
- Git integration: write approved fixes to branch via GitHub API
- BobShell audit log service — log every Bob action with timestamp

**Day 2 tasks:**
- Final report generation (issues found / fixed / pending)
- One-click PR creation via GitHub API + polish demo flow

---

## IBM Bob — Full Capability Coverage

| Bob Capability | Where it appears in RepoRevive |
|---|---|
| **Architect Mode** | Feature 1 — reading the full repo and generating the architecture map |
| **Full Repo Context** | Feature 1 + Feature 3 — understanding every file before explaining or fixing any file |
| **Agentic Workflows** | Feature 2 — three parallel specialised scanners coordinated by Bob |
| **Security Scanning** | Feature 2 — embedded in the health scan (dead code can mask security issues) |
| **Code Mode** | Feature 3 — generating fixes for identified issues |
| **Test Generation** | Feature 3 — writing unit tests that match the repo's existing patterns |
| **Doc Generation** | Feature 3 — writing accurate JSDoc based on full codebase understanding |
| **Human-in-the-Loop** | Feature 3 — no fix is applied without developer approval |
| **BobShell / Auditability** | Feature 4 — every Bob action is logged and attached to the PR |
| **Code Modernization** | Feature 4 — the output is a clean branch with modernised, documented, tested code |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | NestJS (TypeScript) |
| Frontend | React / Next.js |
| Graph visualisation | D3.js |
| Diff viewer | Monaco Editor or diff2html |
| Version control integration | GitHub API (Octokit) |
| AI engine | IBM Bob API |
| Auth | GitHub OAuth |

---

## Team Split

| Person | Role | Feature |
|---|---|---|
| Person A | Full-stack lead | Feature 1 — Repo ingestion + architecture map |
| Person B | Backend / AI pipelines | Feature 2 — Health scan (3 scanners) |
| Person C | Frontend / UX | Feature 3 — Fix queue + diff viewer |
| Person D | DevOps / Integration | Feature 4 — Apply + audit trail + branch creation |

**Shared Day 1 morning (first 2 hours together):**
- Create the monorepo (NestJS backend + React/Next frontend)
- Set up GitHub OAuth
- Agree on the shared JSON contract between backend and frontend
- Set up IBM Bob API credentials and test one call together

---

## Demo Repository

**expressjs/express** — used as the fixed demo subject for the presentation.

Why: It is small enough to clone and parse in seconds, large enough to have real health issues (dead code, undocumented internals, missing test coverage), written in JS/TS, and instantly recognisable to any developer evaluating the demo.

---

## Demo Script (2 minutes)

1. **Paste URL** — drop `github.com/expressjs/express` into the input field
2. **Show the map** — scroll through the D3 node graph, click `router/index.js`, show Bob's explanation of what it does and what imports it
3. **Run health scan** — watch the three scanners run in parallel, show the dashboard (e.g. "7 undocumented functions, 3 dead exports, 4 missing tests")
4. **Open fix queue** — click one fix, show the diff, approve it. Click another, click Modify, type "add an edge case for null input", show Bob regenerating
5. **Apply** — click Apply Approved Fixes, show the new branch created, show the BobShell audit log, click Open PR
6. **Close** — "From zero to a clean branch with tests, docs, and a full audit trail. All Bob, all reviewable, all yours."

---

## Why This Wins

- **Every Bob capability is visibly demonstrated** — no capability is implied or hidden behind the scenes
- **The "before and after" is instant and clear** — a messy repo goes in, a clean branch comes out
- **The problem is universally felt** — every developer has dealt with undocumented code, dead functions, and missing tests
- **The governance story is strong** — nothing happens without human approval; every action is logged
- **It is shippable in 2 days** — four features, four people, clear boundaries, no ambiguity

---

*Built with IBM Bob · Hackathon 2026*
