import crypto from 'crypto';
import { getUserById, getApiKeyByHash, touchApiKey } from '../db/database.js';

export function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export async function validateApiKey(rawKey) {
  const keyHash = hashApiKey(rawKey);
  const keyRecord = getApiKeyByHash(keyHash);
  if (!keyRecord || !keyRecord.user_id) return null;
  touchApiKey(keyRecord.id);
  return getUserById(keyRecord.user_id);
}