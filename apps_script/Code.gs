/****************************************************************
 * FIELD VISITS v3 — backend (Google Apps Script)
 * United Manarah Medical Development Est.
 *
 * Your data lives in ONE Google Sheet in your Drive. This script is
 * the server: logins, visits, fake-GPS checks, customers, targets,
 * sales & collection, reports.
 *
 * Project files:  Code.gs  +  Index (HTML)      (nothing else)
 *
 * TO UPDATE AN EXISTING DEPLOYMENT (keeps the same /exec link):
 *   1. Paste this file over Code.gs, paste Index.html over Index.
 *      Delete any other .gs files (e.g. Data.gs from v2).
 *   2. Save. Deploy > Manage deployments > pencil (Edit) >
 *      Version: New version > Deploy.
 *   Your sheet is upgraded automatically on first use: new columns
 *   and tabs are added, nothing is deleted.
 ****************************************************************/

// ====== SETTINGS YOU MAY EDIT ======
var MANAGER_EMAIL = 'odoirte@gmail.com';   // first manager + alert emails
var TZ = 'Asia/Riyadh';
// ===================================

var APP_TITLE = 'Field Visits · UMDCO';
var DEFAULT_PASSWORD = '000000';
var SCHEMA_VERSION = '3';
var TOKEN_DAYS = 60;

var SH = {
  users: 'Users', clients: 'Clients', visits: 'Visits', settings: 'Settings',
  targets: 'MonthlyTargets', sales: 'Sales'
};
var COLS = {
  Users: ['email', 'name', 'role', 'salt', 'pass_hash', 'active', 'token', 'area', 'phone'],
  Clients: ['code', 'name', 'rep_email', 'lat', 'lon', 'city', 'contact', 'phone', 'status', 'map_link', 'notes', 'area'],
  Visits: ['id', 'ts', 'date', 'time', 'rep_email', 'rep_name', 'client_code', 'client_name', 'visit_type',
    'lat', 'lon', 'accuracy', 'altitude', 'mock', 'distance_m', 'flag', 'tags', 'comment',
    'person_name', 'person_mobile', 'source'],
  Settings: ['key', 'value'],
  MonthlyTargets: ['rep_email', 'month', 'sales_target', 'collection_target'],
  Sales: ['id', 'date', 'rep_email', 'type', 'amount', 'client', 'ref', 'note', 'added_by', 'added_at']
};
var DEFAULT_SETTINGS = {
  far_limit_m: 1500,       // flag visits farther than this from the customer
  weekend_days: '5',       // 0=Sun .. 5=Fri, 6=Sat ; e.g. "5,6"
  email_alerts: 'no',      // "yes" = email the manager on each flagged visit
  currency: 'SAR'
};
// Tags that make a visit "fake" (flagged). Others are notes only.
var STRONG_TAGS = ['MOCK', 'FAR', 'FROZEN', 'TELEPORT', 'ROUND', 'BURST', 'DUP'];

/* ================================================================
 *  Web entry
 * ================================================================ */
function doGet() {
  _ensureSchema();
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Single entry point called from the page: google.script.run.api(req) */
function api(req) {
  try {
    req = req || {};
    _ensureSchema();
    var a = String(req.action || '');
    if (a === 'login') return _ok(_login(req.email, req.password));
    var me = _auth(req.token);
    var fn = ACTIONS[a];
    if (!fn) throw _err('BAD_ACTION');
    if (fn.manager && me.role !== 'manager') throw _err('NOT_ALLOWED');
    return _ok(fn.run(me, req));
  } catch (e) {
    if (e && e.code) return { ok: false, err: e.code, msg: e.msg || '' };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, err: 'SERVER', msg: String(e && e.message ? e.message : e) };
  }
}

var ACTIONS = {
  me:              { run: function (me) { return _meOut(me); } },
  logout:          { run: function (me, r) { _dropToken(r.token); return true; } },
  changePassword:  { run: function (me, r) { return _changePassword(me, r.oldPassword, r.newPassword); } },
  summary:         { run: function (me, r) { return _summary(me, r.month, r.day); } },
  details:         { run: function (me, r) { return _details(me, r); } },
  clients:         { run: function (me) { return _clientsFor(me); } },
  saveClient:      { manager: true, run: function (me, r) { return _saveClient(r.client); } },
  deleteClient:    { manager: true, run: function (me, r) { return _deleteClient(r.code); } },
  visits:          { run: function (me, r) { return _visits(me, r); } },
  saveVisit:       { run: function (me, r) { return _saveVisit(me, r.visit); } },
  users:           { manager: true, run: function () { return _usersOut(); } },
  saveUser:        { manager: true, run: function (me, r) { return _saveUser(me, r.user); } },
  resetPassword:   { manager: true, run: function (me, r) { return _resetPassword(r.email); } },
  deleteUser:      { manager: true, run: function (me, r) { return _deleteUser(me, r.email); } },
  targets:         { manager: true, run: function (me, r) { return _targetsOut(r.month); } },
  saveTargets:     { manager: true, run: function (me, r) { return _saveTargets(r.month, r.rows); } },
  sales:           { manager: true, run: function (me, r) { return _salesOut(r.month); } },
  addSale:         { manager: true, run: function (me, r) { return _addSale(me, r.entry); } },
  deleteSale:      { manager: true, run: function (me, r) { return _deleteSale(r.id); } },
  importSales:     { manager: true, run: function (me, r) { return _importSales(me, r.text); } },
  settings:        { manager: true, run: function () { return _settings(); } },
  saveSettings:    { manager: true, run: function (me, r) { return _saveSettings(r.settings); } }
};

/** Run once by hand if you like (it also runs automatically). */
function setup() { _ensureSchema(true); return 'OK'; }

/* ================================================================
 *  Helpers
 * ================================================================ */
function _ok(d) { return { ok: true, data: d }; }
function _err(code, msg) { return { code: code, msg: msg || '' }; }
function _ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function _sheet(name) {
  var ss = _ss(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}
var _cache = {};
function _head(name) {
  var sh = _sheet(name), lc = sh.getLastColumn();
  if (lc < 1) return [];
  return sh.getRange(1, 1, 1, lc).getValues()[0].map(function (h) { return String(h).trim(); });
}
function _rows(name) {
  if (_cache[name]) return _cache[name];
  var data = _sheet(name).getDataRange().getValues(), out = [];
  if (data.length >= 2) {
    var head = data[0].map(function (h) { return String(h).trim(); });
    for (var i = 1; i < data.length; i++) {
      var o = {}, empty = true;
      for (var c = 0; c < head.length; c++) {
        o[head[c]] = data[i][c];
        if (data[i][c] !== '' && data[i][c] !== null) empty = false;
      }
      if (empty) continue;
      o._row = i + 1;
      out.push(o);
    }
  }
  _cache[name] = out;
  return out;
}
function _clear(name) { delete _cache[name]; }
function _append(name, obj) {
  var head = _head(name);
  var arr = head.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
  var sh = _sheet(name);
  sh.appendRow(arr);
  _clear(name);
}
function _update(name, row, obj) {
  var head = _head(name), sh = _sheet(name);
  var cur = sh.getRange(row, 1, 1, head.length).getValues()[0];
  for (var c = 0; c < head.length; c++) if (obj.hasOwnProperty(head[c])) cur[c] = obj[head[c]];
  sh.getRange(row, 1, 1, head.length).setValues([cur]);
  _clear(name);
}
function _deleteRow(name, row) { _sheet(name).deleteRow(row); _clear(name); }
function _lock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function _str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function _low(v) { return _str(v).toLowerCase(); }
function _num(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(String(v).replace(/[, ]/g, ''));
  return isNaN(n) ? null : n;
}
function _bool(v) {
  if (v === true || v === 1) return true;
  var s = _low(v);
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}
function _today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function _nowTime() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
/** Normalise anything date-like to 'yyyy-MM-dd'. */
function _ds(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, _sheetTz(), 'yyyy-MM-dd');
  }
  var s = String(v).trim(), m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + _p2(m[2]) + '-' + _p2(m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/))) return m[3] + '-' + _p2(m[2]) + '-' + _p2(m[1]);
  return s.slice(0, 10);
}
function _dsTz(v) { return Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : _ds(v); }
function _tsTz(v) { return Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, TZ, 'HH:mm') : _ts(v); }
function _ts(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, _sheetTz(), 'HH:mm');
  var s = _str(v), m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? _p2(m[1]) + ':' + m[2] : s;
}
var _stz = null;
function _sheetTz() { if (!_stz) { try { _stz = _ss().getSpreadsheetTimeZone() || TZ; } catch (e) { _stz = TZ; } } return _stz; }
function _p2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function _addDays(ds, n) {
  var d = new Date(ds + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function _month(m) { m = _str(m); return /^\d{4}-\d{2}$/.test(m) ? m : _today().slice(0, 7); }
function _monthEnd(m) {
  var y = +m.slice(0, 4), mo = +m.slice(5, 7);
  var d = new Date(Date.UTC(y, mo, 0));
  return d.toISOString().slice(0, 10);
}
function _hash(pw, salt) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '|' + String(pw));
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function _haversine(a, b, c, d) {
  if ([a, b, c, d].some(function (x) { return x === null || x === '' || isNaN(x); })) return null;
  var R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLon = (d - b) * r;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}
function _decimals(x) { var s = String(x); var i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }

/* ================================================================
 *  Schema (creates / upgrades the sheet; never deletes data)
 * ================================================================ */
function _ensureSchema(force) {
  var props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('SCHEMA') === SCHEMA_VERSION) return;
  _lock(function () {
    Object.keys(COLS).forEach(function (name) {
      var sh = _sheet(name), head = _head(name);
      var missing = COLS[name].filter(function (c) { return head.indexOf(c) < 0; });
      if (missing.length) {
        sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
        sh.getRange(1, 1, 1, head.length + missing.length).setFontWeight('bold');
        sh.setFrozenRows(1);
      }
      _clear(name);
    });
    // area defaults to city for old customers
    _rows(SH.clients).forEach(function (c) {
      if (!_str(c.area) && _str(c.city)) _update(SH.clients, c._row, { area: c.city });
    });
    // default settings
    var have = {};
    _rows(SH.settings).forEach(function (s) { have[_str(s.key)] = true; });
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      if (!have[k]) _append(SH.settings, { key: k, value: DEFAULT_SETTINGS[k] });
    });
    // make sure there is a manager
    var users = _rows(SH.users);
    var hasMgr = users.some(function (u) { return _role(u) === 'manager'; });
    var mgr = users.filter(function (u) { return _low(u.email) === _low(MANAGER_EMAIL); })[0];
    if (mgr && _role(mgr) !== 'manager') _update(SH.users, mgr._row, { role: 'manager' });
    if (!mgr && !hasMgr) {
      var salt = Utilities.getUuid();
      _append(SH.users, { email: _low(MANAGER_EMAIL), name: 'Manager', role: 'manager', salt: salt,
        pass_hash: _hash(DEFAULT_PASSWORD, salt), active: true });
    }
    props.setProperty('SCHEMA', SCHEMA_VERSION);
  });
}
function _role(u) {
  var r = _low(u.role);
  return (r === 'manager' || r === 'admin' || r === 'supervisor') ? 'manager' : 'rep';
}
function _active(u) { return _str(u.active) === '' ? true : _bool(u.active); }

function _settings() {
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  _rows(SH.settings).forEach(function (s) { if (_str(s.key)) out[_str(s.key)] = s.value; });
  out.far_limit_m = _num(out.far_limit_m) || DEFAULT_SETTINGS.far_limit_m;
  return out;
}
function _saveSettings(s) {
  s = s || {};
  return _lock(function () {
    var rows = _rows(SH.settings);
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      if (!s.hasOwnProperty(k)) return;
      var v = s[k];
      if (k === 'far_limit_m') { v = _num(v); if (!v || v < 50) throw _err('BAD_VALUE', k); }
      if (k === 'weekend_days') v = String(v).split(/[ ,]+/).filter(function (x) { return /^[0-6]$/.test(x); }).join(',');
      var row = rows.filter(function (r) { return _str(r.key) === k; })[0];
      if (row) _update(SH.settings, row._row, { value: v }); else _append(SH.settings, { key: k, value: v });
    });
    return _settings();
  });
}

/* ================================================================
 *  Auth
 * ================================================================ */
function _user(email) {
  email = _low(email);
  return _rows(SH.users).filter(function (u) { return _low(u.email) === email; })[0] || null;
}
function _login(email, pw) {
  email = _low(email);
  if (!email || !_str(pw)) throw _err('LOGIN_MISSING');
  var u = _user(email);
  if (!u || _hash(pw, u.salt) !== _str(u.pass_hash)) throw _err('LOGIN_WRONG');
  if (!_active(u)) throw _err('LOGIN_DISABLED');
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('T_' + token,
    JSON.stringify({ e: email, t: Date.now() }));
  _cleanTokens();
  return { token: token, me: _meOut(u, String(pw) === DEFAULT_PASSWORD) };
}
function _auth(token) {
  token = _str(token);
  if (!token) throw _err('AUTH');
  var raw = PropertiesService.getScriptProperties().getProperty('T_' + token);
  if (!raw) throw _err('AUTH');
  var t = JSON.parse(raw);
  if (Date.now() - t.t > TOKEN_DAYS * 864e5) { _dropToken(token); throw _err('AUTH'); }
  var u = _user(t.e);
  if (!u || !_active(u)) { _dropToken(token); throw _err('AUTH'); }
  return { email: _low(u.email), name: _str(u.name) || _low(u.email), role: _role(u), _u: u };
}
function _meOut(me, mustChange) {
  var u = me._u || me;
  var out = { email: _low(u.email), name: _str(u.name) || _low(u.email), role: _role(u),
    settings: { currency: _settings().currency } };
  if (mustChange === undefined) mustChange = _hash(DEFAULT_PASSWORD, u.salt) === _str(u.pass_hash);
  out.mustChange = !!mustChange;
  return out;
}
function _dropToken(token) { PropertiesService.getScriptProperties().deleteProperty('T_' + _str(token)); }
function _dropTokensOf(email) {
  var p = PropertiesService.getScriptProperties(), all = p.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('T_') !== 0) return;
    try { if (JSON.parse(all[k]).e === _low(email)) p.deleteProperty(k); } catch (e) { p.deleteProperty(k); }
  });
}
function _cleanTokens() {
  var p = PropertiesService.getScriptProperties(), all = p.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('T_') !== 0) return;
    try { if (Date.now() - JSON.parse(all[k]).t > TOKEN_DAYS * 864e5) p.deleteProperty(k); } catch (e) { p.deleteProperty(k); }
  });
}
function _changePassword(me, oldPw, newPw) {
  newPw = _str(newPw);
  if (newPw.length < 6) throw _err('PW_SHORT');
  if (newPw === DEFAULT_PASSWORD) throw _err('PW_DEFAULT');
  return _lock(function () {
    var u = _user(me.email);
    if (_hash(oldPw, u.salt) !== _str(u.pass_hash)) throw _err('PW_OLD_WRONG');
    var salt = Utilities.getUuid();
    _update(SH.users, u._row, { salt: salt, pass_hash: _hash(newPw, salt) });
    return true;
  });
}

/* ================================================================
 *  Users (Settings page)
 * ================================================================ */
function _usersOut() {
  var clients = _rows(SH.clients), byRep = {};
  clients.forEach(function (c) { var e = _low(c.rep_email); byRep[e] = (byRep[e] || 0) + 1; });
  return _rows(SH.users).map(function (u) {
    return { email: _low(u.email), name: _str(u.name), role: _role(u), active: _active(u),
      area: _str(u.area), phone: _str(u.phone), clients: byRep[_low(u.email)] || 0,
      defaultPw: _hash(DEFAULT_PASSWORD, u.salt) === _str(u.pass_hash) };
  }).sort(function (a, b) { return (a.role === b.role ? 0 : a.role === 'manager' ? -1 : 1) || a.name.localeCompare(b.name); });
}
function _saveUser(me, x) {
  x = x || {};
  var email = _low(x.email), name = _str(x.name);
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) && !/^[a-z0-9._-]{3,}$/.test(email)) throw _err('BAD_EMAIL');
  if (!name) throw _err('NAME_REQUIRED');
  var role = x.role === 'manager' ? 'manager' : 'rep';
  return _lock(function () {
    var u = _user(email);
    var orig = _low(x.originalEmail);
    if (x.isNew) {
      if (u) throw _err('USER_EXISTS');
      var salt = Utilities.getUuid();
      _append(SH.users, { email: email, name: name, role: role, salt: salt,
        pass_hash: _hash(DEFAULT_PASSWORD, salt), active: x.active !== false,
        area: _str(x.area), phone: _str(x.phone) });
    } else {
      var target = _user(orig || email);
      if (!target) throw _err('NOT_FOUND');
      if (orig && orig !== email && u) throw _err('USER_EXISTS');
      if (_low(target.email) === me.email && (role !== 'manager' || x.active === false)) throw _err('SELF_LOCK');
      _update(SH.users, target._row, { email: email, name: name, role: role, active: x.active !== false,
        area: _str(x.area), phone: _str(x.phone) });
      if (orig && orig !== email) _renameRep(orig, email, name);
      else _renameRep(email, email, name);
      if (x.active === false) _dropTokensOf(email);
    }
    return _usersOut();
  });
}
function _renameRep(oldE, newE, name) {
  _rows(SH.clients).forEach(function (c) {
    if (_low(c.rep_email) === oldE && oldE !== newE) _update(SH.clients, c._row, { rep_email: newE });
  });
  if (oldE !== newE) {
    _rows(SH.targets).forEach(function (t) { if (_low(t.rep_email) === oldE) _update(SH.targets, t._row, { rep_email: newE }); });
    _rows(SH.sales).forEach(function (t) { if (_low(t.rep_email) === oldE) _update(SH.sales, t._row, { rep_email: newE }); });
    var sh = _sheet(SH.visits), head = _head(SH.visits), ci = head.indexOf('rep_email');
    if (ci >= 0 && sh.getLastRow() > 1) {
      var rg = sh.getRange(2, ci + 1, sh.getLastRow() - 1, 1), v = rg.getValues(), ch = false;
      v.forEach(function (r) { if (_low(r[0]) === oldE) { r[0] = newE; ch = true; } });
      if (ch) rg.setValues(v);
      _clear(SH.visits);
    }
  }
}
function _resetPassword(email) {
  return _lock(function () {
    var u = _user(email);
    if (!u) throw _err('NOT_FOUND');
    var salt = Utilities.getUuid();
    _update(SH.users, u._row, { salt: salt, pass_hash: _hash(DEFAULT_PASSWORD, salt) });
    _dropTokensOf(email);
    return _usersOut();
  });
}
function _deleteUser(me, email) {
  email = _low(email);
  if (email === me.email) throw _err('SELF_LOCK');
  return _lock(function () {
    var u = _user(email);
    if (!u) throw _err('NOT_FOUND');
    var n = _rows(SH.clients).filter(function (c) { return _low(c.rep_email) === email; }).length;
    if (n) throw _err('USER_HAS_CLIENTS', String(n));
    _deleteRow(SH.users, u._row);
    _dropTokensOf(email);
    return _usersOut();
  });
}

/* ================================================================
 *  Customers
 * ================================================================ */
function _clientOut(c, names) {
  var lat = _num(c.lat), lon = _num(c.lon);
  var link = _str(c.map_link) || (lat !== null && lon !== null ? 'https://www.google.com/maps?q=' + lat + ',' + lon : '');
  return { code: _str(c.code), name: _str(c.name), rep: _low(c.rep_email),
    repName: names ? (names[_low(c.rep_email)] || _low(c.rep_email)) : '',
    area: _str(c.area) || _str(c.city), map: link, lat: lat, lon: lon,
    hasLoc: lat !== null && lon !== null };
}
function _repNames() {
  var m = {};
  _rows(SH.users).forEach(function (u) { m[_low(u.email)] = _str(u.name) || _low(u.email); });
  return m;
}
function _clientsFor(me) {
  var names = _repNames();
  var list = _rows(SH.clients)
    .filter(function (c) { return me.role === 'manager' || _low(c.rep_email) === me.email; })
    .map(function (c) { return _clientOut(c, names); });
  // last visit per customer
  var last = {};
  _rows(SH.visits).forEach(function (v) {
    var k = _str(v.client_code), d = _ds(v.date);
    if (!last[k] || d > last[k]) last[k] = d;
  });
  list.forEach(function (c) { c.lastVisit = last[c.code] || ''; });
  list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  var reps = me.role === 'manager' ? _rows(SH.users).filter(function (u) { return _role(u) === 'rep'; })
    .map(function (u) { return { email: _low(u.email), name: _str(u.name) || _low(u.email), active: _active(u) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); }) : [];
  return { clients: list, reps: reps };
}
/** Pull coordinates out of a Google Maps link (resolves short links). */
function _coordsFromLink(link) {
  link = _str(link);
  if (!link) return null;
  var tries = 0, url = link;
  while (tries < 4) {
    var c = _parseCoords(url);
    if (c) return c;
    if (!/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.google\.|www\.google\.|google\.)/i.test(url)) return null;
    try {
      var resp = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
      var h = resp.getHeaders(), loc = h.Location || h.location;
      if (!loc) {
        var body = resp.getContentText().slice(0, 20000);
        return _parseCoords(decodeURIComponent(body));
      }
      url = decodeURIComponent(loc);
    } catch (e) { return null; }
    tries++;
  }
  return null;
}
function _parseCoords(s) {
  s = String(s);
  var pats = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|destination|center|daddr)=(?:loc:)?(-?\d{1,2}\.\d+)(?:,|%2C)\s*\+?(-?\d{1,3}\.\d+)/i,
    /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/,
    /\/place\/(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = s.match(pats[i]);
    if (m) {
      var la = +m[1], lo = +m[2];
      if (Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)) return { lat: la, lon: lo };
    }
  }
  return null;
}
function _saveClient(x) {
  x = x || {};
  var name = _str(x.name), rep = _low(x.rep), area = _str(x.area), link = _str(x.map);
  if (!name) throw _err('NAME_REQUIRED');
  if (!rep) throw _err('REP_REQUIRED');
  if (!_user(rep)) throw _err('REP_UNKNOWN');
  var coords = link ? _coordsFromLink(link) : null;
  return _lock(function () {
    var rows = _rows(SH.clients), code = _str(x.code), row = null;
    if (code) row = rows.filter(function (c) { return _str(c.code) === code; })[0];
    var obj = { name: name, rep_email: rep, area: area, map_link: link };
    if (coords) { obj.lat = coords.lat; obj.lon = coords.lon; }
    if (row) {
      if (!link && x.clearMap) { obj.lat = ''; obj.lon = ''; }
      if (link && !coords && link !== _str(row.map_link)) { obj.lat = ''; obj.lon = ''; }
      _update(SH.clients, row._row, obj);
    } else {
      var used = {};
      rows.forEach(function (c) { used[_str(c.code)] = 1; });
      var n = rows.length + 1;
      while (used['N' + ('0000' + n).slice(-5)]) n++;
      obj.code = 'N' + ('0000' + n).slice(-5);
      obj.status = 'active';
      _append(SH.clients, obj);
      code = obj.code;
    }
    var names = _repNames();
    var saved = _rows(SH.clients).filter(function (c) { return _str(c.code) === code; })[0];
    var out = _clientOut(saved, names);
    out.locFound = !!coords || out.hasLoc;
    return out;
  });
}
function _deleteClient(code) {
  return _lock(function () {
    var row = _rows(SH.clients).filter(function (c) { return _str(c.code) === _str(code); })[0];
    if (!row) throw _err('NOT_FOUND');
    _deleteRow(SH.clients, row._row);
    return true;
  });
}

/* ================================================================
 *  Visits
 * ================================================================ */
function _visitOut(v, clientMap, forManager) {
  var c = clientMap[_str(v.client_code)];
  var o = {
    id: _str(v.id), date: _ds(v.date) || _dsTz(v.ts), time: _ts(v.time) || _tsTz(v.ts),
    rep: _low(v.rep_email), repName: _str(v.rep_name), code: _str(v.client_code),
    client: _str(v.client_name) || (c ? _str(c.name) : ''), area: c ? (_str(c.area) || _str(c.city)) : '',
    person: _str(v.person_name), mobile: _str(v.person_mobile), comment: _str(v.comment),
    lat: _num(v.lat), lon: _num(v.lon), type: _str(v.visit_type)
  };
  if (forManager) {
    o.flag = _bool(v.flag); o.tags = _tagsOut(v.tags); o.dist = _num(v.distance_m);
    o.acc = _num(v.accuracy); o.mock = _bool(v.mock); o.src = _str(v.source);
  }
  return o;
}
/** Turns tags from older versions ("Mock-GPS App, Far") into codes. */
function _tagsOut(s) {
  s = _str(s);
  if (!s || /^[A-Z_ ]+$/.test(s)) return s;
  var map = [[/mock|fake.?gps/i, 'MOCK'], [/far|distance/i, 'FAR'], [/frozen|same.?pin/i, 'FROZEN'],
    [/teleport|speed/i, 'TELEPORT'], [/round/i, 'ROUND'], [/burst/i, 'BURST'], [/dup/i, 'DUP'], [/hour/i, 'HOURS']];
  return s.split(/[,;|]+/).map(function (x) {
    x = x.trim(); if (!x) return '';
    for (var i = 0; i < map.length; i++) if (map[i][0].test(x)) return map[i][1];
    return x.replace(/\s+/g, '_');
  }).filter(Boolean).join(' ');
}
function _clientMap() {
  var m = {};
  _rows(SH.clients).forEach(function (c) { m[_str(c.code)] = c; });
  return m;
}
/** Visits between from..to (inclusive), optionally one rep. */
function _visits(me, r) {
  var today = _today();
  var from = _ds(r.from) || today.slice(0, 7) + '-01', to = _ds(r.to) || today;
  if (from > to) { var t = from; from = to; to = t; }
  if (_addDays(from, 400) < to) throw _err('RANGE_TOO_LONG');
  var rep = me.role === 'manager' ? _low(r.rep) : me.email;
  var mgr = me.role === 'manager', cm = _clientMap(), names = _repNames();
  var list = [];
  _rows(SH.visits).forEach(function (v) {
    var d = _ds(v.date) || _dsTz(v.ts);
    if (d < from || d > to) return;
    if (rep && _low(v.rep_email) !== rep) return;
    var o = _visitOut(v, cm, mgr);
    if (!o.repName) o.repName = names[o.rep] || o.rep;
    list.push(o);
  });
  list.sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); });
  // assigned customers per rep (for coverage)
  var assigned = {};
  _rows(SH.clients).forEach(function (c) { var e = _low(c.rep_email); assigned[e] = (assigned[e] || 0) + 1; });
  var reps = mgr ? _rows(SH.users).filter(function (u) { return _role(u) === 'rep'; })
    .map(function (u) { return { email: _low(u.email), name: _str(u.name) || _low(u.email), assigned: assigned[_low(u.email)] || 0 }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); })
    : [{ email: me.email, name: me.name, assigned: assigned[me.email] || 0 }];
  return { from: from, to: to, today: today, visits: list, reps: reps,
    weekend: String(_settings().weekend_days) };
}

function _saveVisit(me, v) {
  v = v || {};
  // ---- required fields (same checks as the page) ----
  var missing = [];
  var code = _str(v.code), person = _str(v.person), mobile = _str(v.mobile).replace(/[\s-]/g, '');
  if (!code) missing.push('CUSTOMER');
  if (!person) missing.push('PERSON');
  if (!mobile) missing.push('MOBILE');
  else if (!/^\+?\d{8,15}$/.test(mobile)) missing.push('MOBILE_BAD');
  var lat = _num(v.lat), lon = _num(v.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) missing.push('LOCATION');
  if (missing.length) throw _err('VISIT_MISSING', missing.join(','));

  return _lock(function () {
    var client = _rows(SH.clients).filter(function (c) { return _str(c.code) === code; })[0];
    if (!client) throw _err('VISIT_MISSING', 'CUSTOMER');
    if (me.role !== 'manager' && _low(client.rep_email) !== me.email) throw _err('NOT_YOUR_CLIENT');

    var today = _today(), now = new Date(), time = _nowTime();
    var mine = _rows(SH.visits).filter(function (x) {
      return _low(x.rep_email) === me.email && (_ds(x.date) || _dsTz(x.ts)) === today;
    }).sort(function (a, b) { return _ts(a.time).localeCompare(_ts(b.time)); });

    var chk = _check(client, { lat: lat, lon: lon, acc: _num(v.accuracy), mock: _bool(v.mock),
      time: time, now: now }, mine);

    var id = 'V' + Utilities.formatDate(now, TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 900 + 100);
    _append(SH.visits, {
      id: id, ts: now, date: "'" + today, time: "'" + time, rep_email: me.email, rep_name: me.name,
      client_code: code, client_name: _str(client.name), visit_type: _str(v.type) || 'visit',
      lat: lat, lon: lon, accuracy: _num(v.accuracy) === null ? '' : Math.round(_num(v.accuracy)),
      altitude: _num(v.altitude) === null ? '' : _num(v.altitude), mock: _bool(v.mock),
      distance_m: chk.distance === null ? '' : chk.distance, flag: chk.flag, tags: chk.tags.join(' '),
      comment: _str(v.comment).slice(0, 500), person_name: person.slice(0, 80), person_mobile: mobile,
      source: _str(v.source) || 'web'
    });

    // first clean visit fixes the customer's location
    if (!chk.flag && (_num(client.lat) === null || _num(client.lon) === null) &&
        (_num(v.accuracy) === null || _num(v.accuracy) <= 150)) {
      _update(SH.clients, client._row, { lat: lat, lon: lon });
    }
    if (chk.flag && _bool(_settings().email_alerts)) {
      try {
        MailApp.sendEmail(MANAGER_EMAIL, 'Flagged visit: ' + me.name + ' → ' + client.name,
          'Rep: ' + me.name + ' (' + me.email + ')\nCustomer: ' + client.name + ' [' + code + ']\n' +
          'Time: ' + today + ' ' + time + '\nFlags: ' + chk.tags.join(', ') + '\n' +
          'Distance from customer: ' + (chk.distance === null ? 'n/a' : chk.distance + ' m') + '\n' +
          'Pin: https://www.google.com/maps?q=' + lat + ',' + lon);
      } catch (e) { }
    }
    // reps never see flags
    return { id: id, date: today, time: time, client: _str(client.name) };
  });
}

/** Fake-visit rules. Only FLAG for manager review; never block. */
function _check(client, v, todays) {
  var tags = [], s = _settings();
  var cLat = _num(client.lat), cLon = _num(client.lon);
  var distance = (cLat !== null && cLon !== null) ? _haversine(cLat, cLon, v.lat, v.lon) : null;

  if (v.mock) tags.push('MOCK');                                     // fake-GPS app (Android)
  if (distance !== null && distance > s.far_limit_m) tags.push('FAR');  // far from customer
  if (distance === null) tags.push('NO_CLIENT_LOC');                 // note only
  if (_decimals(v.lat) <= 3 && _decimals(v.lon) <= 3) tags.push('ROUND'); // typed-in coordinates
  if (v.acc !== null && v.acc > 300) tags.push('LOW_ACC');           // note only

  var prev = todays.length ? todays[todays.length - 1] : null;
  todays.forEach(function (x) {
    if (_str(x.client_code) === _str(client.code)) { if (tags.indexOf('DUP') < 0) tags.push('DUP'); }
    else if (_num(x.lat) !== null && Math.abs(_num(x.lat) - v.lat) < 0.000005 &&
             Math.abs(_num(x.lon) - v.lon) < 0.000005) { if (tags.indexOf('FROZEN') < 0) tags.push('FROZEN'); }
  });
  if (prev && _str(prev.client_code) !== _str(client.code)) {
    var pt = _ts(prev.time), mins = _mins(v.time) - _mins(pt);
    var d = _haversine(_num(prev.lat), _num(prev.lon), v.lat, v.lon);
    if (mins >= 0 && mins < 4) tags.push('BURST');
    if (d !== null && d > 2000) {
      var hrs = Math.max(mins, 1) / 60, kmh = (d / 1000) / hrs;
      if (kmh > 150) tags.push('TELEPORT');
    }
  }
  var h = +v.time.slice(0, 2);
  if (h < 6 || h >= 23) tags.push('HOURS');                         // note only
  var flag = tags.some(function (t) { return STRONG_TAGS.indexOf(t) >= 0; });
  return { flag: flag, tags: tags, distance: distance };
}
function _mins(t) { var m = String(t).match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : 0; }

/* ================================================================
 *  Targets, sales & collection
 * ================================================================ */
/** Target for a rep in a month; carries forward the latest earlier month. */
function _targetMap(month) {
  var best = {};
  _rows(SH.targets).forEach(function (t) {
    var e = _low(t.rep_email), m = _str(t.month);
    if (Object.prototype.toString.call(t.month) === '[object Date]') m = Utilities.formatDate(t.month, TZ, 'yyyy-MM');
    m = m.slice(0, 7);
    if (!e || !m || m > month) return;
    if (!best[e] || m > best[e].m) best[e] = { m: m, s: _num(t.sales_target) || 0, c: _num(t.collection_target) || 0, row: t._row };
  });
  return best;
}
function _targetsOut(month) {
  month = _month(month);
  var map = _targetMap(month);
  return { month: month, rows: _rows(SH.users).filter(function (u) { return _role(u) === 'rep'; }).map(function (u) {
    var e = _low(u.email), t = map[e];
    return { email: e, name: _str(u.name) || e, active: _active(u),
      sales: t ? t.s : 0, collection: t ? t.c : 0, from: t ? t.m : '' };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); }) };
}
function _saveTargets(month, rows) {
  month = _month(month);
  return _lock(function () {
    var all = _rows(SH.targets);
    (rows || []).forEach(function (r) {
      var e = _low(r.email);
      if (!e) return;
      var s = _num(r.sales) || 0, c = _num(r.collection) || 0;
      var ex = all.filter(function (t) { return _low(t.rep_email) === e && _str(t.month).slice(0, 7) === month; })[0];
      if (ex) _update(SH.targets, ex._row, { sales_target: s, collection_target: c });
      else _append(SH.targets, { rep_email: e, month: "'" + month, sales_target: s, collection_target: c });
    });
    return _targetsOut(month);
  });
}
function _saleType(t) {
  t = _low(t);
  if (/^(c|col|coll|collection|collections|تحصيل|تحصيلات|التحصيل)$/.test(t)) return 'collection';
  if (/^(s|sale|sales|invoice|مبيعات|بيع|المبيعات|فاتورة)$/.test(t)) return 'sales';
  return '';
}
function _saleOut(s, names) {
  return { id: _str(s.id), date: _ds(s.date), rep: _low(s.rep_email), repName: names[_low(s.rep_email)] || _low(s.rep_email),
    type: _saleType(s.type) || 'sales', amount: _num(s.amount) || 0, client: _str(s.client), ref: _str(s.ref), note: _str(s.note) };
}
function _salesOut(month) {
  month = _month(month);
  var names = _repNames();
  var list = _rows(SH.sales).filter(function (s) { return _ds(s.date).slice(0, 7) === month; })
    .map(function (s) { return _saleOut(s, names); })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
  return { month: month, rows: list };
}
function _addSale(me, x) {
  x = x || {};
  var rep = _low(x.rep), type = _saleType(x.type), amt = _num(x.amount), d = _ds(x.date) || _today();
  if (!_user(rep)) throw _err('REP_UNKNOWN');
  if (!type) throw _err('BAD_TYPE');
  if (amt === null || amt === 0) throw _err('BAD_AMOUNT');
  return _lock(function () {
    _append(SH.sales, { id: 'S' + Date.now() + Math.floor(Math.random() * 1000), date: "'" + d, rep_email: rep, type: type,
      amount: amt, client: _str(x.client), ref: _str(x.ref), note: _str(x.note), added_by: me.email, added_at: new Date() });
    return _salesOut(d.slice(0, 7));
  });
}
function _deleteSale(id) {
  return _lock(function () {
    var row = _rows(SH.sales).filter(function (s) { return _str(s.id) === _str(id); })[0];
    if (!row) throw _err('NOT_FOUND');
    var m = _ds(row.date).slice(0, 7);
    _deleteRow(SH.sales, row._row);
    return _salesOut(m);
  });
}
/** Paste from Excel: date | rep (email or name) | type | amount | customer | ref */
function _importSales(me, text) {
  var users = _rows(SH.users), byName = {}, byEmail = {};
  users.forEach(function (u) { byEmail[_low(u.email)] = _low(u.email); byName[_low(u.name)] = _low(u.email); });
  var ok = [], errors = [];
  String(text || '').split(/\r?\n/).forEach(function (line, i) {
    if (!line.trim()) return;
    var p = line.split(/\t|;|,(?=\s*\S)/).map(function (s) { return s.trim(); });
    if (i === 0 && !/\d/.test(p[0] || '')) return; // header row
    var d = _ds(p[0]), rep = byEmail[_low(p[1])] || byName[_low(p[1])], type = _saleType(p[2]), amt = _num(p[3]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !rep || !type || amt === null) { errors.push(i + 1); return; }
    ok.push({ id: 'S' + Date.now() + '' + i, date: "'" + d, rep_email: rep, type: type, amount: amt,
      client: p[4] || '', ref: p[5] || '', note: '', added_by: me.email, added_at: new Date() });
  });
  _lock(function () { ok.forEach(function (o) { _append(SH.sales, o); }); });
  return { added: ok.length, badLines: errors };
}

/* ================================================================
 *  Summary (page 1) and drill-down details
 * ================================================================ */
function _summary(me, month, day) {
  month = _month(month);
  var today = _today();
  day = _ds(day) || _addDays(today, -1);
  var mStart = month + '-01', mEnd = _monthEnd(month);
  if (mEnd > today) mEnd = today;
  var mgr = me.role === 'manager';
  var users = _rows(SH.users).filter(function (u) {
    return mgr ? _role(u) === 'rep' : _low(u.email) === me.email;
  });
  var tmap = _targetMap(month);
  var reps = {};
  users.forEach(function (u) {
    var e = _low(u.email), t = tmap[e];
    reps[e] = { email: e, name: _str(u.name) || e, active: _active(u),
      sales: 0, salesTarget: t ? t.s : 0, coll: 0, collTarget: t ? t.c : 0,
      visitsMTD: 0, fakeMTD: 0, visitsDay: 0, fakeDay: 0, clients: 0, workDays: {} };
  });
  _rows(SH.sales).forEach(function (s) {
    var r = reps[_low(s.rep_email)], d = _ds(s.date);
    if (!r || d.slice(0, 7) !== month) return;
    if (_saleType(s.type) === 'collection') r.coll += _num(s.amount) || 0; else r.sales += _num(s.amount) || 0;
  });
  _rows(SH.visits).forEach(function (v) {
    var r = reps[_low(v.rep_email)];
    if (!r) return;
    var d = _ds(v.date) || _dsTz(v.ts), f = _bool(v.flag);
    if (d >= mStart && d <= mEnd) { r.visitsMTD++; if (f) r.fakeMTD++; r.workDays[d] = 1; }
    if (d === day) { r.visitsDay++; if (f) r.fakeDay++; }
  });
  _rows(SH.clients).forEach(function (c) { var r = reps[_low(c.rep_email)]; if (r) r.clients++; });
  var list = Object.keys(reps).map(function (k) {
    var r = reps[k];
    r.daysActive = Object.keys(r.workDays).length; delete r.workDays;
    if (!mgr) { delete r.fakeMTD; delete r.fakeDay; }
    return r;
  }).filter(function (r) { return r.active || r.visitsMTD || r.sales || r.coll; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  var tot = { sales: 0, salesTarget: 0, coll: 0, collTarget: 0, visitsMTD: 0, fakeMTD: 0, visitsDay: 0, fakeDay: 0, clients: 0 };
  list.forEach(function (r) { Object.keys(tot).forEach(function (k) { tot[k] += r[k] || 0; }); });
  if (!mgr) { delete tot.fakeMTD; delete tot.fakeDay; }
  // month progress: share of working days elapsed
  var wk = String(_settings().weekend_days).split(',');
  var wd = 0, wdDone = 0;
  for (var d = month + '-01'; d <= _monthEnd(month); d = _addDays(d, 1)) {
    var dow = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wk.indexOf(String(dow)) >= 0) continue;
    wd++; if (d <= today) wdDone++;
  }
  return { month: month, day: day, today: today, reps: list, total: tot,
    workDays: wd, workDaysDone: wdDone, isManager: mgr };
}

function _details(me, r) {
  var kind = _str(r.kind), month = _month(r.month), mgr = me.role === 'manager';
  var rep = mgr ? _low(r.rep) : me.email;   // '' = all reps (manager only)
  var day = _ds(r.day) || _addDays(_today(), -1);
  if (!mgr && /fake/.test(kind)) throw _err('NOT_ALLOWED');
  var names = _repNames();
  if (kind === 'sales' || kind === 'collection') {
    var rows = _rows(SH.sales).filter(function (s) {
      return _ds(s.date).slice(0, 7) === month && (!rep || _low(s.rep_email) === rep) &&
        (_saleType(s.type) || 'sales') === kind;
    }).map(function (s) { return _saleOut(s, names); }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    return { kind: kind, rows: rows };
  }
  if (kind === 'clients') {
    return { kind: kind, rows: _clientsFor({ role: 'manager' }).clients.filter(function (c) { return !rep || c.rep === rep; }) };
  }
  var from, to, onlyFake = /fake/.test(kind);
  if (/Day$/.test(kind)) { from = to = day; }
  else { from = month + '-01'; to = _monthEnd(month); }
  var res = _visits(me, { from: from, to: to, rep: rep });
  return { kind: kind, rows: res.visits.filter(function (v) { return !onlyFake || v.flag; }) };
}
