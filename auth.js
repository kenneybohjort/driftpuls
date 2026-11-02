// Inloggning: lokala användare, scrypt-hashade lösenord, serversidiga sessioner.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = (DATA_DIR) => {
  const usersFile = path.join(DATA_DIR, 'users.json');
  const sessFile = path.join(DATA_DIR, 'sessions.json');
  const auditFile = path.join(DATA_DIR, 'audit.jsonl');
  const IDLE = 12 * 3600e3;      // utloggad efter 12 h utan aktivitet
  const ABSOLUTE = 7 * 24 * 3600e3; // och alltid efter 7 dygn
  const MAX_AUDIT_BYTES = 5 * 1024 * 1024; // rotera audit.jsonl vid 5 MB

  const rotateAuditIfNeeded = () => {
    try {
      if (!fs.existsSync(auditFile)) return;
      const st = fs.statSync(auditFile);
      if (st.size < MAX_AUDIT_BYTES) return;
      for (let i = 2; i >= 1; i--) {
        const src = `${auditFile}.${i}`;
        const dst = `${auditFile}.${i + 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
      fs.renameSync(auditFile, `${auditFile}.1`);
    } catch {}
  };

  const log = (action, o = {}) => {
    const rec = { ts: new Date().toISOString(), action, ...o };
    console.log(JSON.stringify(rec));
    try {
      rotateAuditIfNeeded();
      fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n');
    } catch {}
  };
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const write = (f, d) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(t, f); };

  const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  const verify = (pw, stored) => {
    const [, salt, h] = String(stored).split('$');
    if (!salt || !h) return false;
    const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const DUMMY = hash('dummy'); // lika lång svarstid även när användaren inte finns

  // ---------- TOTP / 2FA (RFC 6238 & RFC 4648 Base32 utan externa beroenden) ----------
  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const base32Encode = (buf) => {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
  };
  const base32Decode = (str) => {
    const cleanStr = String(str || '').toUpperCase().replace(/[\s=-]+/g, '');
    let bits = 0, value = 0;
    const bytes = [];
    for (const ch of cleanStr) {
      const idx = BASE32_ALPHABET.indexOf(ch);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  };
  const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));
  const generateTotp = (secretBase32, timeStep = Math.floor(Date.now() / 30000)) => {
    const key = base32Decode(secretBase32);
    if (!key.length) return '';
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(timeStep));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  };
  const verifyTotp = (secretBase32, token, nowMs = Date.now()) => {
    const cleanToken = String(token ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanToken) || !secretBase32) return false;
    const step = Math.floor(nowMs / 30000);
    const bufA = Buffer.from(cleanToken);
    for (const delta of [-1, 0, 1]) {
      const expected = generateTotp(secretBase32, step + delta);
      const bufB = Buffer.from(expected);
      if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) return true;
    }
    return false;
  };

  // ---------- Användare & Roller (admin / tekniker) ----------
  const ROLES = ['admin', 'tekniker'];
  const normRole = (r) => (r === 'tekniker' ? 'tekniker' : 'admin');
  let usersCache = { mtimeMs: -1, data: {} };
  const loadReadOnly = () => {
    try {
      const st = fs.statSync(usersFile);
      if (st.mtimeMs === usersCache.mtimeMs) return usersCache.data;
      const parsed = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      usersCache = { mtimeMs: st.mtimeMs, data: parsed && typeof parsed === 'object' ? parsed : {} };
      return usersCache.data;
    } catch {
      usersCache = { mtimeMs: -1, data: {} };
      return usersCache.data;
    }
  };
  const load = () => structuredClone(loadReadOnly());
  const saveUsers = (u) => {
    write(usersFile, u);
    try {
      const st = fs.statSync(usersFile);
      usersCache = { mtimeMs: st.mtimeMs, data: structuredClone(u) };
    } catch {
      usersCache = { mtimeMs: -1, data: {} };
    }
  };
  const users = {
    list: () => Object.keys(loadReadOnly()),
    listDetailed: () => Object.entries(loadReadOnly())
      .map(([username, info]) => ({
        username,
        role: normRole(info?.role),
        totpEnabled: Boolean(info?.totpSecret),
        created: info?.created || null,
        pwv: info?.pwv || 1,
      }))
      .sort((a, b) => a.username.localeCompare(b.username)),
    getRole(name) {
      const rec = loadReadOnly()[String(name || '').trim().toLowerCase()];
      return normRole(rec?.role);
    },
    hasTotp(name) {
      const rec = loadReadOnly()[String(name || '').trim().toLowerCase()];
      return Boolean(rec?.totpSecret);
    },
    verifyPassword(name, pw) {
      name = String(name || '').toLowerCase();
      const rec = loadReadOnly()[name];
      if (!rec) return false;
      return verify(String(pw ?? ''), rec.hash);
    },
    add(name, pw, role = 'admin') {
      name = String(name || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,32}$/.test(name)) throw new Error('Ogiltigt användarnamn (2–32 tecken: a-z, 0-9, punkt, understreck, bindestreck)');
      if (String(pw ?? '').length < 12) throw new Error('Lösenordet måste vara minst 12 tecken');
      if (!ROLES.includes(role)) throw new Error('Ogiltig roll (måste vara admin eller tekniker)');
      const u = load();
      if (u[name]) throw new Error('Användaren finns redan');
      u[name] = { hash: hash(String(pw)), role, pwv: 1, created: new Date().toISOString() };
      saveUsers(u);
    },
    setRole(name, role) {
      name = String(name || '').trim().toLowerCase();
      if (!ROLES.includes(role)) throw new Error('Ogiltig roll (måste vara admin eller tekniker)');
      const u = load();
      if (!u[name]) throw new Error('Användaren finns inte');
      const currentRole = normRole(u[name].role);
      if (currentRole === 'admin' && role !== 'admin') {
        const adminCount = Object.values(u).filter((rec) => normRole(rec?.role) === 'admin').length;
        if (adminCount <= 1) throw new Error('Kan inte ändra roll på den sista administratören');
      }
      u[name].role = role;
      u[name].updated = new Date().toISOString();
      saveUsers(u);
    },
    passwd(name, pw) {
      name = String(name || '').trim().toLowerCase();
      if (String(pw ?? '').length < 12) throw new Error('Lösenordet måste vara minst 12 tecken');
      const u = load();
      if (!u[name]) throw new Error('Användaren finns inte');
      u[name].hash = hash(String(pw));
      u[name].pwv = (u[name].pwv || 1) + 1; // loggar ut alla pågående sessioner
      u[name].updated = new Date().toISOString();
      saveUsers(u);
    },
    setupTotp(name) {
      name = String(name || '').trim().toLowerCase();
      const u = load();
      if (!u[name]) throw new Error('Användaren finns inte');
      const secret = generateTotpSecret();
      u[name].pendingTotpSecret = secret;
      saveUsers(u);
      const issuer = encodeURIComponent('Driftpuls');
      const account = encodeURIComponent(name);
      const otpauthUrl = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
      return { secret, otpauthUrl };
    },
    enableTotp(name, token) {
      name = String(name || '').trim().toLowerCase();
      const u = load();
      if (!u[name]) throw new Error('Användaren finns inte');
      const pending = u[name].pendingTotpSecret;
      if (!pending) throw new Error('Ingen pågående 2FA-konfiguration hittades. Starta om konfigurationen.');
      if (!verifyTotp(pending, token)) {
        throw new Error('Ogiltig 6-siffrig kod. Kontrollera koden i din Authenticator-app.');
      }
      u[name].totpSecret = pending;
      delete u[name].pendingTotpSecret;
      u[name].updated = new Date().toISOString();
      saveUsers(u);
      return true;
    },
    disableTotp(name) {
      name = String(name || '').trim().toLowerCase();
      const u = load();
      if (!u[name]) throw new Error('Användaren finns inte');
      delete u[name].totpSecret;
      delete u[name].pendingTotpSecret;
      u[name].updated = new Date().toISOString();
      saveUsers(u);
      return true;
    },
    remove(name) {
      name = String(name || '').trim().toLowerCase();
      const u = load();
      if (!u[name]) throw new Error('Användaren finns inte');
      if (Object.keys(u).length <= 1) throw new Error('Kan inte ta bort den sista kvarvarande användaren');
      if (normRole(u[name].role) === 'admin') {
        const adminCount = Object.values(u).filter((rec) => normRole(rec?.role) === 'admin').length;
        if (adminCount <= 1) throw new Error('Kan inte ta bort den sista administratören');
      }
      delete u[name];
      saveUsers(u);
    },
  };

  // Första start: skapa ett konto från ADMIN_USER/ADMIN_PASS om inga användare finns
  function bootstrap(user, pass) {
    if (users.list().length) return;
    if (user && pass) {
      try { users.add(user, pass); log('bootstrap_user', { user }); }
      catch (e) { console.error('Kunde inte skapa första användaren:', e.message); }
    } else {
      console.warn('Inga användare finns. Skapa en: docker exec -it drift-admin node users.js add NAMN');
    }
  }

  // ---------- Sessioner ----------
  const sessions = new Map(Object.entries(read(sessFile, {})));
  const fails = new Map();
  const persist = () => write(sessFile, Object.fromEntries(sessions));
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const cookie = (req) => {
    const m = /(?:^|;\s*)drift_sid=([^;]+)/.exec(req.headers.cookie || '');
    return m ? m[1] : null;
  };
  function session(req) {
    const t = cookie(req);
    const s = t && sessions.get(sha(t));
    if (!s) return null;
    const now = Date.now(), u = loadReadOnly()[s.user];
    if (!u || u.pwv !== s.pwv || now - s.seen > IDLE || now - s.created > ABSOLUTE) {
      sessions.delete(sha(t)); persist(); return null;
    }
    s.seen = now;
    s.role = normRole(u.role);
    return s;
  }

  function changeOwnPassword(req, currentPw, newPw) {
    const user = String(req.adminUser || '').toLowerCase();
    if (!user) throw new Error('Inte inloggad');
    if (!users.verifyPassword(user, currentPw)) {
      log('password_change_failed', { user, ip: req.ip });
      throw new Error('Nuvarande lösenord är felaktigt.');
    }
    users.passwd(user, newPw);
    const updatedUser = load()[user];
    const t = cookie(req);
    const s = t && sessions.get(sha(t));
    if (s && updatedUser) {
      s.pwv = updatedUser.pwv;
      s.seen = Date.now();
      persist();
    }
    log('password_changed', { user, ip: req.ip });
  }

  function cleanupExpiredSessions() {
    const now = Date.now();
    let count = 0;
    const u = load();
    for (const [key, s] of sessions.entries()) {
      const userRec = u[s.user];
      if (!userRec || userRec.pwv !== s.pwv || now - s.seen > IDLE || now - s.created > ABSOLUTE) {
        sessions.delete(key);
        count++;
      }
    }
    if (count > 0) {
      persist();
      log('sessions_pruned', { count });
    }
    for (const [k, f] of fails.entries()) {
      if ((f.until && f.until < now) || (f.ts && now - f.ts > 3600e3)) fails.delete(k);
    }
  }
  cleanupExpiredSessions();
  const cleanupTimer = setInterval(cleanupExpiredSessions, 3600e3);
  if (cleanupTimer.unref) cleanupTimer.unref();

  // ---------- Spärr mot gissning (per IP + användarnamn) ----------
  const locked = (k) => (fails.get(k)?.until || 0) > Date.now();
  const fail = (k) => {
    const f = fails.get(k) || { n: 0, until: 0, ts: 0 };
    f.ts = Date.now();
    if (++f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
    fails.set(k, f);
  };

  function login(req, res) {
    const user = String(req.body?.username ?? '').trim().toLowerCase().slice(0, 64);
    const pw = String(req.body?.password ?? '').slice(0, 256);
    const totp = String(req.body?.totp ?? '').trim();
    const key = `${req.ip}|${user}`;
    if (locked(key)) return res.status(429).json({ success: false, error: 'För många försök. Vänta 15 minuter.' });
    const rec = load()[user];
    const ok = verify(pw, rec ? rec.hash : DUMMY) && !!rec;
    if (!ok) {
      fail(key);
      log('login_failed', { user, ip: req.ip });
      return setTimeout(() => res.status(401).json({ success: false, error: 'Fel användarnamn eller lösenord.' }), 400);
    }
    if (rec.totpSecret) {
      if (!totp) {
        return res.status(200).json({
          success: false,
          requireTotp: true,
          message: 'Ange 6-siffrig engångskod från din Authenticator-app.',
        });
      }
      if (!verifyTotp(rec.totpSecret, totp)) {
        fail(key);
        log('login_totp_failed', { user, ip: req.ip });
        return setTimeout(() => res.status(401).json({ success: false, requireTotp: true, error: 'Ogiltig 2FA-kod. Försök igen.' }), 400);
      }
    }
    fails.delete(key);
    const role = normRole(rec.role);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(sha(token), { user, role, pwv: rec.pwv, created: Date.now(), seen: Date.now() });
    persist();
    res.setHeader('Set-Cookie', `drift_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ABSOLUTE / 1000}${req.secure ? '; Secure' : ''}`);
    log('login', { user, role, twoFactor: Boolean(rec.totpSecret), ip: req.ip });
    res.json({ success: true, user, role });
  }

  function logout(req, res) {
    const t = cookie(req);
    if (t) { sessions.delete(sha(t)); persist(); }
    res.setHeader('Set-Cookie', 'drift_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
  }

  function requireAuth(req, res, next) {
    const s = session(req);
    if (s) {
      req.adminUser = s.user;
      req.userRole = s.role || users.getRole(s.user);
      return next();
    }
    if (req.originalUrl.startsWith('/api')) return res.status(401).json({ success: false, error: 'Inte inloggad' });
    res.redirect('/login');
  }

  function requireAdmin(req, res, next) {
    const role = req.userRole || users.getRole(req.adminUser);
    if (role === 'admin') return next();
    return res.status(403).json({ success: false, error: 'Åtgärden kräver administratörsbehörighet (admin).' });
  }

  return {
    login,
    logout,
    require: requireAuth,
    requireAdmin,
    bootstrap,
    users,
    changeOwnPassword,
    totp: {
      generateSecret: generateTotpSecret,
      generate: generateTotp,
      verify: verifyTotp,
    },
  };
};
