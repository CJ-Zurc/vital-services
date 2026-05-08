const express = require('express');

const router = express.Router();

router.get('/users/:user_id/roles', (req, res) => {
  res.status(200).json({
    system: process.env.AUTH_SYSTEM_SLUG || 'vital',
    user_id: req.params.user_id,
    roles: [],
  });
});

module.exports = router;
