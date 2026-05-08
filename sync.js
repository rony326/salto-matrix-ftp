'use strict';

const fs   = require('fs');
const path = require('path');

// ── FTP sync ────────────────────────────────────────────────────────────────
async function syncFTP(cfg, localDir) {
  const { Client } = require('basic-ftp');
  const client = new Client();
  client.ftp.verbose = false;
  const log = [];

  try {
    await client.access({
      host:     cfg.host,
      port:     cfg.port || 21,
      user:     cfg.user,
      password: cfg.password,
      secure:   cfg.ftps === true,          // FTPS (explicit TLS)
      secureOptions: cfg.ftps ? { rejectUnauthorized: false } : undefined,
    });

    const remotePath = cfg.remotePath || '/';
    const remoteFiles = await client.list(remotePath);
    const csvFiles = remoteFiles.filter(f => f.name.toLowerCase().endsWith('.csv'));

    for (const remoteFile of csvFiles) {
      const remoteFull = `${remotePath.replace(/\/$/, '')}/${remoteFile.name}`;
      const localFull  = path.join(localDir, remoteFile.name);

      // Only download if newer or missing
      let needsDownload = true;
      if (fs.existsSync(localFull)) {
        const localStat = fs.statSync(localFull);
        const remoteDate = remoteFile.modifiedAt || new Date(0);
        if (localStat.size === remoteFile.size && localStat.mtimeMs >= remoteDate.getTime()) {
          needsDownload = false;
        }
      }

      if (needsDownload) {
        await client.downloadTo(localFull, remoteFull);
        log.push({ file: remoteFile.name, action: 'downloaded' });
        console.log(`[FTP] ↓ ${remoteFile.name}`);
      } else {
        log.push({ file: remoteFile.name, action: 'skipped (unchanged)' });
      }
    }

    return { ok: true, files: log, protocol: 'FTP', host: cfg.host };
  } catch (err) {
    console.error('[FTP] Fehler:', err.message);
    return { ok: false, error: err.message, protocol: 'FTP', host: cfg.host };
  } finally {
    client.close();
  }
}

// ── SFTP sync ───────────────────────────────────────────────────────────────
async function syncSFTP(cfg, localDir) {
  const SftpClient = require('ssh2-sftp-client');
  const sftp = new SftpClient();
  const log = [];

  try {
    const connectOpts = {
      host:       cfg.host,
      port:       cfg.port || 22,
      username:   cfg.user,
    };

    if (cfg.privateKey) {
      connectOpts.privateKey = fs.readFileSync(cfg.privateKey);
      if (cfg.passphrase) connectOpts.passphrase = cfg.passphrase;
    } else {
      connectOpts.password = cfg.password;
    }

    if (cfg.hostKey === 'accept') {
      connectOpts.algorithms = { serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519'] };
      connectOpts.hostVerifier = () => true;
    }

    await sftp.connect(connectOpts);

    const remotePath = cfg.remotePath || '/';
    const remoteFiles = await sftp.list(remotePath);
    const csvFiles = remoteFiles.filter(f => f.name.toLowerCase().endsWith('.csv') && f.type === '-');

    for (const remoteFile of csvFiles) {
      const remoteFull = `${remotePath.replace(/\/$/, '')}/${remoteFile.name}`;
      const localFull  = path.join(localDir, remoteFile.name);

      let needsDownload = true;
      if (fs.existsSync(localFull)) {
        const localStat = fs.statSync(localFull);
        if (localStat.size === remoteFile.size && localStat.mtimeMs >= remoteFile.modifyTime) {
          needsDownload = false;
        }
      }

      if (needsDownload) {
        await sftp.fastGet(remoteFull, localFull);
        log.push({ file: remoteFile.name, action: 'downloaded' });
        console.log(`[SFTP] ↓ ${remoteFile.name}`);
      } else {
        log.push({ file: remoteFile.name, action: 'skipped (unchanged)' });
      }
    }

    return { ok: true, files: log, protocol: 'SFTP', host: cfg.host };
  } catch (err) {
    console.error('[SFTP] Fehler:', err.message);
    return { ok: false, error: err.message, protocol: 'SFTP', host: cfg.host };
  } finally {
    try { await sftp.end(); } catch {}
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
async function syncRemote(cfg, localDir) {
  if (!cfg || !cfg.host) return { ok: false, error: 'Keine FTP/SFTP-Konfiguration' };
  const protocol = (cfg.protocol || 'ftp').toLowerCase();
  if (protocol === 'sftp') return syncSFTP(cfg, localDir);
  return syncFTP(cfg, localDir);
}

module.exports = { syncRemote };
