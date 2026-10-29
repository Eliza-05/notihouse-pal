import {
  gmailDeduplicationKey,
  gmailExternalId,
  NoVerifiedMailboxes,
} from './gmail.contract.js';

describe('Gmail contract', () => {
  const notice = {
    mailbox: 'Facturas.Hogar@example.com',
    messageId: '18c2f5a9b0e4d1f2',
    attachmentId: 'ANGjdJ8-' + 'x'.repeat(200),
  };

  it('builds a stable key from mailbox, message and attachment', () => {
    const key = gmailDeduplicationKey(notice);
    expect(key).toBe(gmailDeduplicationKey({ ...notice }));
    expect(key).toBe(
      gmailDeduplicationKey({
        ...notice,
        mailbox: ' facturas.hogar@EXAMPLE.com ',
      }),
    );
    expect(key).toMatch(/^gmail:[0-9a-f]{32}:18c2f5a9b0e4d1f2:[0-9a-f]{32}$/);
  });

  it('never stores the mailbox address in clear', () => {
    expect(gmailDeduplicationKey(notice)).not.toContain('example.com');
  });

  it('distinguishes mailbox, message and attachment', () => {
    const base = gmailDeduplicationKey(notice);
    expect(
      gmailDeduplicationKey({ ...notice, mailbox: 'otra@example.com' }),
    ).not.toBe(base);
    expect(
      gmailDeduplicationKey({ ...notice, messageId: '18c2f5a9b0e4d1f3' }),
    ).not.toBe(base);
    expect(
      gmailDeduplicationKey({ ...notice, attachmentId: 'other' }),
    ).not.toBe(base);
  });

  it('uses the message id as external reference', () => {
    expect(gmailExternalId(notice)).toBe('gmail:18c2f5a9b0e4d1f2');
  });

  it('has no verified mailbox until OAuth exists', async () => {
    expect(await new NoVerifiedMailboxes().resolveOwner()).toBeNull();
  });
});
