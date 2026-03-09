#!/usr/bin/env node

// Bounty payout script for Archon 4tress.org promo
// Usage: node ./scripts/bounty-payout.js <name> <DID> [round]
//
// Checks for duplicate payouts within the round, zaps 100 sats, verifies payment.
// Round defaults to 1. Same agent can claim once per round.
//
// Requires env: ARCHON_GATEKEEPER_URL, ARCHON_PASSPHRASE

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BOUNTY_AMOUNT = 100;
const MAX_BOUNTIES = 100;
const LEDGER_PATH = path.join(__dirname, 'bounty-ledger.json');

function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  }
  return { payouts: [], totalPaid: 0 };
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
}

function km(cmd) {
  return execSync(`keymaster ${cmd}`, { encoding: 'utf8', timeout: 30000 }).trim();
}

function main() {
  const [,, name, did, roundArg] = process.argv;
  const round = parseInt(roundArg, 10) || 1;

  if (!name || !did) {
    console.error('Usage: node ./scripts/bounty-payout.js <name> <DID> [round]');
    process.exit(1);
  }

  if (!did.startsWith('did:cid:')) {
    console.error(`Error: Invalid DID format: ${did}`);
    process.exit(1);
  }

  if (!process.env.ARCHON_PASSPHRASE) {
    console.error('Error: ARCHON_PASSPHRASE not set. Source ~/.keymaster/aragorn.env');
    process.exit(1);
  }

  const ledger = loadLedger();

  const roundPayouts = ledger.payouts.filter(p => p.round === round);

  // Check max bounties for this round
  if (roundPayouts.length >= MAX_BOUNTIES) {
    console.error(`Error: All ${MAX_BOUNTIES} bounties for round ${round} have been claimed.`);
    process.exit(1);
  }

  // Check duplicate DID within round
  const existingDid = roundPayouts.find(p => p.did === did);
  if (existingDid) {
    console.error(`Error: DID already claimed round ${round} bounty on ${existingDid.date} (name: ${existingDid.name})`);
    process.exit(1);
  }

  // Check duplicate name within round
  const existingName = roundPayouts.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existingName) {
    console.error(`Error: Name "${name}" already claimed round ${round} bounty on ${existingName.date} (DID: ${existingName.did})`);
    process.exit(1);
  }

  // Zap
  const bountyNum = roundPayouts.length + 1;
  console.log(`Round ${round}, bounty #${bountyNum}: zapping ${BOUNTY_AMOUNT} sats to ${name} (${did})...`);
  let zapResult;
  try {
    zapResult = km(`lightning-zap ${did} ${BOUNTY_AMOUNT} "4tress.org r${round} bounty #${bountyNum} for ${name}"`);
    console.log(zapResult);
  } catch (e) {
    console.error(`Error: Zap failed.`);
    console.error(e.stderr || e.message);
    process.exit(1);
  }

  // Check for failure in output (lightning-zap may exit 0 on failure)
  if (!zapResult || /fail|error/i.test(zapResult)) {
    console.error(`Error: Zap failed: ${zapResult}`);
    process.exit(1);
  }

  // Extract payment hash and check status
  let paymentHash = null;
  let checkResult = null;
  try {
    const parsed = JSON.parse(zapResult);
    paymentHash = parsed.payment_hash || parsed.paymentHash || null;
  } catch {
    // zapResult may not be JSON, try to extract hash from text
    const match = zapResult.match(/[a-f0-9]{64}/);
    if (match) paymentHash = match[0];
  }

  if (paymentHash) {
    try {
      const raw = km(`lightning-check ${paymentHash}`);
      console.log(`Payment check: ${raw}`);
      checkResult = JSON.parse(raw);
    } catch {
      checkResult = 'check failed';
    }
  }

  // Record payout
  const entry = {
    round,
    number: bountyNum,
    name,
    did,
    amount: BOUNTY_AMOUNT,
    date: new Date().toISOString(),
    paymentHash,
    checkResult: checkResult || null,
  };
  ledger.payouts.push(entry);
  ledger.totalPaid += BOUNTY_AMOUNT;
  saveLedger(ledger);

  // Auto-commit ledger to git and push to bounty-ledger branch
  try {
    const repoRoot = path.resolve(__dirname, '..');
    const git = (cmd) => execSync(`git -C ${repoRoot} ${cmd}`, { encoding: 'utf8', timeout: 30000 }).trim();
    git('add scripts/bounty-ledger.json');
    git(`commit -m "bounty r${round}#${bountyNum}: ${name}"`);
    git('push origin HEAD:bounty-ledger');
    console.log('Ledger committed and pushed to origin/bounty-ledger.');
  } catch (e) {
    console.warn('Warning: git commit/push failed. Ledger saved locally.');
    console.warn(e.message);
  }

  console.log(`\nRound ${round} bounty #${entry.number} paid! (${roundPayouts.length + 1}/${MAX_BOUNTIES} claimed this round, ${ledger.totalPaid} sats total all rounds)`);
}

main();
