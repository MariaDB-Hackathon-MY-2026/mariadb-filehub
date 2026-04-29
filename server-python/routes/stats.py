from fastapi import APIRouter, Depends

from db import query
from deps import get_current_user

router = APIRouter()


@router.get("/")
def get_stats(user: dict = Depends(get_current_user)):
    uid = user["id"]

    totals = query(
        "SELECT COUNT(*) AS total_files, COALESCE(SUM(size_bytes),0) AS total_bytes "
        "FROM files WHERE user_id = ? AND deleted_at IS NULL",
        (uid,),
    )[0]

    by_type = query(
        "SELECT file_type, COUNT(*) AS count FROM files "
        "WHERE user_id = ? AND deleted_at IS NULL GROUP BY file_type ORDER BY count DESC",
        (uid,),
    )

    recent = query(
        "SELECT id, filename, file_type, uploaded_at FROM files "
        "WHERE user_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC LIMIT 5",
        (uid,),
    )

    return {
        "total_files": totals["total_files"],
        "total_bytes": totals["total_bytes"],
        "by_type": by_type,
        "recent_uploads": recent,
    }
