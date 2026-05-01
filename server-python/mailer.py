import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def send_otp(to_email: str, otp: str) -> None:
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")
    if not smtp_user:
        raise RuntimeError("SMTP_USER not configured")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "File Hub — Password Reset Code"
    msg["From"] = f"File Hub <{smtp_user}>"
    msg["To"] = to_email

    html = f"""
    <div style="font-family:monospace;background:#07080d;color:#e2e8f0;padding:32px;border-radius:8px;max-width:480px">
      <h2 style="color:#f59e0b;letter-spacing:3px">FILE<span style="color:#e2e8f0">VAULT</span></h2>
      <p style="color:#94a3b8">Your password reset code:</p>
      <div style="font-size:32px;letter-spacing:12px;color:#f59e0b;margin:20px 0;
                  border:1px solid rgba(245,158,11,.3);padding:16px;border-radius:6px;
                  text-align:center">{otp}</div>
      <p style="color:#64748b;font-size:12px">Expires in 15 minutes. If you didn't request this, ignore this email.</p>
    </div>
    """
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, to_email, msg.as_string())
