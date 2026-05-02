const express = require('express');
const router = express.Router();
const { saveProfile, getProfile } = require('../controllers/profileController');
const { authenticate } = require('../middleware/authMiddleware');

router.post('/', authenticate, saveProfile);
router.get('/', authenticate, getProfile);

module.exports = router;