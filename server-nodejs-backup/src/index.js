require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const authRouter    = require('./routes/auth');
const filesRouter   = require('./routes/files');
const searchRouter  = require('./routes/search');
const statsRouter   = require('./routes/stats');
const foldersRouter = require('./routes/folders');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/auth',    authRouter);
app.use('/files',   filesRouter);
app.use('/search',  searchRouter);
app.use('/stats',   statsRouter);
app.use('/folders', foldersRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Global JSON error handler — prevents HTML error pages
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`File Hub API running on http://localhost:${PORT}`);
  // Warn about missing critical env vars
  if (!process.env.SMTP_USER) console.warn('⚠  SMTP_USER not set — password reset emails will fail');
  if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET not set — using insecure default');
});
