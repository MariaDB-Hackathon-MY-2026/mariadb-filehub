import os
import re
import uuid
import urllib.request
from datetime import date
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from db import query
from deps import get_current_user
from processor import extract_and_embed
from r2 import delete_object, get_object, get_presigned_url, put_object

router = APIRouter()

VALID_SORT  = {"uploaded_at", "filename", "size_bytes"}
VALID_ORDER = {"asc", "desc"}
VALID_TYPES = {"pdf", "docx", "image", "audio", "video", "code", "other"}


# ── Helpers ────────────────────────────────────────────────────────────────────

def files_select() -> str:
    return """SELECT f.id, f.r2_key, f.filename, f.mime_type, f.size_bytes,
                     f.file_type, f.folder_id, f.is_favourite, f.uploaded_at,
                     GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '||') AS tags
              FROM files f
              LEFT JOIN file_tags ft ON ft.file_id = f.id
              LEFT JOIN tags t       ON t.id = ft.tag_id"""


def parse_file(row: dict) -> dict:
    row = dict(row)
    row["tags"] = row["tags"].split("||") if row.get("tags") else []
    row["is_favourite"] = bool(row.get("is_favourite", 0))
    return row


def vec_str(embedding: list[float]) -> str:
    return f"[{','.join(str(v) for v in embedding)}]"


# ── Upload ─────────────────────────────────────────────────────────────────────

@router.post("/upload", status_code=201)
def upload_file(
    file: UploadFile = File(...),
    folder_id: Optional[str] = Form(None),
    user: dict = Depends(get_current_user),
):
    data = file.file.read()
    ext = os.path.splitext(file.filename)[1]
    r2_key = f"{date.today().isoformat()}/{uuid.uuid4()}{ext}"
    fid = int(folder_id) if folder_id and folder_id.isdigit() else None

    processed = extract_and_embed(data, file.filename, file.content_type or "")
    put_object(r2_key, data, file.content_type or "application/octet-stream")

    result = query(
        """INSERT INTO files
               (user_id, folder_id, r2_key, filename, mime_type, size_bytes,
                file_type, extracted_text, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?))""",
        (
            user["id"], fid, r2_key, file.filename,
            file.content_type or "application/octet-stream",
            len(data), processed["file_type"],
            processed["extracted_text"],
            vec_str(processed["embedding"]),
        ),
    )
    rows = query(f"{files_select()} WHERE f.id = ? GROUP BY f.id", (result["insert_id"],))
    return parse_file(rows[0])


# ── URL import helpers ─────────────────────────────────────────────────────────

def resolve_download_url(input_url: str) -> tuple[str, str]:
    """Return (direct_download_url, source_label)."""
    # Google Drive: /file/d/{id}/view  or  /open?id={id}
    gd = re.search(r'drive\.google\.com/file/d/([^/?]+)', input_url)
    if gd:
        return (f"https://drive.usercontent.google.com/download?id={gd.group(1)}&export=download&authuser=0&confirm=t",
                "Google Drive")
    gd_open = re.search(r'drive\.google\.com/open\?.*id=([^&]+)', input_url)
    if gd_open:
        return (f"https://drive.usercontent.google.com/download?id={gd_open.group(1)}&export=download&authuser=0&confirm=t",
                "Google Drive")

    # OneDrive / SharePoint
    if any(x in input_url for x in ('1drv.ms', 'onedrive.live.com', 'sharepoint.com')):
        import base64
        encoded = base64.b64encode(input_url.encode()).decode().rstrip('=').replace('/', '_').replace('+', '-')
        return (f"https://api.onedrive.com/v1.0/shares/u!{encoded}/root/content", "OneDrive")

    # Dropbox: force direct download
    if 'dropbox.com' in input_url:
        direct = input_url.replace('?dl=0', '?dl=1').replace('www.dropbox.com', 'dl.dropboxusercontent.com')
        return (direct, "Dropbox")

    return (input_url, "Direct URL")


MIME_TO_EXT = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'image/jpeg': '.jpg', 'image/jpg': '.jpg',
    'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/svg+xml': '.svg', 'image/bmp': '.bmp',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
    'audio/ogg': '.ogg', 'audio/flac': '.flac',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
    'video/webm': '.webm', 'video/x-matroska': '.mkv',
    'text/plain': '.txt', 'text/html': '.html', 'text/csv': '.csv',
    'application/zip': '.zip', 'application/json': '.json',
}

def ext_from_mime(mime: str) -> str:
    """Best-guess file extension from a MIME type."""
    return MIME_TO_EXT.get(mime.split(';')[0].strip(), '')

def ensure_ext(name: str, fallback_ext: str) -> str:
    """If name has no extension, append fallback_ext."""
    if fallback_ext and not os.path.splitext(name)[1]:
        return name + fallback_ext
    return name

def filename_from_response(response: httpx.Response, fallback_url: str) -> str:
    cd = response.headers.get('content-disposition', '')
    m = re.search(r'filename[^;=\n]*=(([\'"]).*?\2|[^;\n]*)', cd)
    if m:
        return m.group(1).strip().strip('"\'')
    try:
        from urllib.parse import urlparse, unquote
        p = urlparse(fallback_url).path.split('/')[-1]
        if p and '.' in p:
            return unquote(p)
    except Exception:
        pass
    return 'imported-file'


def assert_not_html(response: httpx.Response, source: str) -> None:
    ct = response.headers.get('content-type', '')
    if 'text/html' in ct:
        if source == 'Google Drive':
            raise HTTPException(400,
                "Google Drive returned a login or virus-scan page. "
                "Ensure the file is shared as 'Anyone with the link' and is under 100 MB.")
        raise HTTPException(400,
            f"{source} returned an HTML page instead of a file. "
            "Check the link is a direct public share URL.")


class ImportUrlIn(BaseModel):
    url: str
    filename: Optional[str] = None
    folder_id: Optional[int] = None


# POST /files/import-url — MUST be before /{file_id} routes
@router.post("/import-url", status_code=201)
def import_url(body: ImportUrlIn, user: dict = Depends(get_current_user)):
    if not body.url:
        raise HTTPException(400, "url required")

    download_url, source = resolve_download_url(body.url.strip())
    print(f"[import-url] {source} → {download_url}")

    try:
        with httpx.Client(follow_redirects=True, timeout=60,
                          headers={"User-Agent": "Mozilla/5.0 FILEHUB/1.0"}) as client:
            response = client.get(download_url)

        if response.status_code != 200:
            raise HTTPException(400, f"{source} returned {response.status_code} {response.reason_phrase}")

        assert_not_html(response, source)

        data = response.content
        if len(data) > 100 * 1024 * 1024:
            raise HTTPException(400, "File exceeds 100 MB limit")

        mime_type    = response.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
        original_name = filename_from_response(response, download_url)
        original_ext  = os.path.splitext(original_name)[1] or ext_from_mime(mime_type)
        # If user provided a custom name but omitted the extension, preserve the original one
        filename = ensure_ext(body.filename, original_ext) if body.filename else original_name
        ext      = os.path.splitext(filename)[1]
        r2_key    = f"{date.today().isoformat()}/{uuid.uuid4()}{ext}"
        fid       = body.folder_id

        processed = extract_and_embed(data, filename, mime_type)
        put_object(r2_key, data, mime_type)

        result = query(
            """INSERT INTO files
                   (user_id, folder_id, r2_key, filename, mime_type, size_bytes,
                    file_type, extracted_text, embedding)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?))""",
            (user["id"], fid, r2_key, filename, mime_type, len(data),
             processed["file_type"], processed["extracted_text"],
             vec_str(processed["embedding"])),
        )
        rows = query(f"{files_select()} WHERE f.id = ? GROUP BY f.id", (result["insert_id"],))
        return {**parse_file(rows[0]), "source": source}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[import-url] error: {e}")
        raise HTTPException(500, str(e) or "Import failed — check server logs")


# ── List ───────────────────────────────────────────────────────────────────────

@router.get("/")
def list_files(
    limit: int = 50,
    offset: int = 0,
    sort: str = "uploaded_at",
    order: str = "desc",
    type: Optional[str] = None,
    folder_id: Optional[str] = None,
    favourites: Optional[str] = None,
    tag: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    limit  = max(1, min(limit, 200))
    offset = max(0, offset)
    if sort  not in VALID_SORT:  sort  = "uploaded_at"
    if order not in VALID_ORDER: order = "desc"

    conditions = ["f.user_id = ?", "f.deleted_at IS NULL"]
    params: list = [user["id"]]

    if type and type in VALID_TYPES:
        conditions.append("f.file_type = ?"); params.append(type)
    if folder_id == "none":
        conditions.append("f.folder_id IS NULL")
    elif folder_id:
        conditions.append("f.folder_id = ?"); params.append(int(folder_id))
    if favourites == "1":
        conditions.append("f.is_favourite = 1")
    if tag:
        conditions.append(
            "EXISTS (SELECT 1 FROM file_tags ft2 JOIN tags t2 ON t2.id = ft2.tag_id "
            "WHERE ft2.file_id = f.id AND t2.name = ? AND t2.user_id = ?)"
        )
        params.extend([tag, user["id"]])

    where = "WHERE " + " AND ".join(conditions)
    count_row = query(
        f"SELECT COUNT(DISTINCT f.id) AS total FROM files f {where}", tuple(params)
    )[0]
    rows = query(
        f"{files_select()} {where} GROUP BY f.id ORDER BY f.{sort} {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    return {"total": count_row["total"], "files": [parse_file(r) for r in rows]}


# ── Single file ────────────────────────────────────────────────────────────────

@router.get("/{file_id}")
def get_file(file_id: int, user: dict = Depends(get_current_user)):
    rows = query(
        """SELECT f.id, f.r2_key, f.filename, f.mime_type, f.size_bytes, f.file_type,
                  f.folder_id, f.is_favourite, f.extracted_text, f.uploaded_at,
                  GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '||') AS tags
           FROM files f
           LEFT JOIN file_tags ft ON ft.file_id = f.id
           LEFT JOIN tags t       ON t.id = ft.tag_id
           WHERE f.id = ? AND f.user_id = ? AND f.deleted_at IS NULL
           GROUP BY f.id""",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "Not found")
    return parse_file(rows[0])


# ── Rename ─────────────────────────────────────────────────────────────────────

class RenameIn(BaseModel):
    filename: str

@router.patch("/{file_id}")
def rename_file(file_id: int, body: RenameIn, user: dict = Depends(get_current_user)):
    new_name = body.filename.strip()
    if not new_name:
        raise HTTPException(400, "filename required")
    # Fetch current filename so we can preserve the extension if user omitted it
    current = query(
        "SELECT filename FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (file_id, user["id"]),
    )
    if not current:
        raise HTTPException(404, "Not found")
    original_ext = os.path.splitext(current[0]["filename"])[1]
    new_name = ensure_ext(new_name, original_ext)
    r = query(
        "UPDATE files SET filename = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (new_name, file_id, user["id"]),
    )
    if not r["affected_rows"]:
        raise HTTPException(404, "Not found")
    rows = query(f"{files_select()} WHERE f.id = ? GROUP BY f.id", (file_id,))
    return parse_file(rows[0])


# ── Favourite ──────────────────────────────────────────────────────────────────

@router.patch("/{file_id}/favourite")
def toggle_favourite(file_id: int, user: dict = Depends(get_current_user)):
    rows = query(
        "SELECT is_favourite FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "Not found")
    new_val = 0 if rows[0]["is_favourite"] else 1
    query("UPDATE files SET is_favourite = ? WHERE id = ?", (new_val, file_id))
    return {"is_favourite": bool(new_val)}


# ── Move folder ────────────────────────────────────────────────────────────────

class FolderMoveIn(BaseModel):
    folder_id: Optional[int] = None

@router.patch("/{file_id}/folder")
def move_folder(file_id: int, body: FolderMoveIn, user: dict = Depends(get_current_user)):
    r = query(
        "UPDATE files SET folder_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (body.folder_id, file_id, user["id"]),
    )
    if not r["affected_rows"]:
        raise HTTPException(404, "Not found")
    return {"folder_id": body.folder_id}


# ── Tags ───────────────────────────────────────────────────────────────────────

@router.post("/{file_id}/tags/{name}")
def add_tag(file_id: int, name: str, user: dict = Depends(get_current_user)):
    name = name.strip().lower()
    if not name:
        raise HTTPException(400, "tag name required")
    query("INSERT IGNORE INTO tags (user_id, name) VALUES (?, ?)", (user["id"], name))
    tag_rows = query("SELECT id FROM tags WHERE user_id = ? AND name = ?", (user["id"], name))
    query("INSERT IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)", (file_id, tag_rows[0]["id"]))
    return {"tag": name}


@router.delete("/{file_id}/tags/{name}")
def remove_tag(file_id: int, name: str, user: dict = Depends(get_current_user)):
    name = name.strip().lower()
    tag_rows = query("SELECT id FROM tags WHERE user_id = ? AND name = ?", (user["id"], name))
    if tag_rows:
        query("DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?", (file_id, tag_rows[0]["id"]))
    return {"removed": True}


# ── Re-index ───────────────────────────────────────────────────────────────────

@router.post("/{file_id}/reindex")
def reindex_file(file_id: int, user: dict = Depends(get_current_user)):
    rows = query(
        "SELECT id, r2_key, filename, mime_type FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "Not found")
    f = rows[0]
    data = get_object(f["r2_key"])
    processed = extract_and_embed(data, f["filename"], f["mime_type"])
    query(
        "UPDATE files SET file_type = ?, extracted_text = ?, embedding = VEC_FromText(?) WHERE id = ?",
        (processed["file_type"], processed["extracted_text"], vec_str(processed["embedding"]), file_id),
    )
    return {"reindexed": True, "file_type": processed["file_type"]}


# ── Download ───────────────────────────────────────────────────────────────────

@router.get("/{file_id}/download")
def download_file(file_id: int, user: dict = Depends(get_current_user)):
    rows = query(
        "SELECT r2_key FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "Not found")
    url = get_presigned_url(rows[0]["r2_key"], 900)
    return {"url": url, "expires_in": 900}


# ── Delete (soft) ──────────────────────────────────────────────────────────────

@router.delete("/{file_id}")
def delete_file(file_id: int, user: dict = Depends(get_current_user)):
    rows = query(
        "SELECT r2_key FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "Not found")
    # Soft delete — keeps the row for temporal recovery; R2 object is preserved too
    query("UPDATE files SET deleted_at = NOW() WHERE id = ? AND user_id = ?", (file_id, user["id"]))
    return {"deleted": True}
