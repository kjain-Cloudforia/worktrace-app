# WorkTrace Tab Vault — Chrome extension (Phase 2)

The companion extension for the dashboard's **Tab Vault** module. It does the
things a web page can't:

- **Save all open tabs** in the current window with one click — importing your
  Chrome **tab groups** with their name + colour.
- **Reopen a saved group as a real Chrome tab group** (name + colour restored).
- A one-time **"close the tabs you just saved?"** prompt to free RAM.

The dashboard remains where you rename, reorder, edit, and organise. Both read
and write the **same** file: `modules/tabgroups/data.json` in your private
`worktrace-data-<you>` repo.

## Install (developer mode — no Chrome Web Store)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the puzzle-piece → **WorkTrace Tab Vault** for easy access.
5. Click the icon, **sign in** with your WorkTrace username + password (same as
   the dashboard). Your token is unlocked locally and kept only in
   `chrome.storage.session` — it clears when you fully close Chrome.

## Use

- **Save all open tabs** → captures every http/https tab in the current window,
  groups them the way Chrome had them grouped, writes them to your vault, then
  offers to close them.
- **Your groups → Open** → recreates that group's tabs and bundles them into a
  fresh Chrome tab group.

## Notes / limits (v1)

- Only `http`/`https` tabs are saved (chrome://, extension pages, etc. are skipped).
- Keep the popup open while a save/open runs — the work happens in the popup
  (no background service worker yet).
- `auth.js` is copied verbatim from `app/docs/auth/auth.js`. If the dashboard's
  crypto ever changes, re-copy it.
- No bundled icons yet — Chrome shows a default icon. Drop PNGs + an `icons`
  block in `manifest.json` to brand it.
