const express = require('express');
const router = express.Router();
const { saveScan, getHistory } = require('../controllers/historyController');
const { authenticate } = require('../middleware/authMiddleware');

router.post('/', authenticate, saveScan);
router.get('/', authenticate, getHistory);

module.exports = router;