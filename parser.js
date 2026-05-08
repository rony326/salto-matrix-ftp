'use strict';

const fs   = require('fs');
const path = require('path');

// ── CSV Parser ───────────────────────────────────────────────────────────────
function splitLine(line) {
  // Salto exports use {{...}} list fields containing semicolons.
  // Track both quote context and brace depth so we only split on top-level semicolons.
  const res = []; let cur = ''; let inQ = false; let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && depth === 0) { inQ = !inQ; }   // strip quotes, don't add to cur
    else if (!inQ && c === '{')   { depth++; cur += c; }
    else if (!inQ && c === '}')   { depth--; cur += c; }
    else if (c === ';' && !inQ && depth === 0) { res.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  res.push(cur.trim());
  return res;
}

function parseCSV(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n').map(splitLine);
}

function extractIDs(val) {
  if (!val) return [];
  // IDs may appear with or without quotes after our parser strips them
  const ids = [];
  const re = /([A-F0-9]{32})/gi;
  let m;
  while ((m = re.exec(val)) !== null) ids.push(m[1].toUpperCase());
  return ids;
}

function colIdx(headers, patterns) {
  for (const p of patterns) {
    const i = headers.findIndex(h => new RegExp(p, 'i').test(h));
    if (i >= 0) return i;
  }
  return -1;
}

// ── Type detection ────────────────────────────────────────────────────────────
function detectType(filename, headers, fileMapping) {
  if (fileMapping) {
    const mapped = fileMapping[filename] || fileMapping[filename.toLowerCase()];
    if (mapped) return mapped;
  }
  const n = filename.toLowerCase();
  if (/person|user|benutzer|mitarb/.test(n)) return 'persons';
  if (/t[uü]r|door|lock/.test(n))            return 'doors';
  if (/gruppe|group|level|profil/.test(n))   return 'groups';
  if (/bereich|zone|area/.test(n))           return 'zones';
  const h = headers.join(' ').toLowerCase();
  if (/firstname|lastname|gpf/.test(h))               return 'persons';
  if (/batterystatus/.test(h))                         return 'doors';
  if (/extuseri.*extdoori|extdoori.*extuseri/.test(h)) return 'groups';
  if (headers.length <= 3 && /extid/.test(h))          return 'zones';
  return null;
}

// ── Parsers per type ──────────────────────────────────────────────────────────
function parseDoors(rows) {
  const h = rows[0];
  const iName = colIdx(h, ['^name$']);
  const iDesc = colIdx(h, ['description', 'desc', 'bezeich']);
  const iID   = colIdx(h, ['extid$']);
  const iBatt = colIdx(h, ['battery']);
  return rows.slice(1).filter(r => r[iID]).map(r => ({
    id:      r[iID],
    name:    iName >= 0 ? r[iName] : r[iID],
    desc:    iDesc >= 0 ? r[iDesc] : '',
    battery: iBatt >= 0 ? (parseInt(r[iBatt]) || null) : null,
  }));
}

function parseZones(rows) {
  const h = rows[0];
  const iName = colIdx(h, ['^name$']);
  const iDesc = colIdx(h, ['description', 'desc']);
  const iID   = colIdx(h, ['extid$']);
  return rows.slice(1).filter(r => r[iID]).map(r => ({
    id:   r[iID],
    name: iName >= 0 ? r[iName] : r[iID],
    desc: iDesc >= 0 ? r[iDesc] : '',
  }));
}

function parseGroups(rows) {
  const h = rows[0];
  const iName  = colIdx(h, ['^name$']);
  const iDesc  = colIdx(h, ['description', 'desc']);
  const iID    = colIdx(h, ['extid$']);
  const iUsers = colIdx(h, ['extuseri']);
  const iDoors = colIdx(h, ['extdoori']);
  return rows.slice(1).filter(r => r[iID]).map(r => ({
    id:    r[iID],
    name:  iName >= 0 ? r[iName] : r[iID],
    desc:  iDesc >= 0 ? r[iDesc] : '',
    doors: extractIDs(iDoors >= 0 ? r[iDoors] : ''),
    users: extractIDs(iUsers >= 0 ? r[iUsers] : ''),
  }));
}

function parsePersons(rows) {
  const h = rows[0];
  const iFirst  = colIdx(h, ['firstname', 'vorname']);
  const iLast   = colIdx(h, ['lastname', 'nachname']);
  const iGPF    = colIdx(h, ['gpf']);
  const iID     = colIdx(h, ['extid$']);
  const iLevels = colIdx(h, ['extaccesslevel']);
  const iDoors  = colIdx(h, ['extdoori']);
  return rows.slice(1).filter(r => r[iID]).map(r => {
    const first = iFirst >= 0 ? r[iFirst] : '';
    const last  = iLast  >= 0 ? r[iLast]  : '';
    return {
      id:          r[iID],
      name:        last && first ? `${last}, ${first}` : last || first || r[iID],
      firstName:   first,
      lastName:    last,
      gpf:         iGPF >= 0 ? r[iGPF] : '',
      groups:      extractIDs(iLevels >= 0 ? r[iLevels] : ''),
      directDoors: extractIDs(iDoors  >= 0 ? r[iDoors]  : ''),
    };
  });
}

// ── Load all CSVs from a directory ────────────────────────────────────────────
function loadFromDir(dataDir, fileMapping) {
  const errors = [];
  let csvFiles;
  try {
    csvFiles = fs.readdirSync(dataDir).filter(f => f.toLowerCase().endsWith('.csv'));
  } catch (e) {
    return { persons: [], doors: [], groups: [], zones: [], errors: [`data-Ordner nicht lesbar: ${e.message}`] };
  }

  const typed = { persons: null, doors: null, groups: null, zones: null };

  for (const fname of csvFiles) {
    try {
      const text  = fs.readFileSync(path.join(dataDir, fname), 'utf8');
      const rows  = parseCSV(text);
      if (rows.length < 2) continue;
      const type  = detectType(fname, rows[0], fileMapping);
      if (!type) { errors.push(`Unbekannter Typ: ${fname} — in config/ftp.json unter "fileMapping" eintragen`); continue; }
      if (typed[type]) { errors.push(`Doppelt: ${fname} (Typ ${type} bereits geladen)`); continue; }
      typed[type] = rows;
    } catch (e) {
      errors.push(`Lesefehler ${fname}: ${e.message}`);
    }
  }

  const doors   = typed.doors   ? parseDoors(typed.doors)   : [];
  const zones   = typed.zones   ? parseZones(typed.zones)   : [];
  const groups  = typed.groups  ? parseGroups(typed.groups) : [];
  const persons = typed.persons ? parsePersons(typed.persons) : [];

  persons.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  doors.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  return { persons, doors, groups, zones, errors };
}

module.exports = { loadFromDir };
