import { Router } from 'express';
import { requireAuth, attachAccessState } from '../middleware/auth.js';
import { generateApiKey, hashApiKey } from '../services/apiKey.js';
import { createApiKey, getApiKey, deleteApiKey } from '../db/database.js';

const router = Router();

router.use(requireAuth, attachAccessState);

router.get('/', async (req, res) => {
  try {
    const key = getApiKey(req.session.user.id);
    if (!key) {
      return res.json({ hasKey: false });
    }
    res.json({
      hasKey: true,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    createApiKey(req.session.user.id, keyHash);
    res.status(201).json({
      rawKey,
      message: 'Save this key — it will not be shown again.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/', async (req, res) => {
  try {
    deleteApiKey(req.session.user.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;