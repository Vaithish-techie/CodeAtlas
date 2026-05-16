# 🗺️ CodeAtlas - Interactive Repository Architecture Mapper

**Overcome onboarding paralysis.** Turn complex repositories into interactive visual maps to instantly understand file structures and dependencies. Built with IBM Bob.

![CodeAtlas Demo](https://img.shields.io/badge/Status-Hackathon%20Ready-brightgreen)
![Node.js](https://img.shields.io/badge/Node.js-v12%2B-green)
![Express](https://img.shields.io/badge/Express-4.18-blue)
![D3.js](https://img.shields.io/badge/D3.js-v7-orange)

## 🤖 How We Used IBM Bob

To build this architecture within the 48-hour limit while managing our API token budget, IBM Bob acted as our core engineering partner. Specifically, Bob:

1. **Architected the Backend:** Generated the `child_process` execution logic to securely clone and isolate repositories in temporary directories.
2. **Wrote the Parsing Engine:** Created the complex regex-based dependency extraction tool to map internal file relationships without relying on heavy AST libraries.
3. **Built the Visualization:** Wrote the D3.js force-directed graph logic, including the physics simulation, zoom/pan constraints, and data-binding for the interactive UI.

_Please see the included `ibm-bob-report.json` in the root directory for the full session audit log._

---

## ✨ Features

- **Fast Repository Cloning:** Uses `git clone --depth 1` for blazing fast, commit-history-free cloning.
- **Smart File Analysis:** Recursively walks directory trees and extracts dependencies via regex for JS/TS files.
- **Interactive D3.js Visualization:** Force-directed graph with physics simulation, drag capabilities, and zoom/pan.
- **Visual Distinctions:** Color-coded node system by file type (`.js`, `.ts`, `.jsx`, `.tsx`).
- **Contextual Inspector:** Click any node to instantly view its file size, imports, and dependents.
- **Guaranteed Cleanup:** Automatic teardown of temporary cloning directories to protect server storage.

## 🚀 Quick Start

### Prerequisites

- **Node.js** v12 or higher
- **Git** installed and available in PATH

### Installation

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/Vaithish-techie/CodeAtlas.git](https://github.com/Vaithish-techie/CodeAtlas.git)
   cd CodeAtlas
   ```
