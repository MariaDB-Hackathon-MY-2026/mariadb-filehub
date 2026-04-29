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

// ── URL import helpers ─────────────────────────────────────────
function resolveDownloadUrl(inputUrl) {
  // Google Drive: /file/d/{id}/view  or  /open?id={id}
  // Use drive.usercontent.google.com — more reliable than the old /uc endpoint
  const gdFile = inputUrl.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (gdFile) return {
    url: `https://drive.usercontent.google.com/download?id=${gdFile[1]}&export=download&authuser=0&confirm=t`,
    source: 'Google Drive',
  };
  const gdOpen = inputUrl.match(/drive\.google\.com\/open\?.*id=([^&]+)/);
  if (gdOpen) return {
    url: `https://drive.usercontent.google.com/download?id=${gdOpen[1]}&export=download&authuser=0&confirm=t`,
    source: 'Google Drive',
  };

  // OneDrive / 1drv.ms — encode share URL for MS Graph anonymous share API
  if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(inputUrl)) {
    const encoded = Buffer.from(inputUrl).toString('base64')
      .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    return { url: `https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`, source: 'OneDrive' };
  }

  // Dropbox: force direct download
  if (inputUrl.includes('dropbox.com')) {
    const direct = inputUrl.replace('?dl=0', '?dl=1')
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com');
    return { url: direct, source: 'Dropbox' };
  }

  // S3 / direct link — use as-is
  return { url: inputUrl, source: 'Direct URL' };
}

const MIME_TO_EXT = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
  'audio/ogg': '.ogg', 'audio/flac': '.flac',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
  'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
  'application/zip': '.zip',
};

function extFromMime(mime) { return MIME_TO_EXT[mime.split(';')[0].trim()] || ''; }

function ensureExt(name, fallbackExt) {
  if (fallbackExt && !path.extname(name)) return name + fallbackExt;
  return name;
}

function filenameFromResponse(response, fallbackUrl) {
  const cd = response.headers.get('content-disposition') || '';
  const cdMatch = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (cdMatch) return decodeURIComponent(cdMatch[1].replace(/['"]/g, '').trim());
  try {
    const p = new URL(fallbackUrl).pathname.split('/').pop();
    if (p && p.includes('.')) return decodeURIComponent(p);
  } catch {}
  return 'imported-file';
}

function assertNotHtml(response, source) {
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    if (source === 'Google Drive') {
      throw new Error('Google Drive returned a login or virus-scan page. Make sure the file is shared as "Anyone with the link" and is under 100 MB.');
    }
    throw new Error(`${source} returned an HTML page instead of a file. Check the link is a direct public share URL.`);
  }
}

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

// POST /files/import-url  { url, filename?, folder_id? }
router.post('/import-url', async (req, res) => {
  const { url: inputUrl, filename: customName, folder_id } = req.body;
  if (!inputUrl || typeof inputUrl !== 'string') return res.status(400).json({ error: 'url required' });

  try {
    const { url: downloadUrl, source } = resolveDownloadUrl(inputUrl.trim());
    console.log(`[import-url] ${source} → ${downloadUrl}`);

    // Download the file (max 100 MB, 60 s timeout)
    const response = await fetch(downloadUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 FileVault/1.0' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${source} returned ${response.status} ${response.statusText}`);
    assertNotHtml(response, source);  // catch HTML warning/login pages

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 100 * 1024 * 1024) throw new Error('File exceeds 100 MB limit');

    const buffer       = Buffer.from(await response.arrayBuffer());
    const mimeType     = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const originalName = filenameFromResponse(response, downloadUrl);
    const originalExt  = path.extname(originalName) || extFromMime(mimeType);
    // Preserve extension when user provides a custom name without one
    const filename     = customName?.trim() ? ensureExt(customName.trim(), originalExt) : originalName;
    const ext          = path.extname(filename) || '';
    const r2Key    = `${new Date().toISOString().slice(0, 10)}/${uuidv4()}${ext}`;
    const folderId = folder_id ? Number(folder_id) : null;

    const { fileType, extractedText, embedding } = await extractAndEmbed(buffer, filename, mimeType);
    await putObject(r2Key, buffer, mimeType);
    const vecStr = `[${embedding.join(',')}]`;
    const result = await query(
      `INSERT INTO files (user_id, folder_id, r2_key, filename, mime_type, size_bytes, file_type, extracted_text, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?))`,
      [req.user.id, folderId, r2Key, filename, mimeType, buffer.length, fileType, extractedText, vecStr],
    );
    const rows = await query(`${filesSelect()} WHERE f.id = ? GROUP BY f.id`, [result.insertId]);
    res.status(201).json({ ...parseFile(rows[0]), source });
  } catch (err) { console.error('[import-url]', err); res.status(500).json({ error: err.message }); }
});

// GET /files
router.get('/', async (req, res) => {
  let { limit = 50, offset = 0, sort = 'uploaded_at', order = 'desc', type, folder_id, favourites, tag } = req.query;
  limit  = Math.min(Math.max(Number(limit)  || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  if (!VALID_SORT.has(sort))  sort  = 'uploaded_at';
  if (!VALID_ORDER.has(order)) order = 'desc';

  const conditions = ['f.user_id = ?', 'f.deleted_at IS NULL'];
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
    // Fetch current filename to preserve extension if user omitted it
    const current = await query('SELECT filename FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.id, req.user.id]);
    if (!current.length) return res.status(404).json({ error: 'Not found' });
    const originalExt = path.extname(current[0].filename);
    const newName     = ensureExt(filename.trim(), originalExt);
    const result = await query('UPDATE files SET filename = ? WHERE id = ? AND user_id = ?', [newName, req.params.id, req.user.id]);
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

// DELETE /files/:id  — soft delete (moves to trash, recoverable)
router.delete('/:id', async (req, res) => {
  try {
    const rows = await query('SELECT r2_key FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await query('UPDATE files SET deleted_at = NOW() WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ deleted: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
