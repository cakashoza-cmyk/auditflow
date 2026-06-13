# AuditFlow — Setup Guide

## What is this?
A full working web platform for stock audits — three separate portals for CAs, Bankers, and Borrowers, with a real database, RBI report format, AA consent flow, document tracking, and invoice management.

---

## Step 1: Install Node.js (one-time setup)

1. Go to **https://nodejs.org**
2. Click the big green **LTS** button to download
3. Run the installer — keep all defaults, click Next
4. Restart your computer once done

---

## Step 2: Run the platform

Double-click **`start.bat`** in this folder.

It will:
- Install all required packages (first time only, takes ~1 minute)
- Start the server
- Tell you to open `http://localhost:3000` in your browser

---

## Step 3: Use the platform

Open **http://localhost:3000** in Chrome or Edge.

### Demo accounts (password: `demo1234`)
| Role | Email |
|------|-------|
| Banker | banker@demo.com |
| CA | ca@demo.com |
| Borrower | borrower@demo.com |

The demo comes with 3 pre-loaded audits at different stages.

---

## What each portal does

### Banker Portal
- View your full audit portfolio with live status
- Initiate a new stock audit (fill borrower details, assign CA, set fee)
- See which audits are overdue or need action
- Mark invoices as paid

### CA Portal
- Dashboard showing all assigned audits, urgency, fee receivable
- Click any audit to open the detail panel:
  - **Workflow tab** — advance through 7 stages, view activity timeline
  - **Documents tab** — see which docs are auto-fetched vs pending, upload files
  - **AA Consent tab** — send consent request to borrower, track approval
  - **Invoice tab** — raise invoice to bank, track payment
- Fill the full **RBI Stock Audit Report** (Section 1–7) directly in the platform
- View all invoices and payment status

### Borrower Portal
- See your active audits and their progress
- Upload documents
- Approve AA consent request (gives CA access to your GST, ITR, bank statements)

---

## Your data
All data is stored in `auditflow.db` in this folder — a single SQLite file. No internet connection needed, no external database, no cloud. Everything stays on your machine.

---

## To stop the server
Press **Ctrl+C** in the terminal window, or just close it.

## To restart
Double-click `start.bat` again.
