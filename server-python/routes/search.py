from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from db import query
from embed import embed_text
from deps import get_current_user

router = APIRouter()

VALID_TYPES = {"pdf", "docx", "image", "audio", "video", "code", "other"}


class SearchIn(BaseModel):
    query: str
    limit: int = 10
    type: Optional[str] = None


@router.post("/")
def search(body: SearchIn, user: dict = Depends(get_current_user)):
    if not body.query:
        raise HTTPException(400, "query string required")

    k = max(1, min(body.limit, 50))
    conditions = ["user_id = ?", "deleted_at IS NULL"]
    params: list = [user["id"]]

    if body.type and body.type in VALID_TYPES:
        conditions.append("file_type = ?")
        params.append(body.type)

    where = "WHERE " + " AND ".join(conditions)
    embedding = embed_text(body.query)
    vec_str = f"[{','.join(str(v) for v in embedding)}]"

    rows = query(
        f"""SELECT id, filename, file_type, is_favourite, uploaded_at,
                   VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS distance
            FROM files
            {where}
            ORDER BY distance ASC
            LIMIT ?""",
        (vec_str, *params, k),
    )
    results = [
        {**r, "is_favourite": bool(r["is_favourite"]), "distance": float(r["distance"])}
        for r in rows
    ]
    return {"results": results}
