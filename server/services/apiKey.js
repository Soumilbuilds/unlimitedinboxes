import crypto from 'crypto';
import { getUserById, validateApiKeyForUser, touchApiKey } from '../db/database.js';

export function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export async function validateApiKey(rawKey) {
  const keyHash = hashApiKey(rawKey);
  const userId = validateApiKeyForUser(keyHash);
  if (!userId) return null;
  touchApiKey(userId);
  return getUserById(userId);
}