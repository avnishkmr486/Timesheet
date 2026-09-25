/* =====================================================================
 * Timesheet Management — Core module (window.TSCore)
 * ---------------------------------------------------------------------
 *  1. IndexedDB data layer        (replaceable by a REST backend later)
 *  2. File parsing + column mapping (SheetJS)
 *  3. Normalization + validation
 *  4. Classification + task consolidation + merge resolution
 *  5. Analytics (aggregate), insights, merge suggestions
 *  6. Export helpers + sample-file generator
 * Raw uploaded rows are never mutated: every record stores `raw`
 * (original cells keyed by original header) and `n` (normalized copy).
 * ===================================================================== */
(function () {
  'use strict';

  /* ---------------- 1. Supabase (shared, cloud) data layer ---------------- */
  const SB_URL = 'https://rukymnurvuqkxlkkaopn.supabase.co';
  const SB_KEY = 'sb_publishable_ToGnk4xDeWCi2nSINVDkYQ_opm4jyVj';
  const TABLE = { users: 'users', settings: 'settings', uploads: 'uploads', timesheetRecords: 'timesheetrecords', taskMerges: 'taskmerges' };
  const KEYF = { users: 'id', settings: 'key', uploads: 'uploadId', timesheetRecords: 'recordId', taskMerges: 'mergeId' };
  const qId = v => '"' + String(v).replace(/"/g, '\\"') + '"';

  async function sb(path, opts) {
    const res = await fetch(SB_URL + '/rest/v1/' + path, {
      ...opts,
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', ...(opts && opts.headers) },
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('Cloud database error (' + res.status + '): ' + t.slice(0, 300)); }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  async function chunked(items, size, fn) { for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size)); }

  const DB = {
    all: async s => { const rows = await sb(TABLE[s] + '?select=data', { method: 'GET' }); return (rows || []).map(r => r.data); },
    get: async (s, k) => { const rows = await sb(TABLE[s] + '?id=eq.' + encodeURIComponent(k) + '&select=data', { method: 'GET' }); return rows && rows[0] ? rows[0].data : undefined; },
    put: async (s, v) => {
      const row = { id: String(v[KEYF[s]]), data: v }; if (s === 'timesheetRecords') row.uploadid = v.uploadId || null;
      await sb(TABLE[s], { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    },
    putMany: async (s, arr) => {
      if (!arr.length) return;
      const rows = arr.map(v => { const row = { id: String(v[KEYF[s]]), data: v }; if (s === 'timesheetRecords') row.uploadid = v.uploadId || null; return row; });
      await chunked(rows, 500, chunk => sb(TABLE[s], { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk) }));
    },
    del: async (s, k) => { await sb(TABLE[s] + '?id=eq.' + encodeURIComponent(k), { method: 'DELETE' }); },
    delMany: async (s, keys) => { if (!keys.length) return; await chunked(keys, 200, chunk => sb(TABLE[s] + '?id=in.(' + chunk.map(qId).join(',') + ')', { method: 'DELETE' })); },
    clear: async s => { await sb(TABLE[s] + '?id=not.is.null', { method: 'DELETE' }); },
    delByUpload: async uploadId => { await sb(TABLE.timesheetRecords + '?uploadid=eq.' + encodeURIComponent(uploadId), { method: 'DELETE' }); },
  };

  /* Non-cryptographic salted hash (local-only app). Swap for server auth later. */
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  const hashPassword = (userId, pw) => hash('tsm|' + userId + '|' + pw);

  const DEFAULT_CONFIG = {
    key: 'config',
    hoursPerSP: 8, expectedSPPerWeek: 5, expectedHoursPerWeek: 40, workingDays: 5,
    weekStartDay: 1, dateOrder: 'DMY',
    thresholds: { below: 80, above: 110 },
    excludeLeaveFromSP: true, highMeetingPct: 30, nonBillablePct: 40,
    teams: [], clients: [],
    rules: {
      leave: 'leave, holiday, week off, weekoff, week-off, pto, vacation, sick, comp off, absent, time off',
      clientMeeting: 'client meeting, client call, customer meeting, client sync, client discussion, client demo',
      internalMeeting: 'internal meeting, stand up, standup, stand-up, daily scrum, scrum call, team meeting, retro, retrospective, sprint planning, 1:1, one on one, huddle, all hands, town hall',
      training: 'training, learning, course, certification, knowledge transfer, kt session, upskilling, workshop',
      admin: 'admin, administration, administrative, timesheet, hr activity, appraisal, interview',
    },
  };
  const clone = o => JSON.parse(JSON.stringify(o));

  async function init() {
    let users = await DB.all('users');
    if (!users.length) {
      const u = { id: 'u_admin', username: 'admin', role: 'Admin', active: true, createdDate: new Date().toISOString() };
      u.passwordHash = hashPassword(u.id, 'admin');
      await DB.put('users', u);
      users = [u];
    }
    let cfg = await DB.get('settings', 'config');
    if (!cfg) { cfg = clone(DEFAULT_CONFIG); await DB.put('settings', cfg); }
    /* One-time seed of a read-only Viewer account (viewer / viewer). Not recreated if an admin deletes it. */
    if (!cfg.viewerSeeded) {
      if (!users.some(u => u.username.toLowerCase() === 'viewer')) {
        const v = { id: 'u_viewer', username: 'viewer', role: 'Viewer', active: true, createdDate: new Date().toISOString() };
        v.passwordHash = hashPassword(v.id, 'viewer');
        await DB.put('users', v); users.push(v);
      }
      cfg.viewerSeeded = true; await DB.put('settings', cfg);
    }
    else {
      cfg = Object.assign(clone(DEFAULT_CONFIG), cfg);
      cfg.rules = Object.assign(clone(DEFAULT_CONFIG.rules), cfg.rules || {});
      cfg.thresholds = Object.assign(clone(DEFAULT_CONFIG.thresholds), cfg.thresholds || {});
    }
    const [uploads, records, merges] = await Promise.all([DB.all('uploads'), DB.all('timesheetRecords'), DB.all('taskMerges')]);
    records.sort((a, b) => a.recordId < b.recordId ? -1 : 1);
    uploads.sort((a, b) => a.uploadDate < b.uploadDate ? -1 : 1);
    merges.sort((a, b) => a.createdDate < b.createdDate ? -1 : 1);
    return { users, cfg, uploads, records, merges };
  }

  /* ---------------- dates ---------------- */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function iso(y, m, d) {
    const dt = new Date(Date.UTC(y, m, d));
    if (isNaN(dt) || dt.getUTCMonth() !== ((m % 12) + 12) % 12 || y < 1990 || y > 2100) return null;
    return dt.toISOString().slice(0, 10);
  }
  function addDays(isoD, n) { const d = new Date(isoD + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dayName(isoD) { return DAYS[new Date(isoD + 'T00:00:00Z').getUTCDay()]; }
  function weekStartOf(isoD, startDay) {
    const d = new Date(isoD + 'T00:00:00Z');
    const diff = (d.getUTCDay() - (startDay || 0) + 7) % 7;
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString().slice(0, 10);
  }
  function fmtDate(isoD) {
    if (!isoD) return '—';
    const d = new Date(isoD + 'T00:00:00Z');
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function parseDate(v, order) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : iso(v.getFullYear(), v.getMonth(), v.getDate());
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
      return null;
    }
    const s = String(v).trim();
    let m;
    if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s), order);
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return iso(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) {
      const a = +m[1], b = +m[2]; let y = +m[3]; if (y < 100) y += 2000;
      let d, mo;
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else if (order === 'MDY') { mo = a; d = b; } else { d = a; mo = b; }
      return iso(y, mo - 1, d);
    }
    if ((m = s.match(/^(\d{1,2})[-\s\/.]*([A-Za-z]{3,9})[-\s\/.,]*(\d{2,4})/))) {
      const mo = MON.findIndex(x => x.toLowerCase() === m[2].slice(0, 3).toLowerCase()); let y = +m[3]; if (y < 100) y += 2000;
      if (mo >= 0) return iso(y, mo, +m[1]);
    }
    if ((m = s.match(/^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
      const mo = MON.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
      if (mo >= 0) return iso(+m[3], mo, +m[2]);
    }
    const t = Date.parse(s);
    if (!isNaN(t)) { const d = new Date(t); return iso(d.getFullYear(), d.getMonth(), d.getDate()); }
    return null;
  }

  /* ---------------- 2. Column mapping ---------------- */
  const FIELDS = [
    { key: 'employee', label: 'Employee Name', required: true, syn: ['employee name', 'employee', 'emp name', 'resource name', 'name', 'resource', 'full name', 'associate name'] },
    { key: 'hours', label: 'Hours', required: true, syn: ['hours', 'hrs', 'hour', 'time spent', 'hours spent', 'duration', 'effort', 'effort hours', 'logged hours', 'total hours'] },
    { key: 'date', label: 'Date', required: true, syn: ['date', 'work date', 'entry date', 'worked date', 'log date', 'activity date'] },
    { key: 'weekStart', label: 'Week Start Date', syn: ['week start date', 'week start', 'week starting', 'week start dt', 'week commencing', 'week'] },
    { key: 'client', label: 'Client', syn: ['client', 'client name', 'customer', 'customer name', 'account', 'brand'] },
    { key: 'taskId', label: 'ID / Ticket', syn: ['id', 'ticket', 'ticket id', 'ticket no', 'ticket number', 'task id', 'jira id', 'issue id', 'jira', 'issue key'] },
    { key: 'taskType', label: 'Task Type', syn: ['task type', 'activity type', 'type of task', 'work type', 'type'] },
    { key: 'billable', label: 'Is Billable', syn: ['is billable', 'billable', 'billable flag', 'billing', 'billable non billable'] },
    { key: 'day', label: 'Day', syn: ['day', 'weekday', 'day name'] },
    { key: 'description', label: 'Description', syn: ['description', 'task description', 'work description', 'task details', 'details', 'task', 'task name', 'comments', 'remarks', 'notes', 'summary'] },
    { key: 'empId', label: 'Emp ID', syn: ['emp id', 'employee id', 'empid', 'emp no', 'employee code', 'emp code', 'employee number', 'employee no'] },
    { key: 'empTeam', label: 'Employee Team', syn: ['employee team', 'emp team'] },
    { key: 'team', label: 'Team', syn: ['team', 'team name', 'squad', 'pod'] },
    { key: 'empType', label: 'Employee Type', syn: ['employee type', 'emp type', 'employment type', 'resource type'] },
    { key: 'department', label: 'Department', syn: ['department', 'dept', 'function'] },
    { key: 'stage', label: 'Stage', syn: ['stage', 'status'] },
    { key: 'phase', label: 'Phase', syn: ['phase'] },
    { key: 'project', label: 'Project', syn: ['project', 'project name', 'project code'] },
  ];
  const normH = h => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function autoMap(headers) {
    const map = {}; const used = new Set(); const nh = headers.map(normH);
    FIELDS.forEach(f => {
      for (const s of f.syn) {
        const i = nh.findIndex((h, ix) => !used.has(ix) && h === normH(s));
        if (i >= 0) { map[f.key] = i; used.add(i); break; }
      }
    });
    FIELDS.forEach(f => {
      if (map[f.key] != null) return;
      for (const s of f.syn) {
        const ns = normH(s); if (ns.length < 4) continue;
        const i = nh.findIndex((h, ix) => !used.has(ix) && h && (' ' + h + ' ').includes(' ' + ns + ' '));
        if (i >= 0) { map[f.key] = i; used.add(i); break; }
      }
    });
    return map;
  }
  function missingRequired(map) {
    const miss = [];
    if (map.employee == null) miss.push('Employee Name');
    if (map.hours == null) miss.push('Hours');
    if (map.date == null && !(map.weekStart != null && map.day != null)) miss.push('Date');
    return miss;
  }

  function readWorkbook(buf, fileName) {
    const isCsv = /\.csv$/i.test(fileName || '');
    return XLSX.read(buf, { type: 'array', cellDates: false, raw: isCsv });
  }
  function pickSheet(wb) {
    let best = wb.SheetNames[0], bestN = -1;
    wb.SheetNames.forEach(n => {
      const ref = wb.Sheets[n]['!ref']; if (!ref) return;
      const r = XLSX.utils.decode_range(ref); const size = r.e.r - r.s.r;
      if (size > bestN) { bestN = size; best = n; }
    });
    return best;
  }
  function sheetTable(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
    let hr = 0, best = -1;
    for (let r = 0; r < Math.min(aoa.length, 25); r++) {
      const sc = Object.keys(autoMap((aoa[r] || []).map(String))).length;
      if (sc > best) { best = sc; hr = r; }
    }
    const width = Math.max(...aoa.slice(hr, hr + 50).map(r => r.length), 0);
    const hdr = [];
    for (let i = 0; i < width; i++) {
      let h = String((aoa[hr] || [])[i] == null ? '' : aoa[hr][i]).trim() || ('Column ' + (i + 1));
      let k = h, n = 2; while (hdr.includes(k)) k = h + ' (' + (n++) + ')';
      hdr.push(k);
    }
    const rows = aoa.slice(hr + 1).filter(r => r.some(c => c !== '' && c != null));
    return { headers: hdr, rows, headerRow: hr };
  }

  /* ---------------- 3. Normalization & validation ---------------- */
  function parseHours(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim().toLowerCase().replace(/hrs?|hours?|h$/g, '').trim();
    const m = s.match(/^(-?\d+):(\d{1,2})$/);
    if (m) return (+m[1]) + (m[1].startsWith('-') ? -1 : 1) * (+m[2]) / 60;
    const n = Number(s.replace(',', '.'));
    return s === '' ? null : n;
  }
  function parseBool(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return false;
    if (/^(non|not|no|n|false|0|nb)\b|non[- ]?billable/.test(s)) return false;
    return /^(yes|y|true|1|billable|b)\b/.test(s);
  }
  const INTERNAL_CLIENTS = ['internal', 'unassigned', 'n a', 'na', 'none', 'company', 'in house', 'inhouse'];
  function isInternal(client) { const c = normH(client); return !c || INTERNAL_CLIENTS.includes(c) || c.startsWith('internal'); }
  function extractTicket(id, desc) {
    const re = /\b([A-Z][A-Z0-9]{1,9}-\d{2,})\b/;
    const a = String(id || '').toUpperCase().match(re); if (a) return a[1];
    const b = String(desc || '').toUpperCase().match(re); return b ? b[1] : '';
  }
  function canon(name, list) {
    const s = String(name || '').replace(/\s+/g, ' ').trim(); if (!s) return '';
    const hit = (list || []).find(x => x.name.toLowerCase() === s.toLowerCase());
    return hit ? hit.name : s;
  }
  const DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  function normalize(row, map, cfg) {
    const g = k => map[k] != null ? row[map[k]] : '';
    const str = k => { const v = g(k); return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); };
    let date = parseDate(g('date'), cfg.dateOrder);
    let weekStart = parseDate(g('weekStart'), cfg.dateOrder);
    const dayStr = str('day');
    if (!date && weekStart && dayStr) {
      const di = DAY_IDX[dayStr.slice(0, 3).toLowerCase()];
      if (di != null) { const off = (di - new Date(weekStart + 'T00:00:00Z').getUTCDay() + 7) % 7; date = addDays(weekStart, off); }
    }
    if (!weekStart && date) weekStart = weekStartOf(date, cfg.weekStartDay);
    const n = {
      weekStart: weekStart || '', date: date || '', rawDate: str('date'),
      day: date ? dayName(date) : dayStr,
      employee: str('employee'), empId: str('empId'),
      team: canon(str('empTeam') || str('team'), cfg.teams), rowTeam: str('team'),
      client: canon(str('client'), cfg.clients) || 'Unassigned',
      taskId: str('taskId'), taskType: str('taskType'),
      billable: parseBool(g('billable')), hoursRaw: g('hours'), hours: parseHours(g('hours')),
      description: str('description'), empType: str('empType'), department: str('department'),
      stage: str('stage'), phase: str('phase'), project: str('project'),
    };
    n.ticket = extractTicket(n.taskId, n.description);
    return n;
  }
  const sig = n => [n.employee, n.date, n.client, (n.description || '').toLowerCase(), n.hours, n.taskType].join('|');

  /* Exact-row key: every column (header=value), order-independent so files with reordered columns still match. */
  function rawKey(raw) { return Object.keys(raw).map(h => String(h).toLowerCase().trim() + '=' + String(raw[h] == null ? '' : raw[h]).trim()).sort().join('\u0001'); }
  function processRows(table, map, cfg, existingSigs, existingExact) {
    const R = compileRules(cfg);
    const I = { missingEmployee: [], missingHours: [], invalidHours: [], invalidDate: [], negative: [], blankDesc: [], duplicate: [], existing: [], exactDup: [], exactExisting: [] };
    const seen = new Map(); const seenExact = new Map();
    const cC = new Set((cfg.clients || []).map(c => c.name.toLowerCase()));
    const cT = new Set((cfg.teams || []).map(c => c.name.toLowerCase()));
    const uC = new Map(), uT = new Map();
    const emps = new Set(), clients = new Set(), weeks = new Set();
    let total = 0, minD = '', maxD = '';
    const norm = table.rows.map((row, i) => {
      const rn = table.headerRow + 2 + i;
      const n = normalize(row, map, cfg); n._row = rn; n._cat = classify(n, R);
      const flags = [];
      const ro = {}; table.headers.forEach((h, ci) => { ro[h] = row[ci]; });
      const ek = rawKey(ro);
      if (seenExact.has(ek)) { I.exactDup.push(rn); n._dup = true; n.flags = ['Exact duplicate of row ' + seenExact.get(ek) + ' — will be removed']; return n; }
      if (existingExact && existingExact.has(ek)) { I.exactExisting.push(rn); n._dup = true; n.flags = ['Identical to a row in an earlier upload — will be removed']; return n; }
      seenExact.set(ek, rn);
      if (!n.employee) { I.missingEmployee.push(rn); flags.push('Missing employee'); }
      if (n.hours === null) { I.missingHours.push(rn); flags.push('Missing hours'); }
      else if (!isFinite(n.hours)) { I.invalidHours.push(rn); flags.push('Invalid hours'); }
      else if (n.hours < 0) { I.negative.push(rn); flags.push('Negative hours'); }
      if (!n.date) { I.invalidDate.push(rn); flags.push(n.rawDate ? 'Invalid date' : 'Missing date'); }
      if (!n.description) { I.blankDesc.push(rn); flags.push('Blank description'); }
      const sg = sig(n);
      if (seen.has(sg)) { I.duplicate.push(rn); flags.push('Duplicate of row ' + seen.get(sg)); } else seen.set(sg, rn);
      if (existingSigs && existingSigs.has(sg)) { I.existing.push(rn); flags.push('Already in earlier upload'); }
      if (n.client && n.client !== 'Unassigned' && !cC.has(n.client.toLowerCase())) uC.set(n.client, (uC.get(n.client) || 0) + 1);
      if (n.team && !cT.has(n.team.toLowerCase())) uT.set(n.team, (uT.get(n.team) || 0) + 1);
      n.flags = flags;
      if (typeof n.hours === 'number' && isFinite(n.hours)) total += n.hours;
      if (n.employee) emps.add(n.employee);
      if (n.client) clients.add(n.client);
      if (n.weekStart) weeks.add(n.weekStart);
      if (n.date) { if (!minD || n.date < minD) minD = n.date; if (!maxD || n.date > maxD) maxD = n.date; }
      return n;
    });
    const L = [
      ['exactDup', 'Exact duplicate rows in this file (all columns match) — will be removed', 'warn'],
      ['exactExisting', 'Rows identical to earlier uploads (all columns match) — will be removed', 'warn'],
      ['missingEmployee', 'Rows with missing employee name', 'warn'],
      ['missingHours', 'Rows with missing hours (imported as 0)', 'warn'],
      ['invalidHours', 'Rows with non-numeric hours (imported as 0)', 'warn'],
      ['negative', 'Rows with negative hours (imported as-is)', 'warn'],
      ['invalidDate', 'Rows with missing or invalid dates', 'warn'],
      ['duplicate', 'Possible duplicates (same employee, date, client, description, hours) — imported', 'warn'],
      ['existing', 'Similar to records in earlier uploads (not all columns match) — imported', 'warn'],
      ['blankDesc', 'Rows with blank task description', 'info'],
    ];
    const issues = L.filter(([k]) => I[k].length).map(([k, label, tone]) => ({
      key: k, label, tone, count: I[k].length,
      detail: 'Rows ' + I[k].slice(0, 10).join(', ') + (I[k].length > 10 ? ' …' : ''),
    }));
    if (uC.size) issues.push({ key: 'unknownClients', label: 'Clients not in configuration', tone: 'info', count: uC.size, detail: [...uC.keys()].join(', ') });
    if (uT.size) issues.push({ key: 'unknownTeams', label: 'Teams not in configuration', tone: 'info', count: uT.size, detail: [...uT.keys()].join(', ') });
    return {
      norm, issues, unknownClients: [...uC.keys()], unknownTeams: [...uT.keys()],
      stats: { rows: norm.length - I.exactDup.length - I.exactExisting.length, removed: I.exactDup.length + I.exactExisting.length, employees: emps.size, clients: clients.size, from: minD, to: maxD, totalHours: total, weeks: weeks.size },
    };
  }

  function buildImport(table, map, norm, meta) {
    const uploadId = 'UP-' + Date.now().toString(36).toUpperCase();
    const hdr = table.headers;
    const hps = meta.cfg.hoursPerSP || 8;
    let total = 0, leave = 0; const emps = new Set(); const weeks = new Set(); let maxD = '', minD = '';
    const records = norm.map((n, i) => [n, i]).filter(([n]) => !n._dup).map(([n, i], j) => {
      const raw = {};
      hdr.forEach((h, ci) => { const v = table.rows[i][ci]; raw[h] = v === undefined ? '' : v; });
      const clean = Object.assign({}, n);
      const cat = clean._cat; delete clean._cat; delete clean._dup;
      clean.hours = (typeof n.hours === 'number' && isFinite(n.hours)) ? n.hours : 0;
      total += clean.hours; if (cat === 'leave') leave += clean.hours;
      if (n.employee) emps.add(n.employee);
      if (n.weekStart) weeks.add(n.weekStart);
      if (n.date) { if (!maxD || n.date > maxD) maxD = n.date; if (!minD || n.date < minD) minD = n.date; }
      return { recordId: uploadId + '-' + String(j + 1).padStart(6, '0'), uploadId, rowNumber: n._row, raw, n: clean };
    });
    const wk = [...weeks].sort();
    const mapping = {}; Object.keys(map).forEach(k => { if (map[k] != null) mapping[k] = hdr[map[k]]; });
    const upload = {
      uploadId, fileName: meta.fileName, sheetName: meta.sheetName, uploadDate: new Date().toISOString(),
      weekStart: wk[0] || minD, weekEnd: maxD || (wk.length ? addDays(wk[wk.length - 1], 6) : ''), weeks: wk,
      employeeCount: emps.size, recordCount: records.length,
      totalHours: Math.round(total * 10000) / 10000,
      totalStoryPoints: Math.round(((total - (meta.cfg.excludeLeaveFromSP ? leave : 0)) / hps) * 10000) / 10000,
      uploadedBy: meta.user, headers: hdr, mapping,
      warnings: meta.issues ? meta.issues.map(i => ({ label: i.label, count: i.count })) : [],
    };
    return { upload, records };
  }

  /* ---------------- 4. Classification & consolidation ---------------- */
  const CATS = [
    { key: 'project', label: 'Project / Task Work', color: '#27418C' },
    { key: 'internal_meeting', label: 'Internal Meetings', color: '#8BA3D4' },
    { key: 'client_meeting', label: 'Client Meetings', color: '#2F9C95' },
    { key: 'training', label: 'Training', color: '#C99A2E' },
    { key: 'admin', label: 'Administration', color: '#9A8BC4' },
    { key: 'leave', label: 'Leave / Holiday / Week Off', color: '#B8BFCB' },
    { key: 'other', label: 'Other / Unclassified', color: '#D9785B' },
  ];
  const CAT_LABEL = Object.fromEntries(CATS.map(c => [c.key, c.label]));
  const zeroCats = () => ({ project: 0, internal_meeting: 0, client_meeting: 0, training: 0, admin: 0, leave: 0, other: 0 });

  function compileRules(cfg) {
    const out = {};
    Object.keys(cfg.rules || {}).forEach(k => {
      out[k] = String(cfg.rules[k] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(w => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])'));
    });
    return out;
  }
  const hit = (list, t) => !!list && list.some(re => re.test(t));
  function classify(n, R) {
    const tt = (n.taskType || '').toLowerCase(), d = (n.description || '').toLowerCase(), dep = (n.department || '').toLowerCase();
    const all = tt + ' | ' + dep + ' | ' + d;
    if (hit(R.leave, tt + ' | ' + d)) return 'leave';
    if (hit(R.clientMeeting, all)) return 'client_meeting';
    if (hit(R.internalMeeting, all)) return 'internal_meeting';
    if (/(^|[^a-z])meeting/.test(tt + ' ' + d)) return isInternal(n.client) ? 'internal_meeting' : 'client_meeting';
    if (hit(R.training, tt + ' | ' + d)) return 'training';
    if (hit(R.admin, tt + ' | ' + d)) return 'admin';
    if (!n.description && !n.taskType && !n.ticket) return 'other';
    return 'project';
  }
  const normDesc = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const FILLER = new Set(['support', 'investigation', 'investigate', 'investigating', 'testing', 'tested', 'test', 'analysis', 'analyse', 'analyze', 'worked', 'working', 'work', 'on', 'for', 'the', 'and', 'of', 'fix', 'fixing', 'fixed', 'retest', 'retesting', 'review', 'with', 'to', 'in', 'ticket']);
  function cleanTicketDesc(desc, ticket) {
    const s = String(desc || '').replace(new RegExp(ticket.replace(/[-]/g, '\\-'), 'ig'), ' ');
    const words = s.split(/\s+/).filter(w => { const x = w.toLowerCase().replace(/[^a-z0-9]/g, ''); return x && !FILLER.has(x); });
    const out = words.join(' ').replace(/^[\s\-–:,.]+|[\s\-–:,.]+$/g, '');
    return out.length < 3 ? '' : out.charAt(0).toUpperCase() + out.slice(1);
  }
  function baseTask(n, cat) {
    if (cat === 'internal_meeting') return { k: 'C:im', name: 'Internal Meetings' };
    if (cat === 'client_meeting') return { k: 'C:cm', name: 'Client Meetings' };
    if (cat === 'leave') return { k: 'C:lv', name: 'Leave / Holiday / Week Off' };
    if (n.ticket) return { k: 'T:' + n.ticket, name: n.ticket };
    const d = normDesc(n.description);
    if (!d) return { k: 'D:|' + normDesc(n.taskType), name: '(No description)' + (n.taskType ? ' · ' + n.taskType : '') };
    return { k: 'D:' + d, name: n.description };
  }

  /* prepare(): classify every record, resolve consolidated task (incl. manual merges). */
  function prepare(records, cfg, merges) {
    const R = compileRules(cfg);
    const mergeTo = new Map(), mergeById = new Map();
    merges.forEach(m => { mergeById.set(m.mergeId, m); m.sourceKeys.forEach(k => mergeTo.set(k, m.mergeId)); });
    const resolve = k => { let g = 0; while (mergeTo.has(k) && g++ < 50) k = 'M:' + mergeTo.get(k); return k; };
    const base = new Map();
    const weeksM = new Map();
    const o = { teams: new Set(), employees: new Set(), clients: new Set(), departments: new Set(), projects: new Set(), taskTypes: new Set() };
    records.forEach(r => {
      const n = r.n; const cat = classify(n, R); r._cat = cat;
      const b = baseTask(n, cat); const fk = b.k + '||' + (n.client || '').toLowerCase(); r._base = fk;
      let m = base.get(fk);
      if (!m) { m = { key: fk, name: b.name, type: b.k.slice(0, 1), ticket: b.k.startsWith('T:') ? n.ticket : '', client: n.client, descs: new Map(), raws: new Set(), cat }; base.set(fk, m); }
      if (m.raws.size < 30 && n.description) m.raws.add(n.description);
      if (m.ticket) { const cd = cleanTicketDesc(n.description, m.ticket); if (cd) m.descs.set(cd, (m.descs.get(cd) || 0) + 1); }
      if (n.weekStart) { const w = weeksM.get(n.weekStart) || { start: n.weekStart, end: n.weekStart }; if (n.date && n.date > w.end) w.end = n.date; weeksM.set(n.weekStart, w); }
      if (n.team) o.teams.add(n.team); if (n.employee) o.employees.add(n.employee); if (n.client) o.clients.add(n.client);
      if (n.department) o.departments.add(n.department); if (n.project) o.projects.add(n.project); if (n.taskType) o.taskTypes.add(n.taskType);
    });
    base.forEach(m => {
      if (m.ticket) {
        let best = '', bc = 0;
        m.descs.forEach((c, d) => { if (c > bc || (c === bc && d.length > best.length)) { best = d; bc = c; } });
        m.name = m.ticket + (best ? ' — ' + best : '');
      }
    });
    const taskIndex = new Map();
    records.forEach(r => {
      const k = resolve(r._base); r._task = k;
      let t = taskIndex.get(k);
      if (!t) { t = { key: k, clients: new Set(), bases: new Set() }; taskIndex.set(k, t); }
      t.clients.add(r.n.client); t.bases.add(r._base);
    });
    const nameOf = k => {
      if (!k) return '';
      if (k.startsWith('M:')) { const m = mergeById.get(k.slice(2)); return m ? m.consolidatedTaskName : '(removed merge)'; }
      const b = base.get(k); return b ? b.name : k.split('||')[0].slice(2);
    };
    const weeks = [...weeksM.values()].sort((a, b) => a.start < b.start ? -1 : 1);
    weeks.forEach(w => { if (w.end === w.start) w.end = addDays(w.start, 6); });
    const sortS = s => [...s].sort((a, b) => a.localeCompare(b));
    return {
      base, taskIndex, nameOf, mergeById, resolve, weeks,
      opts: { teams: sortS(o.teams), employees: sortS(o.employees), clients: sortS(o.clients), departments: sortS(o.departments), projects: sortS(o.projects), taskTypes: sortS(o.taskTypes) },
    };
  }

  function periodWeeks(period, weeks) {
    const ws = weeks.map(w => w.start); const n = ws.length;
    if (!period || period === 'all' || period === 'custom') return null;
    if (period === 'current') return new Set(n ? [ws[n - 1]] : []);
    if (period === 'previous') return new Set(n > 1 ? [ws[n - 2]] : []);
    if (period === 'last2') return new Set(ws.slice(-2));
    if (period === 'last4') return new Set(ws.slice(-4));
    if (period.startsWith('w:')) return new Set([period.slice(2)]);
    return null;
  }
  function filterRecords(recs, f, p) {
    const wset = periodWeeks(f.period, p.weeks);
    const custom = f.period === 'custom'; const from = custom ? f.from : '', to = custom ? f.to : '';
    return recs.filter(r => {
      const n = r.n;
      if (wset && !wset.has(n.weekStart)) return false;
      if (from && (!n.date || n.date < from)) return false;
      if (to && (!n.date || n.date > to)) return false;
      if (f.team && n.team !== f.team) return false;
      if (f.employee && n.employee !== f.employee) return false;
      if (f.client && n.client !== f.client) return false;
      if (f.department && n.department !== f.department) return false;
      if (f.project && n.project !== f.project) return false;
      if (f.taskType && n.taskType !== f.taskType) return false;
      if (f.billable === 'yes' && !n.billable) return false;
      if (f.billable === 'no' && n.billable) return false;
      if (f.uploadId && r.uploadId !== f.uploadId) return false;
      return true;
    });
  }

  /* ---------------- 5. Analytics ---------------- */
  function statusOf(ach, th) { return ach < th.below ? 'below' : ach > th.above ? 'above' : 'on'; }
  const inc = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

  function aggregate(recs, cfg, p) {
    const hps = cfg.hoursPerSP || 8, excl = !!cfg.excludeLeaveFromSP, th = cfg.thresholds;
    const spOf = (h, leave) => (h - (excl ? leave : 0)) / hps;
    const T = { hours: 0, cats: zeroCats(), billable: 0, nonBillable: 0, records: recs.length };
    const emps = new Map(), tasks = new Map(), clients = new Map(), teams = new Map(), days = new Map(), weeks = new Map();
    const get = (m, k, mk) => { let x = m.get(k); if (!x) { x = mk(); m.set(k, x); } return x; };
    recs.forEach(r => {
      const n = r.n, h = n.hours || 0, cat = r._cat, b = !!n.billable;
      T.hours += h; T.cats[cat] += h; if (b) T.billable += h; else T.nonBillable += h;
      const en = n.employee || '(Unknown)';
      const e = get(emps, en, () => ({ name: en, empId: n.empId, team: n.team || '(No team)', department: n.department, empType: n.empType, hours: 0, cats: zeroCats(), billable: 0, weeks: new Set(), clients: new Map(), tasks: new Map(), days: new Map(), count: 0 }));
      e.hours += h; e.cats[cat] += h; if (b) e.billable += h; e.count++; if (n.weekStart) e.weeks.add(n.weekStart);
      inc(e.clients, n.client, h); inc(e.tasks, r._task, h); if (n.date) inc(e.days, n.date, h);
      if (!e.empId && n.empId) e.empId = n.empId;
      const t = get(tasks, r._task, () => ({ key: r._task, name: p.nameOf(r._task), clients: new Set(), projects: new Set(), perEmp: new Map(), hours: 0, leave: 0, billable: 0, first: '', last: '', count: 0, cat }));
      t.hours += h; if (cat === 'leave') t.leave += h; if (b) t.billable += h; t.count++;
      t.clients.add(n.client); if (n.project) t.projects.add(n.project); inc(t.perEmp, en, h);
      if (n.date) { if (!t.first || n.date < t.first) t.first = n.date; if (!t.last || n.date > t.last) t.last = n.date; }
      const c = get(clients, n.client, () => ({ name: n.client, hours: 0, cats: zeroCats(), billable: 0, nonBillable: 0, emps: new Map(), tasks: new Set() }));
      c.hours += h; c.cats[cat] += h; if (b) c.billable += h; else c.nonBillable += h; inc(c.emps, en, h); c.tasks.add(r._task);
      if (n.date) { const d = get(days, n.date, () => ({ date: n.date, hours: 0, leave: 0, emps: new Set() })); d.hours += h; if (cat === 'leave') d.leave += h; d.emps.add(en); }
      if (n.weekStart) { const w = get(weeks, n.weekStart, () => ({ start: n.weekStart, hours: 0, leave: 0, billable: 0, emps: new Set(), cats: zeroCats() })); w.hours += h; w.cats[cat] += h; if (cat === 'leave') w.leave += h; if (b) w.billable += h; w.emps.add(en); }
    });
    const empArr = [...emps.values()].map(e => {
      const wk = Math.max(e.weeks.size, 1);
      e.weekCount = wk; e.expSP = (cfg.expectedSPPerWeek || 0) * wk; e.expHours = (cfg.expectedHoursPerWeek || 0) * wk;
      e.sp = spOf(e.hours, e.cats.leave); e.ach = e.expSP ? e.sp / e.expSP * 100 : 0; e.status = statusOf(e.ach, th);
      e.meetings = e.cats.internal_meeting + e.cats.client_meeting; e.nonBillable = e.hours - e.billable;
      e.available = Math.max(e.expHours - e.cats.leave, 0);
      e.util = e.expHours ? e.hours / e.expHours * 100 : 0;
      e.prodUtil = e.available ? e.cats.project / e.available * 100 : 0;
      e.meetPct = e.hours ? e.meetings / e.hours * 100 : 0;
      return e;
    }).sort((a, b) => b.hours - a.hours);
    const taskArr = [...tasks.values()].map(t => {
      t.sp = spOf(t.hours, t.leave); t.empCount = [...t.perEmp.values()].filter(v => v !== 0).length || t.perEmp.size;
      t.clientList = [...t.clients].sort(); t.clientLabel = t.clientList.join(', ');
      t.projectLabel = [...t.projects].join(', ');
      return t;
    }).sort((a, b) => b.hours - a.hours);
    const clientArr = [...clients.values()].map(c => {
      c.sp = spOf(c.hours, c.cats.leave); c.empCount = c.emps.size; c.taskCount = c.tasks.size;
      c.meetings = c.cats.internal_meeting + c.cats.client_meeting; return c;
    }).sort((a, b) => b.hours - a.hours);
    empArr.forEach(e => {
      const t = teams.get(e.team) || { name: e.team, emps: 0, hours: 0, cats: zeroCats(), sp: 0, expSP: 0, expHours: 0, available: 0, billable: 0 };
      t.emps++; t.hours += e.hours; t.sp += e.sp; t.expSP += e.expSP; t.expHours += e.expHours; t.available += e.available; t.billable += e.billable;
      Object.keys(e.cats).forEach(k => { t.cats[k] += e.cats[k]; });
      teams.set(e.team, t);
    });
    const teamArr = [...teams.values()].map(t => {
      t.ach = t.expSP ? t.sp / t.expSP * 100 : 0; t.status = statusOf(t.ach, th);
      t.meetings = t.cats.internal_meeting + t.cats.client_meeting; t.project = t.cats.project;
      t.util = t.expHours ? t.hours / t.expHours * 100 : 0; t.prodUtil = t.available ? t.project / t.available * 100 : 0;
      return t;
    }).sort((a, b) => b.hours - a.hours);
    T.sp = spOf(T.hours, T.cats.leave);
    T.expSP = empArr.reduce((s, e) => s + e.expSP, 0);
    T.expHours = empArr.reduce((s, e) => s + e.expHours, 0);
    T.available = empArr.reduce((s, e) => s + e.available, 0);
    T.ach = T.expSP ? T.sp / T.expSP * 100 : 0; T.status = statusOf(T.ach, th);
    T.meetings = T.cats.internal_meeting + T.cats.client_meeting;
    T.billPct = T.hours ? T.billable / T.hours * 100 : 0;
    T.util = T.expHours ? T.hours / T.expHours * 100 : 0;
    T.prodUtil = T.available ? T.cats.project / T.available * 100 : 0;
    T.empCount = empArr.length;
    T.activeEmps = empArr.filter(e => e.hours - e.cats.leave > 0).length;
    T.clientCount = clientArr.filter(c => !isInternal(c.name) && c.hours !== 0).length;
    T.allClientCount = clientArr.length;
    T.taskCount = taskArr.filter(t => !t.key.startsWith('C:')).length;
    T.avgHours = empArr.length ? T.hours / empArr.length : 0;
    T.avgSP = empArr.length ? T.sp / empArr.length : 0;
    T.weekCount = weeks.size;
    const taskSum = taskArr.reduce((s, t) => s + t.hours, 0);
    const empSum = empArr.reduce((s, e) => s + e.hours, 0);
    const recon = { source: T.hours, taskSum, empSum, ok: Math.abs(taskSum - T.hours) < 1e-6 && Math.abs(empSum - T.hours) < 1e-6 };
    return {
      T, emps: empArr, tasks: taskArr, clients: clientArr, teams: teamArr, recon,
      days: [...days.values()].sort((a, b) => a.date < b.date ? -1 : 1).map(d => ({ date: d.date, hours: d.hours, sp: spOf(d.hours, d.leave), emps: d.emps.size })),
      weeks: [...weeks.values()].sort((a, b) => a.start < b.start ? -1 : 1).map(w => ({ start: w.start, hours: w.hours, sp: spOf(w.hours, w.leave), emps: w.emps.size, billable: w.billable, cats: w.cats })),
    };
  }

  function insights(a, cfg, prev) {
    const out = []; const T = a.T; const th = cfg.thresholds; const pct = v => (Math.round(v * 10) / 10) + '%';
    const hrs = v => (Math.round(v * 100) / 100).toLocaleString('en-US') + ' h';
    if (!T.records) return out;
    const below = a.emps.filter(e => e.expSP > 0 && e.ach < th.below).sort((x, y) => x.ach - y.ach);
    if (below.length) out.push({ tone: 'warn', icon: 'trending_down', title: below.length + ' employee' + (below.length > 1 ? 's' : '') + ' below ' + th.below + '% of expected story points', text: below.slice(0, 4).map(e => e.name + ' (' + pct(e.ach) + ')').join(', ') + (below.length > 4 ? ' and ' + (below.length - 4) + ' more' : ''), view: 'employees' });
    const above = a.emps.filter(e => e.expSP > 0 && e.ach > th.above).sort((x, y) => y.ach - x.ach);
    if (above.length) out.push({ tone: 'info', icon: 'trending_up', title: above.length + ' employee' + (above.length > 1 ? 's' : '') + ' above ' + th.above + '% of expected story points', text: above.slice(0, 4).map(e => e.name + ' (' + pct(e.ach) + ')').join(', '), view: 'employees' });
    const meetPct = T.hours ? T.meetings / T.hours * 100 : 0;
    if (meetPct > cfg.highMeetingPct) out.push({ tone: 'warn', icon: 'groups', title: 'Meetings account for ' + pct(meetPct) + ' of logged time', text: 'Above the configured ' + cfg.highMeetingPct + '% threshold — ' + hrs(T.cats.internal_meeting) + ' internal, ' + hrs(T.cats.client_meeting) + ' client.', view: 'mix' });
    const hiMeet = a.emps.filter(e => e.meetPct > cfg.highMeetingPct && e.hours >= 8).sort((x, y) => y.meetPct - x.meetPct);
    if (hiMeet.length && meetPct <= cfg.highMeetingPct) out.push({ tone: 'info', icon: 'forum', title: hiMeet.length + ' employee' + (hiMeet.length > 1 ? 's spend' : ' spends') + ' more than ' + cfg.highMeetingPct + '% of time in meetings', text: hiMeet.slice(0, 4).map(e => e.name + ' (' + pct(e.meetPct) + ')').join(', '), view: 'employees' });
    const ext = a.clients.filter(c => !isInternal(c.name));
    if (ext.length >= 2 && T.hours > 0) {
      const top = ext[0]; const share = top.hours / T.hours * 100;
      if (share >= 35) out.push({ tone: 'info', icon: 'storefront', title: top.name + ' accounts for ' + pct(share) + ' of all hours', text: hrs(top.hours) + ' across ' + top.taskCount + ' tasks and ' + top.empCount + ' employees.', view: 'clients' });
    }
    const work = a.tasks.filter(t => !t.key.startsWith('C:'));
    if (work.length >= 5) {
      const mean = work.reduce((s, t) => s + t.hours, 0) / work.length;
      const sd = Math.sqrt(work.reduce((s, t) => s + (t.hours - mean) ** 2, 0) / work.length);
      const big = work.filter(t => t.hours > mean + 2 * sd && t.hours / T.hours >= 0.05).slice(0, 2);
      big.forEach(t => out.push({ tone: 'info', icon: 'task_alt', title: '“' + t.name + '” consumed ' + hrs(t.hours), text: pct(t.hours / T.hours * 100) + ' of all logged time, well above the average task (' + hrs(mean) + ').', taskKey: t.key }));
      const wide = work.filter(t => t.empCount >= Math.max(4, Math.ceil(a.emps.length * 0.3))).slice(0, 2);
      wide.forEach(t => out.push({ tone: 'info', icon: 'diversity_3', title: t.empCount + ' employees worked on “' + t.name + '”', text: 'Client: ' + t.clientLabel + ' · ' + hrs(t.hours) + ' total.', taskKey: t.key }));
    }
    if (prev && prev.T.hours > 0) {
      const ch = (T.hours - prev.T.hours) / prev.T.hours * 100;
      if (Math.abs(ch) >= 15) out.push({ tone: ch < 0 ? 'warn' : 'info', icon: ch < 0 ? 'south_east' : 'north_east', title: 'Total hours ' + (ch < 0 ? 'down ' : 'up ') + pct(Math.abs(ch)) + ' vs previous week', text: hrs(prev.T.hours) + ' → ' + hrs(T.hours) + '.', view: 'compare' });
      const pm = new Map(prev.emps.map(e => [e.name, e.hours]));
      const moves = a.emps.filter(e => pm.has(e.name) && pm.get(e.name) > 0).map(e => ({ e, ch: (e.hours - pm.get(e.name)) / pm.get(e.name) * 100 })).filter(x => Math.abs(x.ch) >= 30).sort((x, y) => Math.abs(y.ch) - Math.abs(x.ch));
      if (moves.length) out.push({ tone: 'info', icon: 'swap_vert', title: moves.length + ' employee' + (moves.length > 1 ? 's' : '') + ' changed hours by 30%+ week over week', text: moves.slice(0, 4).map(x => x.e.name + ' (' + (x.ch > 0 ? '+' : '') + pct(x.ch) + ')').join(', '), view: 'compare' });
    }
    const nb = T.hours ? T.nonBillable / T.hours * 100 : 0;
    if (nb > cfg.nonBillablePct) out.push({ tone: 'warn', icon: 'money_off', title: 'Non-billable time is ' + pct(nb) + ' of total', text: 'Above the configured ' + cfg.nonBillablePct + '% threshold (' + hrs(T.nonBillable) + ').', view: 'mix' });
    const unc = a.emps.filter(e => e.hours > 0 && e.cats.other / e.hours > 0.1);
    if (unc.length) out.push({ tone: 'warn', icon: 'help', title: unc.length + ' employee' + (unc.length > 1 ? 's have' : ' has') + ' over 10% unclassified work', text: unc.slice(0, 4).map(e => e.name + ' (' + hrs(e.cats.other) + ')').join(', ') + '. Review descriptions or classification rules.', view: 'detail' });
    if (T.cats.leave > 0) out.push({ tone: 'neutral', icon: 'beach_access', title: hrs(T.cats.leave) + ' of leave / holiday / week off recorded', text: 'Shown separately and excluded from productive utilization' + (cfg.excludeLeaveFromSP ? ' and story points.' : '.'), view: 'mix' });
    return out;
  }

  const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'worked', 'working', 'work', 'task', 'on', 'of', 'to', 'in', 'a', 'an', 'at', 'by', 'is', 'new']);
  function suggestMerges(tasks) {
    const byClient = new Map();
    tasks.forEach(t => { const c = t.clientLabel; if (!byClient.has(c)) byClient.set(c, []); byClient.get(c).push(t); });
    const groups = [];
    byClient.forEach((list, client) => {
      if (list.length < 2 || list.length > 400) return;
      const ctoks = new Set(normDesc(client).split(' '));
      const toks = list.map(t => new Set(normDesc(t.name).split(' ').filter(w => w.length > 2 && !STOP.has(w) && !ctoks.has(w))));
      const parent = list.map((_, i) => i);
      const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const A = toks[i], B = toks[j]; if (A.size < 2 || B.size < 2) continue;
        let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
        const jac = inter / (A.size + B.size - inter);
        if (inter >= 2 && jac >= 0.5) parent[find(i)] = find(j);
      }
      const gm = new Map();
      list.forEach((t, i) => { const r = find(i); if (!gm.has(r)) gm.set(r, []); gm.get(r).push(t); });
      gm.forEach(g => { if (g.length > 1) groups.push({ client, tasks: g, hours: g.reduce((s, t) => s + t.hours, 0) }); });
    });
    return groups.sort((a, b) => b.hours - a.hours).slice(0, 8);
  }

  /* ---------------- 6. Export & sample ---------------- */
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function exportRows(rows, filename, fmt, sheetName, header) {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No rows for the current selection' }], header ? { header } : undefined);
    if (fmt === 'csv') { saveBlob(new Blob(['\ufeff' + XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8' }), filename + '.csv'); return; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName || 'Report').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31));
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename + '.xlsx');
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function serial(isoD) { const [y, m, d] = isoD.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5 + 25569; }

  /* Generates a realistic weekly timesheet in the expected source format. */
  function sampleFile(ws) {
    const rnd = mulberry32(parseInt(hash(ws).slice(0, 8), 16));
    const pick = a => a[Math.floor(rnd() * a.length)];
    const E = [['Ankit Sharma', 'E1001', 'Teal', 'Development'], ['Prakash Rao', 'E1002', 'Teal', 'Development'], ['Neha Gupta', 'E1003', 'Teal', 'QA'], ['Rahul Verma', 'E1004', 'Blue', 'Development'], ['Priya Nair', 'E1005', 'Blue', 'Development'], ['Sandeep Kumar', 'E1006', 'Blue', 'Support'], ['Kavya Iyer', 'E1007', 'Green', 'Development'], ['Arjun Mehta', 'E1008', 'Green', 'Support'], ['Sneha Patil', 'E1009', 'Green', 'QA'], ['Vikram Singh', 'E1010', 'QA', 'QA'], ['Ritu Das', 'E1011', 'QA', 'QA'], ['Manoj Pillai', 'E1012', 'Product', 'Product'], ['Divya Reddy', 'E1013', 'Product', 'Product']];
    const TK = [
      { c: 'BOJANGLES', id: 'OPSSD-11860', v: ['OPSSD-11860 Support', 'OPSSD-11860 investigation', 'Worked on OPSSD-11860', 'OPSSD-11860 testing'], p: 'POS Integration' },
      { c: 'BOJANGLES', id: '', v: ['Inventory issue analysis', 'Inventory issue investigation'], p: 'Inventory' },
      { c: 'BWW', id: 'OPSSD-11902', v: ['OPSSD-11902 Menu sync failure', 'OPSSD-11902 fix', 'OPSSD-11902 Menu sync failure retest'], p: 'Menu Management' },
      { c: 'BWW', id: '', v: ['Payroll Validation', 'Payroll validation'], p: 'Payroll' },
      { c: 'BWW', id: '', v: ['BWW Inventory Issue', 'BWW Inventory issue investigation', 'Inventory issue - BWW'], p: 'Inventory' },
      { c: "Arby's", id: 'ARB-2231', v: ['ARB-2231 Loyalty points mismatch', 'ARB-2231 analysis'], p: 'Loyalty' },
      { c: "Arby's", id: '', v: ['Store onboarding configuration'], p: 'Onboarding' },
      { c: 'Chicken Salad Chick', id: 'CSC-418', v: ['CSC-418 Report automation', 'CSC-418 Report automation testing'], p: 'Reporting' },
      { c: 'Chicken Salad Chick', id: '', v: ['Online ordering regression suite'], p: 'Online Ordering' },
      { c: 'Internal', id: '', v: ['Build pipeline maintenance', 'Test environment setup'], p: 'Internal Tools' },
    ];
    const H = ['Week Start Date', 'Client', 'ID', 'Task Type', 'Is Billable', 'Hours', 'Day', 'Date', 'Description', 'Employee Name', 'Emp ID', 'Employee Team', 'Team', 'Employee Type', 'Department', 'Stage', 'Phase', 'Project'];
    const rows = [H];
    E.forEach((e, ei) => {
      const mine = [TK[(ei * 3) % TK.length], TK[(ei * 3 + 1 + Math.floor(rnd() * 3)) % TK.length], TK[(ei + 5) % TK.length]];
      const leaveDay = rnd() < 0.18 ? Math.floor(rnd() * 5) : -1;
      for (let d = 0; d < 5; d++) {
        const date = addDays(ws, d);
        const row = (client, id, type, bill, hrs, desc, t) => rows.push([serial(ws), client, id, type, bill ? 'Yes' : 'No', hrs, dayName(date), serial(date), desc, e[0], e[1], e[2], e[2], ei === 12 ? 'Contract' : 'Full Time', e[3], t ? pick(['In Progress', 'In Progress', 'Completed']) : '', t ? pick(['Development', 'UAT', 'Analysis']) : '', t ? t.p : '']);
        if (d === leaveDay) { row('Internal', '', 'Leave', false, 8, pick(['Sick leave', 'Casual leave', 'Planned leave'])); continue; }
        let left = 8 + (rnd() < 0.25 ? 0.5 : 0) - (rnd() < 0.15 ? 0.5 : 0);
        row('Internal', '', 'Internal Meeting', false, 0.5, pick(['Daily stand-up', 'Daily stand-up', 'Team sync'])); left -= 0.5;
        if (d === 1 || rnd() < 0.2) { const t = mine[0]; if (t.c !== 'Internal') { row(t.c, '', 'Client Meeting', true, 1, 'Weekly status call with ' + t.c); left -= 1; } }
        if (d === 3 && rnd() < 0.5) { row('Internal', '', 'Internal Meeting', false, 1, 'Sprint planning'); left -= 1; }
        if (d === 4 && rnd() < 0.25) { row('Internal', '', 'Training', false, 1.5, 'Cloud certification training'); left -= 1.5; }
        const t1 = pick(mine), t2 = pick(mine);
        const split = t1 === t2 ? left : Math.max(0.5, Math.round(left * (0.4 + rnd() * 0.3) * 2) / 2);
        const type = e[3] === 'QA' ? 'Testing' : e[3] === 'Support' ? 'Support' : 'Project Work';
        row(t1.c, t1.id, type, t1.c !== 'Internal', split, pick(t1.v), t1);
        if (left - split > 0) row(t2.c, t2.id, type, t2.c !== 'Internal', left - split, pick(t2.v), t2);
      }
    });
    if (rows.length > 20) rows[17][8] = '';
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    for (let r = 1; r < rows.length; r++) [0, 7].forEach(c => { const cell = sheet[XLSX.utils.encode_cell({ r, c })]; if (cell) cell.z = 'dd-mmm-yyyy'; });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, 'Timesheet');
    return { buf: XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), name: 'Team_Timesheet_' + ws + '.xlsx' };
  }

  window.TSCore = {
    DB, init, hashPassword, DEFAULT_CONFIG, clone,
    FIELDS, autoMap, missingRequired, readWorkbook, pickSheet, sheetTable,
    processRows, buildImport, sig, rawKey, compileRules, classify, isInternal,
    CATS, CAT_LABEL, prepare, filterRecords, aggregate, insights, suggestMerges,
    exportRows, sampleFile, fmtDate, addDays, weekStartOf, dayName,
  };
})();
