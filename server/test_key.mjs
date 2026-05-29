import crypto from 'crypto';
import { createApiKey, validateApiKeyForUser } from './db/database.js';

// Generate a test key
const rawKey = crypto.randomBytes(32).toString('hex');
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

console.log('Raw key:', rawKey);
console.log('Key hash:', keyHash);

// User ID 3 is apitest@test.com
createApiKey(3, keyHash);
console.log('Key inserted into database');

// Now verify
const found = validateApiKeyForUser(keyHash);
console.log('Found userId:', found);

// Test with wrong hash
const wrongFound = validateApiKeyForUser('wrong');
console.log('Wrong hash returns:', wrongFound);

// Try with hash from wrong string
const testHash = crypto.createHash('sha256').update('test').digest('hex');
console.log('Hash of "test":', testHash);
const testFound = validateApiKeyForUser(testHash);
console.log('Hash of "test" returns:', testFound);