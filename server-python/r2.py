import os
import boto3
from botocore.config import Config

_client = None


def _s3():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=f"https://{os.getenv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
            aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
            config=Config(signature_version="s3v4"),
            region_name="auto",
        )
    return _client


BUCKET = lambda: os.getenv("R2_BUCKET", "filevault")


def put_object(key: str, data: bytes, content_type: str) -> None:
    _s3().put_object(Bucket=BUCKET(), Key=key, Body=data, ContentType=content_type)


def delete_object(key: str) -> None:
    _s3().delete_object(Bucket=BUCKET(), Key=key)


def get_object(key: str) -> bytes:
    resp = _s3().get_object(Bucket=BUCKET(), Key=key)
    return resp["Body"].read()


def get_presigned_url(key: str, expires: int = 900) -> str:
    return _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET(), "Key": key},
        ExpiresIn=expires,
    )
