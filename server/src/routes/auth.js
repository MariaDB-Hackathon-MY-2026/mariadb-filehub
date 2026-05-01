const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query }    = require('../db');
const { sendOtp }  = require('../mailer');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'FILEHUB-dev-secret';
const TOKEN_TTL  = '7d';

// POST /auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username.trim(), email.trim().toLowerCase(), hashed],
    );
    const user  = { id: result.insertId, username: username.trim(), email: email.trim().toLowerCase() };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email or username is already taken' });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const rows = await query('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const row   = rows[0];
    const valid = await bcrypt.compare(password, row.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const user  = { id: row.id, username: row.username, email: row.email };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/forgot-password — generate OTP and email it
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const normalised = email.trim().toLowerCase();
  try {
    const rows = await query('SELECT id FROM users WHERE email = ?', [normalised]);
    // Always return 200 to avoid user enumeration
    if (!rows.length) return res.json({ sent: true });

    // Generate 6-digit OTP
    const otp     = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Invalidate previous OTPs for this email
    await query('UPDATE password_resets SET used = 1 WHERE email = ?', [normalised]);

    await query(
      'INSERT INTO password_resets (email, otp, expires_at) VALUES (?, ?, ?)',
      [normalised, otp, expires],
    );

    await sendOtp(normalised, otp);
    res.json({ sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reset email — check SMTP settings' });
  }
});

// POST /auth/reset-password — verify OTP and update password
router.post('/reset-password', async (req, res) => {
  const { email, otp, password } = req.body || {};
  if (!email || !otp || !password) {
    return res.status(400).json({ error: 'email, otp and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const normalised = email.trim().toLowerCase();
  try {
    const rows = await query(
      `SELECT id FROM password_resets
       WHERE email = ? AND otp = ? AND used = 0 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [normalised, otp.trim()],
    );
    if (!rows.length) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await Promise.all([
      query('UPDATE users SET password = ? WHERE email = ?', [hashed, normalised]),
      query('UPDATE password_resets SET used = 1 WHERE email = ?', [normalised]),
    ]);

    res.json({ reset: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
