import os
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routes import auth, files, search, folders, stats, recovery

app = FastAPI(title="File Hub API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,     prefix="/auth")
app.include_router(files.router,    prefix="/files")
app.include_router(search.router,   prefix="/search")
app.include_router(folders.router,  prefix="/folders")
app.include_router(stats.router,    prefix="/stats")
app.include_router(recovery.router, prefix="/recovery")


@app.get("/health")
def health():
    return {"status": "ok"}


# Global exception handler — always returns JSON, never an HTML error page
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)})


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 3001))
    print(f"File Hub API (Python) running on http://localhost:{port}")

    missing = [v for v in ["OPENAI_API_KEY", "JWT_SECRET", "R2_ACCOUNT_ID"] if not os.getenv(v)]
    if missing:
        print(f"⚠  Missing env vars: {', '.join(missing)}")
    if not os.getenv("SMTP_USER"):
        print("⚠  SMTP_USER not set — password reset emails will fail")

    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
