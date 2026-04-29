import os
import io
from embed import embed_text, describe_image, transcribe_audio

CODE_EXTENSIONS = {
    ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".kt",
    ".cpp", ".c", ".h", ".cs", ".php", ".swift",
    ".sh", ".bash", ".zsh", ".ps1",
    ".sql", ".html", ".css", ".scss",
    ".yaml", ".yml", ".toml", ".json", ".xml",
}

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}


def detect_file_type(filename: str, mime_type: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if mime_type == "application/pdf":
        return "pdf"
    if (mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            or ext == ".docx"):
        return "docx"
    if mime_type.startswith("image/"):
        return "image"
    if mime_type.startswith("audio/") or ext in AUDIO_EXTENSIONS:
        return "audio"
    if mime_type.startswith("video/") or ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in CODE_EXTENSIONS:
        return "code"
    return "other"


def extract_and_embed(data: bytes, filename: str, mime_type: str) -> dict:
    """
    Returns:
        file_type     : str
        extracted_text: str | None
        embedding     : list[float]
    """
    file_type = detect_file_type(filename, mime_type)
    extracted_text = None

    if file_type == "pdf":
        import fitz  # PyMuPDF
        doc = fitz.open(stream=data, filetype="pdf")
        extracted_text = "".join(page.get_text() for page in doc)
        embedding = embed_text(extracted_text)

    elif file_type == "docx":
        from docx import Document
        doc = Document(io.BytesIO(data))
        extracted_text = "\n".join(p.text for p in doc.paragraphs)
        embedding = embed_text(extracted_text)

    elif file_type == "image":
        extracted_text = describe_image(data, mime_type)
        embedding = embed_text(extracted_text)

    elif file_type == "audio":
        extracted_text = transcribe_audio(data, filename)
        embedding = embed_text(extracted_text)

    elif file_type == "video":
        fallback = f"video file: {filename} | type: {mime_type}"
        embedding = embed_text(fallback)

    elif file_type == "code":
        extracted_text = data.decode("utf-8", errors="replace")
        embedding = embed_text(extracted_text)

    else:
        fallback = f"filename: {filename} | type: {mime_type}"
        embedding = embed_text(fallback)

    return {"file_type": file_type, "extracted_text": extracted_text, "embedding": embedding}
