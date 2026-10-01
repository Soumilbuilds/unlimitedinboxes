import tls from 'node:tls';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';

const MAX_LINE_BYTES = 8192;
const MAX_BUFFER_BYTES = 65536;
const MAX_SESSION_BYTES = 131072;
const MAX_REPLY_LINES = 100;
const AUTH_SECURITY_TTL_MS = 15 * 60 * 1000;
const protocolError = () => new Error('Connectivity protocol failed.');

// One absolute deadline covers the handshake and every command in a session.
// All transport/provider errors stay private and are replaced at the API boundary.
class Session {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.secure = false;
    this.closed = false;
    this.failure = null;
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.bytes = 0;
    this.waiter = null;
    this.onError = () => this.fail();
    this.onDisconnect = () => this.fail();
    this.onSecure = () => {
      if (this.secure || socket.authorized !== true) return this.fail();
      this.secure = true;
      this.wake();
    };
    this.onData = chunk => this.receive(chunk);
    socket.on('error', this.onError);
    socket.on('end', this.onDisconnect);
    socket.on('close', this.onDisconnect);
    socket.on('secureConnect', this.onSecure);
    socket.on('data', this.onData);
    this.timer = setTimeout(() => this.fail(), timeoutMs);
  }

  fail() {
    if (!this.failure) this.failure = protocolError();
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(this.failure);
    }
  }

  wake() {
    if (!this.waiter || this.failure) return;
    const { kind, resolve } = this.waiter;
    if (kind === 'secure' && this.secure) {
      this.waiter = null;
      resolve();
    } else if (kind === 'line' && this.lines.length) {
      this.waiter = null;
      resolve(this.lines.shift());
    }
  }

  receive(chunk) {
    if (this.failure || this.closed) return;
    if (!this.secure) return this.fail();
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.bytes += data.length;
      if (this.bytes > MAX_SESSION_BYTES || this.buffer.length + data.length > MAX_BUFFER_BYTES) {
        return this.fail();
      }
      this.buffer = Buffer.concat([this.buffer, data]);
      let end;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        if (end < 1 || this.buffer[end - 1] !== 13 || end - 1 > MAX_LINE_BYTES) return this.fail();
        const line = this.buffer.subarray(0, end - 1).toString('latin1');
        if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line) || this.lines.length >= MAX_REPLY_LINES) {
          return this.fail();
        }
        this.buffer = this.buffer.subarray(end + 1);
        this.lines.push(line);
        this.wake();
      }
      // Permit a final CR while waiting for the LF in a split packet.
      if (this.buffer.length > MAX_LINE_BYTES + 1) this.fail();
    } catch {
      this.fail();
    }
  }

  wait(kind) {
    if (this.failure || this.closed || this.waiter) return Promise.reject(protocolError());
    if (kind === 'secure' && this.secure) return Promise.resolve();
    if (kind === 'line' && this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => { this.waiter = { kind, resolve, reject }; });
  }

  write(command) {
    if (this.failure || this.closed || !this.secure || this.socket.authorized !== true ||
        this.lines.length || this.buffer.length || /[\r\n\x00]/.test(command) ||
        Buffer.byteLength(command) > MAX_LINE_BYTES) {
      throw protocolError();
    }
    this.socket.write(`${command}\r\n`);
  }

  assertIdle() {
    if (this.failure || this.closed || this.socket.authorized !== true || this.lines.length || this.buffer.length) {
      throw protocolError();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('secureConnect', this.onSecure);
    this.socket.removeListener('end', this.onDisconnect);
    // Keep the error listener through destruction: TLS can emit a late error.
    this.socket.once('close', () => {
      this.socket.removeListener('error', this.onError);
      this.socket.removeListener('close', this.onDisconnect);
    });
    this.socket.destroy();
  }
}

async function smtpReply(session) {
  const lines = [];
  let code;
  for (let count = 0; count < MAX_REPLY_LINES; count += 1) {
    const match = /^([2-5][0-5][0-9])(?:([ -])(.*))?$/.exec(await session.wait('line'));
    if (!match || (code !== undefined && code !== Number(match[1]))) throw protocolError();
    code = Number(match[1]);
    lines.push(match[3] ?? '');
    if (match[2] !== '-') return { code, lines };
  }
  throw protocolError();
}

async function smtpCommand(session, command) {
  session.write(command);
  return smtpReply(session);
}

async function smtpHello(session) {
  if ((await smtpReply(session)).code !== 220) throw protocolError();
  const reply = await smtpCommand(session, 'EHLO connectivity.example.invalid');
  if (reply.code !== 250) throw protocolError();
  return reply.lines.slice(1); // The first EHLO line is the server greeting.
}

async function smtpAuth(session, email, password) {
  const capabilities = await smtpHello(session);
  const supportsPlain = capabilities.some(line => {
    const match = /^AUTH(?:[ \t]+|=)([A-Z0-9_\t -]+)$/i.exec(line);
    return match && match[1].trim().split(/[ \t]+/).some(mechanism => mechanism.toUpperCase() === 'PLAIN');
  });
  if (!supportsPlain) throw protocolError();
  const payload = Buffer.from(`\0${email}\0${password}`, 'utf8').toString('base64');
  let reply = await smtpCommand(session, `AUTH PLAIN ${payload}`);
  // Some servers request the PLAIN response separately despite an initial response.
  if (reply.code === 334) {
    if (reply.lines.length !== 1 || reply.lines[0] !== '') throw protocolError();
    reply = await smtpCommand(session, payload);
  }
  return reply.code;
}

function imapQuote(value) {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

async function imapCommand(session, tag, command) {
  session.write(`${tag} ${command}`);
  for (let count = 0; count < MAX_REPLY_LINES; count += 1) {
    const line = await session.wait('line');
    if (line.startsWith('* ')) {
      // Only well-formed untagged status/data lines are accepted, never literals.
      if (!/^\* (?:OK|NO|BAD)(?: .*)?$/i.test(line) &&
          !/^\* (?:CAPABILITY(?: [A-Z0-9=._-]+)+|FLAGS \([^\r\n]*\)|\d+ (?:EXISTS|RECENT|EXPUNGE)|\d+ FETCH \(.*\))$/i.test(line)) {
        throw protocolError();
      }
      if (/\{\d+\+?\}$/.test(line)) throw protocolError();
      continue;
    }
    const match = /^([A-Za-z0-9]+) (OK|NO|BAD)(?: .*)?$/i.exec(line);
    if (!match || match[1] !== tag || match[2].toUpperCase() !== 'OK') throw protocolError();
    return;
  }
  throw protocolError();
}

function validHost(host) {
  return typeof host === 'string' && host.length <= 253 &&
    (isIP(host) !== 0 || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(host));
}

function validCredential(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 2048 &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function mailboxCredentials(credentials) {
  try {
    const { email, password } = credentials ?? {};
    const at = typeof email === 'string' ? email.lastIndexOf('@') : -1;
    const domain = at > 0 ? email.slice(at + 1).toLowerCase().replace(/\.$/, '') : '';
    if (!validCredential(email) || !validCredential(password) || !validHost(domain) || isIP(domain)) {
      throw protocolError();
    }
    return { email, password, domain };
  } catch {
    throw new Error('Invalid mailbox credentials.');
  }
}

export function createSmtpConnectivity({
  host, smtpPort = 465, imapPort = 993, connectImpl = tls.connect, timeoutMs = 15000,
} = {}) {
  if (!validHost(host) || ![smtpPort, imapPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      typeof connectImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('Invalid connectivity configuration.');
  }
  const authenticationChecks = new Map();

  async function withSession(port, operation) {
    let session;
    let socket;
    try {
      socket = connectImpl({ host, port, ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      session = new Session(socket, timeoutMs);
      await session.wait('secure');
      const result = await operation(session);
      session.assertIdle();
      return result;
    } finally {
      if (session) session.close();
      else if (socket) socket.destroy();
    }
  }

  async function verifyAuthenticationSecurity(credentials = {}) {
    const { email, password, domain } = mailboxCredentials(credentials);
    const now = Date.now();
    for (const [key, check] of authenticationChecks) {
      if (check.expiresAt !== null && check.expiresAt <= now) authenticationChecks.delete(key);
    }
    const existing = authenticationChecks.get(domain);
    if (existing) return existing.promise;

    // Cache only a successful result, not credentials. In-flight work is shared by
    // every mailbox in this domain; a failed probe is immediately eligible for retry.
    const check = { expiresAt: null, promise: null };
    check.promise = (async () => {
      try {
        let incorrectPassword;
        do { incorrectPassword = randomBytes(32).toString('base64url'); } while (incorrectPassword === password);
        await withSession(smtpPort, async session => {
          // 535 proves invalid credentials were rejected; a policy/temporary failure does not.
          if (await smtpAuth(session, email, incorrectPassword) !== 535) throw protocolError();
        });
        check.expiresAt = Date.now() + AUTH_SECURITY_TTL_MS;
        return true;
      } catch {
        if (authenticationChecks.get(domain) === check) authenticationChecks.delete(domain);
        throw new Error('Authentication security verification failed.');
      }
    })();
    authenticationChecks.set(domain, check);
    return check.promise;
  }

  return {
    verifyAuthenticationSecurity,

    async verifyMailbox(credentials = {}) {
      const { email, password } = mailboxCredentials(credentials);
      try {
        await withSession(smtpPort, async session => {
          if (await smtpAuth(session, email, password) !== 235) throw protocolError();
        });
        await verifyAuthenticationSecurity({ email, password });
        await withSession(imapPort, async session => {
          if (!/^\* OK(?: .*)?$/i.test(await session.wait('line'))) throw protocolError();
          await imapCommand(session, 'A1', `LOGIN ${imapQuote(email)} ${imapQuote(password)}`);
          await imapCommand(session, 'A2', 'SELECT INBOX');
        });
        return { smtp: true, imap: true };
      } catch {
        throw new Error('Mailbox connectivity verification failed.');
      }
    },

    async verifyRelaySecurity() {
      try {
        await withSession(smtpPort, async session => {
          await smtpHello(session);
          const sender = await smtpCommand(session, 'MAIL FROM:<relay-check@example.net>');
          if (sender.code === 530) return;
          // Some servers use 503 for this authentication gate. A generic 503
          // only indicates a command sequencing error and cannot prove safety.
          if (sender.code === 503 && sender.lines.length === 1 &&
              /^(?:5\.5\.1[ \t]+)?(?:You must authenticate first|Authentication required)\.?$/i.test(sender.lines[0].trim())) return;
          if (sender.code !== 250) throw protocolError();
          const recipient = await smtpCommand(session, 'RCPT TO:<relay-check@example.net>');
          if (recipient.code !== 530 && recipient.code !== 550) throw protocolError();
          // Never issue DATA, even if the remote endpoint accepts the recipient.
        });
        return true;
      } catch {
        throw new Error('Relay security verification failed.');
      }
    },
  };
}
