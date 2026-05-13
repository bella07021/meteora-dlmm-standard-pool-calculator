# Meteora DLMM Standard Pool Calculator

Calculator for modeling Meteora DLMM Standard Pool liquidity distributions.

Open `index.html` directly for local-only calculations. Shared project save/load needs the API server because the browser must not contain a GitHub token.

## Shared project storage

Projects are stored in `data/projects.json` through `api/projects.js`.

Required environment variable:

```bash
GITHUB_TOKEN=github_pat_...
```

Optional environment variables:

```bash
GITHUB_REPO=bella07021/meteora-dlmm-standard-pool-calculator
GITHUB_BRANCH=main
PROJECTS_JSON_PATH=data/projects.json
PORT=8093
```

Run locally with shared storage:

```bash
npm run dev
```

https://bella07021.github.io/meteora-dlmm-standard-pool-calculator/
