// Unit tests for who gets in with BetterID, and when self sign-up makes an
// account (utils/bsSignInDecision.js). No database: run with
// `npx jasmine --config=spec/support/bsapi.json`.
import {
  decideSignIn,
  selfSignupEnabled,
  signupName,
  verifiedEmail,
} from '../../utils/bsSignInDecision.js';

const linked = { user: { id: 'u1' }, email: 'a@example.com' };
const notLinked = { reason: 'not_linked' };
const attemptOnly = { reason: 'inactive', turnedOff: false };
const turnedOff = { reason: 'inactive', turnedOff: true };
const base = { selfSignup: true, via: 'bsid', email: 'new@example.com' };

describe('decideSignIn', () => {
  it('signs in a linked VLAD, whatever else is true', () => {
    for (const selfSignup of [true, false]) {
      for (const via of ['bsid', 'extension']) {
        expect(decideSignIn({ account: linked, selfSignup, via, email: null })).toEqual({
          action: 'sign_in',
        });
      }
    }
  });

  it('with self sign-up off, refuses an unlinked VLAD and records it (as before)', () => {
    for (const account of [notLinked, attemptOnly, turnedOff]) {
      expect(decideSignIn({ ...base, account, selfSignup: false })).toEqual({
        action: 'refuse',
        reason: 'not_linked',
        record: true,
      });
    }
  });

  it('refuses a broken link without recording it', () => {
    expect(decideSignIn({ ...base, account: { reason: 'no_account' } })).toEqual({
      action: 'refuse',
      reason: 'no_account',
      record: false,
    });
    expect(decideSignIn({ ...base, account: { reason: 'ambiguous' } })).toEqual({
      action: 'refuse',
      reason: 'not_linked',
      record: false,
    });
  });

  it("doesn't let a VLAD whose link an admin turned off sign itself up", () => {
    expect(decideSignIn({ ...base, account: turnedOff, emailOwner: { kind: 'none' } })).toEqual({
      action: 'refuse',
      reason: 'not_linked',
      record: true,
    });
  });

  it('asks for the email owner before deciding, then creates when the email is free', () => {
    for (const account of [notLinked, attemptOnly]) {
      expect(decideSignIn({ ...base, account })).toEqual({ action: 'lookup_email' });
      expect(decideSignIn({ ...base, account, emailOwner: { kind: 'none' } })).toEqual({
        action: 'create',
        reuseUserId: null,
      });
    }
  });

  it("makes the account on a recipient's _User (no contracts_Users row)", () => {
    expect(
      decideSignIn({ ...base, account: notLinked, emailOwner: { kind: 'contact', userId: 'c1' } })
    ).toEqual({ action: 'create', reuseUserId: 'c1' });
  });

  it('never links an existing account by email: refuses and records it', () => {
    expect(decideSignIn({ ...base, account: notLinked, emailOwner: { kind: 'account' } })).toEqual({
      action: 'refuse',
      reason: 'email_taken',
      record: true,
    });
  });

  it('refuses without a verified email, and records it for an admin', () => {
    expect(decideSignIn({ ...base, account: notLinked, email: null })).toEqual({
      action: 'refuse',
      reason: 'no_email',
      record: true,
    });
  });

  it('sends the extension path to the passkey without recording', () => {
    expect(decideSignIn({ ...base, account: notLinked, via: 'extension', email: null })).toEqual({
      action: 'refuse',
      reason: 'use_passkey',
      record: false,
    });
  });
});

describe('verifiedEmail', () => {
  it('takes only a verified, well-formed email, lower-cased', () => {
    expect(verifiedEmail({ email: ' Jane@Example.COM ', email_verified: true })).toBe(
      'jane@example.com'
    );
    expect(verifiedEmail({ email: 'jane@example.com' })).toBeNull();
    expect(verifiedEmail({ email: 'jane@example.com', email_verified: 'true' })).toBeNull();
    expect(verifiedEmail({ email: 'not-an-email', email_verified: true })).toBeNull();
    expect(verifiedEmail({ email_verified: true })).toBeNull();
    expect(verifiedEmail(undefined)).toBeNull();
  });
});

describe('signupName', () => {
  it("uses the token's name, else the email's local part", () => {
    expect(signupName({ name: ' Jane Doe ' }, 'x@example.com')).toBe('Jane Doe');
    expect(signupName({ preferred_username: 'jdoe' }, 'x@example.com')).toBe('jdoe');
    expect(signupName({}, 'jane.doe+docs@example.com')).toBe('Jane Doe Docs');
    expect(signupName({}, 'x@example.com')).toBe('X');
  });
});

describe('selfSignupEnabled', () => {
  it('is off unless BS_SELF_SIGNUP is "true"', () => {
    expect(selfSignupEnabled({})).toBe(false);
    expect(selfSignupEnabled({ BS_SELF_SIGNUP: '1' })).toBe(false);
    expect(selfSignupEnabled({ BS_SELF_SIGNUP: 'false' })).toBe(false);
    expect(selfSignupEnabled({ BS_SELF_SIGNUP: 'true' })).toBe(true);
    expect(selfSignupEnabled({ BS_SELF_SIGNUP: 'TRUE' })).toBe(true);
  });
});
