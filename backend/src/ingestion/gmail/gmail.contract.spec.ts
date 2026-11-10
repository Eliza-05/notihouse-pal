import { parseMailboxLinks } from '../../config/env.validation.js';
import { ConfiguredMailboxes } from './configured-mailboxes.js';
import { gmailDeduplicationKey, gmailExternalId } from './gmail.contract.js';

const PROFILE = '6f1d2c3b-0a4e-4b5c-8d7e-9f0a1b2c3d4e';

describe('Gmail contract', () => {
  const notice = {
    mailbox: 'Facturas.Hogar@example.com',
    messageId: '18c2f5a9b0e4d1f2',
    partId: '1',
  };

  it('builds a stable key from mailbox, message and part', () => {
    const key = gmailDeduplicationKey(notice);
    expect(key).toBe(gmailDeduplicationKey({ ...notice }));
    expect(key).toBe(
      gmailDeduplicationKey({
        ...notice,
        mailbox: ' facturas.hogar@EXAMPLE.com ',
      }),
    );
    expect(key).toMatch(/^gmail:[0-9a-f]{32}:18c2f5a9b0e4d1f2:1$/);
  });

  it('never stores the mailbox address in clear', () => {
    expect(gmailDeduplicationKey(notice)).not.toContain('example.com');
  });

  it('distinguishes mailbox, message and part', () => {
    const base = gmailDeduplicationKey(notice);
    expect(
      gmailDeduplicationKey({ ...notice, mailbox: 'otra@example.com' }),
    ).not.toBe(base);
    expect(
      gmailDeduplicationKey({ ...notice, messageId: '18c2f5a9b0e4d1f3' }),
    ).not.toBe(base);
    expect(gmailDeduplicationKey({ ...notice, partId: '2' })).not.toBe(base);
  });

  it('uses the message id as external reference', () => {
    expect(gmailExternalId(notice)).toBe('gmail:18c2f5a9b0e4d1f2');
  });
});

describe('GMAIL_MAILBOX_LINKS', () => {
  it('has no links when unset or empty', () => {
    expect(parseMailboxLinks(undefined).size).toBe(0);
    expect(parseMailboxLinks('').size).toBe(0);
  });

  it('normalizes the mailbox and keeps the profile', () => {
    const links = parseMailboxLinks(` Facturas@Example.com=${PROFILE} `);
    expect(links.get('facturas@example.com')).toBe(PROFILE);
  });

  it.each([
    ['no profile', 'a@example.com'],
    ['bad uuid', 'a@example.com=123'],
    ['not a mailbox', `example.com=${PROFILE}`],
    ['two values', `a@example.com=${PROFILE}=${PROFILE}`],
  ])('rejects %s without echoing the value', (_c, raw) => {
    let message = '';
    try {
      parseMailboxLinks(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/GMAIL_MAILBOX_LINKS/);
    expect(message).not.toContain('example.com');
  });

  it('rejects a mailbox linked twice', () => {
    expect(() =>
      parseMailboxLinks(`a@example.com=${PROFILE},A@example.com=${PROFILE}`),
    ).toThrow(/repite/);
  });
});

describe('ConfiguredMailboxes', () => {
  const resolverWith = (links: string | undefined) =>
    new ConfiguredMailboxes(
      {
        select: () => {
          throw new Error('no debe consultar la base sin vínculo');
        },
      } as never,
      { get: () => links } as never,
    );

  it('resolves nothing, and never reads the database, without a link', async () => {
    expect(await resolverWith(undefined).resolveOwner('a@b.co')).toBeNull();
    expect(
      await resolverWith(`otra@b.co=${PROFILE}`).resolveOwner('a@b.co'),
    ).toBeNull();
  });
});
