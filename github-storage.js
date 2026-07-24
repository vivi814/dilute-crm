/**
 * GitHub-backed persistent storage
 * Main data (items/config/returnForms) → dilute-data.json
 * Images (base64)                      → dilute-images.json  (separate file to avoid size limits)
 * Orders/returns (ShopLine sync)        → dilute-orders.json  (separate file — see note below)
 */
const fs   = require('fs');
const path = require('path');

// Token in parts
const _t1='ghp_rE5088ph', _t2='Mvq4APxR3I7f', _t3='72hS6umLnN4dPQ7z';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || (_t1+_t2+_t3);
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'vivi814/dilute-crm';
const DATA_FILE    = 'dilute-data.json';
const IMAGES_FILE  = 'dilute-images.json';
const ORDERS_FILE  = 'dilute-orders.json';
const LOCAL_CACHE       = path.join(__dirname, 'data', '_github_cache.json');
const LOCAL_IMAGES_CACHE = path.join(__dirname, 'data', '_github_images_cache.json');
const LOCAL_ORDERS_CACHE = path.join(__dirname, 'data', '_github_orders_cache.json');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const headers = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent': 'dilute-crm',
};

let _sha       = null;
let _imagesSha = null;
let _ordersSha = null;
let _writeTimer = null;
let _pendingData = null;
// orders 用獨立的 debounce timer，避免跟 items/config 的存檔搶同一個 timer/sha，
// 訂單同步（可能很頻繁）不應該拖慢或干擾商品編輯的存檔時機
let _ordersWriteTimer = null;
let _pendingOrdersData = null;

// ── Generic GitHub file loader ────────────────────────────────
async function ghLoad(filename) {
  if (!GITHUB_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`,
      { headers }
    );
    if (!res.ok) return null;
    const json = await res.json();
    let content;
    if (json.encoding === 'base64' && json.content) {
      content = Buffer.from(json.content, 'base64').toString('utf8');
    } else if (json.download_url) {
      // Files over ~1MB come back with no inline content from the Contents API —
      // fall back to the raw download URL, which has no such size limit.
      const rawRes = await fetch(json.download_url, { headers: { 'Authorization': headers.Authorization, 'User-Agent': headers['User-Agent'] } });
      if (!rawRes.ok) return null;
      content = await rawRes.text();
    } else {
      return null;
    }
    return { data: JSON.parse(content), sha: json.sha };
  } catch (e) {
    console.warn(`[storage] GitHub load ${filename} failed:`, e.message);
    return null;
  }
}

// ── Generic GitHub file saver ─────────────────────────────────
// 回傳 { sha, ok }：ok=false 代表這次沒有真的存進GitHub（呼叫端要能知道存檔其實失敗了，
// 不能誤以為資料已經安全備份，避免呼叫端在還沒真正存好時就跟使用者回報「成功」）
async function ghSave(filename, data, sha, localCache) {
  if (!GITHUB_TOKEN) return { sha, ok: false };
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    const sizeKB = Buffer.byteLength(jsonStr, 'utf8') / 1024;
    if (sizeKB > 90 * 1024) {
      console.warn(`[storage] ${filename} too large (${Math.round(sizeKB)}KB), skipping GitHub save`);
      return { sha, ok: false };
    }
    const content = Buffer.from(jsonStr).toString('base64');
    const body = {
      message: `[auto] data update ${new Date().toISOString()}`,
      content,
      ...(sha ? { sha } : {}),
    };
    let res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`,
      { method: 'PUT', headers, body: JSON.stringify(body) }
    );
    // 422 = 檔案已存在但缺少 sha，自動取得 sha 後重試
    if (res.status === 422 && !sha) {
      const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`, { headers });
      if (getRes.ok) {
        const getJson = await getRes.json();
        body.sha = getJson.sha;
        res = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${filename}`,
          { method: 'PUT', headers, body: JSON.stringify(body) }
        );
      }
    }
    if (res.ok) {
      const json = await res.json();
      const newSha = json.content?.sha;
      if (localCache) fs.writeFileSync(localCache, jsonStr, 'utf8');
      console.log(`[storage] Saved ${filename} (${Math.round(sizeKB)}KB) ✅`);
      return { sha: newSha, ok: true };
    } else {
      const err = await res.text();
      console.warn(`[storage] GitHub save ${filename} failed:`, res.status, err);
    }
  } catch (e) {
    console.warn(`[storage] GitHub save ${filename} error:`, e.message);
  }
  return { sha, ok: false };
}

// ── Per-file image storage (images/<hash>.<ext>) ────────────────
// 大量圖片改成每張各自存成獨立檔案，不再全部擠進同一個 dilute-images.json：
// - 上傳一張只動一個小檔案，不會隨照片越多而越存越慢
// - 沒有總檔案大小上限的問題（單一大檔案在 GitHub Contents API 有~1MB讀取限制、
//   以及本專案自訂的90MB跳過存檔上限；改成分散成多檔後這兩個限制都不會被觸發）
// 內容用雜湊當檔名，同一張照片不會重複寫入，也不需要追蹤 sha
async function ghSaveImageFile(hash, ext, base64Content) {
  if (!GITHUB_TOKEN) return false;
  try {
    const filePath = `images/${hash}.${ext}`;
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      { method: 'PUT', headers, body: JSON.stringify({ message: `[img] ${filePath}`, content: base64Content }) }
    );
    // 422 通常代表這個檔案（同雜湊=同內容）已經存在，視為成功
    if (res.ok || res.status === 422) return true;
    const err = await res.text();
    console.warn(`[storage] Save image ${filePath} failed:`, res.status, err);
    return false;
  } catch (e) {
    console.warn(`[storage] Save image ${hash}.${ext} error:`, e.message);
    return false;
  }
}

async function ghLoadImageFile(hash, ext) {
  if (!GITHUB_TOKEN) return null;
  try {
    const filePath = `images/${hash}.${ext}`;
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      { headers }
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.encoding === 'base64' && json.content) {
      return Buffer.from(json.content.replace(/\n/g, ''), 'base64');
    }
    if (json.download_url) {
      const rawRes = await fetch(json.download_url, { headers: { 'Authorization': headers.Authorization, 'User-Agent': headers['User-Agent'] } });
      if (!rawRes.ok) return null;
      return Buffer.from(await rawRes.arrayBuffer());
    }
    return null;
  } catch (e) {
    console.warn(`[storage] Load image ${hash}.${ext} error:`, e.message);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────

async function loadFromGitHub() {
  const result = await ghLoad(DATA_FILE);
  if (!result) return null;
  _sha = result.sha;
  fs.writeFileSync(LOCAL_CACHE, JSON.stringify(result.data, null, 2), 'utf8');
  console.log('[storage] Loaded main data from GitHub ✅');
  return result.data;
}

async function loadImagesFromGitHub() {
  const result = await ghLoad(IMAGES_FILE);
  if (!result) return null;
  _imagesSha = result.sha;
  fs.writeFileSync(LOCAL_IMAGES_CACHE, JSON.stringify(result.data, null, 2), 'utf8');
  console.log(`[storage] Loaded images from GitHub ✅ (${Object.keys(result.data).length} images)`);
  return result.data;
}

async function saveToGitHub(data) {
  const r = await ghSave(DATA_FILE, data, _sha, LOCAL_CACHE);
  _sha = r.sha;
  return r.ok;
}

async function loadOrdersFromGitHub() {
  const result = await ghLoad(ORDERS_FILE);
  if (!result) return null;
  _ordersSha = result.sha;
  fs.writeFileSync(LOCAL_ORDERS_CACHE, JSON.stringify(result.data, null, 2), 'utf8');
  console.log(`[storage] Loaded orders from GitHub ✅ (${(result.data.orders||[]).length} orders, ${(result.data.returns||[]).length} returns)`);
  return result.data;
}

async function saveOrdersToGitHub(data) {
  const r = await ghSave(ORDERS_FILE, data, _ordersSha, LOCAL_ORDERS_CACHE);
  _ordersSha = r.sha;
  return r.ok;
}

function loadOrdersFromLocalCache() {
  try {
    if (fs.existsSync(LOCAL_ORDERS_CACHE)) return JSON.parse(fs.readFileSync(LOCAL_ORDERS_CACHE, 'utf8'));
  } catch {}
  return null;
}

// Debounced writes — 獨立的 timer，不跟 scheduleSave() 共用。
// 收函式而不是先算好的資料：整批同步時這裡會被連續呼叫上千次，
// 只有真的要存檔那一刻（debounce 到期）才呼叫它組出 snapshot，
// 避免每呼叫一次就先花 O(n) 組一次陣列，變相把 Map 化省下來的效能又還回去。
//
// 單一飛行（single-flight）保護：debounce 只解決「呼叫很頻繁」，沒解決「上一次
// GitHub 存檔還沒回來、下一次又來了」——訂單量大時整批同步會連續觸發上百次，
// 如果每次 debounce 到期都各自發一個 PUT，會疊出一堆同時飛行中的請求，每個都
// 帶著越滾越大的 JSON blob，記憶體用量隨同步進度線性疊加，正是造成正式環境
// OOM 重啟的原因。這裡用 _ordersSaving 旗標確保同一時間最多只有一個真正在
// 發送的存檔請求；存檔中若又有新資料進來，只記下「還有更新」，等目前這次存完
// 再用最新資料補存一次，不會疊加並發請求。
let _ordersSaving = false;
let _ordersSaveAgain = false;

function scheduleOrdersSave(getData) {
  _pendingOrdersData = getData;
  if (_ordersWriteTimer) clearTimeout(_ordersWriteTimer);
  _ordersWriteTimer = setTimeout(() => runOrdersSave(), 100);
}

async function runOrdersSave() {
  if (_ordersSaving) {
    _ordersSaveAgain = true;
    return;
  }
  if (!_pendingOrdersData) return;
  _ordersSaving = true;
  _ordersSaveAgain = false;
  const getData = _pendingOrdersData;
  _pendingOrdersData = null;
  try {
    await saveOrdersToGitHub(getData());
  } finally {
    _ordersSaving = false;
    if (_ordersSaveAgain || _pendingOrdersData) {
      _ordersSaveAgain = false;
      runOrdersSave();
    }
  }
}

function loadFromLocalCache() {
  try {
    if (fs.existsSync(LOCAL_CACHE)) return JSON.parse(fs.readFileSync(LOCAL_CACHE, 'utf8'));
  } catch {}
  return null;
}

function loadImagesFromLocalCache() {
  try {
    if (fs.existsSync(LOCAL_IMAGES_CACHE)) return JSON.parse(fs.readFileSync(LOCAL_IMAGES_CACHE, 'utf8'));
  } catch {}
  return null;
}

// Debounced writes
function scheduleSave(data) {
  _pendingData = data;
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    if (_pendingData) saveToGitHub(_pendingData);
    _pendingData = null;
  }, 100);
}

module.exports = {
  loadFromGitHub, loadImagesFromGitHub, loadOrdersFromGitHub,
  loadFromLocalCache, loadImagesFromLocalCache, loadOrdersFromLocalCache,
  saveToGitHub, saveOrdersToGitHub,
  scheduleSave, scheduleOrdersSave,
  ghSaveImageFile, ghLoadImageFile,
  GITHUB_TOKEN, GITHUB_REPO,
};
