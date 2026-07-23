/**
 * 財務報表的第二層密碼驗證。
 * 不用 express-session（沒有個別使用者、沒有需要伺服器記住的狀態，而且 MemoryStore
 * 在這個 app 本來就會頻繁重啟的情況下，會讓所有已登入的財務 session 靜默登出）。
 * 改用無狀態的簽章 cookie：payload 帶著到期時間，伺服器端不用存任何 session。
 */
const crypto = require('crypto');

const FINANCE_ACCESS_CODE   = process.env.FINANCE_ACCESS_CODE   || '';
const FINANCE_COOKIE_SECRET = process.env.FINANCE_COOKIE_SECRET || '';
const COOKIE_NAME     = 'dilute_finance';
const SESSION_TTL_MS  = 12 * 60 * 60 * 1000; // 12 小時

function sign(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', FINANCE_COOKIE_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !FINANCE_COOKIE_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', FINANCE_COOKIE_SECRET).update(b64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// timingSafeEqual 要求兩個 buffer 長度相同，長度不同時代表密碼一定不對，直接回傳 false
function checkAccessCode(code) {
  if (!FINANCE_ACCESS_CODE || !FINANCE_COOKIE_SECRET || typeof code !== 'string') return false;
  const a = Buffer.from(code);
  const b = Buffer.from(FINANCE_ACCESS_CODE);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function issueCookie(res) {
  const token = sign({ exp: Date.now() + SESSION_TTL_MS });
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,               // 本機 http 開發環境不強制 Secure，不然 cookie 送不出去
    sameSite: isProd ? 'none' : 'lax',
    maxAge: SESSION_TTL_MS,
  });
}

function clearCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' });
}

function isAuthed(req) {
  return !!verify(req.cookies?.[COOKIE_NAME]);
}

function requireFinanceAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: '需要財務密碼登入' });
  next();
}

module.exports = { checkAccessCode, issueCookie, clearCookie, requireFinanceAuth, isAuthed, COOKIE_NAME };
