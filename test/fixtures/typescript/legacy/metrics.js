// Legacy metrics endpoints, still CommonJS.

const express = require('express');
const { formatDuration } = require('./format.js');

const MAX_SAMPLES = 100;

/** Look up the account behind a widget owner. */
async function loadAccount(db, id) {
  return db.query('SELECT id, email FROM accounts WHERE id = ?', [id]);
}

/** Fixed size window of request durations. */
class SampleWindow extends Array {
  push(value) {
    if (this.length >= MAX_SAMPLES) this.shift();
    return super.push(value);
  }

  summary() {
    return formatDuration(this.length);
  }
}

const router = express.Router();

router.get('/metrics', (req, res) => {
  res.json({ samples: new SampleWindow().summary() });
});

module.exports = { MAX_SAMPLES, loadAccount, SampleWindow, router };
