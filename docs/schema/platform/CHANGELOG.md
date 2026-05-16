# Platform schema — changelog

## v1 — 2026-05-16 (initial)

User registry schema for WorkTrace. Each user has:

- `user_id` — slug, stable identifier (used in file paths)
- `display_name` — human-readable name shown on dashboard
- `github_login` — for CODEOWNERS enforcement in Phase 4
- `timezone`, `active`, `joined_at` — administrative metadata
- `modules_enabled` — which modules the user has opted into

No PII beyond display name and GitHub login. No emails, no real names beyond display preference.
