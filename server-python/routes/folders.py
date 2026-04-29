from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from db import query
from deps import get_current_user

router = APIRouter()


class FolderIn(BaseModel):
    name: str


@router.get("/")
def list_folders(user: dict = Depends(get_current_user)):
    rows = query(
        """SELECT f.id, f.name, f.created_at,
                  COUNT(fi.id) AS file_count
           FROM folders f
           LEFT JOIN files fi ON fi.folder_id = f.id
                             AND fi.user_id = f.user_id
                             AND fi.deleted_at IS NULL
           WHERE f.user_id = ?
           GROUP BY f.id
           ORDER BY f.name""",
        (user["id"],),
    )
    return {"folders": rows}


@router.post("/", status_code=201)
def create_folder(body: FolderIn, user: dict = Depends(get_current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name required")
    try:
        result = query(
            "INSERT INTO folders (user_id, name) VALUES (?, ?)",
            (user["id"], name),
        )
        return {"folder": {"id": result["insert_id"], "name": name, "file_count": 0}}
    except Exception as e:
        if "Duplicate" in str(e):
            # Return the existing folder so clients can reuse it
            rows = query(
                "SELECT id, name FROM folders WHERE user_id = ? AND name = ?",
                (user["id"], name),
            )
            existing = rows[0] if rows else None
            return JSONResponse(
                status_code=409,
                content={"error": "Folder name already exists", "folder": existing},
            )
        raise HTTPException(500, str(e))


@router.patch("/{folder_id}")
def rename_folder(folder_id: int, body: FolderIn, user: dict = Depends(get_current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name required")
    query(
        "UPDATE folders SET name = ? WHERE id = ? AND user_id = ?",
        (name, folder_id, user["id"]),
    )
    return {"id": folder_id, "name": name}


@router.delete("/{folder_id}")
def delete_folder(folder_id: int, user: dict = Depends(get_current_user)):
    query(
        "UPDATE files SET folder_id = NULL WHERE folder_id = ? AND user_id = ?",
        (folder_id, user["id"]),
    )
    query(
        "DELETE FROM folders WHERE id = ? AND user_id = ?",
        (folder_id, user["id"]),
    )
    return {"deleted": True}
