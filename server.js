'use strict';

const express        = require('express');
const session        = require('express-session');
const cors           = require('cors');
const fs             = require('fs');
const path           = require('path');
const crypto         = require('crypto');
const { Issuer, generators } = require('openid-client');

const { syncRemote } = require('./sync');
const { loadFromDir } = require('./parser');

// ── Config — single source of truth: environment variables ───────────────────
const PORT      = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR  = path.resolve(process.env.DATA_DIR  || './data');
const ZONES_FILE = path.resolve(process.env.ZONES_FILE || './config/zones.json');

// ── Auth config ───────────────────────────────────────────────────────────────
// AUTH_MODE: 'none' (default) | 'oidc' | 'forward-auth'
const AUTH_MODE = process.env.AUTH_MODE || 'none';

// OIDC / Authentik settings (only needed when AUTH_MODE=oidc)
const OIDC_ISSUER        = process.env.OIDC_ISSUER        || '';   // e.g. https://auth.example.com/application/o/salto-matrix/
const OIDC_CLIENT_ID     = process.env.OIDC_CLIENT_ID     || '';
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const OIDC_REDIRECT_URI  = process.env.OIDC_REDIRECT_URI  || `http://localhost:${PORT}/auth/callback`;
const OIDC_SCOPES        = process.env.OIDC_SCOPES        || 'openid profile email';
const SESSION_SECRET     = process.env.SESSION_SECRET     || crypto.randomBytes(32).toString('hex');

// Forward-Auth header names (only needed when AUTH_MODE=forward-auth)
const AUTH_USER_HDR   = process.env.AUTH_USER_HDR   || 'x-authentik-username';
const AUTH_EMAIL_HDR  = process.env.AUTH_EMAIL_HDR  || 'x-authentik-email';
const AUTH_NAME_HDR   = process.env.AUTH_NAME_HDR   || 'x-authentik-name';
const AUTH_GROUPS_HDR = process.env.AUTH_GROUPS_HDR || 'x-authentik-groups';

// Sync interval
let SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_SEC || '300', 10) * 1000;

// ── State ─────────────────────────────────────────────────────────────────────
let db = { persons: [], doors: [], groups: [], zones: [], errors: [], lastUpdate: null };
let syncState = { running: false, lastSync: null, lastResult: null, nextSync: null, error: null, disabled: false };
let syncTimer = null;
let oidcClient = null;

// ── Config loaders ────────────────────────────────────────────────────────────
function loadFTPConfig() {
  if (!process.env.FTP_HOST) return null;
  return {
    protocol:    process.env.FTP_PROTOCOL   || 'ftp',
    host:        process.env.FTP_HOST,
    port:        parseInt(process.env.FTP_PORT || (process.env.FTP_PROTOCOL === 'sftp' ? '22' : '21'), 10),
    user:        process.env.FTP_USER        || 'anonymous',
    password:    process.env.FTP_PASSWORD    || '',
    remotePath:  process.env.FTP_REMOTE_PATH || '/',
    ftps:        process.env.FTP_TLS         === 'true',
    privateKey:  process.env.SFTP_KEY_FILE   || null,
    hostKey:     process.env.SFTP_HOST_KEY   || 'verify',
    disabled:    process.env.FTP_DISABLED    === 'true',
    fileMapping: {
      [process.env.FTP_FILE_PERSONS || 'personen.csv']: 'persons',
      [process.env.FTP_FILE_DOORS   || 'tueren.csv']:   'doors',
      [process.env.FTP_FILE_GROUPS  || 'gruppen.csv']:  'groups',
      [process.env.FTP_FILE_ZONES   || 'bereich.csv']:  'zones',
    },
  };
}

function loadZoneMapping() {
  if (fs.existsSync(ZONES_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8'));
      return cfg.doorZones || {};
    } catch (e) { console.error('[CONFIG] zones.json Fehler:', e.message); }
  }
  return {};
}

// ── Data reload ───────────────────────────────────────────────────────────────
function reloadData() {
  const cfg = loadFTPConfig();
  const result = loadFromDir(DATA_DIR, cfg?.fileMapping || null);
  const doorZones = loadZoneMapping();
  result.doors = result.doors.map(d => ({ ...d, zone: doorZones[d.name] || doorZones[d.id] || '' }));
  db = { ...result, lastUpdate: new Date().toISOString() };
  console.log(`[DATA] ${db.persons.length} Personen, ${db.doors.length} Türen, ${db.groups.length} Gruppen`);
  if (db.errors.length) db.errors.forEach(e => console.warn('  WARN:', e));
}

// ── FTP/SFTP sync ─────────────────────────────────────────────────────────────
async function runSync() {
  if (syncState.running) return;
  const cfg = loadFTPConfig();
  if (!cfg) {
    syncState.error = null; syncState.disabled = true;
    console.warn('[SYNC] Keine FTP/SFTP-Konfiguration — nur lokale Daten');
    scheduleNext(); return;
  }
  if (cfg.disabled === true) {
    console.log('[SYNC] FTP-Sync deaktiviert');
    syncState.error = null; syncState.disabled = true;
    syncState.lastResult = { ok: true, disabled: true };
    syncState.lastSync = new Date().toISOString();
    scheduleNext(); return;
  }
  syncState.disabled = false;
  syncState.running = true;
  syncState.error = null;
  console.log(`[SYNC] Starte ${cfg.protocol?.toUpperCase() || 'FTP'}-Sync von ${cfg.host}${cfg.remotePath || '/'}`);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const result = await syncRemote(cfg, DATA_DIR);
    syncState.lastResult = result;
    syncState.lastSync = new Date().toISOString();
    if (result.ok) {
      if (result.files.filter(f => f.action === 'downloaded').length > 0) {
        console.log(`[SYNC] ${result.files.filter(f=>f.action==='downloaded').length} Datei(en) aktualisiert`);
        reloadData();
      } else { console.log('[SYNC] Keine Änderungen'); }
    } else { syncState.error = result.error; }
  } catch (e) {
    syncState.error = e.message;
    console.error('[SYNC] Fehler:', e.message);
  } finally {
    syncState.running = false;
    scheduleNext();
  }
}

function scheduleNext() {
  if (syncTimer) clearTimeout(syncTimer);
  syncState.nextSync = new Date(Date.now() + SYNC_INTERVAL_MS).toISOString();
  syncTimer = setTimeout(runSync, SYNC_INTERVAL_MS);
}

// ── OIDC client setup ─────────────────────────────────────────────────────────
async function setupOIDC() {
  if (AUTH_MODE !== 'oidc') return;
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) {
    console.error('[OIDC] OIDC_ISSUER, OIDC_CLIENT_ID und OIDC_CLIENT_SECRET müssen gesetzt sein');
    return;
  }
  try {
    const issuer = await Issuer.discover(OIDC_ISSUER);
    oidcClient = new issuer.Client({
      client_id:     OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      redirect_uris: [OIDC_REDIRECT_URI],
      response_types: ['code'],
    });
    console.log(`[OIDC] Client initialisiert — Issuer: ${issuer.metadata.issuer}`);
  } catch (e) {
    console.error('[OIDC] Initialisierung fehlgeschlagen:', e.message);
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Session (required for OIDC state/nonce)
app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   8 * 60 * 60 * 1000,   // 8 hours
    sameSite: 'lax',
  },
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  // Public paths — always allow
  if (req.path === '/health') return next();

  if (AUTH_MODE === 'none') return next();

  if (AUTH_MODE === 'forward-auth') {
    const username = req.headers[AUTH_USER_HDR];
    if (!username) {
      console.warn('[AUTH] Kein Auth-Header:', req.path);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.authUser = {
      username,
      email:  req.headers[AUTH_EMAIL_HDR]  || '',
      name:   req.headers[AUTH_NAME_HDR]   || username,
      groups: req.headers[AUTH_GROUPS_HDR] || '',
    };
    return next();
  }

  if (AUTH_MODE === 'oidc') {
    // Allow auth routes through
    if (req.path.startsWith('/auth/')) return next();
    // Check session
    if (req.session?.user) {
      req.authUser = req.session.user;
      return next();
    }
    // Not authenticated — redirect to login (HTML) or 401 (API)
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized', loginUrl: '/auth/login' });
    }
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/login');
  }

  next();
}

app.use(requireAuth);

// ── OIDC routes ───────────────────────────────────────────────────────────────

// Start login flow
app.get('/auth/login', (req, res) => {
  if (AUTH_MODE !== 'oidc') return res.redirect('/');
  if (!oidcClient) return res.status(503).send('OIDC nicht konfiguriert. OIDC_ISSUER, OIDC_CLIENT_ID und OIDC_CLIENT_SECRET setzen.');

  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidcState = state;
  req.session.oidcNonce = nonce;

  const authUrl = oidcClient.authorizationUrl({
    scope: OIDC_SCOPES,
    state,
    nonce,
  });
  res.redirect(authUrl);
});

// OIDC callback
app.get('/auth/callback', async (req, res) => {
  if (AUTH_MODE !== 'oidc') return res.redirect('/');
  if (!oidcClient) return res.status(503).send('OIDC nicht konfiguriert');

  try {
    const params = oidcClient.callbackParams(req);
    const tokenSet = await oidcClient.callback(OIDC_REDIRECT_URI, params, {
      state: req.session.oidcState,
      nonce: req.session.oidcNonce,
    });
    const claims = tokenSet.claims();

    req.session.user = {
      username: claims.preferred_username || claims.sub,
      name:     claims.name  || claims.preferred_username || claims.sub,
      email:    claims.email || '',
      groups:   (claims.groups || []).join(', '),
      sub:      claims.sub,
    };

    delete req.session.oidcState;
    delete req.session.oidcNonce;

    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;

    console.log(`[OIDC] Login: ${req.session.user.username}`);
    res.redirect(returnTo);
  } catch (e) {
    console.error('[OIDC] Callback-Fehler:', e.message);
    res.status(500).send(`Login fehlgeschlagen: ${e.message}<br><a href="/auth/login">Erneut versuchen</a>`);
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  const user = req.session?.user;
  req.session.destroy(() => {
    if (AUTH_MODE === 'oidc' && oidcClient?.issuer?.metadata?.end_session_endpoint) {
      const logoutUrl = new URL(oidcClient.issuer.metadata.end_session_endpoint);
      logoutUrl.searchParams.set('post_logout_redirect_uri', OIDC_REDIRECT_URI.replace('/auth/callback', '/'));
      return res.redirect(logoutUrl.toString());
    }
    res.redirect('/');
  });
});

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  res.json(req.authUser || { username: null, name: null, email: null, authMode: AUTH_MODE });
});

app.get('/api/data', (req, res) => { res.json(db); });

app.get('/api/status', (req, res) => {
  res.json({
    ok: true, lastUpdate: db.lastUpdate,
    counts: { persons: db.persons.length, doors: db.doors.length, groups: db.groups.length, zones: db.zones.length },
    errors: db.errors, sync: syncState,
    dataDir: DATA_DIR, syncIntervalSec: SYNC_INTERVAL_MS / 1000,
  });
});

app.post('/api/sync', async (req, res) => {
  if (syncState.running) return res.json({ ok: false, message: 'Sync läuft bereits' });
  res.json({ ok: true, message: 'Sync gestartet' });
  runSync();
});

app.post('/api/reload', (req, res) => {
  reloadData();
  res.json({ ok: true, lastUpdate: db.lastUpdate });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ── Start ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

reloadData();

setupOIDC().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✓ Salto Access Matrix auf http://localhost:${PORT}`);
    console.log(`  Auth-Modus     : ${AUTH_MODE}`);
    if (AUTH_MODE === 'oidc') {
      console.log(`  OIDC Issuer    : ${OIDC_ISSUER || 'NICHT GESETZT'}`);
      console.log(`  Redirect URI   : ${OIDC_REDIRECT_URI}`);
    }
    console.log(`  Data-Ordner    : ${DATA_DIR}`);
    console.log(`  Sync-Intervall : ${SYNC_INTERVAL_MS / 1000}s\n`);
  });
  runSync();
});

process.on('SIGTERM', () => { if (syncTimer) clearTimeout(syncTimer); process.exit(0); });
process.on('SIGINT',  () => { if (syncTimer) clearTimeout(syncTimer); process.exit(0); });
