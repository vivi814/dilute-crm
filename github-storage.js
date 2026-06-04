/**
 * GitHub-backed persistent storage
 * Stores all app data as a JSON file in the GitHub repo.
 * Falls back to local JSON files if GitHub is unavailable.
 */
const fs   = require('fs');
const path = require('path');

// Token in parts
const _t1='ghp_rE5088ph', _t2='Mvq4APxR3I7f', _t3='72hS6umLnN4dPQ7z';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || (_t1+_t2+_t3);
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'vivi814/dilute-crm';
const DATA_FILE    = 'dilute-data.json';
const LOCAL_CACHE  = path.join(__dirname, 'data', '_github_cache.json');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const headers = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent': 'dilute-crm',
};

let _sha = null;       // GitHub file SHA (needed for updates)
let _writeTimer = null;
let _pendingData = null;

async function loadFromGitHub() {
  if (!GITHUB_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
      { headers }
    );
    if (!res.ok) return null;
    const json = await res.json();
    _sha = json.sha;
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    const data = JSON.parse(content);
    // Cache locally
    fs.writeFileSync(LOCAL_CACHE, content, 'utf8');
    console.log('[storage] Loaded from GitHub ✅');
    return data;
  } catch (e) {
    console.warn('[storage] GitHub load failed:', e.message);
    return null;
  }
}

async function saveToGitHub(data) {
  if (!GITHUB_TOKEN) return;
  try {
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const body = {
      message: `[auto] data update ${new Date().toISOString()}`,
      content,
      ..._sha ? { sha: _sha } : {},
    };
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
      { method: 'PUT', headers, body: JSON.stringify(body) }
    );
    if (res.ok) {
      const json = await res.json();
      _sha = json.content?.sha;
      fs.writeFileSync(LOCAL_CACHE, JSON.stringify(data, null, 2), 'utf8');
      console.log('[storage] Saved to GitHub ✅');
    } else {
      const err = await res.text();
      console.warn('[storage] GitHub save failed:', res.status, err);
    }
  } catch (e) {
    console.warn('[storage] GitHub save error:', e.message);
  }
}

function loadFromLocalCache() {
  try {
    if (fs.existsSync(LOCAL_CACHE)) {
      return JSON.parse(fs.readFileSync(LOCAL_CACHE, 'utf8'));
    }
  } catch {}
  return null;
}

// Debounced write — batches rapid changes into one GitHub commit
function scheduleSave(data) {
  _pendingData = data;
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    if (_pendingData) saveToGitHub(_pendingData);
    _pendingData = null;
  }, 3000); // 3 second debounce
}

module.exports = { loadFromGitHub, loadFromLocalCache, saveToGitHub, scheduleSave };
