# CLAUDE.md — Netmap Pinger

Netmap Pinger is a standalone Python and SQLite web map with a continuous ICMP
collector. It was split out of the former `netmap/` module of the Monitoring
project on 2026-11-25. Earlier commits and installation records are preserved
in the original Monitoring repository.

- Setup and deployment examples: [README.md](README.md).
- Keep one Uvicorn worker. The collector and optional mail worker run in the app lifespan.
- Topology writes use optimistic revisions. Keep probe and history changes in one
  SQLite transaction. Use SQLite Backup API for live backups.
- Bind direct runs to loopback. For shared use, terminate TLS and require operator
  authentication at the reverse proxy. Keep the backend socket private.
- Fast tests: `python -m pytest -q --durations=5` from the repository root.
- Full Python tests: `python -m pytest -q -m "not manual" --timeout=300`.
- Browser checks: `node tests/layout.browser.cjs` with Playwright installed.
- Git stores source code, generic deployment examples and synthetic fixtures.
  Keep runtime files and production credentials/configuration outside Git.
