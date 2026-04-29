# File Vault

A Chrome browser extension for uploading, browsing, and semantically searching files. Files are stored in **Cloudflare R2**; metadata and vector embeddings live in **MariaDB 11.6+**. All processing (text extraction, AI embeddings, transcription) happens on a local API server — the extension only talks HTTP.

---

## Architecture

```
Chrome Extension (popup)
       ↕ HTTP REST (localhost:3001)
Python FastAPI server  ─── (or Node.js / Express backup)
       ├── Cloudflare R2          (raw file storage)
       ├── MariaDB 11.6+          (metadata + VECTOR(1536) embeddings)
       └── OpenAI API             (embeddings, GPT-4o vision, Whisper)
```

---

## Features

| Feature | Description |
|---------|-------------|
| Upload | Drag & drop, file browser, clipboard paste, live page capture, URL import (Google Drive / OneDrive / Dropbox / S3 / direct) |
| Folder Upload | Upload an entire directory at once — auto-creates a vault folder |
| Similarity Search | Finds files by meaning, not filename (OpenAI embeddings + MariaDB vector index) |
| Folders & Tags | Organise files; click a tag to filter |
| Favourites | Star files, filter to starred only |
| Trash & Recovery | Soft delete → restore from trash; powered by MariaDB System-Versioned Temporal Tables |
| Dashboard | Storage stats, breakdown by type, recent uploads |
| Auth | JWT register / login / forgot password (email OTP reset) |
| Cyberpunk UI | Amber neon theme, scanlines, hover previews, adjustable window size |

---

## Project Structure

```
file-vault/
├── extension/                    Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── icons/icon128.png
│   └── popup/
│       ├── popup.html
│       ├── popup.js
│       └── popup.css
├── server-python/                ★ Primary API server (FastAPI)
│   ├── main.py                   Entry point
│   ├── db.py                     MariaDB connection pool
│   ├── r2.py                     Cloudflare R2 / boto3 client
│   ├── embed.py                  OpenAI embeddings + GPT-4o vision + Whisper
│   ├── processor.py              Per-file-type text extraction pipeline
│   ├── deps.py                   JWT auth dependency
│   ├── mailer.py                 SMTP email for OTP
│   ├── routes/
│   │   ├── auth.py
│   │   ├── files.py
│   │   ├── search.py
│   │   ├── folders.py
│   │   ├── stats.py
│   │   └── recovery.py           Temporal table backup/restore
│   ├── .env.example              ← Template — copy to .env
│   └── requirements.txt
├── server/                       Node.js / Express backup server
│   ├── src/
│   │   ├── index.js
│   │   ├── db.js
│   │   ├── r2.js
│   │   ├── embed.js
│   │   ├── processor.js
│   │   ├── mailer.js
│   │   └── routes/
│   │       ├── auth.js
│   │       ├── files.js
│   │       ├── search.js
│   │       ├── folders.js
│   │       ├── stats.js
│   │       └── recovery.js
│   ├── .env.example              ← Template — copy to .env
│   └── package.json
└── sql/
    ├── schema.sql                      Base schema
    ├── migration_auth.sql              Users table
    ├── migration_password_reset.sql    OTP reset table
    ├── migration_wave3.sql             Folders, tags, favourites
    └── migration_temporal.sql         System-versioned temporal tables
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Python | 3.10+ | For the primary FastAPI server |
| Node.js | 18+ | For the backup Express server |
| MariaDB | **11.6+** | Required for native `VECTOR` type and temporal tables |
| Cloudflare R2 | — | Free tier available; create a bucket at [dash.cloudflare.com](https://dash.cloudflare.com) |
| OpenAI API key | — | Used for embeddings, GPT-4o vision, Whisper transcription |
| Gmail App Password | — | Only needed for password-reset OTP emails |

---

## Deployment Guide

### Step 1 — Clone the repository

```bash
git clone https://github.com/your-username/file-vault.git
cd file-vault
```

---

### Step 2 — Set up MariaDB

Run the SQL migrations **in order** using HeidiSQL, DBeaver, or the MariaDB CLI:

```sql
-- Connect to MariaDB first, then:

source sql/schema.sql;                    -- creates the filevault database + files table
source sql/migration_auth.sql;            -- adds users table + user_id to files
source sql/migration_password_reset.sql;  -- adds password_resets table
source sql/migration_wave3.sql;           -- adds folders, tags, file_tags, is_favourite
source sql/migration_temporal.sql;        -- enables system-versioned temporal tables (trash/recovery)
```

**MariaDB CLI example:**

```bash
mariadb -u root -p < sql/schema.sql
mariadb -u root -p < sql/migration_auth.sql
mariadb -u root -p < sql/migration_password_reset.sql
mariadb -u root -p < sql/migration_wave3.sql
mariadb -u root -p < sql/migration_temporal.sql
```

---

### Step 3 — Configure environment variables

All secrets are read from a `.env` file. A template is provided for each server.

#### Python server (primary)

```bash
cd server-python
cp .env.example .env
```

Edit `server-python/.env`:

```env
# MariaDB
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mariadb_password
DB_NAME=filevault

# Cloudflare R2  (Dashboard → R2 → Manage API tokens)
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=filevault

# OpenAI  (https://platform.openai.com/api-keys)
OPENAI_API_KEY=sk-...your_openai_api_key

# JWT  — generate with:  python -c "import secrets; print(secrets.token_hex(32))"
JWT_SECRET=change_this_to_a_long_random_string

# Gmail App Password  (https://myaccount.google.com/apppasswords)
SMTP_USER=you@gmail.com
SMTP_PASS=your_gmail_app_password

# Server
PORT=3001
```

#### Node.js server (backup)

```bash
cd server
cp .env.example .env
# Fill in the same values as above
```

> ⚠️ **Never commit `.env` to version control.** It is already listed in `.gitignore`.

---

### Step 4 — Start the API server

#### Option A — Python / FastAPI (recommended)

```bash
cd server-python
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 3001 --reload
```

Server starts at **http://localhost:3001**

#### Option B — Node.js / Express (backup)

```bash
cd server
npm install
node src/index.js
```

Server starts at **http://localhost:3001**

---

### Step 5 — Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. The **File Vault** icon appears in your Chrome toolbar
5. Click the icon → Settings (⚙) → set **Server URL** to `http://localhost:3001` → **SAVE**
6. Register an account and start uploading files

---

## Where to Get API Keys

| Service | Where to get it |
|---------|----------------|
| **OpenAI API key** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Cloudflare R2** | [dash.cloudflare.com](https://dash.cloudflare.com) → R2 → Create bucket → Manage API tokens |
| **Gmail App Password** | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) — enable 2FA first |

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Create account |
| POST | `/auth/login` | Login, returns JWT |
| POST | `/auth/forgot-password` | Send OTP to email |
| POST | `/auth/reset-password` | Verify OTP + set new password |
| POST | `/files/upload` | Upload a file (multipart/form-data) |
| POST | `/files/import-url` | Import file from URL (Google Drive, OneDrive, Dropbox, S3) |
| GET | `/files` | List files (sort, filter, paginate) |
| GET | `/files/:id` | Get file details + extracted text |
| GET | `/files/:id/download` | Get 15-min presigned download URL |
| PATCH | `/files/:id` | Rename file |
| PATCH | `/files/:id/favourite` | Toggle favourite |
| PATCH | `/files/:id/folder` | Move to folder |
| POST | `/files/:id/tags/:name` | Add tag |
| DELETE | `/files/:id/tags/:name` | Remove tag |
| POST | `/files/:id/reindex` | Re-extract and re-embed |
| DELETE | `/files/:id` | Soft delete (moves to trash) |
| GET | `/folders` | List folders |
| POST | `/folders` | Create folder |
| PATCH | `/folders/:id` | Rename folder |
| DELETE | `/folders/:id` | Delete folder (files kept, unfiled) |
| POST | `/search` | Similarity search `{ query, limit, type }` |
| GET | `/stats` | Dashboard statistics |
| GET | `/health` | Health check (no auth) |
| GET | `/recovery` | List trashed files |
| POST | `/recovery/:id` | Restore file from trash |
| GET | `/recovery/:id/history` | View file change history (temporal) |
| DELETE | `/recovery/:id/purge` | Permanently delete from R2 + DB |

**GET /files query params:**
`limit`, `offset`, `sort` (uploaded_at / filename / size_bytes), `order` (asc / desc), `type`, `folder_id`, `favourites=1`, `tag`

---

## File Processing Pipeline

| Type | Detection | Extraction | Embedding input |
|------|-----------|------------|-----------------|
| PDF | `application/pdf` | `PyMuPDF` / `pdf-parse` | Text ≤ 8 000 chars |
| DOCX | `.docx` mime | `python-docx` / `mammoth` | Text ≤ 8 000 chars |
| Image | `image/*` | GPT-4o vision → description | Description string |
| Audio | `audio/*` | OpenAI Whisper-1 | Transcript ≤ 8 000 chars |
| Code | `.js .ts .py .go .rs ...` | Raw UTF-8 | Code ≤ 8 000 chars |
| Other | fallback | — | `filename: X \| type: Y` |

All types embedded with **text-embedding-3-small** → `VECTOR(1536)` stored in MariaDB.

---

## Backup & Recovery (MariaDB Temporal Tables)

Deleted files are **soft-deleted** (`deleted_at` timestamp) and moved to the Trash tab. The database table is **system-versioned** (MariaDB 11.6+ temporal tables), which means every row change is recorded automatically.

- **Trash tab** — browse soft-deleted files, restore in one click, or purge permanently
- **Change history** — view the full edit timeline of any file (uploaded → renamed → deleted)
- **30-day retention** — files in trash are kept until explicitly purged

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3, Vanilla JS |
| Primary API | Python 3, FastAPI, Uvicorn |
| Backup API | Node.js, Express |
| Database | MariaDB 11.6+ (VECTOR type + ANN index + System-Versioned Tables) |
| File Storage | Cloudflare R2 (S3-compatible) |
| AI | OpenAI text-embedding-3-small, GPT-4o, Whisper-1 |
| Auth | JWT + bcrypt |
| Email | SMTP (Gmail App Password) |
