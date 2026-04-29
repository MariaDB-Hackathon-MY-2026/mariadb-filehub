const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Gmail App Password (not your login password)
  },
});

async function sendOtp(toEmail, otp) {
  await transporter.sendMail({
    from: `"File Vault" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Your File Vault Password Reset Code',
    html: `
      <div style="font-family:monospace;background:#07080d;color:#e2e8f0;padding:32px;border-radius:8px;max-width:400px">
        <h2 style="color:#f59e0b;letter-spacing:4px">FILE<span>VAULT</span></h2>
        <p style="margin-top:16px">Your password reset code is:</p>
        <div style="font-size:36px;font-weight:bold;color:#f59e0b;letter-spacing:8px;margin:20px 0">${otp}</div>
        <p style="color:#64748b;font-size:12px">This code expires in <strong>15 minutes</strong>.<br/>If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendOtp };
