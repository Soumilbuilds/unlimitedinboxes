export function selectLegacyOrderMailboxes({ mailboxes, domain, totalMailboxes, mailboxPassword, plannedMailboxes = null }) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const total = Number(totalMailboxes);
  if (!normalizedDomain) throw new Error('Order tenant domain is missing');
  if (!Number.isInteger(total) || total < 1) throw new Error('Order mailbox total is invalid');
  if (!mailboxPassword) throw new Error('Order mailbox password is missing');
  if (!Array.isArray(mailboxes)) throw new Error('Exchange mailbox inventory is invalid');

  const byEmail = new Map();
  for (const mailbox of mailboxes) {
    const email = String(mailbox?.primarySmtpAddress || '').trim().toLowerCase();
    if (!email.endsWith(`@${normalizedDomain}`)) continue;
    const objectId = String(mailbox?.externalDirectoryObjectId || '').trim();
    if (!email || !objectId) continue;
    const existing = byEmail.get(email);
    if (existing && existing.objectId !== objectId) {
      throw new Error(`Exchange returned conflicting objects for ${email}`);
    }
    byEmail.set(email, {
      name: String(mailbox?.displayName || '').trim() || email.split('@')[0],
      email,
      password: mailboxPassword,
      objectId
    });
  }

  const candidates = [...byEmail.values()].sort((left, right) => (
    left.email < right.email ? -1 : left.email > right.email ? 1 : 0
  ));
  if (plannedMailboxes != null) {
    if (!Array.isArray(plannedMailboxes) || plannedMailboxes.length !== total) {
      throw new Error(`Persisted mailbox plan does not contain exactly ${total} identities`);
    }
    const seen = new Set();
    const selected = plannedMailboxes.map((identity, index) => {
      const alias = String(identity?.alias || '').trim().toLowerCase();
      const fullName = String(identity?.fullName || '').trim();
      if (!fullName || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias) || seen.has(alias)) {
        throw new Error(`Persisted mailbox plan item ${index + 1} has an invalid or duplicate identity`);
      }
      seen.add(alias);
      const email = `${alias}@${normalizedDomain}`;
      const mailbox = byEmail.get(email);
      if (!mailbox) throw new Error(`Exchange is missing planned shared mailbox ${email}`);
      return mailbox;
    });
    return { candidateCount: candidates.length, selected };
  }
  if (candidates.length < total) {
    throw new Error(`Exchange has only ${candidates.length}/${total} usable shared mailboxes for ${normalizedDomain}`);
  }
  return { candidateCount: candidates.length, selected: candidates.slice(0, total) };
}
