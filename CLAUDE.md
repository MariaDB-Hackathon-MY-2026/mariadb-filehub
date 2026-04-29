# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the API server (production)
cd server && npm start          # node src/index.js → http://localhost:3001

# Start with file-watching (development)
cd server && npm run dev        # node --watch src/index.js

# No build step — the extension is loaded directly as unpacked in Chrome
# chrome://extensions → Developer mode → Load unpacked → select extension/
```

There are no test scripts. Verify changes manually with the extension or curl:

```bash
curl http://localhost:3001/health
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"x@x.com","password":"pass"}'
```

## Architecture

The project is split into two completely independent parts that communicate only over HTTP.

### Server (`server/src/`)

**Entry point:** `index.js` mounts all routers and the global JSON error handler. All routes are protected by `middleware/auth.js` (JWT verify), which attaches `req.user.id` — every DB query must scope to `req.user.id`.

**Data flow for upload:**
1. `multer` buffers the file in memory → `routes/files.js`
2. `processor.js → extractAndEmbed()` detects type, extracts text (pdf-parse / mammoth / GPT-4o vision / Whisper), then calls `embed.js → embedText()` (text-embedding-3-small, 1536 dims)
3. Raw bytes go to R2 via `r2.js → putObject()`
4. Metadata + `VEC_FromText(embedding)` inserted into MariaDB

**Vector search** (`routes/search.js`): embeds the query string, then runs `VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) ORDER BY distance ASC` — MariaDB 11.6+ native ANN. The `VECTOR INDEX` on `files.embedding` is required for this to be fast.

**Key patterns:**
- `db.js` exposes a single `query(sql, params)` function; all route files import it directly
- `filesSelect()` in `routes/files.js` is the canonical SELECT for file rows — it LEFT JOINs `file_tags` + `tags` and uses `GROUP_CONCAT` to return tags as a `||`-delimited string; `parseFile()` splits it back into an array and casts `is_favourite` to bool
- Downloads never proxy bytes through the server — `r2.js → getPresignedUrl()` returns a 15-min signed R2 URL sent to the client

### Extension (`extension/popup/`)

Single-page popup with no build toolchain — plain HTML/CSS/JS.

**State object** (`popup.js` top): all UI state lives in one `state` object (`sort`, `order`, `type`, `folderId`, `showFavs`, `tag`, `isSearchMode`, `searchType`, `folders`, `offset`). Every filter/sort control mutates state then calls `loadFiles(false)`.

**`apiFetch(path, options)`** — the only function that calls the server. It injects `Authorization: Bearer <TOKEN>` automatically. `TOKEN` and the server `API` URL are loaded from `chrome.storage.local` on popup open.

**Rendering pipeline:** `loadFiles()` builds query params from state → `renderFiles()` → `buildRow()` per file. `buildRow()` looks up `state.folders` to resolve a folder name badge; `state.folders` is lazily fetched inside `loadFiles()` the first time it is empty.

**Expanded preview** (`togglePreview()`): fetches `/files/:id` (extracted text + tags) and `/files/:id/download` (presigned URL) in parallel, then renders media/text preview, tags row, folder-move dropdown, and rename input all inside a `.file-preview` div appended to the row.

**Tag filtering:** clicking `.tag-label` inside a tag chip sets `state.tag` and calls `loadFiles(false)`. An inline `#tagFilterBar` element is created dynamically (inserted before `.controls-section`) to show the active tag with a clear button.

## Database Schema (key tables)

```
files          — id, user_id, folder_id, r2_key, filename, mime_type, size_bytes,
                 file_type ENUM, is_favourite, extracted_text, embedding VECTOR(1536), uploaded_at
folders        — id, user_id, name, created_at
tags           — id, user_id, name  (UNIQUE KEY uq_user_tag)
file_tags      — file_id, tag_id  (composite PK)
users          — id, username, email, password_hash, created_at
password_resets— email, otp, expires_at, used
```

Run migrations in order when setting up a new database: `schema.sql` → `migration_auth.sql` → `migration_password_reset.sql` → `migration_wave3.sql`.

## Environment Variables

All in `server/.env` (see README for full template). Critical ones:
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `OPENAI_API_KEY`
- `JWT_SECRET`
- `SMTP_USER`, `SMTP_PASS` (Gmail App Password — only needed for password reset)
