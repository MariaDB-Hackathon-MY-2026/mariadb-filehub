const express = require('express');
const { query } = require('../db');
const { deleteObject } = require('../r2');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /recovery — list soft-deleted files
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, filename, file_type, size_bytes, uploaded_at, deleted_at
       FROM files FOR SYSTEM_TIME ALL
       WHERE user_id = ?
         AND deleted_at IS NOT NULL
         AND deleted_at < TIMESTAMP'9999-12-31 23:59:59'
       ORDER BY deleted_at DESC`,
      [req.user.id],
    );
    res.json({ files: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// POST /recovery/:id — restore
router.post('/:id', async (req, res) => {
  try {
    const rows = await query(
      'SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL',
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Deleted file not found' });
    await query('UPDATE files SET deleted_at = NULL WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ restored: true, file_id: Number(req.params.id) });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /recovery/:id/history — temporal change log
router.get('/:id/history', async (req, res) => {
  try {
    const rows = await query(
      `SELECT filename, file_type, folder_id, is_favourite, deleted_at,
              ROW_START AS changed_at, ROW_END AS valid_until
       FROM files FOR SYSTEM_TIME ALL
       WHERE id = ? AND user_id = ?
       ORDER BY ROW_START ASC`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const history = rows.map((r, i) => {
      let event = 'updated';
      if (i === 0)          event = 'uploaded';
      else if (r.deleted_at) event = 'deleted';
      else {
        const prev = rows[i - 1];
        const changes = [];
        if (r.filename     !== prev.filename)     changes.push('renamed');
        if (r.folder_id    !== prev.folder_id)    changes.push('moved');
        if (r.is_favourite !== prev.is_favourite) changes.push(r.is_favourite ? 'starred' : 'unstarred');
        event = changes.join(', ') || 'updated';
      }
      return { ...r, is_favourite: !!r.is_favourite, event };
    });
    res.json({ history });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE /recovery/:id/purge — permanent delete
router.delete('/:id/purge', async (req, res) => {
  try {
    const rows = await query(
      'SELECT r2_key FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL',
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found or not in trash' });

    // Try to remove from R2 — don't let R2 failure block DB cleanup
    let r2Warning = null;
    try {
      await deleteObject(rows[0].r2_key);
    } catch (r2Err) {
      r2Warning = `R2 removal skipped: ${r2Err.message || 'unknown error'}`;
      console.warn('R2 delete warning:', r2Err);
    }

    // Always clean up the database regardless of R2 result
    await query('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]);
    await query('DELETE FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);

    res.json({ purged: true, ...(r2Warning && { warning: r2Warning }) });
  } catch (err) {
    console.error('Purge error:', err);
    res.status(500).json({ error: err.message || 'Purge failed — check server logs' });
  }
});

module.exports = router;
