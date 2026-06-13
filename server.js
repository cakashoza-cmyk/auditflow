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
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.SENDER_EMAIL || 'cakashoza@gmail.com';
  if (!apiKey) { console.log('  EMAIL SKIPPED (no BREVO_API_KEY)'); return; }
  const payload = JSON.stringify({
    sender: { name: 'AuditFlow', email: senderEmail },
    to: [{ email: to, name: toName || to }],
    subject: subject,
    textContent: body
  });
  const options = {
    hostname: 'api.brevo.com',
    path: '/v3/smtp/email',
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
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
          firm_reg_no, bank_name, branch, gstin, pan, constitution } = req.body;
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
    is_temp_password: false });
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI analysis not configured. Add GEMINI_API_KEY in Railway Variables.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  const docType = req.body.doc_type || 'stock_statement';
  const docConfig = AI_DOC_PROMPTS[docType] || AI_DOC_PROMPTS.stock_statement;

  const base64 = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype || 'application/pdf';
  const prompt = docConfig.prompt(audit) + '\n\nRULES: Return ONLY the JSON object. No markdown. No code blocks. Pure JSON starting with { and ending with }.';

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mediaType, data: base64 } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
  });

  const path2 = '/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: path2,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
  };

  const request = https.request(options, function(r) {
    let data = '';
    r.on('data', function(chunk) { data += chunk; });
    r.on('end', function() {
      try {
        const resp = JSON.parse(data);
        if (resp.error) return res.status(500).json({ error: 'AI error: ' + resp.error.message });
        const text = (resp.candidates?.[0]?.content?.parts?.[0]?.text) || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return res.status(500).json({ error: 'AI returned unexpected format', raw: text.slice(0,300) });
        const extracted = JSON.parse(jsonMatch[0]);
        addTimeline(req.params.id, 'AI analysed ' + docConfig.label + ' — report fields pre-filled', req.user.name);
        res.json({ ok: true, data: extracted });
      } catch(e) {
        res.status(500).json({ error: 'Failed to parse AI response: ' + e.message });
      }
    });
  });
  request.on('error', function(e) { res.status(500).json({ error: 'AI request failed: ' + e.message }); });
  request.write(payload);
  request.end();
});

// ── DOCUMENTS ────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: function(_, __, cb) { cb(null, UPLOADS); },
    filename: function(_, f, cb) { cb(null, Date.now() + '-' + f.originalname); }
  }),
  limits: { fileSize: 10*1024*1024 }
});

app.post('/api/audits/:id/documents/upload', auth(), upload.single('file'), function(req, res) {
  const { doc_id } = req.body;
  if (!req.file) return res.status(400).json({ error:'No file' });
  const filePath = '/uploads/' + req.file.filename;
  dbUpdate('documents', { id:parseInt(doc_id), audit_id:req.params.id }, { status:'uploaded', file_path:filePath, uploaded_by:req.user.id });
  addTimeline(req.params.id, 'Document uploaded: ' + req.file.originalname, req.user.name);
  res.json({ path:filePath });
});

app.put('/api/audits/:id/documents/:docId', auth(), function(req, res) {
  const { status, source } = req.body;
  const u = {};
  if (status) u.status = status;
  if (source) u.source = source;
  dbUpdate('documents', { id:parseInt(req.params.docId), audit_id:req.params.id }, u);
  res.json({ ok:true });
});

app.post('/api/audits/:id/documents', auth(['banker','admin']), function(req, res) {
  const { name, source } = req.body;
  res.json(dbInsert('documents', { audit_id:req.params.id, name, source:source||'Manual', status:'pending', file_path:null, uploaded_by:null }));
});

// ── AA CONSENT ───────────────────────────────────────────────────────────
app.post('/api/audits/:id/consent', auth(['borrower','banker','admin','ca']), function(req, res) {
  const { data_types } = req.body;
  const expires = new Date(); expires.setDate(expires.getDate()+30);
  const consent = dbInsert('aa_consents', { audit_id:req.params.id,
    borrower_id:req.user.role==='borrower'?req.user.id:null,
    data_types:JSON.stringify(data_types||['gst','itr','bank_statement']),
    status:'pending', expires_at:expires.toISOString().split('T')[0] });
  addTimeline(req.params.id, 'AA consent request sent to borrower', req.user.name);
  res.json(consent);
});

app.put('/api/aa-consents/:id/approve', auth(['borrower','admin']), function(req, res) {
  const consent = dbFindOne('aa_consents', { id:parseInt(req.params.id) });
  if (!consent) return res.status(404).json({ error:'Not found' });
  dbUpdate('aa_consents', { id:parseInt(req.params.id) }, { status:'approved' });
  const types = JSON.parse(consent.data_types||'[]');
  const nameMap = { gst:'GST', itr:'ITR', bank_statement:'Bank Statement' };
  dbFind('documents', { audit_id:consent.audit_id })
    .filter(function(d) {
      return types.some(function(t) {
        return d.name.toLowerCase().includes((nameMap[t]||t).toLowerCase());
      }) && d.status === 'aa_pending';
    })
    .forEach(function(d) { dbUpdate('documents', { id:d.id }, { status:'aa_fetched' }); });
  addTimeline(consent.audit_id, 'AA consent approved. ' + types.length + ' data type(s) auto-fetched.', 'Borrower');
  res.json({ ok:true });
});

// ── REPORTS ──────────────────────────────────────────────────────────────
app.get('/api/audits/:id/report', auth(), function(req, res) {
  let r = dbFindOne('reports', { audit_id:req.params.id });
  if (!r) r = dbInsert('reports', { audit_id:req.params.id, data:'{}', status:'draft' });
  res.json(Object.assign({}, r, { data:JSON.parse(r.data||'{}') }));
});

app.put('/api/audits/:id/report', auth(['ca','admin']), function(req, res) {
  const { data, status } = req.body;
  let inadequate_dp = false;
  let dp_calculated = null;
  try {
    const d = data || {};
    const stocks = d.stocks || [];
    const phys_total = parseFloat(((stocks[5]||{}).physical||'0').toString().replace(/[^0-9.]/g,'')||0);
    const debtors    = parseFloat((d.dp_debtors||'0').toString().replace(/[^0-9.]/g,'')||0);
    const creditors  = parseFloat((d.total_creditors||'0').toString().replace(/[^0-9.]/g,'')||0);
    const outstanding= parseFloat((d.outstanding||'0').toString().replace(/[^0-9.]/g,'')||0);
    if (phys_total > 0 || debtors > 0) {
      dp_calculated = phys_total + debtors - creditors;
      inadequate_dp = outstanding > 0 && dp_calculated < outstanding;
    }
  } catch(e) {}
  const upd = Object.assign({ data:JSON.stringify(data||{}) }, status ? { status } : {});
  const existing = dbFindOne('reports', { audit_id:req.params.id });
  if (existing) dbUpdate('reports', { audit_id:req.params.id }, upd);
  else dbInsert('reports', Object.assign({ audit_id:req.params.id }, upd));
  const auditUpd = status === 'finalized' ? { stage:'finalized' } : {};
  if (dp_calculated !== null) { auditUpd.inadequate_dp = inadequate_dp; auditUpd.dp_calculated = dp_calculated; }
  if (Object.keys(auditUpd).length) dbUpdate('audits', { id:req.params.id }, auditUpd);
  if (inadequate_dp) addTimeline(req.params.id, 'INADEQUATE DP: Calculated DP is less than outstanding balance', req.user.name);
  if (status === 'finalized') addTimeline(req.params.id, 'Report finalized and submitted to bank', req.user.name);
  else addTimeline(req.params.id, 'Report draft saved', req.user.name);
  res.json({ ok:true, inadequate_dp, dp_calculated });
});

// ── INVOICES ─────────────────────────────────────────────────────────────
app.get('/api/invoices', auth(['ca','banker','admin']), function(req, res) {
  let invoices;
  if (req.user.role === 'ca') {
    invoices = dbFind('invoices', { ca_id:req.user.id });
  } else {
    const ids = dbFind('audits', { banker_id:req.user.id }).map(function(a){ return a.id; });
    invoices = dbFind('invoices').filter(function(i){ return ids.includes(i.audit_id); });
  }
  res.json(invoices.map(function(i) {
    const a = dbFindOne('audits', { id:i.audit_id })||{};
    return Object.assign({}, i, { borrower_name:a.borrower_name, bank_name:a.bank_name, branch:a.branch });
  }).sort(function(a,b){ return new Date(b.raised_at||b.created_at)-new Date(a.raised_at||a.created_at); }));
});

app.post('/api/audits/:id/invoice', auth(['ca','admin']), function(req, res) {
  if (dbFindOne('invoices', { audit_id:req.params.id }))
    return res.status(400).json({ error:'Invoice already raised' });
  const audit = dbFindOne('audits', { id:req.params.id });
  if (!audit) return res.status(404).json({ error:'Not found' });
  const amount = parseFloat(audit.fee)||0;
  const gst = Math.round(amount*0.18);
  const total = amount+gst;
  const inv = dbInsert('invoices', { id:req.params.id.replace('AF-','INV-'), audit_id:req.params.id,
    ca_id:req.user.id, amount, gst, total, status:'sent',
    raised_at:new Date().toISOString(), paid_at:null });
  dbUpdate('audits', { id:req.params.id }, { pay_status:'pending' });
  addTimeline(req.params.id, 'Invoice ' + inv.id + ' raised', req.user.name);
  res.json(inv);
});

app.put('/api/invoices/:id/pay', auth(['banker','admin']), function(req, res) {
  const inv = dbFindOne('invoices', { id:req.params.id });
  if (!inv) return res.status(404).json({ error:'Not found' });
  const today = new Date().toISOString().split('T')[0];
  dbUpdate('invoices', { id:req.params.id }, { status:'paid', paid_at:today });
  dbUpdate('audits', { id:inv.audit_id }, { pay_status:'paid', pay_date:today });
  addTimeline(inv.audit_id, 'Payment received', req.user.name);
  res.json({ ok:true });
});

// ── ANALYTICS ────────────────────────────────────────────────────────────
app.get('/api/analytics', auth(['banker','admin']), function(req, res) {
  const audits = dbFind('audits', { banker_id:req.user.id });
  const byStage = {};
  for (const a of audits) byStage[a.stage] = (byStage[a.stage]||0)+1;
  const today = new Date().toISOString().split('T')[0];
  const overdue  = audits.filter(function(a){ return a.deadline && a.deadline < today && a.stage !== 'finalized'; }).length;
  const inadDP   = audits.filter(function(a){ return a.inadequate_dp; }).length;
  const ids = audits.map(function(a){ return a.id; });
  const pendingFee = dbFind('invoices').filter(function(i){ return ids.includes(i.audit_id) && i.status === 'sent'; }).reduce(function(s,i){ return s+(i.total||0); }, 0);
  res.json({ total:audits.length, byStage:Object.entries(byStage).map(function([stage,c]){ return {stage,c}; }), overdue, inadDP, pendingFee });
});


// -- PASSWORD RESET
app.post('/api/auth/forgot-password', async function(req, res) {
  const { email } = req.body;
  const user = dbFindOne('users', { email });
  if (!user) return res.status(400).json({ error: 'No account found with that email' });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  dbUpdate('users', { id: user.id }, { reset_otp: otp, reset_otp_expires: expires });
  sendEmail({
    to: email, toName: user.name,
    subject: '[AuditFlow] Password Reset OTP',
    body: 'Dear ' + user.name + ',\n\nYour OTP to reset your AuditFlow password is:\n\n  ' + otp + '\n\nThis OTP is valid for 15 minutes. Do not share it with anyone.\n\nIf you did not request this, ignore this email.\n\nTeam AuditFlow',
    type: 'otp'
  });
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', async function(req, res) {
  const { email, otp, newPassword } = req.body;
  const user = dbFindOne('users', { email });
  if (!user) return res.status(400).json({ error: 'No account found' });
  if (!user.reset_otp || user.reset_otp !== otp)
    return res.status(400).json({ error: 'Invalid OTP' });
  if (new Date() > new Date(user.reset_otp_expires))
    return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
  const hash = await bcrypt.hash(newPassword, 10);
  dbUpdate('users', { id: user.id }, { password: hash, reset_otp: null, reset_otp_expires: null, is_temp_password: false });
  res.json({ ok: true });
});

// ── DELETE AUDIT (Banker/Admin only) ────────────────────────────────────────
// Allowed only if stage is 'initiated' or 'docs_requested' — CA hasn't done
// substantive work yet. Beyond that the audit is a compliance record.
app.delete('/api/audits/:id', auth(['banker','admin']), function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const lockedStages = ['visit_scheduled','visit_done','draft_ready','finalized'];
  if (lockedStages.includes(audit.stage)) {
    return res.status(403).json({ error: 'Cannot cancel audit after site visit has been scheduled. Contact your CA directly.' });
  }
  // Notify CA if assigned
  const ca = audit.ca_id ? dbFindOne('users', { id: audit.ca_id }) : null;
  if (ca) {
    sendEmail({ to: ca.email, toName: ca.name,
      subject: '[AuditFlow] Audit cancelled: ' + audit.borrower_name,
      body: 'Dear ' + ca.name + ',\n\nThe stock audit for ' + audit.borrower_name + ' (ID: ' + audit.id + ') has been cancelled by ' + req.user.name + ' (' + (audit.bank_name||'Bank') + ').\n\nNo further action is required from your side for this audit.\n\nRegards,\nTeam AuditFlow',
      type: 'audit_cancelled_ca' });
  }
  // Notify borrower if registered
  const borrower = audit.borrower_id ? dbFindOne('users', { id: audit.borrower_id }) : null;
  const borrowerEmail = (borrower && borrower.email) || audit.borrower_email;
  if (borrowerEmail) {
    sendEmail({ to: borrowerEmail, toName: audit.borrower_name,
      subject: '[AuditFlow] Your stock audit has been cancelled',
      body: 'Dear ' + audit.borrower_name + ',\n\nYour stock audit (ID: ' + audit.id + ') initiated by ' + (audit.bank_name||'your bank') + ' has been cancelled.\n\nIf you believe this is an error, please contact your bank directly.\n\nRegards,\nTeam AuditFlow',
      type: 'audit_cancelled_borrower' });
  }
  // Soft-delete: mark as cancelled (preserves record, removes from active views)
  dbUpdate('audits', { id: req.params.id }, { stage: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: req.user.name });
  addTimeline(req.params.id, 'Audit cancelled by ' + req.user.name, req.user.name);
  res.json({ ok: true });
});

// ── DELETE DOCUMENT (uploader, CA, borrower, banker — not after finalized) ──
// A CA or borrower can delete a wrongly uploaded file to re-upload the correct one.
// Banker can remove a document requirement they added by mistake.
// Nobody can delete documents from a finalized audit.
app.delete('/api/audits/:id/documents/:docId', auth(), function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.stage === 'finalized') {
    return res.status(403).json({ error: 'Cannot delete documents from a finalized audit.' });
  }
  const doc = dbFindOne('documents', { id: parseInt(req.params.docId), audit_id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  // Only the uploader, the banker who owns the audit, or admin can delete
  const isUploader  = doc.uploaded_by && doc.uploaded_by === req.user.id;
  const isAuditOwner = audit.banker_id && audit.banker_id === req.user.id;
  const isAdmin     = req.user.role === 'admin';
  const isBanker    = req.user.role === 'banker';
  if (!isUploader && !isAuditOwner && !isAdmin && !isBanker) {
    return res.status(403).json({ error: 'You can only delete documents you uploaded.' });
  }
  // Delete physical file from disk
  if (doc.file_path) {
    const fullPath = path.join(UPLOADS, path.basename(doc.file_path));
    try { fs.unlinkSync(fullPath); } catch(e) { /* file may already be gone */ }
  }
  // If it was a banker-created doc requirement, remove it entirely
  // If it was a system doc with an uploaded file, just reset it to pending
  if (doc.source === 'Manual' && isBanker) {
    const db = loadDB();
    db.documents = db.documents.filter(function(d) { return !(d.id === parseInt(req.params.docId) && d.audit_id === req.params.id); });
    saveDB(db);
    addTimeline(req.params.id, 'Document requirement removed: ' + doc.name, req.user.name);
  } else {
    dbUpdate('documents', { id: parseInt(req.params.docId), audit_id: req.params.id },
      { status: 'pending', file_path: null, uploaded_by: null });
    addTimeline(req.params.id, 'Document deleted and reset to pending: ' + doc.name, req.user.name);
  }
  res.json({ ok: true });
});

// ── RATE CA (Banker only, after finalized) ───────────────────────────────────
app.post('/api/audits/:id/rate', auth(['banker','admin']), function(req, res) {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (audit.stage !== 'finalized') return res.status(400).json({ error: 'Can only rate after audit is finalized' });
  dbUpdate('audits', { id: req.params.id }, { ca_rating: rating, ca_rating_comment: comment||'', ca_rated_by: req.user.name, ca_rated_at: new Date().toISOString() });
  addTimeline(req.params.id, 'CA rated ' + rating + '/5 by ' + req.user.name + (comment ? ': "' + comment + '"' : ''), req.user.name);
  res.json({ ok: true });
});

// ── SET DRIVE LINK (Banker or CA) ────────────────────────────────────────────
app.put('/api/audits/:id/drive-link', auth(['banker','admin','ca']), function(req, res) {
  const { drive_link } = req.body;
  if (!dbFindOne('audits', { id: req.params.id })) return res.status(404).json({ error: 'Not found' });
  dbUpdate('audits', { id: req.params.id }, { drive_link: drive_link||null });
  addTimeline(req.params.id, drive_link ? 'Google Drive folder linked for documents' : 'Drive link removed', req.user.name);
  res.json({ ok: true });
});

// ── CA PUBLIC PROFILE (no auth required) ─────────────────────────────────────
app.get('/api/profile/ca/:icaiNo', function(req, res) {
  const ca = dbFind('users', { role:'ca' }).find(function(u){ return u.icai_no === req.params.icaiNo; });
  if (!ca) return res.status(404).json({ error: 'CA not found' });
  const allAudits = dbFind('audits', { ca_id: ca.id });
  const completed = allAudits.filter(function(a){ return a.stage === 'finalized'; });
  const rated = completed.filter(function(a){ return a.ca_rating; });
  const avgRating = rated.length ? (rated.reduce(function(s,a){ return s+(a.ca_rating||0); },0)/rated.length).toFixed(1) : null;
  const totalExposure = completed.reduce(function(s,a){ return s+(parseFloat(a.exposure)||0); },0);
  const onTime = completed.filter(function(a){ return a.deadline && a.updated_at && a.updated_at.split('T')[0] <= a.deadline; }).length;
  const onTimeRate = completed.length ? Math.round(onTime/completed.length*100) : null;
  const banks = [...new Set(allAudits.map(function(a){ return a.bank_name; }).filter(Boolean))];
  const sectors = allAudits.reduce(function(acc,a){ if(a.constitution){acc[a.constitution]=(acc[a.constitution]||0)+1;} return acc; },{});
  const topSectors = Object.entries(sectors).sort(function(a,b){return b[1]-a[1];}).slice(0,3).map(function(e){return e[0];});
  const featured = completed.filter(function(a){ return a.ca_rating>=4; }).sort(function(a,b){ return (b.exposure||0)-(a.exposure||0); }).slice(0,5).map(function(a){
    return { bank: a.bank_name, sector: a.constitution||'—', exposure: a.exposure, rating: a.ca_rating, year: (a.ca_rated_at||a.updated_at||'').slice(0,4) };
  });
  res.json({
    name: ca.name, icai_no: ca.icai_no, firm_name: ca.firm_name||null, firm_reg_no: ca.firm_reg_no||null,
    city: ca.city||null, phone: ca.phone||null, email: ca.email,
    total_audits: allAudits.length, completed_audits: completed.length,
    avg_rating: avgRating ? parseFloat(avgRating) : null, rating_count: rated.length,
    total_exposure_cr: totalExposure ? (totalExposure/1e7).toFixed(1) : null,
    on_time_rate: onTimeRate, banks_worked_with: banks.length, bank_names: banks,
    top_sectors: topSectors, featured_assignments: featured,
    member_since: ca.created_at ? ca.created_at.slice(0,7) : null
  });
});

// ── PUBLIC PROFILE PAGE ───────────────────────────────────────────────────────
app.get('/profile/ca/:icaiNo', function(req, res) {
  const appUrl = process.env.APP_URL || ('http://localhost:' + PORT);
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CA Profile | AuditFlow</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}
.card{max-width:680px;margin:0 auto;background:#fff;border-radius:18px;box-shadow:0 4px 32px rgba(0,0,0,.10);overflow:hidden}
.hdr{background:linear-gradient(135deg,#1d4ed8,#3b82f6);padding:32px 28px;color:#fff}
.name{font-size:26px;font-weight:800;margin-bottom:4px}.sub{font-size:14px;opacity:.85;margin-bottom:2px}
.body{padding:28px}.section{margin-bottom:24px}.sh{font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.stat{background:#f8fafc;border-radius:12px;padding:14px;text-align:center}
.sv{font-size:28px;font-weight:800;color:#1d4ed8}.sl{font-size:11px;color:#6b7280;margin-top:2px}
.stars{color:#f59e0b;font-size:18px}.tag{display:inline-block;background:#eff6ff;color:#1d4ed8;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600;margin:3px 3px 0 0}
.assign{background:#f8fafc;border-radius:10px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.abank{font-weight:700;font-size:13px}.ameta{font-size:12px;color:#6b7280;margin-top:2px}
.arating{color:#f59e0b;font-size:13px;font-weight:700}.cta{text-align:center;padding:20px;background:#f8fafc;border-top:1px solid #e5e7eb}
.btn{display:inline-block;background:#1d4ed8;color:#fff;border-radius:10px;padding:12px 28px;font-weight:700;text-decoration:none;font-size:14px}
.badge{display:inline-flex;align-items:center;gap:4px;background:#dcfce7;color:#16a34a;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700}
.info-row{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px}
.il{color:#6b7280;width:120px;flex-shrink:0}.iv{font-weight:600}
</style></head><body>
<div class="card">
  <div class="hdr">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><div class="name" id="name">Loading…</div><div class="sub" id="firm"></div><div class="sub" id="city"></div></div>
      <div id="badge"></div>
    </div>
  </div>
  <div class="body">
    <div class="section"><div class="sh">Performance Stats</div><div class="stats" id="stats"></div></div>
    <div class="section" id="sec-sectors" style="display:none"><div class="sh">Top Sectors</div><div id="sectors"></div></div>
    <div class="section" id="sec-banks" style="display:none"><div class="sh">Banks Worked With</div><div id="banks"></div></div>
    <div class="section" id="sec-featured" style="display:none"><div class="sh">Featured Assignments</div><div id="featured"></div></div>
    <div class="section"><div class="sh">Contact & Details</div><div id="contact"></div></div>
  </div>
  <div class="cta"><div style="font-size:13px;color:#6b7280;margin-bottom:12px">Verified profile powered by AuditFlow</div>
  <a href="${appUrl}" class="btn">🔗 View on AuditFlow</a></div>
</div>
<script>
fetch('/api/profile/ca/${req.params.icaiNo}').then(r=>r.json()).then(d=>{
  if(d.error){document.getElementById('name').textContent='Profile not found';return;}
  document.getElementById('name').textContent=d.name;
  document.getElementById('firm').textContent=d.firm_name||(d.icai_no?'ICAI: '+d.icai_no:'');
  document.getElementById('city').textContent=d.city||'';
  if(d.avg_rating){document.getElementById('badge').innerHTML='<div class="badge">★ '+d.avg_rating+' / 5</div>';}
  const stars=d.avg_rating?'★'.repeat(Math.round(d.avg_rating))+'☆'.repeat(5-Math.round(d.avg_rating)):'—';
  const stats=[
    {v:d.completed_audits||0,l:'Audits Completed'},{v:d.total_audits||0,l:'Total Assigned'},
    {v:d.avg_rating?'<span class=stars>'+stars+'</span><br><small>'+d.rating_count+' ratings</small>':'No ratings yet',l:'Avg Rating',html:true},
    {v:d.total_exposure_cr?'₹'+d.total_exposure_cr+'Cr':'—',l:'Total Exposure Audited'},
    {v:d.on_time_rate!==null?d.on_time_rate+'%':'—',l:'On-Time Completion'},
    {v:d.banks_worked_with||0,l:'Banks Served'}
  ];
  document.getElementById('stats').innerHTML=stats.map(s=>'<div class=stat><div class=sv>'+(s.html?s.v:s.v)+'</div><div class=sl>'+s.l+'</div></div>').join('');
  if(d.top_sectors&&d.top_sectors.length){document.getElementById('sec-sectors').style.display='';document.getElementById('sectors').innerHTML=d.top_sectors.map(s=>'<span class=tag>'+s+'</span>').join('');}
  if(d.bank_names&&d.bank_names.length){document.getElementById('sec-banks').style.display='';document.getElementById('banks').innerHTML=d.bank_names.map(b=>'<span class=tag>🏦 '+b+'</span>').join('');}
  if(d.featured_assignments&&d.featured_assignments.length){document.getElementById('sec-featured').style.display='';document.getElementById('featured').innerHTML=d.featured_assignments.map(a=>'<div class=assign><div><div class=abank>'+a.bank+'</div><div class=ameta>'+a.sector+(a.exposure?'  ·  ₹'+Number(a.exposure).toLocaleString(\"en-IN\")+' exposure':'')+(a.year?' · '+a.year:'')+'</div></div>'+(a.rating?'<div class=arating>★ '+a.rating+'</div>':'')+'</div>').join('');}
  const rows=[[d.icai_no?'ICAI No.':'','ICAI: '+(d.icai_no||'—')],[d.firm_reg_no?'Firm Reg':'','Firm Reg: '+(d.firm_reg_no||'—')],[d.email?'Email':'',' '+d.email],[d.phone?'Phone':'','📞 '+d.phone],[d.member_since?'Member Since':'','AuditFlow member since '+(d.member_since||'')]].filter(r=>r[0]);
  document.getElementById('contact').innerHTML=rows.map(r=>'<div class=info-row><span class=il>'+r[0]+'</span><span class=iv>'+r[1]+'</span></div>').join('');
}).catch(()=>{document.getElementById('name').textContent='Failed to load profile';});
</script></body></html>`);
});

// ── REFERRAL / INVITE ────────────────────────────────────────────────────────
// Any logged-in user (banker, CA, borrower) can invite anyone by email.
// If the email is new, a user account is created with a temp password.
// If already registered, a "you've been invited to connect" email is sent instead.
app.post('/api/refer', auth(), async function(req, res) {
  const { name, email, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const appUrl = process.env.APP_URL || ('http://localhost:' + PORT);
  const existing = dbFindOne('users', { email });
  if (existing) {
    sendEmail({ to: email, toName: existing.name,
      subject: req.user.name + ' invited you to AuditFlow',
      body: 'Dear ' + existing.name + ',\n\n' + req.user.name + ' has invited you to collaborate on AuditFlow — India\'s stock audit platform.\n\n' + (message ? '"' + message + '"\n\n' : '') + 'Login: ' + appUrl + '\n\nTeam AuditFlow',
      type: 'referral_existing' });
    return res.json({ ok: true, status: 'already_registered' });
  }
  const tempPwd = Math.random().toString(36).slice(2,10);
  const hash = await bcrypt.hash(tempPwd, 10);
  dbInsert('users', { name, email, password: hash, role: 'invited',
    referred_by: req.user.id, referred_by_name: req.user.name,
    is_temp_password: true, created_at: new Date().toISOString() });
  const body = 'Dear ' + name + ',\n\n' + req.user.name + ' has invited you to AuditFlow — the platform that is transforming how stock audits are done in India.\n\n' + (message ? '"' + message + '"\n\n' : '') +
    'Your Login Details:\n' +
    'Email: ' + email + '\n' +
    'Password: ' + tempPwd + ' (temporary — please change after login)\n' +
    'Login: ' + appUrl + '\n\n' +
    'AuditFlow helps you manage stock audits end-to-end — from document upload to final report.\n\n' +
    'Team AuditFlow';
  sendEmail({ to: email, toName: name, subject: req.user.name + ' invited you to AuditFlow', body, type: 'referral_new' });
  res.json({ ok: true, status: 'invited', tempPwd });
});

// ── AI DOC TYPES ─────────────────────────────────────────────────────────────
app.get('/api/ai-doc-types', auth(), function(req, res) {
  res.json(Object.entries(AI_DOC_PROMPTS).map(([key, v]) => ({ key, label: v.label, description: v.description })));
});

// ── AI ANALYZE ───────────────────────────────────────────────────────────────
app.post('/api/audits/:id/ai-analyze', auth(), upload.single('file'), async function(req, res) {
  const audit = dbFindOne('audits', { id: req.params.id });
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const docType = req.body.doc_type;
  if (!AI_DOC_PROMPTS[docType]) return res.status(400).json({ error: 'Unknown doc type' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI not configured (GEMINI_API_KEY missing)' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const cfg = AI_DOC_PROMPTS[docType];
  const base64Data = req.file.buffer.toString('base64');
  const mimeType = req.file.mimetype || 'application/pdf';

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: cfg.prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  });

  const https = require('https');
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };

  const geminiReq = https.request(options, function(geminiRes) {
    let data = '';
    geminiRes.on('data', chunk => data += chunk);
    geminiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // Try to extract JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const extracted = JSON.parse(jsonMatch[0]);
          // Store AI result on the audit
          const audits = dbAll('audits');
          const idx = audits.findIndex(a => a.id === req.params.id);
          if (idx !== -1) {
            if (!audits[idx].ai_results) audits[idx].ai_results = {};
            audits[idx].ai_results[docType] = { result: extracted, analyzed_at: new Date().toISOString(), doc_type: docType, label: cfg.label };
            saveDB();
          }
          res.json({ ok: true, doc_type: docType, label: cfg.label, result: extracted, raw: text });
        } else {
          res.json({ ok: true, doc_type: docType, label: cfg.label, result: null, raw: text });
        }
      } catch(e) {
        res.status(500).json({ error: 'Failed to parse AI response', details: e.message });
      }
    });
  });
  geminiReq.on('error', err => res.status(500).json({ error: 'AI request failed', details: err.message }));
  geminiReq.write(payload);
  geminiReq.end();
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
