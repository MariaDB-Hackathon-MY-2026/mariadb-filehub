import os
import base64
import io
from openai import OpenAI

_client: OpenAI | None = None


def _oai() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


def embed_text(text: str) -> list[float]:
    """Embed text with text-embedding-3-small → 1536-dim vector."""
    resp = _oai().embeddings.create(
        model="text-embedding-3-small",
        input=text[:8000],
    )
    return resp.data[0].embedding


def describe_image(data: bytes, mime_type: str) -> str:
    """Use GPT-4o vision to describe an image in 2-3 sentences."""
    b64 = base64.b64encode(data).decode()
    resp = _oai().chat.completions.create(
        model="gpt-4o",
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
                {"type": "text",
                 "text": "Describe this image in 2-3 sentences for search indexing purposes."},
            ],
        }],
        max_tokens=200,
    )
    return resp.choices[0].message.content or ""


def transcribe_audio(data: bytes, filename: str) -> str:
    """Transcribe audio with Whisper-1."""
    audio_file = (filename, io.BytesIO(data))
    resp = _oai().audio.transcriptions.create(model="whisper-1", file=audio_file)
    return resp.text
