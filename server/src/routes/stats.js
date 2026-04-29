const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

// GET /stats
router.get('/', async (req, res) => {
  const uid = req.user.id;
  try {
    const [totals, byType, recent] = await Promise.all([
      query(
        'SELECT COUNT(*) AS total_files, COALESCE(SUM(size_bytes), 0) AS total_bytes FROM files WHERE user_id = ?',
        [uid],
      ),
      query(
        'SELECT file_type, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM files WHERE user_id = ? GROUP BY file_type',
        [uid],
      ),
      query(
        'SELECT id, filename, file_type, size_bytes, uploaded_at FROM files WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 5',
        [uid],
      ),
    ]);
    res.json({
      total_files:    totals[0].total_files,
      total_bytes:    totals[0].total_bytes,
      by_type:        byType,
      recent_uploads: recent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
