import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeImplementationText } from '../routes/orders.js';

const IMPLEMENTATION_TERMS = /shared mailbox|powershell|puppeteer|playwright|\bgraph\b|\bbrowser\b|chromium|chrome devtools|\bcdp\b|websocket|externaldirectoryobjectid|external directory object id|waiting for selector|protocol error|target closed/i;

test('customer order logs hide mailbox implementation details', () => {
 const examples = [
 'STEP 12: Create remaining 99 shared mailboxes',
 'Exchange Online PowerShell mailbox creation failed: spawn pwsh ENOENT',
 'Microsoft Graph admin client ready',
 'Puppeteer browser session failed: Target closed',
 'Browser: launch incognito and login to Microsoft 365',
 'Preflight failed: Waiting for selector `button[data-test="create"]` failed: Waiting failed: 60000ms exceeded',
 'Required field ExternalDirectoryObjectId is missing from Graph response',
 'Chrome DevTools WebSocket disconnected',
 ];

 for (const example of examples) {
 const sanitized = sanitizeImplementationText(example);
 assert.doesNotMatch(sanitized, IMPLEMENTATION_TERMS, sanitized);
 assert.ok(sanitized.length > 0);
 }
});

test('customer order logs preserve useful mailbox progress', () => {
 assert.equal(
 sanitizeImplementationText('STEP 12: Create remaining 99 shared mailboxes'),
 'STEP 12: Create remaining 99 mailboxes'
 );
 assert.match(
 sanitizeImplementationText('Puppeteer browser page failed: Target closed'),
 /automation service/i
 );
});
