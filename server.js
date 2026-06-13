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

app.get('*', function(_, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ── SEED ─────────────────────────────────────────────────────────────────
async function seedDemo() {
  const db = loadDB();
  if (db.users.length > 0) return;
  console.log('Seeding demo data...');
  const hash = await bcrypt.hash('demo1234', 10);
  const banker   = dbInsert('users', { name:'Suresh Mehta',  email:'banker@demo.com',   password:hash, role:'banker',
    bank_name:'Bank of Baroda', branch:'Surat Main', city:'Surat',
    address:'Bank of Baroda, Ring Road, Surat 395002', phone:'9876500001',
    icai_no:null, firm_name:null, firm_reg_no:null, gstin:null, pan:null, constitution:null, is_temp_password:false });
  const ca       = dbInsert('users', { name:'CA Rajiv Shah', email:'ca@demo.com', password:hash, role:'ca',
    bank_name:null, branch:null, city:'Surat', address:'Shah & Associates, Nanpura, Surat 395001',
    phone:'9876543210', icai_no:'112847', firm_name:'Shah & Associates', firm_reg_no:'123456W',
    gstin:'24ABCDE1234F1Z5', pan:null, constitution:null, is_temp_password:false });
  const borrower = dbInsert('users', { name:'Rajan Mehta', email:'borrower@demo.com', password:hash, role:'borrower',
    bank_name:null, branch:null, city:'Surat', address:'Plot 14, Pandesara GIDC, Surat 394221',
    phone:'9876500003', icai_no:null, firm_name:null, firm_reg_no:null,
    gstin:'24AXXXX1234Z1Z5', pan:'AXXXX1234Z', constitution:'Proprietorship', is_temp_password:false });

  const a1 = 'AF-2024-0341';
  dbInsert('audits',{ id:a1, borrower_id:borrower.id, banker_id:banker.id, ca_id:ca.id, ca_email:null,
    borrower_email:'borrower@demo.com', banker_email:null, borrower_name:'Prakash Textiles',
    bank_name:'Bank of Baroda', branch:'Surat Main', exposure:'42 L', constitution:'Proprietorship',
    city:'Surat', cluster:'Textiles', stage:'visit_done', deadline:'2026-06-18', fee:4200,
    pay_status:'not_raised', pay_date:null, notes:null, inadequate_dp:false, dp_calculated:null, initiated_by:'banker' });
  defaultDocs(a1);
  dbFind('documents',{audit_id:a1}).filter(function(d){ return d.source==='Auto-fetch via AA'; })
    .forEach(function(d){ dbUpdate('documents',{id:d.id},{status:'aa_fetched'}); });
  dbFind('documents',{audit_id:a1}).filter(function(d){ return d.name.includes('Stock')||d.name.includes('Sanction'); })
    .forEach(function(d){ dbUpdate('documents',{id:d.id},{status:'uploaded'}); });
  addTimeline(a1,'Audit initiated by Suresh Mehta','Suresh Mehta');
  addTimeline(a1,'Assigned to CA Rajiv Shah (M.No. 112847, FRN: 123456W)','Suresh Mehta');
  addTimeline(a1,'AA consent approved — GST, ITR, Bank Statements auto-fetched','Borrower');
  addTimeline(a1,'Stock statement uploaded by customer','Rajan Mehta');
  addTimeline(a1,'Site visit completed','CA Rajiv Shah');
  dbInsert('reports',{ audit_id:a1,
    data:JSON.stringify({ borrower_name:'Prakash Textiles', constitution:'Proprietorship', city:'Surat',
      bank_name:'Bank of Baroda', branch:'Surat Main', exposure:'4200000', cluster:'Textiles',
      outstanding:'3800000', dp_debtors:'800000', total_creditors:'200000',
      stocks:[{},{},{},{},{},{ books:'4200000', physical:'4100000', diff:'100000' }] }),
    status:'draft' });
  dbInsert('aa_consents',{ audit_id:a1, borrower_id:borrower.id,
    data_types:JSON.stringify(['gst','itr','bank_statement']), status:'approved', expires_at:'2026-07-11' });

  const a2 = 'AF-2024-0338';
  dbInsert('audits',{ id:a2, borrower_id:null, banker_id:banker.id, ca_id:ca.id, ca_email:null,
    borrower_email:'krishna@demo.com', banker_email:null, borrower_name:'Krishna Auto Parts LLP',
    bank_name:'HDFC Bank', branch:'Ahmedabad Industrial', exposure:'85 L', constitution:'LLP',
    city:'Ahmedabad', cluster:'Auto Components', stage:'draft_ready', deadline:'2026-06-16', fee:7500,
    pay_status:'not_raised', pay_date:null, notes:null, inadequate_dp:true, dp_calculated:6800000, initiated_by:'banker' });
  defaultDocs(a2);
  dbFind('documents',{audit_id:a2})
    .filter(function(d){ return d.source==='Auto-fetch via AA'||d.name.includes('Stock')||d.name.includes('Sanction')||d.name.includes('Debtor'); })
    .forEach(function(d){ dbUpdate('documents',{id:d.id},{status:d.source==='Auto-fetch via AA'?'aa_fetched':'uploaded'}); });
  addTimeline(a2,'Audit initiated','Suresh Mehta');
  addTimeline(a2,'All documents submitted','System');
  addTimeline(a2,'Site visit completed','CA Rajiv Shah');
  addTimeline(a2,'INADEQUATE DP: Calculated DP Rs.68,00,000 is less than outstanding Rs.82,00,000','CA Rajiv Shah');
  addTimeline(a2,'Draft report prepared — pending final review','CA Rajiv Shah');

  const a3 = 'AF-2024-0347';
  dbInsert('audits',{ id:a3, borrower_id:null, banker_id:banker.id, ca_id:ca.id, ca_email:null,
    borrower_email:'nikhil@demo.com', banker_email:null, borrower_name:'Nikhil Cold Storage',
    bank_name:'Union Bank of India', branch:'Anand', exposure:'2.1 Cr', constitution:'Proprietorship',
    city:'Anand', cluster:'Agro Processing', stage:'initiated', deadline:'2026-06-27', fee:14000,
    pay_status:'not_raised', pay_date:null, notes:null, inadequate_dp:false, dp_calculated:null, initiated_by:'banker' });
  defaultDocs(a3);
  addTimeline(a3,'Audit initiated by Suresh Mehta','Suresh Mehta');
  addTimeline(a3,'Welcome email sent to borrower','System');

  console.log('Demo data ready.');
  console.log('  banker@demo.com / ca@demo.com / borrower@demo.com  (password: demo1234)');
}

seedDemo().then(function() {
  app.listen(PORT, function() {
    console.log('AuditFlow v2 running at http://localhost:' + PORT);
  });
});
