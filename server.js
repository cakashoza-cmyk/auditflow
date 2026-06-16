// AuditFlow v2 — Stock Audit Platform
// Run: npm install && node server.js  |  Open: http://localhost:3000

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'auditflow-jwt-secret-2024';
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const DB_FILE    = path.join(DATA_DIR, 'auditflow_data.json');
const UPLOADS    = path.join(DATA_DIR, 'uploads');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

// ── JSON FILE DATABASE ──────────────────────────────────────────────────
const EMPTY_DB = {
  users: [], audits: [], documents: [], timeline: [],
  reports: [], invoices: [], aa_consents: [], notifications: [],
  _seq: { users:0, documents:0, timeline:0, reports:0, aa_consents:0, notifications:0 }
};

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch { return JSON.parse(JSON.stringify(EMPTY_DB)); }
  }
  return JSON.parse(JSON.stringify(EMPTY_DB));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function dbAll(table) { return loadDB()[table] || []; }

function withDB(fn) {
  const db = loadDB(); const result = fn(db); saveDB(db); return result;
}
function dbInsert(table, data) {
  return withDB(db => {
    if (!db._seq) db._seq = {};
    if (!db._seq[table]) db._seq[table] = db[table].length;
    db._seq[table]++;
    const row = { id: db._seq[table], ...data, created_at: new Date().toISOString() };
    db[table].push(row);
    return row;
  });
}
function dbFind(table, where = {}) {
  const db = loadDB();
  if (!db[table]) return [];
  return db[table].filter(r => Object.entries(where).every(([k,v]) => r[k] == v));
}
function dbFindOne(table, where = {}) { return dbFind(table, where)[0] || null; }
function dbUpdate(table, where, updates) {
  withDB(db => {
    if (!db[table]) return;
    db[table] = db[table].map(r =>
      Object.entries(where).every(([k,v]) => r[k] == v)
        ? { ...r, ...updates, updated_at: new Date().toISOString() } : r
    );
  });
}

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────────────
function auth(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(req.user.role))
        return res.status(403).json({ error: 'Forbidden' });
      next();
    } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  };
}

// ── HELPERS ─────────────────────────────────────────────────────────────
function genAuditId() {
  const y = new Date().getFullYear();
  return 'AF-' + y + '-' + String(Math.floor(Math.random()*9000)+1000);
}
function safeUser(u) { if (!u) return null; const { password, ...r } = u; return r; }
function addTimeline(auditId, note, actor) {
  dbInsert('timeline', { audit_id: auditId, note, actor });
}
function defaultDocs(auditId) {
  const docs = [
    { name:'Stock Statement (Latest Month)',  source:'Customer Upload',   status:'pending'    },
    { name:'GST Returns (Last 2 months)',      source:'Auto-fetch via AA', status:'aa_pending' },
    { name:'ITR (Last 2 years)',               source:'Auto-fetch via AA', status:'aa_pending' },
    { name:'Bank Statement (3 months)',        source:'Auto-fetch via AA', status:'aa_pending' },
    { name:'Sanction Letter (Latest)',         source:'Bank Upload',       status:'pending'    },
    { name:'Debtor / Creditor List',           source:'Customer Upload',   status:'pending'    },
    { name:'Insurance Policy',                 source:'Customer Upload',   status:'pending'    },
  ];
  for (const d of docs) dbInsert('documents', { audit_id:auditId, ...d, uploaded_by:null, file_path:null });
}

// ── EMAIL ───────────────────────────────────────────────────────────────
function sendBrevoEmail({ to, toName, subject, body }) {
  const apiKey = process.env.RESEND_API_KEY;
  const senderEmail = process.env.SENDER_EMAIL || 'noreply@auditflw.in';
  if (!apiKey) { console.log('  EMAIL SKIPPED (no RESEND_API_KEY)'); return; }
  const payload = JSON.stringify({
    from: 'AuditFlow <' + senderEmail + '>',
    to: [to],
    subject: subject,
    text: body
  });
  const options = {
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  const req = https.request(options, function(res) {
    let data = '';
    res.on('data', function(chunk) { data += chunk; });
    res.on('end', function() {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('  EMAIL SENT -> ' + to);
      } else {
        console.error('  EMAIL FAILED (' + res.statusCode + '): ' + data);
      }
    });
  });
  req.on('error', function(err) { console.error('  EMAIL ERROR: ' + err.message); });
  req.write(payload);
  req.end();
}

function sendEmail({ to, toName, subject, body, type }) {
  const notif = dbInsert('notifications', { to_email:to, to_name:toName, subject, body, type,
    sent_at: new Date().toISOString(), status:'sent' });
  console.log('  EMAIL -> ' + to + ' | ' + subject);
  sendBrevoEmail({ to, toName, subject, body });
  return notif;
}

function sendWelcomeEmail({ name, email, role, tempPassword, auditId, borrowerName, bankName, caName, icaiNo }) {
  const loginUrl = process.env.APP_URL || 'http://localhost:3000';
  let subject, body;
  if (role === 'ca') {
    subject = '[AuditFlow] New audit assigned: ' + borrowerName + ', ' + bankName;
    body = 'Dear ' + name + ',\n\nA new stock audit has been assigned to you through AuditFlow — a platform built to make CA work faster, more visible, and more rewarding.\n\nAUDIT DETAILS\nBorrower: ' + borrowerName + '\nBank: ' + bankName + '\nAudit ID: ' + auditId + '\n\nWHAT AUDITFLOW DOES FOR YOU TODAY\n✓ Borrower submits documents digitally — no chasing, no WhatsApp forwards\n✓ One-click reminders to borrowers for pending submissions\n✓ Invoice reconciliation built in — match stock statements automatically\n✓ All your active audits on one dashboard — no registers, no spreadsheets\n✓ Banker rates your work on completion — strong ratings bring more assignments\n\nWHAT\'S COMING FOR EMPANELLED CAs\n⚡ Single profile listed across multiple banks — one registration, many opportunities\n⚡ Auto-generated audit reports from submitted data\n⚡ E-signature and digital report submission\n⚡ Audit analytics — track your turnaround time, ratings, and earnings\n⚡ Mobile app for on-site audits\n⚡ Direct borrower communication log for compliance records\n\nEarly empanelled CAs get priority listing when new banks join the platform.\n\nBEGIN YOUR AUDIT\n👉 ' + loginUrl + '\nEmail: ' + email + '\nPassword: ' + tempPassword + '\n\nChange your password after first login.\n\nRegards,\nTeam AuditFlow';
  } else if (role === 'banker') {
    subject = '[AuditFlow] Audit initiated — ' + borrowerName + ' | ID: ' + auditId;
    body = 'Dear ' + name + ',\n\nYour stock audit has been successfully initiated on AuditFlow.\n\nAUDIT SUMMARY\nBorrower: ' + borrowerName + '\nCA Assigned: ' + caName + ' (ICAI ' + icaiNo + ')\nAudit ID: ' + auditId + '\n\nWHAT AUDITFLOW IS HANDLING FOR YOU\n✓ Borrower and CA have been notified automatically\n✓ Document submissions tracked in real time — no manual follow-up\n✓ Automated reminders sent if submissions are pending\n✓ Full audit trail for compliance — no more MIS spreadsheets\n✓ Rate the CA on completion — builds a quality panel over time\n✓ All your audits in one place — status visible at a glance\n\nTRACK THIS AUDIT LIVE\n👉 ' + loginUrl + '\nEmail: ' + email + '\nPassword: ' + tempPassword + '\n\nChange your password after first login.\n\nRegards,\nTeam AuditFlow';
  } else {
    subject = '[AuditFlow] Your stock audit just got easier — action needed';
    body = 'Dear ' + name + ',\n\n' + bankName + ' has initiated a stock audit for your account. Instead of the usual back-and-forth of emails, phone calls, and physical document submissions, this audit will be conducted entirely through AuditFlow — a secure digital platform built for exactly this purpose.\n\nWHAT THIS MEANS FOR YOU\n✓ Submit documents once — no repeat requests for the same paper\n✓ See exactly where your audit stands, in real time\n✓ No more follow-up calls wondering what\'s pending\n✓ Everything on your phone or laptop, at your convenience\n\nYour audit has been assigned to ' + caName + ' (ICAI ' + icaiNo + ').\n\nLOGIN AND COMPLETE YOUR SUBMISSION IN MINUTES\n👉 ' + loginUrl + '\nEmail: ' + email + '\nPassword: ' + tempPassword + '\n\nChange your password after first login. If you face any difficulty, reply to this email.\n\nRegards,\nTeam AuditFlow';
  }
  return sendEmail({ to:email, toName:name, subject, body, type:'welcome_'+role });
}

function sendReminderEmail({ auditId, borrowerName, bankName, caName, caEmail, borrowerEmail, target, customMessage, stage, senderName }) {
  const messages = [];
  const stageLabel = { initiated:'Initiated', docs_requested:'Documents Requested', customer_submitted:'Customer Submitted', visit_scheduled:'Visit Scheduled', visit_done:'Visit Done', draft_ready:'Draft Ready', finalized:'Finalized' };
  if ((target==='ca'||target==='both') && caEmail) {
    const msg = customMessage || 'Reminder to expedite the stock audit for ' + borrowerName + '. Stage: ' + (stageLabel[stage]||stage);
    sendEmail({ to:caEmail, toName:caName, subject:'[AuditFlow] Action needed: ' + borrowerName + ' audit (' + auditId + ')', body:'Dear ' + caName + ',\n\n' + msg + '\n\nAudit ID: ' + auditId + '\nLogin now to take action: ' + (process.env.APP_URL || 'http://localhost:3000') + '\n\nRegards,\n' + senderName + '\nPowered by AuditFlow', type:'reminder_ca' });
    messages.push('CA ' + caName);
  }
  if ((target==='borrower'||target==='both') && borrowerEmail) {
    const msg = customMessage || 'Reminder regarding your pending stock audit. Please submit required documents.';
    sendEmail({ to:borrowerEmail, toName:borrowerName, subject:'[AuditFlow] Pending: documents required for your stock audit (' + auditId + ')', body:'Dear ' + borrowerName + ',\n\n' + msg + '\n\nSubmitting digitally takes minutes and avoids any delay in your audit clearance.\n\nAudit ID: ' + auditId + '\nLogin now: ' + (process.env.APP_URL || 'http://localhost:3000') + '\n\nRegards,\n' + senderName + '\nPowered by AuditFlow', type:'reminder_borrower' });
    messages.push('Borrower');
  }
  return messages;
}

// ── AUTO-LINK audits to user on registration/login ───────────────────────
function linkPendingAudits(userId, email, role) {
  const db = loadDB();
  let linked = 0;
  if (role === 'ca') {
    db.audits.filter(function(a) { return a.ca_email === email && !a.ca_id; }).forEach(function(a) {
      a.ca_id = userId; a.updated_at = new Date().toISOString(); linked++;
    });
  }
  if (role === 'borrower') {
    db.audits.filter(function(a) { return a.borrower_email === email && !a.borrower_id; }).forEach(function(a) {
      a.borrower_id = userId; a.updated_at = new Date().toISOString(); linked++;
    });
  }
  saveDB(db);
  return linked;
}

// ── AUTH ROUTES ──────────────────────────────────────────────────────────
app.post('/api/auth/register', async function(req, res) {
  const { name, email, password, role, phone, city, address, icai_no, firm_name,
          firm_reg_no, bank_name, branch, gstin, pan, constitution, referred_by } = req.body;
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: 'Name, email, password and role required' });
  if (dbFindOne('users', { email }))
    return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const user = dbInsert('users', { name, email, password:hash, role,
    phone:phone||null, city:city||null, address:address||null,
    icai_no:icai_no||null, firm_name:firm_name||null, firm_reg_no:firm_reg_no||null,
    bank_name:bank_name||null, branch:branch||null,
    gstin:gstin||null, pan:pan||null, constitution:constitution||null,
    is_temp_password: false,
    referred_by: referred_by || null,
    free_months: 12 // all new registrations get 12 months free (Founding Member offer)
  });
  // Credit referrer with 2 extra free months
  if (referred_by) {
    var db = loadDB();
    var refIdx = db.users.findIndex(function(u) { return u.id === referred_by; });
    if (refIdx !== -1) {
      db.users[refIdx].free_months = (db.users[refIdx].free_months || 12) + 2;
      db.users[refIdx].referral_count = (db.users[refIdx].referral_count || 0) + 1;
      saveDB(db);
      var referrer = db.users[refIdx];
      sendEmail({ to: referrer.email, toName: referrer.name,
        subject: '[AuditFlow] Your referral worked! +2 months added',
        body: 'Hi ' + referrer.name + ',\n\n' + name + ' just joined AuditFlow using your referral link. We\'ve added 2 more months of free Professional access to your account.\n\nYour total free months: ' + db.users[refIdx].free_months + '\n\nKeep sharing your referral link to earn more!\n\nRegards,\nTeam AuditFlow',
        type: 'referral' });
    }
  }
  const linked = linkPendingAudits(user.id, email, role);
  const token = jwt.sign({ id:user.id, name:user.name, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.json({ token, user:safeUser(user), linked_audits:linked });
});

app.post('/api/auth/login', async function(req, res) {
  const { email, password } = req.body;
  const user = dbFindOne('users', { email });
  if (!user || !await bcrypt.compare(password, user.password))
    return res.status(400).json({ error: 'Invalid credentials' });
  linkPendingAudits(user.id, email, user.role);
  const token = jwt.sign({ id:user.id, name:user.name, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.json({ token, user:safeUser(user) });
});

app.get('/api/auth/me', auth(), function(req, res) {
  const user = dbFindOne('users', { id: req.user.id });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(safeUser(user));
});

app.put('/api/auth/me', auth(), function(req, res) {
  const { name, phone, city, address, icai_no, firm_name, firm_reg_no, bank_name, branch } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (phone !== undefined) updates.phone = phone;
  if (city !== undefined) updates.city = city;
  if (address !== undefined) updates.address = address;
  if (icai_no !== undefined) updates.icai_no = icai_no;
  if (firm_name !== undefined) updates.firm_name = firm_name;
  if (firm_reg_no !== undefined) updates.firm_reg_no = firm_reg_no;
  if (bank_name !== undefined) updates.bank_name = bank_name;
  if (branch !== undefined) updates.branch = branch;
  dbUpdate('users', { id: req.user.id }, updates);
  res.json(safeUser(dbFindOne('users', { id: req.user.id })));
});

app.put('/api/auth/change-password', auth(), async function(req, res) {
  const { current, newPassword } = req.body;
  const user = dbFindOne('users', { id: req.user.id });
  if (!await bcrypt.compare(current, user.password))
    return res.status(400).json({ error: 'Current password incorrect' });
  const hash = await bcrypt.hash(newPassword, 10);
  dbUpdate('users', { id: req.user.id }, { password: hash, is_temp_password: false });
  res.json({ ok: true });
});

// ── USER LISTS ───────────────────────────────────────────────────────────
app.get('/api/cas', auth(['banker','admin','ca']), function(req, res) {
  res.json(dbFind('users', { role:'ca' }).map(safeUser));
});
app.get('/api/bankers', auth(['ca','admin']), function(req, res) {
  res.json(dbFind('users', { role:'banker' }).map(safeUser));
});
app.get('/api/notifications', auth(), function(req, res) {
  const user = dbFindOne('users', { id: req.user.id });
  const notifs = dbFind('notifications').filter(function(n) { return n.to_email === user.email; })
    .sort(function(a,b) { return new Date(b.created_at)-new Date(a.created_at); }).slice(0,20);
  res.json(notifs);
});

// ── ADMIN STATS (protected by key) ───────────────────────────────────────
app.get('/api/admin/stats', function(req, res) {
  var key = req.query.key || '';
  var adminKey = process.env.ADMIN_KEY || 'auditflow-admin-2024';
  if (key !== adminKey) return res.status(403).json({ error: 'Forbidden' });
  var db = loadDB();
  var users = db.users || [];
  var audits = db.audits || [];
  var byRole = {};
  users.forEach(function(u) {
    var r = u.role || 'unknown';
    byRole[r] = (byRole[r] || 0) + 1;
  });
  var recentSignups = users.slice(-10).reverse().map(function(u) {
    return { name: u.name, email: u.email, role: u.role, joined: u.created_at };
  });
  res.json({
    total_users: users.length,
    by_role: byRole,
    total_audits: audits.length,
    recent_signups: recentSignups
  });
});

// ── AUDIT ROUTES ─────────────────────────────────────────────────────────
app.get('/api/audits', auth(), function(req, res) {
  const u = req.user;
  const user = dbFindOne('users', { id: u.id });
  let audits = dbFind('audits');
  if (u.role === 'ca') {
    audits = audits.filter(function(a) { return a.ca_id == u.id || a.ca_email === user.email; });
  } else if (u.role === 'banker') {
    audits = audits.filter(function(a) { return a.banker_id == u.id; });
  } else if (u.role === 'borrower') {
    audits = audits.filter(function(a) { return a.borrower_id == u.id || a.borrower_email === user.email; });
  }
  audits = audits.sort(function(a,b) { return new Date(b.created_at)-new Date(a.created_at); });
  audits = audits.map(function(a) { return Object.assign({}, a, {
    ca: a.ca_id ? safeUser(dbFindOne('users', { id:a.ca_id })) : null,
    documents: dbFind('documents', { audit_id:a.id }),
  }); });
  res.json(audits);
});

app.post('/api/audits', auth(['banker','admin','ca']), async function(req, res) {
  const { borrower_name, bank_name, branch, exposure, constitution, city, cluster,
          deadline, fee, ca_id, ca_email: caEmailParam, borrower_email, banker_email, notes } = req.body;
  if (!borrower_name || !bank_name || !branch)
    return res.status(400).json({ error: 'borrower_name, bank_name, branch required' });

  let resolved_ca_id = ca_id || null;
  let resolved_ca_email = caEmailParam || null;
  let resolved_banker_id = req.user.role === 'banker' ? req.user.id : null;
  let resolved_banker_email = null;
  let resolved_borrower_id = null;
  let resolved_borrower_email = borrower_email || null;

  if (req.user.role === 'ca') {
    resolved_ca_id = req.user.id;
    if (banker_email) {
      const b = dbFindOne('users', { email:banker_email, role:'banker' });
      if (b) { resolved_banker_id = b.id; }
      else resolved_banker_email = banker_email;
    }
  }
  if (borrower_email) {
    const bor = dbFindOne('users', { email:borrower_email, role:'borrower' });
    if (bor) resolved_borrower_id = bor.id;
  }
  if (!resolved_ca_id && caEmailParam) {
    const caUser = dbFindOne('users', { email:caEmailParam, role:'ca' });
    if (caUser) { resolved_ca_id = caUser.id; resolved_ca_email = null; }
    else resolved_ca_email = caEmailParam;
  }

  const id = genAuditId();
  dbInsert('audits', {
    id, borrower_id:resolved_borrower_id, banker_id:resolved_banker_id,
    ca_id:resolved_ca_id, ca_email:resolved_ca_email,
    borrower_email:resolved_borrower_email, banker_email:resolved_banker_email,
    borrower_name, bank_name, branch,
    exposure:exposure||null, constitution:constitution||null,
    city:city||null, cluster:cluster||null,
    stage:'initiated', deadline:deadline||null,
    fee:parseFloat(fee)||0, pay_status:'not_raised', pay_date:null, notes:notes||null,
    inadequate_dp:false, dp_calculated:null, initiated_by:req.user.role
  });
  defaultDocs(id);
  addTimeline(id, 'Audit initiated by ' + req.user.name + ' (' + bank_name + ', ' + branch + ')', req.user.name);

  const caUserR = resolved_ca_id ? safeUser(dbFindOne('users', { id:resolved_ca_id })) : null;
  const caName = (caUserR && caUserR.name) || 'To be assigned';
  const caEmail2 = (caUserR && caUserR.email) || resolved_ca_email;
  const icaiNo = (caUserR && caUserR.icai_no) || '—';
  const tempPwd = Math.random().toString(36).slice(-8);

  if (caEmail2) {
    if (!dbFindOne('users', { email: caEmail2 })) {
      const hash = await bcrypt.hash(tempPwd, 10);
      const newCA = dbInsert('users', { name:'CA ('+caEmail2+')', email:caEmail2, password:hash, role:'ca', is_temp_password:true,
        icai_no:null, firm_name:null, firm_reg_no:null, city:null, phone:null, address:null,
        bank_name:null, branch:null, gstin:null, pan:null, constitution:null });
      dbUpdate('audits', { id }, { ca_id: newCA.id, ca_email: null });
      addTimeline(id, 'CA invite sent to ' + caEmail2, 'System');
      sendWelcomeEmail({ name:'CA ('+caEmail2+')', email:caEmail2, role:'ca', tempPassword:tempPwd,
        auditId:id, borrowerName:borrower_name, bankName:bank_name, caName:req.user.name, icaiNo:'—' });
    } else {
      addTimeline(id, 'Assigned to CA ' + caName, req.user.name);
      sendEmail({ to:caEmail2, toName:caName, subject:'[AuditFlow] New audit assigned: ' + borrower_name,
        body:'Dear ' + caName + ',\n\nNew audit assigned: ' + borrower_name + ' (' + bank_name + ', ' + branch + ')\nAudit ID: ' + id + '\n\nLogin: ' + (process.env.APP_URL || 'http://localhost:3000') + '',
        type:'assignment_ca' });
    }
  }
  if (borrower_email) {
    if (!dbFindOne('users', { email: borrower_email })) {
      const hash2 = await bcrypt.hash(tempPwd, 10);
      const newBor = dbInsert('users', { name:borrower_name, email:borrower_email, password:hash2, role:'borrower', is_temp_password:true,
        icai_no:null, firm_name:null, firm_reg_no:null, city:city||null, phone:null, address:null,
        bank_name:null, branch:null, gstin:null, pan:null, constitution:constitution||null });
      dbUpdate('audits', { id }, { borrower_id: newBor.id, borrower_email: null });
      addTimeline(id, 'Borrower invite sent to ' + borrower_email, 'System');
    }
    sendWelcomeEmail({ name:borrower_name, email:borrower_email, role:'borrower', tempPassword:tempPwd,
      auditId:id, borrowerName:borrower_name, bankName:bank_name, caName, icaiNo });
  }
  if (resolved_banker_email && !dbFindOne('users', { email:resolved_banker_email })) {
    const hash3 = await bcrypt.hash(tempPwd, 10);
    const newBanker = dbInsert('users', { name:'Banker ('+resolved_banker_email+')', email:resolved_banker_email,
      password:hash3, role:'banker', is_temp_password:true, bank_name:bank_name||null, branch:branch||null,
      icai_no:null, firm_name:null, firm_reg_no:null, city:null, phone:null, address:null,
      gstin:null, pan:null, constitution:null });
    dbUpdate('audits', { id }, { banker_id:newBanker.id, banker_email:null });
    sendWelcomeEmail({ name:'Banker ('+resolved_banker_email+')', email:resolved_banker_email, role:'banker',
      tempPassword:tempPwd, auditId:id, borrowerName:borrower_name, bankName:bank_name, caName, icaiNo });
    addTimeline(id, 'Banker invite sent to ' + resolved_banker_email, 'System');
  }
  res.json(dbFindOne('audits', { id }));
});

app.get('/api/audits/:id', auth(), function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Not found' });
  res.json(Object.assign({}, audit, {
    ca:       audit.ca_id     ? safeUser(dbFindOne('users', { id:audit.ca_id }))     : null,
    banker:   audit.banker_id ? safeUser(dbFindOne('users', { id:audit.banker_id })) : null,
    documents: dbFind('documents', { audit_id:audit.id }),
    timeline:  dbFind('timeline',  { audit_id:audit.id }).sort(function(a,b){ return new Date(b.created_at)-new Date(a.created_at); }),
    report:   dbFindOne('reports',    { audit_id:audit.id }),
    invoice:  dbFindOne('invoices',   { audit_id:audit.id }),
    consent:  dbFind('aa_consents', { audit_id:audit.id }).sort(function(a,b){ return b.id-a.id; })[0]||null,
  }));
});

app.put('/api/audits/:id', auth(['banker','admin','ca']), function(req, res) {
  const { ca_id, fee, deadline, notes, exposure } = req.body;
  const audit = dbFindOne('audits', { id:req.params.id });
  if (!audit) return res.status(404).json({ error:'Not found' });
  const updates = {};
  if (ca_id !== undefined) updates.ca_id = ca_id||null;
  if (fee !== undefined) updates.fee = parseFloat(fee)||0;
  if (deadline !== undefined) updates.deadline = deadline;
  if (notes !== undefined) updates.notes = notes;
  if (exposure !== undefined) updates.exposure = exposure;
  dbUpdate('audits', { id:req.params.id }, updates);
  if (ca_id && ca_id != audit.ca_id) {
    const ca = dbFindOne('users', { id:parseInt(ca_id) });
    if (ca) {
      addTimeline(req.params.id, 'Re-assigned to CA ' + ca.name, req.user.name);
      const prevAudits = dbFind('audits').filter(function(a) {
        return a.id !== req.params.id && a.ca_id == ca.id && a.borrower_id == audit.borrower_id;
      });
      if (prevAudits.length > 0) {
        addTimeline(req.params.id, 'WARNING: CA ' + ca.name + ' previously audited this borrower — verify RBI consecutive audit compliance', 'System');
      }
      sendEmail({ to:ca.email, toName:ca.name,
        subject:'[AuditFlow] Audit re-assigned: ' + audit.borrower_name,
        body:'Dear ' + ca.name + ',\n\nYou have been assigned the stock audit for ' + audit.borrower_name + '.\nAudit ID: ' + req.params.id + '\n\nLogin: ' + (process.env.APP_URL || 'http://localhost:3000') + '',
        type:'reassignment_ca' });
    }
  }
  res.json(dbFindOne('audits', { id:req.params.id }));
});

const STAGES = ['initiated','docs_requested','customer_submitted','visit_scheduled','visit_done','draft_ready','finalized'];
const STAGE_NOTES = {
  docs_requested:'Documents requested from borrower',
  customer_submitted:'Customer submitted required documents',
  visit_scheduled:'Site visit scheduled',
  visit_done:'Site visit completed',
  draft_ready:'Draft report prepared',
  finalized:'Report finalized and submitted to bank'
};

app.put('/api/audits/:id/stage', auth(['ca','banker','admin']), function(req, res) {
  const { stage, note } = req.body;
  if (!STAGES.includes(stage)) return res.status(400).json({ error:'Invalid stage' });
  if (!dbFindOne('audits', { id:req.params.id })) return res.status(404).json({ error:'Not found' });
  dbUpdate('audits', { id:req.params.id }, { stage });
  addTimeline(req.params.id, note||STAGE_NOTES[stage]||'Stage: '+stage, req.user.name);
  res.json({ stage });
});

// ── REMINDER ─────────────────────────────────────────────────────────────
app.post('/api/audits/:id/remind', auth(['banker','admin','ca']), function(req, res) {
  const { target, message } = req.body;
  const audit = dbFindOne('audits', { id:req.params.id });
  if (!audit) return res.status(404).json({ error:'Not found' });
  const ca = audit.ca_id ? dbFindOne('users', { id:audit.ca_id }) : null;
  const borrower = audit.borrower_id ? dbFindOne('users', { id:audit.borrower_id }) : null;
  const sent = sendReminderEmail({
    auditId:audit.id, borrowerName:audit.borrower_name, bankName:audit.bank_name,
    caName:(ca && ca.name)||'—', caEmail:(ca && ca.email)||null,
    borrowerEmail:(borrower && borrower.email)||audit.borrower_email,
    target, customMessage:message, stage:audit.stage, senderName:req.user.name
  });
  addTimeline(audit.id, 'Reminder sent to: ' + target + (message ? ' — "' + message + '"' : ''), req.user.name);
  res.json({ ok:true, sent });
});

// ── AI STOCK ANALYSIS ────────────────────────────────────────────────────────
const uploadAI = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

app.get('/api/ai-doc-types', auth(['ca','admin']), function(req, res) {
  res.json(Object.entries(AI_DOC_PROMPTS).map(function([key, v]) {
    return { key, label: v.label, desc: v.desc };
  }));
});

const AI_DOC_PROMPTS = {
  stock_statement: {
    label: 'Stock Statement',
    desc: 'Monthly stock statement submitted by borrower showing category-wise inventory values and drawing power',
    prompt: (a) => `You are an expert Indian CA analyzing a STOCK STATEMENT for bank working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"last_stock_date":"YYYY-MM-DD","sanctioned_limit":null,"outstanding":null,"dp_bank":null,"dp_audit":null,"audit_period":null,"account_no":null,"facility_type":null,"stocks":[{"books":null,"physical":null,"diff":null,"remarks":null},{"books":null,"physical":null,"diff":null,"remarks":null},{"books":null,"physical":null,"diff":null,"remarks":null},{"books":null,"physical":null,"diff":null,"remarks":null},{"books":null,"physical":null,"diff":null,"remarks":null},{"books":null,"physical":null,"diff":null,"remarks":null}],"stock_good_pct":null,"stock_slow_pct":null,"stock_dead_pct":null,"stock_observations":null,"ai_summary":null}
stocks[0]=Raw Materials,[1]=WIP,[2]=Finished Goods,[3]=Stores & Spares,[4]=Stock in Transit,[5]=Total. All INR numbers, no symbols.`
  },
  debtors_statement: {
    label: 'Debtors / Book Debts Statement',
    desc: 'Debtor-wise or aging-wise list of outstanding receivables. Used to calculate eligible drawing power from book debts.',
    prompt: (a) => `You are an expert Indian CA analyzing a DEBTORS / BOOK DEBTS STATEMENT for bank working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"total_debtors":null,"dp_debtors":null,"debtors":[{"amount":null,"pct":null,"remarks":null},{"amount":null,"pct":null,"remarks":null},{"amount":null,"pct":null,"remarks":null},{"amount":null,"pct":null,"remarks":null},{"amount":null,"pct":null,"remarks":null}],"disputed_debtors":null,"related_debtors":null,"debtor_observations":null,"ai_summary":null}
debtors[0]=<30 days,[1]=30-60 days,[2]=60-90 days,[3]=90-180 days,[4]=>180 days. All INR numbers.`
  },
  creditors_statement: {
    label: 'Creditors Statement',
    desc: 'List of outstanding payables to suppliers. Creditors are deducted from drawing power calculation.',
    prompt: (a) => `You are an expert Indian CA analyzing a CREDITORS STATEMENT for bank working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"total_creditors":null,"old_creditors":null,"creditor_observations":null,"ai_summary":null}
old_creditors = creditors outstanding > 90 days. All INR numbers.`
  },
  bank_statement: {
    label: 'Bank Statement (6 months)',
    desc: 'Last 6 months bank account statement. Used to verify cash flow, average utilisation and check for cheque returns or irregular transactions.',
    prompt: (a) => `You are an expert Indian CA analyzing a BANK ACCOUNT STATEMENT for working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"ops_obs":null,"records_obs":null,"discrepancies":null,"sanction_compliance":null,"ai_summary":null}
In ops_obs: mention average utilisation %, number of cheque returns if any, whether credits are regular and consistent with declared sales, any unusual large debits/credits, overdrawing beyond limit. Be specific with numbers found.`
  },
  gst_returns: {
    label: 'GST Returns (GSTR-3B / GSTR-1)',
    desc: 'GST returns for last 6-12 months. Used to cross-check declared turnover with stock levels and bank credits.',
    prompt: (a) => `You are an expert Indian CA analyzing GST RETURNS for working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"gstin":null,"audit_period":null,"ops_obs":null,"discrepancies":null,"ai_summary":null}
In ops_obs: mention total taxable turnover declared, monthly average sales, whether turnover is consistent with stock levels and bank credits. In discrepancies: note any mismatch between GST sales and expected stock movement.`
  },
  insurance: {
    label: 'Insurance Policy / Certificate',
    desc: 'Insurance certificate covering stock/assets. Must be valid, adequate, and show bank as mortgagee/loss payee.',
    prompt: (a) => `You are an expert Indian CA analyzing an INSURANCE POLICY/CERTIFICATE for working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"insurer":null,"policy_no":null,"policy_expiry":"YYYY-MM-DD","sum_insured":null,"coverage_type":null,"bank_mortgagee":null,"insurance_observations":null,"ai_summary":null}
coverage_type must be one of: Fire, Burglary, Flood, All Risk, Marine. bank_mortgagee: Yes or No.`
  },
  financials: {
    label: 'ITR / Audited Balance Sheet',
    desc: 'Latest ITR or audited financials. Used to assess sales turnover, profitability, inventory turnover ratio and net worth.',
    prompt: (a) => `You are an expert Indian CA analyzing ITR / AUDITED FINANCIALS for working capital audit.
Borrower: ${a.borrower_name}, Bank: ${a.bank_name}
Extract and return ONLY this JSON (null for missing):
{"address":null,"gstin":null,"constitution":null,"records_obs":null,"ops_obs":null,"discrepancies":null,"ai_summary":null}
In ops_obs: mention annual sales turnover, net profit/loss, inventory turnover ratio (if calculable), net worth, any significant change year-over-year. In records_obs: comment on quality and completeness of financial records.`
  }
};

app.post('/api/audits/:id/ai-analyze', auth(['ca','admin']), uploadAI.single('file'), async function(req, res) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI not configured - add GROQ_API_KEY in Railway (free key at console.groq.com)' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const docType = req.body.doc_type;
  const cfg = AI_DOC_PROMPTS[docType];
  if (!cfg) return res.status(400).json({ error: 'Invalid doc_type: ' + docType });
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const promptText = cfg.prompt(audit) + '\nRespond ONLY with a valid JSON object. No markdown, no code fences.';
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isExcel = mimeType.includes('spreadsheet') || mimeType.includes('excel') || req.file.originalname.match(/\.xlsx?$/i);

  function extractPdfText(buf) {
    const s = buf.toString('latin1');
    const texts = [];
    const re1 = /\(([^)\\]|\\.)*\)\s*Tj/g;
    let m;
    while ((m = re1.exec(s)) !== null) {
      texts.push(m[0].replace(/\)\s*Tj$/, '').replace(/^\(/, '').replace(/\\n/g, ' '));
    }
    const re2 = /\[([^\]]*)\]\s*TJ/g;
    while ((m = re2.exec(s)) !== null) {
      const parts = m[1].match(/\(([^)\\]|\\.)*\)/g) || [];
      texts.push(parts.map(function(p){ return p.slice(1,-1); }).join(''));
    }
    // fallback: readable ascii runs
    if (texts.length < 5) {
      const fallback = s.replace(/[^\x20-\x7e\n]/g, ' ').replace(/ {3,}/g, ' ');
      return fallback.slice(0, 12000);
    }
    return texts.join(' ').slice(0, 12000);
  }
  function extractExcelText(buf) {
    // xlsx files are ZIP; extract readable strings by scanning for UTF-16 and ASCII text
    const s = buf.toString('latin1');
    const texts = [];
    // Find XML-like shared strings in xlsx ZIP (often readable as latin1)
    const re = /<t[^>]*>([^<]+)<\/t>/g;
    let m;
    while ((m = re.exec(s)) !== null) texts.push(m[1]);
    if (texts.length > 0) return texts.join('\t').slice(0, 12000);
    // fallback: printable ascii runs >= 4 chars
    const runs = s.match(/[\x20-\x7e]{4,}/g) || [];
    return runs.join(' ').slice(0, 12000);
  }
  async function buildGroqPayload() {
    if (isImage) {
      const base64Data = req.file.buffer.toString('base64');
      return JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data } }
        ]}],
        temperature: 0.1, max_tokens: 2048
      });
    }
    let textContent = '';
    if (isPdf) { textContent = extractPdfText(req.file.buffer); }
    else if (isExcel) { textContent = extractExcelText(req.file.buffer); }
    else { textContent = req.file.buffer.toString('utf8', 0, 12000); }
    return JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: promptText + '\n\nDOCUMENT CONTENT:\n' + textContent }],
      temperature: 0.1, max_tokens: 2048
    });
  }
  let groqPayload;
  try { groqPayload = await buildGroqPayload(); } catch(e) { return res.status(500).json({ error: 'File processing error: ' + e.message }); }
  const https = require('https');
  const groqReq = https.request({
    hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(groqPayload) }
  }, function(groqRes) {
    let rdata = '';
    groqRes.on('data', chunk => rdata += chunk);
    groqRes.on('end', () => {
      try {
        const parsed = JSON.parse(rdata);
        if (parsed.error) return res.status(500).json({ error: 'AI error: ' + parsed.error.message });
        const content = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '';
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const extracted = JSON.parse(m[0]);
            const _aiDb = loadDB();
            const aidx = _aiDb.audits.findIndex(a => a.id === req.params.id);
            if (aidx !== -1) {
              if (!_aiDb.audits[aidx].ai_results) _aiDb.audits[aidx].ai_results = {};
              _aiDb.audits[aidx].ai_results[docType] = { result: extracted, analyzed_at: new Date().toISOString() };
              saveDB(_aiDb);
            }
            res.json({ ok: true, doc_type: docType, label: cfg.label, result: extracted });
          } catch(pe) { res.json({ ok: true, doc_type: docType, label: cfg.label, result: null, raw: content }); }
        } else {
          res.json({ ok: true, doc_type: docType, label: cfg.label, result: null, raw: content });
        }
      } catch(e) { res.status(500).json({ error: 'Failed to parse AI response', details: e.message }); }
    });
  });
  groqReq.on('error', err => res.status(500).json({ error: 'AI request failed', details: err.message }));
  groqReq.write(groqPayload);
  groqReq.end();
});


// ── REPORT ───────────────────────────────────────────────────────────────────
app.get('/api/audits/:id/report', auth(), function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const report = dbFindOne('reports', { audit_id: req.params.id });
  res.json({ data: (report && report.data) || {}, status: (report && report.status) || 'draft' });
});

app.put('/api/audits/:id/report', auth(), function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const { data, status } = req.body;
  const existing = dbFindOne('reports', { audit_id: req.params.id });

  // DP check
  const outstanding = parseFloat(data.outstanding) || 0;
  const dpAudit = parseFloat(data.dp_audit) || 0;
  const inadequate_dp = outstanding > 0 && dpAudit > 0 && dpAudit < outstanding;

  if (existing) {
    const _rDb = loadDB();
    const idx = _rDb.reports.findIndex(r => r.audit_id === req.params.id);
    _rDb.reports[idx] = { ..._rDb.reports[idx], data, status, updated_at: new Date().toISOString() };
    saveDB(_rDb);
  } else {
    dbInsert('reports', { audit_id: req.params.id, data, status, created_at: new Date().toISOString() });
  }

  if (status === 'finalized') {
    const _fDb = loadDB();
    const aidx = _fDb.audits.findIndex(a => a.id === req.params.id);
    if (aidx !== -1) {
      _fDb.audits[aidx].stage = 'finalized';
      _fDb.audits[aidx].inadequate_dp = inadequate_dp;
      _fDb.audits[aidx].dp_calculated = dpAudit;
      saveDB(_fDb);
      addTimeline(req.params.id, 'Report finalized and submitted to bank', req.user.name);
    }
  }
  res.json({ ok: true, inadequate_dp, dp_calculated: dpAudit });
});

// ── DRIVE LINK ────────────────────────────────────────────────────────────────
app.put('/api/audits/:id/drive-link', auth(['ca','admin']), function(req, res) {
  const { drive_link } = req.body;
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Not found' });
  dbUpdate('audits', { id: req.params.id }, { drive_link: drive_link || null });
  addTimeline(req.params.id, drive_link ? 'Google Drive folder linked' : 'Drive link removed', req.user.name);
  res.json({ ok: true });
});

// ── AA CONSENT ────────────────────────────────────────────────────────────────
app.post('/api/audits/:id/consent', auth(['ca','banker','admin']), function(req, res) {
  const { data_types } = req.body;
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const consent = dbInsert('aa_consents', {
    audit_id: req.params.id,
    requested_by: req.user.id,
    data_types: data_types || ['gst','itr','bank'],
    status: 'pending',
    requested_at: new Date().toISOString(),
    approved_at: null
  });
  addTimeline(req.params.id, 'Account Aggregator consent requested from borrower', req.user.name);
  const borrower = audit.borrower_id ? dbFindOne('users', { id: audit.borrower_id }) : null;
  if (borrower) {
    sendEmail({ to: borrower.email, toName: borrower.name,
      subject: '[AuditFlow] Consent required for your stock audit (' + req.params.id + ')',
      body: 'Dear ' + borrower.name + ',\n\nYour CA has requested consent to fetch your financial data (GST, ITR, Bank Statement) via the Account Aggregator framework for your stock audit.\n\nPlease log in to approve:\n' + (process.env.APP_URL || 'http://localhost:3000') + '\n\nAudit ID: ' + req.params.id + '\n\nRegards,\nAuditFlow',
      type: 'aa_consent_request' });
  }
  res.json(consent);
});

app.put('/api/aa-consents/:id/approve', auth(['borrower']), function(req, res) {
  const consent = dbFindOne('aa_consents', { id: parseInt(req.params.id) });
  if (!consent) return res.status(404).json({ error: 'Not found' });
  dbUpdate('aa_consents', { id: parseInt(req.params.id) }, { status: 'approved', approved_at: new Date().toISOString() });
  addTimeline(consent.audit_id, 'Borrower approved Account Aggregator consent', req.user.name);
  res.json({ ok: true });
});

// ── CA RATING ─────────────────────────────────────────────────────────────────
app.post('/api/audits/:id/rate', auth(['banker','admin']), function(req, res) {
  const { rating, comment } = req.body;
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  dbUpdate('audits', { id: req.params.id }, { rating: parseInt(rating), rating_comment: comment || '', rated_by: req.user.id, rated_at: new Date().toISOString() });
  addTimeline(req.params.id, 'CA rated ' + rating + '/5 by banker' + (comment ? ': "' + comment + '"' : ''), req.user.name);
  // update CA average rating
  if (audit.ca_id) {
    const caAudits = dbFind('audits', {}).filter(function(a) { return a.ca_id == audit.ca_id && a.rating; });
    const avg = caAudits.reduce(function(s, a) { return s + a.rating; }, 0) / caAudits.length;
    dbUpdate('users', { id: audit.ca_id }, { avg_rating: Math.round(avg * 10) / 10, total_ratings: caAudits.length });
  }
  res.json({ ok: true });
});

// ── INVOICES ──────────────────────────────────────────────────────────────────
app.post('/api/audits/:id/invoice', auth(['ca','admin']), function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (dbFindOne('invoices', { audit_id: req.params.id })) return res.status(400).json({ error: 'Invoice already raised' });
  const inv = dbInsert('invoices', {
    audit_id: req.params.id,
    ca_id: req.user.id,
    amount: audit.fee || 0,
    status: 'raised',
    raised_at: new Date().toISOString(),
    paid_at: null
  });
  dbUpdate('audits', { id: req.params.id }, { pay_status: 'raised' });
  addTimeline(req.params.id, 'Invoice raised for ₹' + (audit.fee || 0), req.user.name);
  const banker = audit.banker_id ? dbFindOne('users', { id: audit.banker_id }) : null;
  if (banker) {
    sendEmail({ to: banker.email, toName: banker.name,
      subject: '[AuditFlow] Invoice raised: ' + audit.borrower_name + ' (₹' + (audit.fee || 0) + ')',
      body: 'Dear ' + banker.name + ',\n\nAudit fee invoice has been raised for ' + audit.borrower_name + '.\nAmount: ₹' + (audit.fee || 0) + '\nAudit ID: ' + req.params.id + '\n\nPlease log in to mark as paid:\n' + (process.env.APP_URL || 'http://localhost:3000'),
      type: 'invoice_raised' });
  }
  res.json(inv);
});

app.get('/api/invoices', auth(['ca','admin','banker']), function(req, res) {
  const user = req.user;
  let invoices = dbFind('invoices');
  if (user.role === 'ca') invoices = invoices.filter(function(i) { return i.ca_id == user.id; });
  if (user.role === 'banker') {
    const myAuditIds = dbFind('audits', { banker_id: user.id }).map(function(a) { return a.id; });
    invoices = invoices.filter(function(i) { return myAuditIds.includes(i.audit_id); });
  }
  invoices = invoices.map(function(inv) {
    const audit = dbFindOne('audits', { id: inv.audit_id });
    return Object.assign({}, inv, { audit: audit || null });
  }).sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  res.json(invoices);
});

app.put('/api/invoices/:id/pay', auth(['banker','admin']), function(req, res) {
  const inv = dbFindOne('invoices', { id: parseInt(req.params.id) });
  if (!inv) return res.status(404).json({ error: 'Not found' });
  dbUpdate('invoices', { id: parseInt(req.params.id) }, { status: 'paid', paid_at: new Date().toISOString() });
  dbUpdate('audits', { id: inv.audit_id }, { pay_status: 'paid', pay_date: new Date().toISOString() });
  addTimeline(inv.audit_id, 'Invoice marked as paid by banker', req.user.name);
  const ca = dbFindOne('users', { id: inv.ca_id });
  if (ca) {
    sendEmail({ to: ca.email, toName: ca.name,
      subject: '[AuditFlow] Payment confirmed: ₹' + inv.amount,
      body: 'Dear ' + ca.name + ',\n\nPayment of ₹' + inv.amount + ' has been marked as received for audit ' + inv.audit_id + '.\n\nRegards,\nAuditFlow',
      type: 'invoice_paid' });
  }
  res.json({ ok: true });
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
app.get('/api/analytics', auth(['ca','admin']), function(req, res) {
  const uid = req.user.id;
  const myAudits = dbFind('audits').filter(function(a) { return a.ca_id == uid; });
  const total = myAudits.length;
  const finalized = myAudits.filter(function(a) { return a.stage === 'finalized'; }).length;
  const inProgress = total - finalized;
  const totalFees = myAudits.reduce(function(s, a) { return s + (parseFloat(a.fee) || 0); }, 0);
  const paidFees = myAudits.filter(function(a) { return a.pay_status === 'paid'; }).reduce(function(s, a) { return s + (parseFloat(a.fee) || 0); }, 0);
  const overdue = myAudits.filter(function(a) { return a.deadline && new Date(a.deadline) < new Date() && a.stage !== 'finalized'; }).length;
  const inadequateDp = myAudits.filter(function(a) { return a.inadequate_dp; }).length;
  const user = dbFindOne('users', { id: uid });
  res.json({ total, finalized, inProgress, overdue, totalFees, paidFees, inadequateDp, avg_rating: user && user.avg_rating || null, total_ratings: user && user.total_ratings || 0 });
});

// ── REFERRAL ──────────────────────────────────────────────────────────────────
app.get('/api/my/referral-link', auth(), function(req, res) {
  var appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  var link = appUrl + '/?ref=' + req.user.id;
  var user = dbFindOne('users', { id: req.user.id });
  res.json({
    referral_link: link,
    referral_count: user.referral_count || 0,
    free_months: user.free_months || 12
  });
});

app.post('/api/refer', auth(), function(req, res) {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const referrer = dbFindOne('users', { id: req.user.id });
  var appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  var referralLink = appUrl + '/?ref=' + referrer.id;
  sendEmail({ to: email, toName: name || email,
    subject: referrer.name + ' invited you to AuditFlow — 12 Months Free',
    body: 'Hi ' + (name || '') + ',\n\n' + referrer.name + ' has invited you to join AuditFlow — India\'s digital stock audit platform for CAs and banks.\n\nAs a Founding Member, you get 12 months of full access completely free. No credit card required.\n\nRegister using this exclusive link:\n' + referralLink + '\n\nWith AuditFlow you can:\n• Generate RBI-compliant audit reports in one click\n• Auto-calculate Drawing Power with AI assistance\n• Manage mandates, invoices and client documents — all in one place\n\nThis is a limited offer for the first 100 CAs only. Secure your spot today.\n\nRegards,\nTeam AuditFlow',
    type: 'referral' });
  res.json({ ok: true, referral_link: referralLink });
});

// ── CA PUBLIC PROFILE ─────────────────────────────────────────────────────────
app.get('/api/profile/ca/:icai_no', function(req, res) {
  const ca = dbFind('users', { role: 'ca' }).find(function(u) { return u.icai_no === req.params.icai_no; });
  if (!ca) return res.status(404).json({ error: 'CA not found' });
  const myAudits = dbFind('audits').filter(function(a) { return a.ca_id == ca.id; });
  res.json({
    name: ca.name, icai_no: ca.icai_no, firm_name: ca.firm_name,
    firm_reg_no: ca.firm_reg_no, city: ca.city, phone: ca.phone,
    avg_rating: ca.avg_rating || null, total_ratings: ca.total_ratings || 0,
    total_audits: myAudits.length,
    finalized_audits: myAudits.filter(function(a) { return a.stage === 'finalized'; }).length
  });
});


// ── ROOT → LANDING PAGE ───────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get('/lander', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get('/landing.html', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ── APP (login/dashboard) ─────────────────────────────────────────────────────
app.get('/app', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── CATCH-ALL (serve React SPA) ───────────────────────────────────────────────
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── SEED DEMO ACCOUNTS ────────────────────────────────────────────────────────
async function seedDemo() {
  const demos = [
    { name: 'Demo Banker', email: 'banker@demo.com', role: 'banker', password: 'demo1234' },
    { name: 'Demo CA', email: 'ca@demo.com', role: 'ca', password: 'demo1234' },
    { name: 'Demo Borrower', email: 'borrower@demo.com', role: 'borrower', password: 'demo1234' }
  ];
  for (const d of demos) {
    if (!dbFindOne('users', { email: d.email })) {
      const hash = await bcrypt.hash(d.password, 10);
      dbInsert('users', { name: d.name, email: d.email, password: hash, role: d.role,
        created_at: new Date().toISOString() });
      console.log('Seeded demo:', d.email);
    }
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
seedDemo().then(() => {
  app.listen(PORT, () => console.log('AuditFlow running on port', PORT));
});
