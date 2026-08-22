import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDelegatedExchangeSessionScript,
  parseExchangeDeviceCode,
} from '../services/exchangeDelegatedPowerShell.js';
import { isMicrosoftDeviceAuthorizationConfirmation } from '../services/puppeteer.js';

test('parses the Exchange Online device authorization prompt used in production', () => {
  assert.deepEqual(parseExchangeDeviceCode(
    'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code ABCD12345 to authenticate.',
  ), {
    verificationUri: 'https://login.microsoft.com/device',
    userCode: 'ABCD12345',
  });
});

test('delegated mailbox batches use supported Exchange cmdlets and no private admin API', () => {
  const script = buildDelegatedExchangeSessionScript();
  assert.match(script, /Connect-ExchangeOnline\s+-Device/i);
  assert.match(script, /foreach \(\$request in @\(\$command\.payload\.mailboxes\)\)/i);
  assert.match(script, /New-Mailbox\s+-Shared/i);
  assert.match(script, /Get-EXOMailbox/i);
  assert.match(script, /Set-CASMailbox/i);
  assert.doesNotMatch(script, /\/beta\/Mailbox|admin\.exchange\.microsoft\.com\/beta/i);
});

test('device-code flow accepts Exchange branded sign-in confirmation screens', () => {
  assert.equal(
    isMicrosoftDeviceAuthorizationConfirmation(
      'Are you trying to sign in to Microsoft Exchange REST API Based Powershell? Continue',
    ),
    true,
  );
  assert.equal(isMicrosoftDeviceAuthorizationConfirmation('Enter the code displayed'), false);
});
