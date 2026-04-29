const express = require('express');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const { query } = require('../db');
const { putObject, deleteObject, getPresignedUrl, getObject } = require('../r2');
const { extractAndEmbed } = require('../processor');
const auth    = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const VALID_SORT  = new Set(['uploaded_at', 'filename', 'size_bytes']);
const VALID_ORDER = new Set(['asc', 'desc']);
const VALID_TYPES = new Set(['pdf', 'docx', 'image', 'audio', 'video', 'code', 'other']);

router.use(auth);

// ── Helpers ────────────────────────────────────────────────────
function filesSelect() {
  return `SELECT f.id, f.r2_key, f.filename, f.mime_type, f.size_bytes,
                 f.file_type, f.folder_id, f.is_favourite, f.uploaded_at,
                 GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '||') AS tags
          FROM files f
          LEFT JOIN file_tags ft ON ft.file_id = f.id
          LEFT JOIN tags t       ON t.id = ft.tag_id`;
}

function parseFile(row) {
  return { ...row, tags: row.tags ? row.tags.split('||') : [], is_favourite: !!row.is_favourite };
}

// POST /files/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const { originalname, mimetype, buffer, size } = req.file;
  const ext   = path.extname(originalname);
  const r2Key = `${new Date().toISOString().slice(0, 10)}/${uuidv4()}${ext}`;
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
  try {
    const { fileType, extractedText, embedding } = await extractAndEmbed(buffer, originalname, mimetype);
    await putObject(r2Key, buffer, mimetype);
    const vecStr = `[${embedding.join(',')}]`;
    const result = await query(
      `INSERT INTO files (user_id, folder_id, r2_key, filename, mime_type, size_bytes, file_type, extracted_text, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?))`,
      [req.user.id, folderId, r2Key, originalname, mimetype, size, fileType, extractedText, vecStr],
    );
    const rows = await query(`${filesSelect()} WHERE f.id = ? GROUP BY f.id`, [result.insertId]);
    res.status(201).json(parseFile(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /files
router.get('/', async (req, res) => {
  let { limit = 50, offset = 0, sort = 'uploaded_at', order = 'desc', type, folder_id, favourites, tag } = req.query;
  limit  = Math.min(Math.max(Number(limit)  || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  if (!VALID_SORT.has(sort))  sort  = 'uploaded_at';
  if (!VALID_ORDER.has(order)) order = 'desc';

  const conditions = ['f.user_id = ?'];
  const params     = [req.user.id];

  if (type && VALID_TYPES.has(type))   { conditions.push('f.file_type = ?');     params.push(type); }
  if (folder_id === 'none')            { conditions.push('f.folder_id IS NULL'); }
  else if (folder_id)                  { conditions.push('f.folder_id = ?');     params.push(Number(folder_id)); }
  if (favourites === '1')              { conditions.push('f.is_favourite = 1');  }
  if (tag)                             { conditions.push('EXISTS (SELECT 1 FROM file_tags ft2 JOIN tags t2 ON t2.id = ft2.tag_id WHERE ft2.file_id = f.id AND t2.name = ? AND t2.user_id = ?)');
                                         params.push(tag, req.user.id); }

  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const [countRows, rows] = await Promise.all([
      query(`SELECT COUNT(DISTINCT f.id) AS total FROM files f ${where}`, params),
      query(
        `${filesSelect()} ${where} GROUP BY f.id ORDER BY f.${sort} ${order} LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
    ]);
    res.json({ total: countRows[0].total, files: rows.map(parseFile) });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /files/:id
router.get('/:id', async (req, res) => {
  try {
    const rows = await query(
      `SELECT f.id, f.r2_key, f.filename, f.mime_type, f.size_bytes, f.file_type,
              f.folder_id, f.is_favourite, f.extracted_text, f.uploaded_at,
              GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '||') AS tags
       FROM files f
       LEFT JOIN file_tags ft ON ft.file_id = f.id
       LEFT JOIN tags t       ON t.id = ft.tag_id
       WHERE f.id = ? AND f.user_id = ?
       GROUP BY f.id`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(parseFile(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// PATCH /files/:id — rename
router.patch('/:id', async (req, res) => {
  const { filename } = req.body;
  if (!filename?.trim()) return res.status(400).json({ error: 'filename required' });
  try {
    const result = await query('UPDATE files SET filename = ? WHERE id = ? AND user_id = ?', [filename.trim(), req.params.id, req.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    const rows = await query(`${filesSelect()} WHERE f.id = ? GROUP BY f.id`, [req.params.id]);
    res.json(parseFile(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// PATCH /files/:id/favourite — toggle
router.patch('/:id/favourite', async (req, res) => {
  try {
    const rows = await query('SELECT is_favourite FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const newVal = rows[0].is_favourite ? 0 : 1;
    await query('UPDATE files SET is_favourite = ? WHERE id = ?', [newVal, req.params.id]);
    res.json({ is_favourite: !!newVal });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// PATCH /files/:id/folder — move to folder (null = remove from folder)
router.patch('/:id/folder', async (req, res) => {
  const folderId = req.body.folder_id ?? null;
  try {
    const result = await query('UPDATE files SET folder_id = ? WHERE id = ? AND user_id = ?', [folderId, req.params.id, req.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ folder_id: folderId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// POST /files/:id/tags/:name — add tag
router.post('/:id/tags/:name', async (req, res) => {
  const tagName = req.params.name.trim().toLowerCase();
  if (!tagName) return res.status(400).json({ error: 'tag name required' });
  try {
    // Upsert tag
    await query('INSERT IGNORE INTO tags (user_id, name) VALUES (?, ?)', [req.user.id, tagName]);
    const tagRows = await query('SELECT id FROM tags WHERE user_id = ? AND name = ?', [req.user.id, tagName]);
    await query('INSERT IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', [req.params.id, tagRows[0].id]);
    res.json({ tag: tagName });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE /files/:id/tags/:name — remove tag
router.delete('/:id/tags/:name', async (req, res) => {
  const tagName = req.params.name.trim().toLowerCase();
  try {
    const tagRows = await query('SELECT id FROM tags WHERE user_id = ? AND name = ?', [req.user.id, tagName]);
    if (tagRows.length) {
      await query('DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?', [req.params.id, tagRows[0].id]);
    }
    res.json({ removed: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// POST /files/:id/reindex
router.post('/:id/reindex', async (req, res) => {
  try {
    const rows = await query('SELECT id, r2_key, filename, mime_type FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { r2_key, filename, mime_type } = rows[0];
    const buffer = await getObject(r2_key);
    const { fileType, extractedText, embedding } = await extractAndEmbed(buffer, filename, mime_type);
    const vecStr = `[${embedding.join(',')}]`;
    await query('UPDATE files SET file_type = ?, extracted_text = ?, embedding = VEC_FromText(?) WHERE id = ?', [fileType, extractedText, vecStr, req.params.id]);
    res.json({ reindexed: true, file_type: fileType });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /files/:id/download
router.get('/:id/download', async (req, res) => {
  try {
    const rows = await query('SELECT r2_key FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const url = await getPresignedUrl(rows[0].r2_key, 900);
    res.json({ url, expires_in: 900 });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE /files/:id
router.delete('/:id', async (req, res) => {
  try {
    const rows = await query('SELECT r2_key FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await Promise.all([
      deleteObject(rows[0].r2_key),
      query('DELETE FROM file_tags WHERE file_id = ?', [req.params.id]),
      query('DELETE FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]),
    ]);
    res.json({ deleted: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
