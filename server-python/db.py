import os
import mariadb
from typing import Any, Tuple

_pool: mariadb.ConnectionPool | None = None


def _get_pool() -> mariadb.ConnectionPool:
    global _pool
    if _pool is None:
        _pool = mariadb.ConnectionPool(
            host=os.getenv("DB_HOST", "127.0.0.1"),
            port=int(os.getenv("DB_PORT", "3306")),
            user=os.getenv("DB_USER", "root"),
            password=os.getenv("DB_PASSWORD", ""),
            database=os.getenv("DB_NAME", "filevault"),
            pool_name="filevault",
            pool_size=5,
        )
    return _pool


def query(sql: str, params: Tuple = ()) -> Any:
    """
    Execute SQL and return:
      - list[dict]  for SELECT / WITH / SHOW
      - dict        for INSERT / UPDATE / DELETE  →  {insert_id, affected_rows}
    """
    conn = _get_pool().get_connection()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)
        upper = sql.strip().upper()
        if upper.startswith(("SELECT", "WITH", "SHOW")):
            return cur.fetchall()
        conn.commit()
        return {"insert_id": cur.lastrowid, "affected_rows": cur.rowcount}
    finally:
        conn.close()
