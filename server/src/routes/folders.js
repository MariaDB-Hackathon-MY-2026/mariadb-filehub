const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /folders
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT f.id, f.name, f.created_at,
              COUNT(fi.id) AS file_count
       FROM folders f
       LEFT JOIN files fi ON fi.folder_id = f.id AND fi.user_id = f.user_id
       WHERE f.user_id = ?
       GROUP BY f.id
       ORDER BY f.name`,
      [req.user.id],
    );
    res.json({ folders: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// POST /folders
router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const result = await query(
      'INSERT INTO folders (user_id, name) VALUES (?, ?)',
      [req.user.id, name.trim()],
    );
    res.status(201).json({ folder: { id: result.insertId, name: name.trim(), file_count: 0 } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      // Return the existing folder so clients can reuse it
      const [existing] = await query(
        'SELECT id, name FROM folders WHERE user_id = ? AND name = ?',
        [req.user.id, name.trim()],
      );
      return res.status(409).json({ error: 'Folder name already exists', folder: existing || null });
    }
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// PATCH /folders/:id — rename
router.patch('/:id', async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    await query('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', [name.trim(), req.params.id, req.user.id]);
    res.json({ id: Number(req.params.id), name: name.trim() });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE /folders/:id — remove folder, keep files (unset folder_id)
router.delete('/:id', async (req, res) => {
  try {
    await Promise.all([
      query('UPDATE files SET folder_id = NULL WHERE folder_id = ? AND user_id = ?', [req.params.id, req.user.id]),
      query('DELETE FROM folders WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]),
    ]);
    res.json({ deleted: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
