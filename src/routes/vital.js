const express = require('express');

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', scope: 'vital' });
});

router.get('/appointments', (req, res) => {
  res.status(200).json({ items: [], note: 'scaffold; appointment logic pending' });
});

router.get('/telemedicine', (req, res) => {
  res.status(200).json({ items: [], note: 'scaffold; telemedicine logic pending' });
});

module.exports = router;
