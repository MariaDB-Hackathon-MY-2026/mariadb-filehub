const express = require('express');
const { embedText } = require('../embed');
const { query } = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

const VALID_TYPES = new Set(['pdf','docx','image','audio','video','code','other']);

// POST /search  { query: string, limit?: number, type?: string }
router.post('/', async (req, res) => {
  const { query: queryText, limit = 10, type } = req.body;
  if (!queryText || typeof queryText !== 'string') {
    return res.status(400).json({ error: 'query string required' });
  }
  const k = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const conditions = ['user_id = ?'];
  const params     = [req.user.id];
  if (type && VALID_TYPES.has(type)) { conditions.push('file_type = ?'); params.push(type); }
  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const embedding = await embedText(queryText);
    const vecStr = `[${embedding.join(',')}]`;
    const rows = await query(
      `SELECT id, filename, file_type, is_favourite, uploaded_at,
              VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS distance
       FROM files
       ${where}
       ORDER BY distance ASC
       LIMIT ?`,
      [vecStr, ...params, k],
    );
    res.json({ results: rows.map(r => ({ ...r, is_favourite: !!r.is_favourite })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
