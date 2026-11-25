# AGENTS — Netmap Pinger

Read [CLAUDE.md](CLAUDE.md) for project conventions and [README.md](README.md)
for setup, operations and tests.

- `netmap/app.py` serves the map and runs the collector in its lifespan.
- `netmap/store.py`, `history.py` and `statistics.py` share a local SQLite database.
- `netmap/static/` contains the browser editor, charts and optional watch navigation.
- `netmap/import_friendly.py` imports a Friendly Pinger map into an empty database.
- `netmap/deploy/` contains configurable systemd and Apache examples.

Keep one worker per database. Run `python -m pytest` from the repository root.
Tests use synthetic maps and addresses. Keep site topology, exports, mail settings,
password files, and production configuration out of Git.

Use an authenticated HTTPS reverse proxy for shared access to the app and API.
Keep browser mutation checks and topology revision checks when changing the API.
