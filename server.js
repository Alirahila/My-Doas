'use strict';
/*
  My Doas App server (no npm dependencies, Node 18+).
  Payment flow: two paths, each independent and optional.
    1. Stripe Checkout for card payments (international). Subscribe creates a
       Stripe-hosted checkout page server-side and sends the browser there
       directly (full page navigation). Stripe redirects back to
       /api/stripe-callback after the attempt; the server confirms payment
       status directly with Stripe's API before unlocking.
    2. UPI — instant, self-reported unlock (see the comment above the UPI
       section below for how that works and its tradeoffs).

  Environment variables (set these in Render > Environment):
    STRIPE_SECRET_KEY     sk_test_... while testing, sk_live_... once your Stripe account is verified
    PRICE_USD             optional, default 16 (international yearly price in US dollars)
    TOKEN_SECRET           any long random string; signs the unlock tokens (recommended)
    PRICE_INR             optional, default 1299 (yearly price in rupees, shown on the UPI QR)
    PLAN_DAYS             optional, default 365
    ADMIN_SECRET           any long passphrase, protects /admin (the UPI claims log and optional code tool)
    CODE_HOURS             optional, default 72 (only relevant to the optional code tool on /admin)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PRICE_INR = Number(process.env.PRICE_INR || 1299);
const PLAN_DAYS = Number(process.env.PLAN_DAYS || 365);
const TOKEN_SECRET = (process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex'));
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
const CODE_HOURS = Number(process.env.CODE_HOURS || 72);
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const PRICE_USD = Number(process.env.PRICE_USD || 16);

const PUBLIC_DIR = path.join(__dirname, 'public');
const DOAS_FILE = path.join(__dirname, 'data', 'doas.json');
const REDEEMED_FILE = path.join(__dirname, 'data', 'redeemed-codes.json');
const CLAIMS_FILE = path.join(__dirname, 'data', 'upi-claims.json');

/* ---------- tokens: stateless, signed ---------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0]).digest();
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch (e) { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}

/* ---------- helpers ---------- */
const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/* ---------- API ---------- */
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers.host;
  return proto + '://' + host;
}

function stripeMode() {
  if (!STRIPE_SECRET_KEY) return 'unconfigured';
  if (STRIPE_SECRET_KEY.startsWith('sk_live_')) return 'live';
  if (STRIPE_SECRET_KEY.startsWith('sk_test_')) return 'test';
  return 'invalid';
}
function formBody(obj, prefix) {
  // Stripe's API takes application/x-www-form-urlencoded with bracket notation for nested fields.
  const parts = [];
  for (const k in obj) {
    const key = prefix ? prefix + '[' + k + ']' : k;
    const v = obj[k];
    if (v && typeof v === 'object') parts.push(formBody(v, key));
    else parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
  }
  return parts.join('&');
}
async function createStripeSession(origin) {
  const body = formBody({
    mode: 'payment',
    success_url: origin + '/api/stripe-callback?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: origin + '/#pay_error=' + encodeURIComponent('Payment was cancelled.'),
    line_items: [{ price_data: { currency: 'usd', unit_amount: Math.round(PRICE_USD * 100), product_data: { name: 'My Doas App — yearly plan' } }, quantity: '1' }]
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
    body
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const desc = (data && data.error && data.error.message) || ('Stripe returned ' + r.status);
    console.error('[stripe] session creation failed:', r.status, desc);
    const err = new Error(desc);
    throw err;
  }
  return data; // { id, url, ... }
}
async function retrieveStripeSession(id) {
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('Stripe returned ' + r.status));
  return data;
}

/* ---------- manual UPI verification: admin-issued redeem codes ----------
   A static UPI QR gives no payment callback, so a real person (Rahila) must
   check her own UPI app and confirm the payment before a code is issued.
   Codes are signed + time-limited, and are tracked in a small JSON file so
   a code can't be redeemed twice. That file lives on local disk, so it does
   not survive a Render redeploy or a free-tier instance restart — fine for
   a low-volume manual flow, not a substitute for a real database at scale. */
function adminAuthed(req) {
  if (!ADMIN_SECRET) return false;
  const given = Buffer.from(bearer(req));
  const expected = Buffer.from(ADMIN_SECRET);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
function signCode(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(body).digest('base64url').slice(0, 12);
  return body + '.' + sig;
}
function readCode(raw) {
  const code = String(raw || '').trim();
  const parts = code.split('.');
  if (parts.length !== 2) return null;
  const bodyPart = parts[0], sigPart = parts[1];
  let body;
  try { body = Buffer.from(bodyPart, 'base64url').toString('utf8'); } catch (e) { return null; }
  const expectedSig = crypto.createHmac('sha256', ADMIN_SECRET).update(bodyPart).digest('base64url').slice(0, 12);
  const a = Buffer.from(expectedSig), b = Buffer.from(sigPart);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(body); } catch (e) { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}
function loadRedeemed() {
  try { return new Set(JSON.parse(fs.readFileSync(REDEEMED_FILE, 'utf8'))); } catch (e) { return new Set(); }
}
function markRedeemed(code) {
  const set = loadRedeemed();
  set.add(code);
  const arr = Array.from(set).slice(-2000); // keep the file bounded
  try { fs.mkdirSync(path.dirname(REDEEMED_FILE), { recursive: true }); fs.writeFileSync(REDEEMED_FILE, JSON.stringify(arr)); } catch (e) { console.error('redeemed-codes write failed', e.message); }
}

/* ---------- UPI instant unlock: honor-system claim, logged for manual review ----------
   No wait for a code. The buyer taps "I've paid" and gets in immediately; this is
   NOT verified against any bank or UPI record — it is self-reported. Every claim is
   logged (timestamp + optional note) so Rahila can reconcile against her UPI app
   afterwards. This trades payment security for zero friction; if it's abused, the
   /api/redeem + /admin code-based flow above still works as a stricter fallback. */
function loadClaims() {
  try { return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')); } catch (e) { return []; }
}
function addClaim(entry) {
  const arr = loadClaims();
  arr.push(entry);
  const trimmed = arr.slice(-500); // keep the file bounded
  try { fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true }); fs.writeFileSync(CLAIMS_FILE, JSON.stringify(trimmed)); } catch (e) { console.error('upi-claims write failed', e.message); }
}

async function handleApi(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, {
      amount: PRICE_INR,
      currency: 'INR',
      days: PLAN_DAYS,
      stripeMode: stripeMode(),
      amountUsd: PRICE_USD
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/stripe-session') {
    if (limited(ip, 20)) return send(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
    const sm = stripeMode();
    if (sm === 'unconfigured') return send(res, 503, { error: 'Card payments are not set up yet.' });
    if (sm === 'invalid') return send(res, 503, { error: 'The Stripe key is not valid. It should start with sk_test_ or sk_live_.' });
    try {
      const session = await createStripeSession(originOf(req));
      return send(res, 200, { url: session.url });
    } catch (e) {
      return send(res, 502, { error: 'Stripe could not start the payment: ' + e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/stripe-callback') {
    const sessionId = url.searchParams.get('session_id') || '';
    function bounce(hashParams) {
      res.writeHead(302, { Location: '/#' + new URLSearchParams(hashParams).toString(), 'Cache-Control': 'no-store' });
      res.end();
    }
    if (!sessionId) return bounce({ pay_error: 'The payment page sent back an incomplete response.' });
    if (stripeMode() === 'unconfigured' || stripeMode() === 'invalid') return bounce({ pay_error: 'Card payments are not set up.' });
    try {
      const session = await retrieveStripeSession(sessionId);
      if (session.payment_status !== 'paid') {
        return bounce({ pay_error: 'Payment was not completed.' });
      }
      const exp = Date.now() + PLAN_DAYS * 86400000;
      const token = signToken({ src: 'stripe', pid: session.payment_intent || sessionId, exp });
      console.log('[payment] Stripe verified', sessionId);
      return bounce({ token: token });
    } catch (e) {
      console.error('[stripe] callback verify failed:', e.message);
      return bounce({ pay_error: 'Payment could not be verified. If money was deducted, it will be refunded.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/upi-claim') {
    if (limited(ip, 8)) return send(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
    let body;
    try { body = await readBody(req, 2048); } catch (e) { return send(res, 400, { error: 'Invalid request.' }); }
    const note = String(body.note || '').slice(0, 200);
    const exp = Date.now() + PLAN_DAYS * 86400000;
    const token = signToken({ src: 'upi', exp });
    addClaim({ ts: Date.now(), note, ip: ip ? ip.replace(/\.\d+$/, '.xxx') : '' });
    console.log('[payment] UPI self-reported claim, note:', note || '(none)');
    return send(res, 200, { token, exp });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/claims') {
    if (!ADMIN_SECRET) return send(res, 503, { error: 'Admin is not set up (no ADMIN_SECRET configured).' });
    if (!adminAuthed(req)) return send(res, 401, { error: 'Wrong admin passphrase.' });
    const claims = loadClaims().slice(-100).reverse();
    return send(res, 200, { claims });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/create-code') {
    if (!ADMIN_SECRET) return send(res, 503, { error: 'Admin codes are not set up (no ADMIN_SECRET configured).' });
    if (limited(ip, 30)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
    if (!adminAuthed(req)) return send(res, 401, { error: 'Wrong admin passphrase.' });
    const exp = Date.now() + CODE_HOURS * 3600000;
    const code = signCode({ exp, iat: Date.now() });
    return send(res, 200, { code, expiresInHours: CODE_HOURS });
  }

  if (req.method === 'POST' && url.pathname === '/api/redeem') {
    if (!ADMIN_SECRET) return send(res, 503, { error: 'Redeem codes are not set up yet.' });
    if (limited(ip, 20)) return send(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
    let body;
    try { body = await readBody(req, 2048); } catch (e) { return send(res, 400, { error: 'Invalid request.' }); }
    const raw = String(body.code || '');
    const p = readCode(raw);
    if (!p) return send(res, 400, { error: 'That code is invalid or has expired. Please check it and try again, or ask for a new one.' });
    const redeemed = loadRedeemed();
    if (redeemed.has(raw.trim())) return send(res, 400, { error: 'That code has already been used.' });
    markRedeemed(raw.trim());
    const exp = Date.now() + PLAN_DAYS * 86400000;
    const token = signToken({ src: 'upi', exp });
    console.log('[payment] UPI code redeemed');
    return send(res, 200, { token, exp });
  }

  if (req.method === 'GET' && url.pathname === '/api/doas') {
    const p = readToken(bearer(req));
    if (!p) return send(res, 401, { error: 'Subscription required.' });
    try {
      const doas = JSON.parse(fs.readFileSync(DOAS_FILE, 'utf8'));
      return send(res, 200, { doas, exp: p.exp });
    } catch (e) {
      console.error('doas file error', e.message);
      return send(res, 500, { error: 'Could not load doas.' });
    }
  }

  return send(res, 404, { error: 'Not found.' });
}

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // single-page app: unknown paths open the app
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(idx);
      });
    }
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(buf);
  });
}

/* ---------- admin page: Rahila generates a redeem code after checking her UPI app ---------- */
const ADMIN_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>My Doas App — issue a code</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;background:#26262a;color:#f4ebd8;font:16px/1.5 Georgia,serif;padding:28px 18px 60px}
.wrap{max-width:420px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
p.sub{color:#bfb7a6;margin:0 0 24px;font-size:15px}
label{display:block;font-size:14px;color:#bfb7a6;margin:16px 0 6px}
input{width:100%;box-sizing:border-box;height:46px;border-radius:10px;border:1px solid rgba(244,235,216,.2);background:#303035;color:#f4ebd8;padding:0 12px;font:inherit}
button{width:100%;height:48px;margin-top:20px;border:0;border-radius:24px;background:#f2a3c0;color:#2a1f25;font-weight:600;font-size:17px}
button:disabled{opacity:.5}
.out{margin-top:22px;padding:16px;border:1px solid #d8b46b;border-radius:12px;display:none}
.out.show{display:block}
.code{font-family:ui-monospace,Menlo,monospace;font-size:15px;word-break:break-all;background:#1c1c1f;padding:10px;border-radius:8px;margin:8px 0}
.msg{margin-top:14px;font-size:14px;color:#ff9b9b}
.hint{margin-top:28px;font-size:13.5px;color:#8b8578}
a{color:#f2a3c0}
</style></head><body><div class="wrap">
<h1>Issue a code (optional)</h1>
<p class="sub">The app no longer makes buyers wait for this — UPI now unlocks instantly when they tap "I've paid" (see the claims log below). Use this only if you want to hand someone stricter, single-use access by hand.</p>
<label for="pw">Admin passphrase</label>
<input id="pw" type="password" autocomplete="off">
<label for="note">Note to yourself (optional — buyer's name/number)</label>
<input id="note" type="text" placeholder="e.g. Fatima, 98xxxxxxxx">
<button id="go">Generate code</button>
<div class="out" id="out">
  <div>Send this to the buyer:</div>
  <div class="code" id="codeText"></div>
  <button id="copy" type="button" style="margin-top:0">Copy code</button>
  <div style="margin-top:10px;font-size:13.5px;color:#bfb7a6">Valid for ${CODE_HOURS} hours, and only works once.</div>
</div>
<div class="msg" id="msg"></div>

<h1 style="margin-top:40px">Recent UPI claims</h1>
<p class="sub">Self-reported "I've paid" taps, newest first. Check these against your UPI app; nothing here is verified automatically.</p>
<button id="loadClaims" type="button">Load claims</button>
<div id="claimsList" style="margin-top:16px;font-size:14.5px"></div>

<p class="hint">This page is not linked from the app. Keep this URL and your admin passphrase private — anyone with both can issue themselves a code or read this log.</p>
</div>
<script>
document.getElementById('go').onclick = async function(){
  var btn=this, msg=document.getElementById('msg'), out=document.getElementById('out');
  msg.textContent='';out.classList.remove('show');btn.disabled=true;
  try{
    var r = await fetch('/api/admin/create-code',{method:'POST',headers:{Authorization:'Bearer '+document.getElementById('pw').value}});
    var d = await r.json();
    if(!r.ok) throw new Error(d.error||'Could not create a code.');
    document.getElementById('codeText').textContent=d.code;
    out.classList.add('show');
  }catch(e){ msg.textContent = e.message; }
  btn.disabled=false;
};
document.getElementById('copy').onclick = function(){
  var t=document.getElementById('codeText').textContent;
  navigator.clipboard&&navigator.clipboard.writeText(t).catch(function(){});
};
document.getElementById('loadClaims').onclick = async function(){
  var btn=this, msg=document.getElementById('msg'), list=document.getElementById('claimsList');
  msg.textContent='';btn.disabled=true;list.textContent='Loading…';
  try{
    var r = await fetch('/api/admin/claims',{headers:{Authorization:'Bearer '+document.getElementById('pw').value}});
    var d = await r.json();
    if(!r.ok) throw new Error(d.error||'Could not load claims.');
    if(!d.claims.length){ list.textContent='No claims yet.'; }
    else{
      list.innerHTML = d.claims.map(function(c){
        var when = new Date(c.ts).toLocaleString();
        return '<div style="padding:10px 0;border-top:1px solid rgba(244,235,216,.15)"><b>'+when+'</b><br>'+
          (c.note ? c.note.replace(/</g,'&lt;') : '<span style="color:#8b8578">(no note)</span>') +
          (c.ip ? '<br><span style="color:#8b8578">from '+c.ip+'</span>' : '') + '</div>';
      }).join('');
    }
  }catch(e){ list.textContent=''; msg.textContent = e.message; }
  btn.disabled=false;
};
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/admin') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      return res.end(ADMIN_PAGE);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  console.log('My Doas App on port ' + PORT + ' | Stripe mode: ' + stripeMode());
  if (stripeMode() === 'test') console.log('NOTE: Stripe test key in use. No real money is charged. Switch to sk_live_ once your Stripe account is verified.');
});
