// ── Config ────────────────────────────────────────────────────
let API   = 'http://localhost:3001';
let TOKEN = null;

// Authenticated fetch — attaches Bearer token to every request
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  return fetch(`${API}${path}`, { ...options, headers });
}

const FILE_ICONS = { pdf:'📄', docx:'📝', image:'🖼️', audio:'🎵', code:'💻', video:'🎬', other:'📁' };

const PROGRESS_STEPS = [
  { pct:15, label:'UPLOADING…'  },
  { pct:45, label:'EXTRACTING…' },
  { pct:75, label:'EMBEDDING…'  },
  { pct:95, label:'STORING…'    },
];

// ── State ─────────────────────────────────────────────────────
const state = {
  sort:'uploaded_at', order:'desc',
  type:'', offset:0, limit:30,
  isSearchMode:false, searchType:'',
  expandedId:null,
  folderId:null, showFavs:false,
  tag: null,
  folders:[],
};

// ── Elements ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropZone       = $('dropZone');
const fileInput      = $('fileInput');
const selectedFile   = $('selectedFile');
const uploadBtn      = $('uploadBtn');
const progressWrap   = $('progressWrap');
const progressBar    = $('progressBar');
const progressLabel  = $('progressLabel');
const searchInput    = $('searchInput');
const searchBtn      = $('searchBtn');
const clearSearchBtn = $('clearSearchBtn');
const fileList       = $('fileList');
const emptyState     = $('emptyState');
const emptyMsg       = $('emptyMsg');
const loadMoreWrap   = $('loadMoreWrap');
const loadMoreBtn    = $('loadMoreBtn');
const orderBtn       = $('orderBtn');
const settingsBtn    = $('settingsBtn');
const settingsPanel  = $('settingsPanel');
const settingsClose  = $('settingsClose');
const serverUrlInput = $('serverUrlInput');
const saveServerUrl  = $('saveServerUrl');
const serverUrlStatus= $('serverUrlStatus');
const clipboardBtn   = $('clipboardBtn');
const captureBtn     = $('captureBtn');
const previewTooltip = $('previewTooltip');
const previewContent = $('previewContent');

// ── Window size ────────────────────────────────────────────────
const SIZE_DEFAULTS = { width: 480, height: 580 };

function applySize(width, height) {
  document.body.style.width    = `${width}px`;
  document.body.style.minWidth = `${width}px`;
  document.body.style.maxWidth = `${width}px`;
  document.body.style.height    = `${height}px`;
  document.body.style.minHeight = `${height}px`;
  document.body.style.maxHeight = `${height}px`;
  // Mark active buttons
  document.querySelectorAll('.size-btn[data-axis="width"]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.val) === width));
  document.querySelectorAll('.size-btn[data-axis="height"]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.val) === height));
}

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    chrome.storage.local.get(['popupWidth','popupHeight'], ({ popupWidth = SIZE_DEFAULTS.width, popupHeight = SIZE_DEFAULTS.height }) => {
      const axis = btn.dataset.axis;
      const val  = Number(btn.dataset.val);
      const newW = axis === 'width'  ? val : popupWidth;
      const newH = axis === 'height' ? val : popupHeight;
      chrome.storage.local.set({ popupWidth: newW, popupHeight: newH });
      applySize(newW, newH);
    });
  });
});

$('popoutBtn').addEventListener('click', () => {
  chrome.storage.local.get(['popupWidth','popupHeight'], ({ popupWidth = 620, popupHeight = 700 }) => {
    chrome.windows.create({
      url:    chrome.runtime.getURL('popup/popup.html'),
      type:   'popup',
      width:  popupWidth,
      height: popupHeight,
    });
  });
});

// ── Init: Load saved API URL + token ──────────────────────────
chrome.storage.local.get(['apiUrl', 'token', 'user', 'popupWidth', 'popupHeight'], ({ apiUrl, token, user, popupWidth, popupHeight }) => {
  if (apiUrl) { API = apiUrl; serverUrlInput.value = apiUrl; }
  else serverUrlInput.value = API;

  // Apply saved window size
  applySize(popupWidth || SIZE_DEFAULTS.width, popupHeight || SIZE_DEFAULTS.height);

  if (token) {
    TOKEN = token;
    showApp(user);
  } else {
    showAuthScreen();
  }
  checkServerHealth();
});

function showAuthScreen() {
  $('authScreen').style.display = 'flex';
}

function showApp(user) {
  $('authScreen').style.display = 'none';
  if (user) {
    $('settingsUser').textContent = `${user.username} (${user.email})`;
  }
  loadFiles(false);
}

async function checkServerHealth() {
  try {
    const res = await fetch(`${API}/health`); // health is public
    if (!res.ok) throw new Error();
    setServerOnline(true);
  } catch { setServerOnline(false); }
}

function setServerOnline(online) {
  $('serverStatus').textContent = online ? 'ONLINE' : 'OFFLINE';
  $('serverStatus').style.color = online ? '' : '#ef4444';
  document.querySelector('.pulse-dot').style.background = online ? '' : '#ef4444';
  document.querySelector('.pulse-dot').style.boxShadow = online ? '' : '0 0 6px #ef4444';
}

// ── Tab navigation ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
    $(`tab-${name}`).style.display = 'flex';
    if (name === 'dashboard') loadDashboard();
    if (name === 'trash')     loadTrash();
  });
});

// ── Auth forms ─────────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    $('loginForm').style.display    = mode === 'login'    ? 'flex' : 'none';
    $('registerForm').style.display = mode === 'register' ? 'flex' : 'none';
    $('loginError').textContent = ''; $('registerError').textContent = '';
  });
});

// Helper: show only one auth form at a time
function showAuthForm(id) {
  ['loginForm','registerForm','forgotForm','resetForm'].forEach(f => $( f).style.display = 'none');
  $(id).style.display = 'flex';
  // Hide tabs when in forgot/reset flow
  document.querySelector('.auth-tabs').style.display = (id === 'loginForm' || id === 'registerForm') ? 'flex' : 'none';
}

// Forgot password links
$('forgotLink').addEventListener('click',  () => { $('forgotEmail').value = $('loginEmail').value; showAuthForm('forgotForm'); });
$('backToLogin').addEventListener('click', () => showAuthForm('loginForm'));
$('backToForgot').addEventListener('click',() => showAuthForm('forgotForm'));

// Step 1 — send OTP
$('forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('forgotError').textContent = '';
  const email = $('forgotEmail').value.trim();
  const btn = $('forgotForm').querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'SENDING…';
  try {
    const res  = await fetch(`${API}/auth/forgot-password`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // Pre-fill email hidden value for step 2
    $('resetForm').dataset.email = email;
    showAuthForm('resetForm');
  } catch (err) {
    $('forgotError').textContent = err.message;
  } finally { btn.disabled = false; btn.textContent = 'SEND CODE'; }
});

// Step 2 — verify OTP + set new password
$('resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('resetError').textContent = '';
  const email    = $('resetForm').dataset.email;
  const otp      = $('resetOtp').value.trim();
  const password = $('resetPassword').value;
  const btn = $('resetForm').querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'RESETTING…';
  try {
    const res  = await fetch(`${API}/auth/reset-password`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, otp, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // Pre-fill login email and show success
    $('loginEmail').value = email;
    $('loginError').textContent = '';
    showAuthForm('loginForm');
    // Show brief success message
    $('loginError').style.color = 'var(--green)';
    $('loginError').textContent = '✓ Password reset! Please log in.';
    setTimeout(() => { $('loginError').style.color = ''; $('loginError').textContent = ''; }, 4000);
  } catch (err) {
    $('resetError').textContent = err.message;
  } finally { btn.disabled = false; btn.textContent = 'RESET PASSWORD'; }
});

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').textContent = '';
  const email    = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  try {
    const res  = await fetch(`${API}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    TOKEN = data.token;
    chrome.storage.local.set({ token: data.token, user: data.user });
    showApp(data.user);
  } catch (err) { $('loginError').textContent = err.message; }
});

$('registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('registerError').textContent = '';
  const username = $('regUsername').value.trim();
  const email    = $('regEmail').value.trim();
  const password = $('regPassword').value;
  try {
    const res  = await fetch(`${API}/auth/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, email, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    TOKEN = data.token;
    chrome.storage.local.set({ token: data.token, user: data.user });
    showApp(data.user);
  } catch (err) { $('registerError').textContent = err.message; }
});

// ── Settings ───────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => { settingsPanel.style.display = 'flex'; });
settingsClose.addEventListener('click', () => { settingsPanel.style.display = 'none'; });

$('logoutBtn').addEventListener('click', () => {
  TOKEN = null;
  chrome.storage.local.remove(['token', 'user']);
  settingsPanel.style.display = 'none';
  fileList.innerHTML = '';
  showAuthScreen();
});

saveServerUrl.addEventListener('click', () => {
  const url = serverUrlInput.value.trim().replace(/\/$/, '');
  if (!url) return;
  API = url;
  chrome.storage.local.set({ apiUrl: url });
  serverUrlStatus.textContent = 'SAVED ✓';
  setTimeout(() => { serverUrlStatus.textContent = ''; }, 2000);
  checkServerHealth();
});

// ── Drag & Drop ────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
['dragleave','dragend'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over')));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) setSelectedFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => { if (fileInput.files[0]) setSelectedFile(fileInput.files[0]); });

function setSelectedFile(file) {
  if (file !== fileInput.files[0]) {
    const dt = new DataTransfer(); dt.items.add(file); fileInput.files = dt.files;
  }
  selectedFile.textContent = `📎 ${truncate(file.name, 40)}`;
  uploadBtn.disabled = false;
}

// ── Clipboard capture ──────────────────────────────────────────
// Listen for Ctrl+V paste anywhere in the popup (handles images too)
document.addEventListener('paste', e => {
  const items = [...e.clipboardData.items];
  const imageItem = items.find(i => i.type.startsWith('image/'));
  if (imageItem) {
    const blob = imageItem.getAsFile();
    setSelectedFile(new File([blob], `clipboard-${Date.now()}.png`, { type: imageItem.type }));
    return;
  }
  const textItem = items.find(i => i.type === 'text/plain');
  if (textItem) {
    textItem.getAsString(text => {
      if (!text.trim()) return;
      const blob = new Blob([text], { type: 'text/plain' });
      setSelectedFile(new File([blob], `clipboard-${Date.now()}.txt`, { type: 'text/plain' }));
    });
  }
});

// Clipboard button: try readText() for text, otherwise prompt Ctrl+V for images
clipboardBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      const blob = new Blob([text], { type: 'text/plain' });
      setSelectedFile(new File([blob], `clipboard-${Date.now()}.txt`, { type: 'text/plain' }));
    } else {
      selectedFile.textContent = '📋 Press Ctrl+V to paste an image…';
    }
  } catch {
    // readText blocked — prompt user to paste manually
    selectedFile.textContent = '📋 Press Ctrl+V to paste…';
  }
});

// ── Page capture ───────────────────────────────────────────────
captureBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let bodyText = '';

    // chrome.scripting is unavailable on chrome://, edge://, or extension pages
    const isRestricted = !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://');

    if (!isRestricted && chrome.scripting) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.body.innerText,
        });
        bodyText = results[0]?.result || '';
      } catch {
        // Scripting blocked on this page — fall back to URL+title only
      }
    }

    const content = `URL: ${tab.url}\nTitle: ${tab.title}\n\n${bodyText}`;
    const safeName = (tab.title || 'page').slice(0, 50).replace(/[^a-z0-9]/gi, '-');
    const blob = new Blob([content], { type: 'text/plain' });
    setSelectedFile(new File([blob], `${safeName}-${Date.now()}.txt`, { type: 'text/plain' }));
  } catch (e) { alert(`Page capture failed: ${e.message}`); }
});

// ── URL Import ─────────────────────────────────────────────────
$('urlImportBtn').addEventListener('click', () => {
  const panel = $('urlImportPanel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'flex';
  if (!visible) $('urlImportInput').focus();
});

$('urlImportCancel').addEventListener('click', () => {
  $('urlImportPanel').style.display = 'none';
  $('urlImportInput').value = '';
  $('urlImportName').value  = '';
  $('urlImportStatus').textContent = '';
});

$('urlImportGo').addEventListener('click', doUrlImport);
$('urlImportInput').addEventListener('keydown', e => { if (e.key === 'Enter') doUrlImport(); });

async function doUrlImport() {
  const url  = $('urlImportInput').value.trim();
  const name = $('urlImportName').value.trim();
  if (!url) { $('urlImportStatus').style.color = 'var(--red)'; $('urlImportStatus').textContent = 'Paste a URL first'; return; }

  const btn = $('urlImportGo');
  btn.disabled = true; btn.textContent = '⟳ DOWNLOADING…';
  $('urlImportStatus').style.color = 'var(--cyan)';
  $('urlImportStatus').textContent = 'Fetching file…';

  try {
    const body = { url };
    if (name) body.filename = name;
    const res  = await apiFetch('/files/import-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    $('urlImportStatus').style.color = 'var(--green)';
    $('urlImportStatus').textContent = `✓ Imported from ${data.source || 'URL'}`;
    $('urlImportInput').value = '';
    $('urlImportName').value  = '';
    setTimeout(() => {
      $('urlImportPanel').style.display = 'none';
      $('urlImportStatus').textContent = '';
    }, 1800);
    state.offset = 0; state.isSearchMode = false;
    await loadFiles(false);
  } catch (err) {
    const msg = err.message || 'Unknown error — check server console';
    $('urlImportStatus').style.color = 'var(--red)';
    $('urlImportStatus').textContent = `✕ ${msg}`;
  } finally {
    btn.disabled = false; btn.textContent = '⬇ IMPORT';
  }
}

// ── Folder Upload ──────────────────────────────────────────────
const folderInput = $('folderInput');
let folderFiles   = [];   // FileList snapshot

$('folderUploadBtn').addEventListener('click', () => {
  folderInput.value = '';
  folderInput.click();
});

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  if (!files.length) return;
  folderFiles = files;

  // Derive directory name from first file's relative path  (e.g. "MyDocs/a.pdf" → "MyDocs")
  const dirName = (files[0].webkitRelativePath || '').split('/')[0] || 'Folder';
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  // Hide other panels, show confirm
  $('urlImportPanel').style.display      = 'none';
  $('folderProgressPanel').style.display = 'none';
  $('folderConfirmPanel').style.display  = 'flex';
  $('folderConfirmInfo').textContent =
    `📂 ${escHtml(dirName)}  ·  ${files.length} file${files.length === 1 ? '' : 's'}  ·  ${formatBytes(totalSize)}`;
  $('folderConfirmGo').dataset.dirName = dirName;
});

$('folderConfirmCancel').addEventListener('click', () => {
  $('folderConfirmPanel').style.display = 'none';
  folderFiles = [];
});

$('folderConfirmGo').addEventListener('click', doFolderUpload);

async function doFolderUpload() {
  if (!folderFiles.length) return;
  const files   = folderFiles;
  const dirName = $('folderConfirmGo').dataset.dirName || 'Folder';
  const createVault = $('folderCreateVault').checked;

  // Hide confirm, show progress
  $('folderConfirmPanel').style.display  = 'none';
  $('folderProgressPanel').style.display = 'flex';
  $('folderProgressBar').style.width     = '0%';
  $('folderProgressBar').style.background = '';

  // Optionally create (or find) a vault folder first
  let targetFolderId = null;
  if (createVault) {
    try {
      const res  = await apiFetch('/folders', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name: dirName }),
      });
      const data = await res.json();
      if (res.ok) {
        targetFolderId = data.folder.id;
        // Refresh cached folders
        state.folders = [];
      } else if (res.status === 409 && data.folder) {
        // Folder already exists — reuse it
        targetFolderId = data.folder.id;
      }
    } catch { /* non-fatal — upload without folder */ }
  }

  let done = 0; let errors = 0;
  const total = files.length;

  for (const file of files) {
    const label = file.webkitRelativePath || file.name;
    $('folderProgressInfo').textContent  = `UPLOADING ${done + 1} / ${total}`;
    $('folderProgressFile').textContent  = label;
    $('folderProgressBar').style.width   = `${Math.round((done / total) * 100)}%`;

    try {
      const form = new FormData();
      form.append('file', file);
      if (targetFolderId) form.append('folder_id', targetFolderId);
      const res = await apiFetch('/files/upload', { method:'POST', body:form });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Upload failed'); }
    } catch { errors++; }

    done++;
    $('folderProgressBar').style.width = `${Math.round((done / total) * 100)}%`;
  }

  // Done
  $('folderProgressInfo').textContent = errors
    ? `⚠ DONE — ${done - errors} / ${total} succeeded (${errors} failed)`
    : `✓ ALL ${total} FILE${total === 1 ? '' : 'S'} UPLOADED`;
  $('folderProgressFile').textContent = '';
  $('folderProgressBar').style.background = errors ? '#f59e0b' : 'var(--green)';

  folderFiles = [];
  setTimeout(() => {
    $('folderProgressPanel').style.display = 'none';
    $('folderProgressBar').style.background = '';
    $('folderProgressBar').style.width = '0%';
  }, 2500);

  // Bust the folders cache so the new folder appears in the panel
  state.folders = [];
  state.offset = 0; state.isSearchMode = false;
  await loadFiles(false);
}

// ── Upload ─────────────────────────────────────────────────────
uploadBtn.addEventListener('click', doUpload);

async function doUpload() {
  const file = fileInput.files[0];
  if (!file) return;
  uploadBtn.disabled = true;
  progressWrap.style.display = 'flex';
  setProgress(0, 'PREPARING…');

  let stepIdx = 0;
  const stepTimer = setInterval(() => {
    if (stepIdx < PROGRESS_STEPS.length) {
      const s = PROGRESS_STEPS[stepIdx++];
      setProgress(s.pct, s.label);
    }
  }, 900);

  try {
    const form = new FormData();
    form.append('file', file);
    const res = await apiFetch('/files/upload', { method:'POST', body:form });
    const data = await res.json();
    clearInterval(stepTimer);
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    setProgress(100, 'COMPLETE ✓');
    setTimeout(() => {
      progressWrap.style.display = 'none'; setProgress(0,'');
      fileInput.value = ''; selectedFile.textContent = ''; uploadBtn.disabled = true;
    }, 1200);
    state.offset = 0; state.isSearchMode = false;
    await loadFiles(false);
  } catch (err) {
    clearInterval(stepTimer);
    setProgress(100, `ERROR: ${err.message}`);
    progressBar.style.background = '#ef4444';
    setTimeout(() => {
      progressWrap.style.display = 'none'; progressBar.style.background = ''; setProgress(0,''); uploadBtn.disabled = false;
    }, 2500);
  }
}

function setProgress(pct, label) {
  progressBar.style.width = `${pct}%`;
  progressLabel.textContent = label;
}

// ── Search ─────────────────────────────────────────────────────
searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
clearSearchBtn.addEventListener('click', () => {
  searchInput.value = ''; clearSearchBtn.style.display = 'none';
  $('searchTypeFilter').style.display = 'none';
  state.isSearchMode = false; state.offset = 0; loadFiles(false);
});

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  state.isSearchMode = true;
  clearSearchBtn.style.display = '';
  $('searchTypeFilter').style.display = 'flex';
  fileList.innerHTML = ''; emptyState.style.display = 'none'; loadMoreWrap.style.display = 'none';
  saveSearch(q);
  try {
    const body = { query: q, limit: 20 };
    if (state.searchType) body.type = state.searchType;
    const res = await apiFetch('/search', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderSearchResults(data.results);
  } catch (err) { showEmpty(`SEARCH ERROR: ${err.message}`); }
}

// ── Sort / Filter ──────────────────────────────────────────────
document.querySelectorAll('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); state.sort = btn.dataset.sort; state.offset = 0; state.isSearchMode = false; loadFiles(false);
}));

document.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); state.type = btn.dataset.type; state.offset = 0; state.isSearchMode = false; loadFiles(false);
}));

orderBtn.addEventListener('click', () => {
  state.order = state.order === 'desc' ? 'asc' : 'desc';
  orderBtn.textContent = state.order === 'desc' ? '↓' : '↑';
  state.offset = 0; state.isSearchMode = false; loadFiles(false);
});

loadMoreBtn.addEventListener('click', () => { state.offset += state.limit; loadFiles(true); });

// ── Load Files ─────────────────────────────────────────────────
async function loadFiles(append = false) {
  if (state.isSearchMode) return;
  const params = new URLSearchParams({ limit:state.limit, offset:state.offset, sort:state.sort, order:state.order });
  if (state.type)       params.set('type', state.type);
  if (state.folderId)   params.set('folder_id', state.folderId);
  if (state.showFavs)   params.set('favourites', '1');
  if (state.tag)        params.set('tag', state.tag);
  try {
    // Ensure folders are loaded so buildRow can show folder names
    if (!state.folders.length) {
      try {
        const fr = await apiFetch('/folders');
        const fd = await fr.json();
        if (fr.ok) state.folders = fd.folders;
      } catch {}
    }
    const res = await apiFetch(`/files?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderFiles(data.files, append);
    const loaded = state.offset + data.files.length;
    loadMoreWrap.style.display = loaded < data.total ? '' : 'none';
    if (!append && !data.files.length) showEmpty('NO FILES FOUND');
  } catch (err) { showEmpty(`ERROR: ${err.message}`); }
}

// ── Render ─────────────────────────────────────────────────────
function renderFiles(files, append) {
  if (!append) { fileList.innerHTML = ''; emptyState.style.display = 'none'; loadMoreWrap.style.display = 'none'; }
  files.forEach((f, i) => { const r = buildRow(f); r.style.animationDelay = `${i*40}ms`; fileList.appendChild(r); });
}

function renderSearchResults(results) {
  fileList.innerHTML = ''; emptyState.style.display = 'none'; loadMoreWrap.style.display = 'none';
  if (!results.length) { showEmpty('NO SIMILAR FILES FOUND'); return; }
  results.forEach((f, i) => { const r = buildRow(f, f.distance); r.style.animationDelay = `${i*40}ms`; fileList.appendChild(r); });
}

function buildRow(file, distance) {
  const row = document.createElement('div');
  row.className = 'file-row'; row.dataset.id = file.id;

  const icon   = FILE_ICONS[file.file_type] || '📁';
  const folder = state.folders.find(f => f.id == file.folder_id);
  const metaParts = [formatBytes(file.size_bytes), formatDate(file.uploaded_at)];
  if (folder) metaParts.push(`📁 ${truncate(folder.name, 12)}`);
  const meta = metaParts.filter(Boolean).join(' · ');

  row.innerHTML = `
    <div class="file-row-main">
      <button class="icon-btn star ${file.is_favourite ? 'active' : ''}" title="Favourite">${file.is_favourite ? '⭐' : '☆'}</button>
      <span class="file-icon">${icon}</span>
      <div class="file-info">
        <div class="file-name" title="${escHtml(file.filename)}">${escHtml(truncate(file.filename, 33))}</div>
        <div class="file-meta">${meta}</div>
      </div>
      ${distance != null ? `<span class="distance-badge">${distance.toFixed(3)}</span>` : ''}
      <div class="file-actions">
        <button class="icon-btn reindex"  title="Re-index">↺</button>
        <button class="icon-btn download" title="Download">⬇</button>
        <button class="icon-btn delete"   title="Delete">✕</button>
      </div>
    </div>
  `;

  const favBtn = row.querySelector('.icon-btn.star');
  favBtn.addEventListener('click',              e => { e.stopPropagation(); toggleFavourite(file.id, favBtn); });
  row.querySelector('.file-name').addEventListener('click', () => togglePreview(row, file));
  row.querySelector('.reindex').addEventListener('click',   e => { e.stopPropagation(); reindexFile(file.id, row); });
  row.querySelector('.download').addEventListener('click',  e => { e.stopPropagation(); downloadFile(file.id); });
  row.querySelector('.delete').addEventListener('click',    e => { e.stopPropagation(); deleteFile(file.id, row); });

  // Hover tooltip (only when not expanded)
  row.querySelector('.file-row-main').addEventListener('mouseenter', ev => { if (state.expandedId !== file.id) showTooltip(ev, file); });
  row.querySelector('.file-row-main').addEventListener('mouseleave', hideTooltip);
  row.querySelector('.file-row-main').addEventListener('mousemove',  moveTooltip);

  return row;
}

// ── Expanded Preview ───────────────────────────────────────────
async function togglePreview(row, file) {
  const existing = row.querySelector('.file-preview');
  if (existing) { existing.remove(); state.expandedId = null; return; }

  // Close any other open preview
  document.querySelectorAll('.file-preview').forEach(p => p.remove());
  state.expandedId = file.id;

  const panel = document.createElement('div');
  panel.className = 'file-preview';
  panel.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:#4b5563">LOADING…</div>`;
  row.appendChild(panel);

  try {
    // Get file details (extracted_text) + presigned URL in parallel
    const [detailRes, urlRes] = await Promise.all([
      apiFetch(`/files/${file.id}`),
      apiFetch(`/files/${file.id}/download`),
    ]);
    const detail = await detailRes.json();
    const { url }  = await urlRes.json();

    panel.innerHTML = '';

    // Media preview
    if (file.file_type === 'image') {
      const img = document.createElement('img');
      img.className = 'preview-media'; img.src = url; img.alt = file.filename;
      panel.appendChild(img);
    } else if (file.file_type === 'audio') {
      const audio = document.createElement('audio');
      audio.className = 'preview-audio'; audio.controls = true; audio.src = url;
      panel.appendChild(audio);
    } else if (file.mime_type && file.mime_type.startsWith('video/')) {
      const video = document.createElement('video');
      video.className = 'preview-video'; video.controls = true; video.src = url;
      panel.appendChild(video);
    } else if (detail.extracted_text) {
      const pre = document.createElement('div');
      pre.className = 'preview-text';
      pre.textContent = detail.extracted_text.slice(0, 600) + (detail.extracted_text.length > 600 ? '…' : '');
      panel.appendChild(pre);
    }

    // Tags row
    panel.appendChild(renderTagsRow(detail.tags || [], file.id));

    // Folder move row
    if (state.folders.length) {
      const folderDiv = document.createElement('div');
      folderDiv.className = 'preview-rename';
      const folderSel = document.createElement('select');
      folderSel.className = 'setting-input';
      folderSel.style.cssText = 'flex:1;padding:3px 6px;font-size:10px';
      folderSel.innerHTML = `<option value="">— No folder —</option>` +
        state.folders.map(f => `<option value="${f.id}" ${file.folder_id == f.id ? 'selected' : ''}>${escHtml(f.name)}</option>`).join('');
      const folderMoveBtn = document.createElement('button');
      folderMoveBtn.className = 'btn btn-sm btn-primary';
      folderMoveBtn.textContent = 'MOVE';
      folderMoveBtn.addEventListener('click', async () => {
        const fid = folderSel.value ? Number(folderSel.value) : null;
        try {
          const r = await apiFetch(`/files/${file.id}/folder`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ folder_id: fid }) });
          if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
          file.folder_id = fid;
          // Update folder badge in meta
          const metaEl = row.querySelector('.file-meta');
          const folder = state.folders.find(f => f.id == fid);
          const metaParts = [formatBytes(file.size_bytes), formatDate(file.uploaded_at)];
          if (folder) metaParts.push(`📁 ${truncate(folder.name, 12)}`);
          metaEl.textContent = metaParts.filter(Boolean).join(' · ');
          folderMoveBtn.textContent = '✓ MOVED';
          setTimeout(() => { folderMoveBtn.textContent = 'MOVE'; }, 1500);
        } catch (err) { alert(`Move failed: ${err.message}`); }
      });
      folderDiv.appendChild(folderSel);
      folderDiv.appendChild(folderMoveBtn);
      panel.appendChild(folderDiv);
    }

    // Rename row
    const renameDiv = document.createElement('div');
    renameDiv.className = 'preview-rename';
    renameDiv.innerHTML = `
      <input type="text" value="${escHtml(file.filename)}" placeholder="Rename file…" />
      <button class="btn btn-sm btn-primary">SAVE</button>
    `;
    renameDiv.querySelector('button').addEventListener('click', async () => {
      const newName = renameDiv.querySelector('input').value.trim();
      if (!newName || newName === file.filename) return;
      await renameFile(file.id, newName, row);
    });
    panel.appendChild(renameDiv);
  } catch (err) {
    panel.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:#ef4444">ERROR: ${escHtml(err.message)}</div>`;
  }
}

// ── Rename ─────────────────────────────────────────────────────
async function renameFile(id, newName, row) {
  try {
    const res = await apiFetch(`/files/${id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ filename: newName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    row.querySelector('.file-name').textContent = truncate(newName, 36);
    row.querySelector('.file-name').title = newName;
  } catch (err) { alert(`Rename failed: ${err.message}`); }
}

// ── Re-index ───────────────────────────────────────────────────
async function reindexFile(id, row) {
  const btn = row.querySelector('.icon-btn.reindex');
  btn.textContent = '⟳'; btn.style.color = 'var(--cyan)';
  try {
    const res = await apiFetch(`/files/${id}/reindex`, { method:'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    btn.textContent = '✓'; btn.style.color = 'var(--green)';
    setTimeout(() => { btn.textContent = '↺'; btn.style.color = ''; }, 2000);
  } catch (err) {
    btn.textContent = '!'; btn.style.color = 'var(--red)';
    setTimeout(() => { btn.textContent = '↺'; btn.style.color = ''; }, 2000);
    alert(`Re-index failed: ${err.message}`);
  }
}

// ── Download ───────────────────────────────────────────────────
async function downloadFile(id) {
  try {
    const res = await apiFetch(`/files/${id}/download`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    window.open(data.url, '_blank');
  } catch (err) { alert(`Download failed: ${err.message}`); }
}

// ── Delete ─────────────────────────────────────────────────────
async function deleteFile(id, row) {
  if (!confirm('Delete this file?')) return;
  try {
    row.style.opacity = '0.4';
    const res = await apiFetch(`/files/${id}`, { method:'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    row.style.transition = 'opacity .2s, max-height .3s'; row.style.maxHeight = '0'; row.style.overflow = 'hidden'; row.style.opacity = '0';
    setTimeout(() => { row.remove(); if (!fileList.children.length) showEmpty('NO FILES FOUND'); }, 300);
  } catch (err) { row.style.opacity = '1'; alert(`Delete failed: ${err.message}`); }
}

// ── Dashboard ──────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const res = await apiFetch('/stats');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    $('dashTotal').textContent = data.total_files;
    $('dashSize').textContent  = formatBytes(data.total_bytes) || '0 B';

    // By-type bars
    const maxCount = Math.max(...data.by_type.map(t => t.count), 1);
    $('dashByType').innerHTML = data.by_type.map(t => `
      <div class="dash-bar-row">
        <div class="dash-bar-label">${(FILE_ICONS[t.file_type]||'📁')} ${t.file_type.toUpperCase()}</div>
        <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(t.count/maxCount*100).toFixed(1)}%"></div></div>
        <div class="dash-bar-count">${t.count}</div>
      </div>
    `).join('');

    // Recent uploads
    $('dashRecent').innerHTML = data.recent_uploads.map(f => `
      <div class="dash-recent-row">
        <span class="dash-recent-icon">${FILE_ICONS[f.file_type]||'📁'}</span>
        <span class="dash-recent-name" title="${escHtml(f.filename)}">${escHtml(truncate(f.filename,32))}</span>
        <span class="dash-recent-date">${formatDate(f.uploaded_at)}</span>
      </div>
    `).join('');
  } catch (err) {
    $('dashByType').innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:#ef4444">ERROR: ${escHtml(err.message)}</div>`;
  }
}

// ── Tooltip ─────────────────────────────────────────────────────
function showTooltip(ev, file) {
  previewContent.innerHTML = `
    <div class="p-name">${escHtml(file.filename)}</div>
    <div class="p-row">TYPE &nbsp;<span>${(file.file_type||'other').toUpperCase()}</span></div>
    <div class="p-row">SIZE &nbsp;<span>${formatBytes(file.size_bytes)||'—'}</span></div>
    <div class="p-row">DATE &nbsp;<span>${formatDate(file.uploaded_at)||'—'}</span></div>
    <div style="margin-top:5px;font-size:9px;color:#374151">Click name to preview</div>
  `;
  previewTooltip.style.display = 'block'; moveTooltip(ev);
}
function moveTooltip(ev) {
  previewTooltip.style.left = `${Math.min(ev.clientX+12, window.innerWidth-240)}px`;
  previewTooltip.style.top  = `${Math.max(ev.clientY-10, 4)}px`;
}
function hideTooltip() { previewTooltip.style.display = 'none'; }

// ── Search history ─────────────────────────────────────────────
const HISTORY_KEY = 'searchHistory';
const MAX_HISTORY = 5;

function saveSearch(q) {
  chrome.storage.local.get([HISTORY_KEY], ({ searchHistory = [] }) => {
    const updated = [q, ...searchHistory.filter(h => h !== q)].slice(0, MAX_HISTORY);
    chrome.storage.local.set({ [HISTORY_KEY]: updated });
    renderSearchHistory(updated);
  });
}

function renderSearchHistory(history) {
  const wrap = $('searchHistory');
  if (!history.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = `<span class="history-label">RECENT:</span>` +
    history.map(h => `<button class="history-chip" data-q="${escHtml(h)}">${escHtml(truncate(h, 20))}</button>`).join('');
  wrap.querySelectorAll('.history-chip').forEach(chip =>
    chip.addEventListener('click', () => { searchInput.value = chip.dataset.q; runSearch(); })
  );
}

chrome.storage.local.get([HISTORY_KEY], ({ searchHistory = [] }) => renderSearchHistory(searchHistory));

// ── Search type filter ─────────────────────────────────────────
document.querySelectorAll('.stype-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stype-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.searchType = btn.dataset.type;
    if (state.isSearchMode && searchInput.value.trim()) runSearch();
  });
});

// ── Favourites filter ──────────────────────────────────────────
$('favsBtn').addEventListener('click', () => {
  state.showFavs = !state.showFavs;
  $('favsBtn').classList.toggle('active', state.showFavs);
  $('favsBtn').textContent = state.showFavs ? '⭐' : '☆';
  state.offset = 0; state.isSearchMode = false; loadFiles(false);
});

// ── Folders ────────────────────────────────────────────────────
$('folderBtn').addEventListener('click', () => {
  const panel = $('folderPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  if (panel.style.display === 'flex') loadFolders();
});

$('newFolderBtn').addEventListener('click', () => {
  $('newFolderRow').style.display = $('newFolderRow').style.display === 'none' ? 'flex' : 'none';
  if ($('newFolderRow').style.display === 'flex') $('newFolderInput').focus();
});

$('newFolderSave').addEventListener('click', createFolder);
$('newFolderInput').addEventListener('keydown', e => { if (e.key === 'Enter') createFolder(); });

async function loadFolders() {
  try {
    const res  = await apiFetch('/folders');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.folders = data.folders;
    renderFolderList(data.folders);
  } catch (err) { console.error(err); }
}

function renderFolderList(folders) {
  const list = $('folderList');
  const allItem = `<div class="folder-item ${!state.folderId && state.folderId !== 'none' ? 'active' : ''}" data-id="">
    <span>📂</span><span class="folder-item-name">All Files</span>
  </div>`;
  const noneItem = `<div class="folder-item ${state.folderId === 'none' ? 'active' : ''}" data-id="none">
    <span>📄</span><span class="folder-item-name">Unfiled</span>
  </div>`;
  const folderItems = folders.map(f => `
    <div class="folder-item ${state.folderId == f.id ? 'active' : ''}" data-id="${f.id}">
      <span>📁</span>
      <span class="folder-item-name">${escHtml(f.name)}</span>
      <span class="folder-item-count">${f.file_count}</span>
      <button class="folder-item-del" data-folder-id="${f.id}" title="Delete folder">✕</button>
    </div>`).join('');

  list.innerHTML = allItem + noneItem + folderItems;

  list.querySelectorAll('.folder-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.classList.contains('folder-item-del')) return;
      state.folderId = item.dataset.id || null;
      state.offset = 0; state.isSearchMode = false;
      $('folderBtn').classList.toggle('active', !!state.folderId);
      $('folderPanel').style.display = 'none';
      renderFolderList(state.folders);
      loadFiles(false);
    });
  });

  list.querySelectorAll('.folder-item-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete folder? Files will be kept but unfiled.')) return;
      await apiFetch(`/folders/${btn.dataset.folderId}`, { method:'DELETE' });
      if (state.folderId == btn.dataset.folderId) { state.folderId = null; loadFiles(false); }
      loadFolders();
    });
  });
}

async function createFolder() {
  const name = $('newFolderInput').value.trim();
  if (!name) return;
  try {
    const res  = await apiFetch('/folders', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $('newFolderInput').value = '';
    $('newFolderRow').style.display = 'none';
    loadFolders();
  } catch (err) { alert(err.message); }
}

// ── Toggle Favourite ───────────────────────────────────────────
async function toggleFavourite(id, btn) {
  try {
    const res  = await apiFetch(`/files/${id}/favourite`, { method:'PATCH' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    btn.classList.toggle('active', data.is_favourite);
    btn.textContent = data.is_favourite ? '⭐' : '☆';
  } catch (err) { alert(err.message); }
}

// ── Add / Remove Tag ───────────────────────────────────────────
async function addTag(fileId, tagName, tagsRow) {
  const name = tagName.trim().toLowerCase();
  if (!name) return;
  try {
    const res = await apiFetch(`/files/${fileId}/tags/${encodeURIComponent(name)}`, { method:'POST' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
    const chip = createTagChip(name, fileId, tagsRow);
    tagsRow.insertBefore(chip, tagsRow.lastElementChild); // before the + button
  } catch (err) { alert(err.message); }
}

async function removeTag(fileId, tagName, chip) {
  try {
    const res = await apiFetch(`/files/${fileId}/tags/${encodeURIComponent(tagName)}`, { method:'DELETE' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
    chip.remove();
  } catch (err) { alert(err.message); }
}

function createTagChip(name, fileId, tagsRow) {
  const chip = document.createElement('span');
  chip.className = 'tag-chip';
  chip.innerHTML = `<span class="tag-label" title="Filter by tag">${escHtml(name)}</span><button class="tag-remove" title="Remove tag">✕</button>`;
  chip.querySelector('.tag-label').addEventListener('click', () => {
    state.tag = name;
    state.offset = 0; state.isSearchMode = false;
    // Close expanded preview
    document.querySelectorAll('.file-preview').forEach(p => p.remove());
    state.expandedId = null;
    updateTagFilterBar();
    loadFiles(false);
  });
  chip.querySelector('.tag-remove').addEventListener('click', () => removeTag(fileId, name, chip));
  return chip;
}

function updateTagFilterBar() {
  let bar = $('tagFilterBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'tagFilterBar';
    bar.className = 'search-history'; // reuse chip-row style
    bar.style.display = 'none';
    // Insert it just before the controls section
    const controls = document.querySelector('.controls-section');
    controls.parentNode.insertBefore(bar, controls);
  }
  if (!state.tag) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `<span class="history-label">TAG:</span>
    <span class="history-chip" style="border-color:var(--cyan);color:var(--cyan)">${escHtml(state.tag)}</span>
    <button class="clear-btn" id="clearTagBtn" title="Clear tag filter">✕</button>`;
  bar.querySelector('#clearTagBtn').addEventListener('click', () => {
    state.tag = null; state.offset = 0; state.isSearchMode = false;
    updateTagFilterBar(); loadFiles(false);
  });
}

function renderTagsRow(tags, fileId) {
  const row = document.createElement('div');
  row.className = 'tags-row';
  tags.forEach(t => row.appendChild(createTagChip(t, fileId, row)));

  // + add tag button
  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add-btn'; addBtn.textContent = '+ tag';
  addBtn.addEventListener('click', () => {
    const name = prompt('Tag name:');
    if (name) addTag(fileId, name, row);
  });
  row.appendChild(addBtn);
  return row;
}

// ── Trash / Recovery ───────────────────────────────────────────
async function loadTrash() {
  const list = $('trashList');
  const empty = $('trashEmpty');
  list.innerHTML = '<div style="font-family:var(--font-mono);font-size:10px;color:#4b5563;padding:16px">LOADING…</div>';
  empty.style.display = 'none';
  try {
    const res  = await apiFetch('/recovery');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    list.innerHTML = '';
    if (!data.files.length) { empty.style.display = 'flex'; return; }
    data.files.forEach((f, i) => {
      const row = buildTrashRow(f);
      row.style.animationDelay = `${i * 40}ms`;
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:#ef4444;padding:16px">ERROR: ${escHtml(err.message)}</div>`;
  }
}

function buildTrashRow(file) {
  const row = document.createElement('div');
  row.className = 'file-row'; row.dataset.id = file.id;

  const icon = FILE_ICONS[file.file_type] || '📁';
  const deletedDate = file.deleted_at ? new Date(file.deleted_at).toLocaleDateString() : '—';

  row.innerHTML = `
    <div class="file-row-main">
      <span class="file-icon" style="opacity:.5">${icon}</span>
      <div class="file-info">
        <div class="file-name" title="${escHtml(file.filename)}">${escHtml(truncate(file.filename, 33))}</div>
        <div class="file-meta">${formatBytes(file.size_bytes)}</div>
        <div class="trash-row-meta">🗑 Deleted ${deletedDate}</div>
      </div>
      <div class="trash-actions">
        <button class="icon-btn history-btn" title="View history">📋</button>
        <button class="icon-btn restore"     title="Restore file">↩</button>
        <button class="icon-btn purge"       title="Delete permanently">✕</button>
      </div>
    </div>
  `;

  row.querySelector('.history-btn').addEventListener('click', e => { e.stopPropagation(); toggleHistory(row, file); });
  row.querySelector('.restore').addEventListener('click',     e => { e.stopPropagation(); restoreFile(file.id, row); });
  row.querySelector('.purge').addEventListener('click',       e => { e.stopPropagation(); purgeFile(file.id, row); });
  return row;
}

async function restoreFile(id, row) {
  try {
    row.style.opacity = '0.4';
    const res  = await apiFetch(`/recovery/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    row.style.transition = 'opacity .2s, max-height .3s';
    row.style.maxHeight = '0'; row.style.overflow = 'hidden'; row.style.opacity = '0';
    setTimeout(() => {
      row.remove();
      if (!$('trashList').children.length) $('trashEmpty').style.display = 'flex';
    }, 300);
  } catch (err) { row.style.opacity = '1'; alert(`Restore failed: ${err.message}`); }
}

async function purgeFile(id, row) {
  if (!confirm('Permanently delete this file? This cannot be undone.')) return;
  try {
    row.style.opacity = '0.4';
    const res  = await apiFetch(`/recovery/${id}/purge`, { method: 'DELETE' });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    // Success — animate out (R2 warning is non-fatal, file is removed from DB)
    row.style.transition = 'opacity .2s, max-height .3s';
    row.style.maxHeight = '0'; row.style.overflow = 'hidden'; row.style.opacity = '0';
    setTimeout(() => {
      row.remove();
      if (!$('trashList').children.length) $('trashEmpty').style.display = 'flex';
    }, 300);
  } catch (err) { row.style.opacity = '1'; alert(`Purge failed: ${err.message}`); }
}

async function toggleHistory(row, file) {
  const existing = row.querySelector('.history-panel');
  if (existing) { existing.remove(); return; }
  const panel = document.createElement('div');
  panel.className = 'history-panel';
  panel.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:#4b5563">LOADING HISTORY…</div>`;
  row.appendChild(panel);
  try {
    const res  = await apiFetch(`/recovery/${file.id}/history`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    panel.innerHTML = `<div style="font-family:var(--font-mono);font-size:9px;color:var(--text-dim);letter-spacing:2px;margin-bottom:8px">CHANGE HISTORY</div>`;
    data.history.forEach(h => {
      const dotClass = h.event === 'deleted' ? 'delete' : h.event === 'uploaded' ? 'upload' : '';
      const detail = h.event === 'renamed' ? ` → ${escHtml(h.filename)}` : '';
      const time   = h.changed_at ? new Date(h.changed_at).toLocaleString() : '—';
      const entry  = document.createElement('div');
      entry.className = 'history-row';
      entry.innerHTML = `
        <div class="history-dot ${dotClass}"></div>
        <div>
          <div class="history-event">${escHtml(h.event)}</div>
          <div class="history-time">${time}</div>
          ${detail ? `<div class="history-detail">${detail}</div>` : ''}
        </div>`;
      panel.appendChild(entry);
    });
  } catch (err) {
    panel.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:#ef4444">ERROR: ${escHtml(err.message)}</div>`;
  }
}

$('emptyTrashBtn').addEventListener('click', async () => {
  if (!confirm('Permanently delete ALL files in trash? This cannot be undone.')) return;
  const rows = [...$('trashList').querySelectorAll('.file-row')];
  await Promise.all(rows.map(row => purgeFile(Number(row.dataset.id), row)));
});

// ── Utils ──────────────────────────────────────────────────────
function showEmpty(msg) { emptyMsg.textContent = msg; emptyState.style.display = 'flex'; }
function truncate(s, n) { return s.length > n ? s.slice(0,n-1)+'…' : s; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatBytes(b) {
  if (!b) return ''; if (b<1024) return `${b} B`;
  if (b<1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/(1024*1024)).toFixed(1)} MB`;
}
function formatDate(iso) { return iso ? new Date(iso).toLocaleDateString() : ''; }
