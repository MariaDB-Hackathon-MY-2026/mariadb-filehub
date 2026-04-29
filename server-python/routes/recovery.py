"""
Recovery routes — powered by MariaDB System-Versioned Temporal Tables.

When a file is deleted, its row is soft-deleted (deleted_at = NOW()).
MariaDB's temporal versioning records every state change, so we can:
  - List all deleted files the current user has ever had
  - Show the exact time each file was deleted
  - Restore a file with one click (clears deleted_at)
  - View the full change history of any live file

Requires migration_temporal.sql to have been run.
"""

from fastapi import APIRouter, Depends, HTTPException

from db import query
from deps import get_current_user

router = APIRouter()


@router.get("/")
def list_recoverable(user: dict = Depends(get_current_user)):
    """
    Return all soft-deleted files for this user.
    Uses FOR SYSTEM_TIME ALL to reach rows hidden by temporal versioning.
    """
    rows = query(
        """SELECT id, filename, file_type, size_bytes, uploaded_at, deleted_at
           FROM files FOR SYSTEM_TIME ALL
           WHERE user_id = ?
             AND deleted_at IS NOT NULL
             AND deleted_at < TIMESTAMP'9999-12-31 23:59:59'
           ORDER BY deleted_at DESC""",
        (user["id"],),
    )
    return {"files": rows}


@router.post("/{file_id}")
def restore_file(file_id: int, user: dict = Depends(get_current_user)):
    """
    Restore a soft-deleted file by clearing deleted_at.
    The R2 object was never removed, so the file is immediately downloadable again.
    """
    # Verify the file belongs to this user and is currently deleted
    rows = query(
        "SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "Deleted file not found or already restored")

    query(
        "UPDATE files SET deleted_at = NULL WHERE id = ? AND user_id = ?",
        (file_id, user["id"]),
    )
    return {"restored": True, "file_id": file_id}


@router.get("/{file_id}/history")
def file_history(file_id: int, user: dict = Depends(get_current_user)):
    """
    Return the full change history of a file using MariaDB temporal tables.
    Shows every rename, folder move, favourite toggle, and deletion event.
    """
    rows = query(
        """SELECT filename, file_type, folder_id, is_favourite, deleted_at,
                  ROW_START AS changed_at,
                  ROW_END   AS valid_until
           FROM files FOR SYSTEM_TIME ALL
           WHERE id = ? AND user_id = ?
           ORDER BY ROW_START ASC""",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "File not found")
    history = []
    for i, r in enumerate(rows):
        r = dict(r)
        # Determine what changed compared to previous version
        if i == 0:
            r["event"] = "uploaded"
        elif r.get("deleted_at"):
            r["event"] = "deleted"
        else:
            prev = rows[i - 1]
            changes = []
            if r["filename"]     != prev["filename"]:     changes.append("renamed")
            if r["folder_id"]    != prev["folder_id"]:    changes.append("moved")
            if r["is_favourite"] != prev["is_favourite"]: changes.append("starred" if r["is_favourite"] else "unstarred")
            r["event"] = ", ".join(changes) if changes else "updated"
        history.append(r)
    return {"history": history}


@router.delete("/{file_id}/purge")
def purge_file(file_id: int, user: dict = Depends(get_current_user)):
    """
    Permanently delete a file (removes from R2 + hard-deletes the DB row).
    All temporal history for this file is also erased.
    Only works on already-soft-deleted files.
    """
    from r2 import delete_object

    rows = query(
        "SELECT r2_key FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL",
        (file_id, user["id"]),
    )
    if not rows:
        raise HTTPException(404, "File not found or not in trash")

    delete_object(rows[0]["r2_key"])
    query("DELETE FROM file_tags WHERE file_id = ?", (file_id,))
    query("DELETE FROM files WHERE id = ? AND user_id = ?", (file_id, user["id"]))
    return {"purged": True}
