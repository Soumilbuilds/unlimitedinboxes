import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSmtpConnectivity } from '../services/smtpConnectivity.js';

const email = 'alice@example.test';
const password = 'Synthetic"Password\\WithEscapes!';
const diagnostic = 'PRIVATE_PROVIDER_BODY password=synthetic-secret /opt/private';
const ehlo = '250-mail.example.test\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 1048576\r\n';
const hello = { command: 'EHLO connectivity.example.invalid', reply: ehlo };
const authPayload = Buffer.from(`\0${email}\0${password}`).toString('base64');

// Emulates a TLS protocol socket, not service results. Every command consumes
// one scripted exchange, with real CRLF framing and optionally split packets.
function transport(scripts) {
  const sockets = [];
  const options = [];
  const failures = [];
  function connectImpl(config) {
    const script = scripts[sockets.length];
    assert.ok(script, 'Unexpected connection');
    options.push(config);
    const socket = new EventEmitter();
    socket.authorized = script.authorized ?? true;
    socket.commands = [];
    socket.remaining = [...(script.steps ?? [])];
    socket.destroyed = false;
    const deliver = reply => {
      for (const chunk of Array.isArray(reply) ? reply : [reply]) socket.emit('data', Buffer.from(chunk));
    };
    socket.write = wire => {
      try {
        assert.ok(wire.endsWith('\r\n'));
        const command = wire.slice(0, -2);
        socket.commands.push(command);
        const step = socket.remaining.shift();
        assert.ok(step, 'Unexpected command');
        if (typeof step.command === 'function') step.command(command);
        else assert.equal(command, step.command);
        queueMicrotask(() => {
          if (step.error) socket.emit('error', new Error(diagnostic));
          else if (step.end) socket.emit('end');
          else if (step.reply !== undefined) deliver(step.reply);
        });
        return true;
      } catch (error) {
        // The service sanitizes transport exceptions. Retain harness assertion
        // failures separately so a negative test cannot accidentally pass.
        failures.push(error);
        throw error;
      }
    };
    socket.destroy = () => {
      socket.destroyed = true;
      socket.emit('close');
    };
    sockets.push(socket);
    queueMicrotask(() => {
      if (script.error) return socket.emit('error', new Error(diagnostic));
      if (script.beforeSecure) deliver(script.greeting);
      if (script.noHandshake) return;
      socket.emit('secureConnect');
      if (!script.beforeSecure && script.greeting) deliver(script.greeting);
    });
    return socket;
  }
  return { connectImpl, sockets, options, failures };
}

function smtp(steps, extra = {}) { return { greeting: '220 mail.example.test Ready\r\n', steps: [hello, ...steps], ...extra }; }
function validAuth(reply = '235 Authenticated\r\n') { return smtp([{ command: `AUTH PLAIN ${authPayload}`, reply }]); }
function invalidAuth(reply = '535 Invalid Credentials\r\n') {
  return smtp([{ command: command => {
    assert.match(command, /^AUTH PLAIN /);
    const fields = Buffer.from(command.slice(11), 'base64').toString().split('\0');
    assert.deepEqual(fields.slice(0, 2), ['', email]);
    assert.ok(fields[2].length >= 32);
    assert.notEqual(fields[2], password);
  }, reply }]);
}
function imap(extra = {}) {
  return { greeting: '* OK IMAP Ready\r\n', steps: [
    { command: 'A1 LOGIN "alice@example.test" "Synthetic\\"Password\\\\WithEscapes!"', reply: 'A1 OK Logged In\r\n' },
    { command: 'A2 SELECT INBOX', reply: '* FLAGS (\\Seen)\r\n* 3 EXISTS\r\nA2 OK Selected\r\n' },
  ], ...extra };
}
function fixture(scripts, config = {}) {
  const wire = transport(scripts);
  return { ...wire, service: createSmtpConnectivity({ host: 'mail.example.test', connectImpl: wire.connectImpl, timeoutMs: 200, ...config }) };
}
function safeFailure(message) {
  return error => {
    assert.equal(error.message, message);
    assert.doesNotMatch(JSON.stringify({ ...error, stack: error.stack }), /PRIVATE_PROVIDER_BODY|synthetic-secret|\/opt\/private/);
    assert.equal(error.cause, undefined);
    return true;
  };
}
function assertClosed(f) {
  assert.deepEqual(f.failures, [], 'The scripted protocol must match every transmitted command');
  for (const socket of f.sockets) {
    assert.equal(socket.destroyed, true);
    assert.equal(socket.listenerCount('data'), 0);
    assert.equal(socket.listenerCount('secureConnect'), 0);
    assert.equal(socket.listenerCount('error'), 0);
  }
}

test('MAIL FROM 530 is safe: no RCPT, AUTH or DATA is sent', async () => {
  const f = fixture([smtp([{ command: 'MAIL FROM:<relay-check@example.net>', reply: '530 Authentication Required\r\n' }])]);
  assert.equal(await f.service.verifyRelaySecurity(), true);
  assert.deepEqual(f.sockets[0].commands, [hello.command, 'MAIL FROM:<relay-check@example.net>']);
  assertClosed(f);
});

test('MAIL FROM 503 explicitly requiring authentication is safe without RCPT, AUTH or DATA', async () => {
  for (const reply of [
    '503 5.5.1 You must authenticate first.\r\n',
    '503 You must authenticate first\r\n',
    '503 5.5.1 Authentication required.\r\n',
    '503 AUTHENTICATION REQUIRED\r\n',
  ]) {
    const f = fixture([smtp([{ command: 'MAIL FROM:<relay-check@example.net>', reply }])]);
    assert.equal(await f.service.verifyRelaySecurity(), true);
    assert.deepEqual(f.sockets[0].commands, [hello.command, 'MAIL FROM:<relay-check@example.net>']);
    assert.equal(f.sockets[0].remaining.length, 0);
    assertClosed(f);
  }
});

test('MAIL FROM 503 without an explicit authentication requirement fails without further commands', async () => {
  for (const reply of [
    '503 5.5.1 Bad sequence of commands.\r\n',
    '503 5.5.1 Send HELO first.\r\n',
    '503 5.5.1 Authentication not required.\r\n',
    '503 5.5.1 You must authenticate first. But anonymous relay is allowed.\r\n',
    '503\r\n',
    '503-Bad sequence of commands\r\n503 5.5.1 You must authenticate first.\r\n',
    '503 Authentication required for another operation.\r\n',
  ]) {
    const f = fixture([smtp([{ command: 'MAIL FROM:<relay-check@example.net>', reply }])]);
    await assert.rejects(f.service.verifyRelaySecurity(), safeFailure('Relay security verification failed.'));
    assert.deepEqual(f.sockets[0].commands, [hello.command, 'MAIL FROM:<relay-check@example.net>']);
    assert.equal(f.sockets[0].remaining.length, 0);
    assertClosed(f);
  }
});

test('relay recipient 530 or 550 is safe; accepting an external recipient is rejected without DATA', async () => {
  for (const code of [530, 550, 250, 251, 451]) {
    const f = fixture([smtp([
      { command: 'MAIL FROM:<relay-check@example.net>', reply: '250 Sender Accepted\r\n' },
      { command: 'RCPT TO:<relay-check@example.net>', reply: `${code} ${diagnostic}\r\n` },
    ])]);
    if ([530, 550].includes(code)) assert.equal(await f.service.verifyRelaySecurity(), true);
    else await assert.rejects(f.service.verifyRelaySecurity(), safeFailure('Relay security verification failed.'));
    assert.equal(f.sockets[0].commands.length, 3);
    assert.ok(f.sockets[0].commands.every(command => !command.startsWith('DATA') && !command.startsWith('AUTH')));
    assertClosed(f);
  }
});

test('valid SMTP and IMAP credentials require a separate bad-password 535 probe and SELECT INBOX', async () => {
  const f = fixture([validAuth(), invalidAuth(), imap()]);
  assert.deepEqual(await f.service.verifyMailbox({ email, password }), { smtp: true, imap: true });
  assert.deepEqual(f.options.map(option => option.port), [465, 465, 993]);
  assert.ok(f.sockets.every(socket => socket.remaining.length === 0));
  assertClosed(f);
});

test('only bad-password 535 proves authentication security; success, policy and temporary failures do not', async () => {
  for (const code of [235, 530, 454, 534, 550]) {
    const f = fixture([validAuth(), invalidAuth(`${code} ${diagnostic}\r\n`)]);
    await assert.rejects(f.service.verifyMailbox({ email, password }), safeFailure('Mailbox connectivity verification failed.'));
    assert.equal(f.sockets.length, 2, 'IMAP must not run after an inconclusive security probe');
    assertClosed(f);
  }
});

test('successful security probes are cached but a failed probe is retried', async () => {
  const cached = fixture([invalidAuth()]);
  assert.equal(await cached.service.verifyAuthenticationSecurity({ email, password }), true);
  assert.equal(await cached.service.verifyAuthenticationSecurity({ email: 'bob@example.test', password: 'OtherPassword!' }), true);
  assert.equal(cached.sockets.length, 1);
  const retry = fixture([invalidAuth('454 Temporary Failure\r\n'), invalidAuth()]);
  await assert.rejects(retry.service.verifyAuthenticationSecurity({ email, password }), safeFailure('Authentication security verification failed.'));
  assert.equal(await retry.service.verifyAuthenticationSecurity({ email, password }), true);
  assert.equal(retry.sockets.length, 2);
  assertClosed(retry);
});

test('AUTH PLAIN supports a separate empty challenge and fragmented CRLF replies', async () => {
  const f = fixture([smtp([
    { command: `AUTH PLAIN ${authPayload}`, reply: ['334 ', '\r', '\n'] },
    { command: authPayload, reply: ['235 Auth', 'enticated\r', '\n'] },
  ]), invalidAuth(), imap()]);
  assert.deepEqual(await f.service.verifyMailbox({ email, password }), { smtp: true, imap: true });
  assertClosed(f);
});

test('valid-password SMTP rejection, IMAP LOGIN rejection and mismatched SELECT tags fail safely', async () => {
  const scripts = [
    [validAuth(`535 ${diagnostic}\r\n`)],
    [validAuth(), invalidAuth(), imap({ steps: [{ command: imap().steps[0].command, reply: `A1 NO ${diagnostic}\r\n` }] })],
    [validAuth(), invalidAuth(), imap({ steps: [imap().steps[0], { command: 'A2 SELECT INBOX', reply: 'A9 OK Selected\r\n' }] })],
  ];
  for (const script of scripts) {
    const f = fixture(script);
    await assert.rejects(f.service.verifyMailbox({ email, password }), safeFailure('Mailbox connectivity verification failed.'));
    assertClosed(f);
  }
});

test('TLS enforces certificate validation, SNI and TLS 1.2 minimum on every connection', async () => {
  const f = fixture([validAuth(), invalidAuth(), imap()]);
  await f.service.verifyMailbox({ email, password });
  for (const options of f.options) {
    assert.equal(options.host, 'mail.example.test');
    assert.equal(options.servername, 'mail.example.test');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.equal(options.checkServerIdentity, undefined, 'Use the TLS default hostname verifier');
  }
  const ip = fixture([smtp([{ command: 'MAIL FROM:<relay-check@example.net>', reply: '530 Authentication Required\r\n' }])], { host: '192.0.2.10' });
  assert.equal(await ip.service.verifyRelaySecurity(), true);
  assert.equal(Object.hasOwn(ip.options[0], 'servername'), false);
  assert.equal(ip.options[0].rejectUnauthorized, true);
});

test('untrusted TLS, handshake errors and pre-handshake data never transmit credentials', async () => {
  for (const extra of [{ authorized: false }, { error: true }, { beforeSecure: true }]) {
    const f = fixture([{ ...validAuth(), ...extra }]);
    await assert.rejects(f.service.verifyMailbox({ email, password }), safeFailure('Mailbox connectivity verification failed.'));
    assert.deepEqual(f.sockets[0].commands, []);
    assertClosed(f);
  }
});

test('an untrusted IMAP certificate blocks LOGIN after SMTP checks succeed', async () => {
  const f = fixture([validAuth(), invalidAuth(), imap({ authorized: false })]);
  await assert.rejects(f.service.verifyMailbox({ email, password }), safeFailure('Mailbox connectivity verification failed.'));
  assert.equal(f.sockets.length, 3);
  assert.deepEqual(f.sockets[2].commands, []);
  assertClosed(f);
});

test('malformed replies, unsolicited data and missing AUTH PLAIN capability fail closed', async () => {
  for (const reply of [
    '250 Greeting\n',
    '250-Greeting\r\n550 AUTH PLAIN\r\n',
    '250-Greeting\r\n250 AUTH LOGIN\r\n',
    `${ehlo}235 Unsolicited Authentication\r\n`,
    '250 Greeting\r\npartial',
    `250 ${'x'.repeat(8193)}\r\n`,
  ]) {
    const f = fixture([{ greeting: '220 Ready\r\n', steps: [{ command: hello.command, reply }] }]);
    await assert.rejects(f.service.verifyMailbox({ email, password }), safeFailure('Mailbox connectivity verification failed.'));
    assert.deepEqual(f.sockets[0].commands, [hello.command]);
    assertClosed(f);
  }
});

test('stalled TLS handshakes and command replies time out and close their socket', async () => {
  for (const script of [{ noHandshake: true }, smtp([{ command: 'MAIL FROM:<relay-check@example.net>' }])]) {
    const f = fixture([script], { timeoutMs: 20 });
    await assert.rejects(f.service.verifyRelaySecurity(), safeFailure('Relay security verification failed.'));
    assertClosed(f);
  }
});

test('credential command injection is rejected before connecting', async () => {
  for (const credentials of [{ email: `${email}\r\nDATA`, password }, { email, password: 'bad\npassword' }, { email, password: 'bad\0password' }]) {
    const f = fixture([]);
    await assert.rejects(f.service.verifyMailbox(credentials), { message: 'Invalid mailbox credentials.' });
    assert.equal(f.sockets.length, 0);
  }
});
