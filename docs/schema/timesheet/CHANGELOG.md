# Timesheet module schema — changelog

## v1 — 2026-05-16 (initial, with iterations)

Per-user structured timesheet entries. One file per user at `modules/timesheet/users/<user_id>.json`.

Each entry covers one (work_date, project) pair and includes:

- `work_date` — IST shift-window date
- `project.company_name` — Salesforce `Organization.Name`
- `project.friendly_name` — short alias from each user's `config.json`
- `headline` — 1-2 sentence summary (for dashboard tile view)
- `bullets` — full bullet text array (for dashboard detail view)
- `counts` — open-ended counter dict (bullets, deploys, creates, modifications, etc.)
- `tags` — free-form filter labels
- `entry_hash` — idempotency key

### Pre-release iteration (2026-05-16)

Initial v1 design was sanitization-only (headline + counts; no raw bullets). Iterated within Phase 0 (before any real data was published against the schema) to include `bullets[]` as well — since the private repo's collaborator gate is already the trust boundary, surfacing full content to the dashboard is acceptable and gives a much richer detail view.

### Privacy boundary (current)

- ✅ **Full bullet text** is allowed (private repo, team-only readers)
- ✅ Counts, tags, work dates, project legal entity name, sanitized headline
- ❌ GitHub tokens / API keys / Salesforce session IDs — never
- ❌ Anything that's not already in `timesheet.md` — never (the sync layer doesn't fabricate fields)

### Dashboard view contract

- **Tile view** (the 2×2 grid on the dashboard): renders `headline` + `counts`. Quick scan.
- **Detail view** (click a tile): renders full `bullets[]`. Deep dive.
- **Default scope**: each user sees their own data by default; can switch to teammates' views as a UX convenience. Not a security boundary — see README "Privacy model" section.
