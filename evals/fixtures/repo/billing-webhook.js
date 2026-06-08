// billing-webhook.js — receives paid-invoice notifications from the billing provider.
const express = require("express");

const router = express.Router();

// POST /webhooks/billing : record the payment when an invoice is marked paid.
router.post("/webhooks/billing", express.json(), (req, res) => {
  const invoice = req.body.data.object;
  const cents = Math.round(parseFloat(invoice.amount) * 100);
  recordPayment(invoice.customer, cents);
  res.json({ ok: true });
});

// Add the payment to the in-memory ledger, keyed by customer id.
function recordPayment(customerId, cents) {
  ledger[customerId] = (ledger[customerId] || 0) + cents;
}

module.exports = router;
