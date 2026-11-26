// BetterID self sign-up (BS_SELF_SIGNUP=true): a new Better DocSign account
// for a VLAD that signed in through bs-id with a verified email and has no
// link yet. When it may happen is decided in utils/bsSignInDecision.js; this
// file looks up the email and makes the account.
//
// The account is what OpenSign's own sign-up makes (AddAdmin.js
// addAdminRecords): the _User, its tenant, a contracts_Users row with the
// contracts_Admin role, and its own organization with an "All Users" team.
// The tenant is marked BsSelfSignup, which keeps the shared list of
// unassigned sign-in attempts off its Users page (bsIdentityAdmin.js). Then
// the VLAD is linked to it (bs_Identity, active, label "Self sign-up").
//
// Races: two sign-ins at once must not make two accounts. The _User is the
// lock. A new one is made with signUp, and its username (the email) is unique,
// so only one sign-in makes it. Then every sign-in that wants to finish an
// account on a _User increments its BsSignupClaims, and only the one that
// moved it to 1 goes on (as bs_LoginChallenge's Uses in bsextlogin.js). The
// others get SignupLost('busy') and wait for the winner's link. If making the
// account fails, what was made is removed and the claim is released.

import crypto from 'node:crypto';
import { addAdminRecords } from '../cloud/parsefunction/AddAdmin.js';

export const CLAIM_FIELD = 'BsSignupClaims';
export const SELF_SIGNUP_LABEL = 'Self sign-up';

export class SignupLost extends Error {
  constructor(reason) {
    super(`self sign-up: ${reason}`);
    this.reason = reason; // 'busy' | 'email_taken'
  }
}

const userPtr = id => ({ __type: 'Pointer', className: '_User', objectId: id });

async function extendedUsers(userId, email) {
  const byUser = new Parse.Query('contracts_Users').equalTo('UserId', userPtr(userId));
  const byEmail = new Parse.Query('contracts_Users').equalTo('Email', email);
  return Parse.Query.or(byUser, byEmail).limit(10).find({ useMasterKey: true });
}

// Who has `email` (lower case) already, for decideSignIn's emailOwner:
//   { kind: 'none' }               nobody
//   { kind: 'contact', userId }    one _User, username = email, with no
//                                  contracts_Users row: a recipient OpenSign
//                                  made for a contact. The account is made on it.
//   { kind: 'account' }            anything else (an account, or unclear)
export async function emailOwner(email) {
  const users = await Parse.Query.or(
    new Parse.Query(Parse.User).equalTo('username', email),
    new Parse.Query(Parse.User).equalTo('email', email)
  )
    .limit(10)
    .find({ useMasterKey: true });
  const ext = await new Parse.Query('contracts_Users')
    .equalTo('Email', email)
    .first({ useMasterKey: true });
  if (ext) return { kind: 'account' };
  if (users.length === 0) return { kind: 'none' };
  if (users.length > 1 || users[0].get('username') !== email) return { kind: 'account' };
  const own = await extendedUsers(users[0].id, email);
  return own.length ? { kind: 'account' } : { kind: 'contact', userId: users[0].id };
}

// Best effort: signUp leaves a session nobody uses (bsidlogin makes its own).
function dropSession(sessionToken) {
  if (!sessionToken) return;
  new Parse.Query(Parse.Session)
    .equalTo('sessionToken', sessionToken)
    .first({ useMasterKey: true })
    .then(s => s && s.destroy({ useMasterKey: true }))
    .catch(() => {});
}

// Link the VLAD to the new account: its unassigned sign-in attempt row if it
// has one (so the Users page doesn't keep a stale attempt), else a new row.
// bsIdentityBeforeSave refuses a second active link for the VLAD.
async function linkVlad(vlad, userId, created) {
  const attempt = await new Parse.Query('bs_Identity')
    .equalTo('vlad', vlad)
    .doesNotExist('UserId')
    .ascending('createdAt')
    .first({ useMasterKey: true });
  const row = attempt || new Parse.Object('bs_Identity');
  if (!attempt) {
    row.set('vlad', vlad);
    row.setACL(new Parse.ACL());
    created.identity = row;
  }
  row.set('UserId', Parse.User.createWithoutData(userId));
  row.set('Label', SELF_SIGNUP_LABEL);
  row.set('Active', true);
  row.set('LastSeenAt', new Date());
  await row.save(null, { useMasterKey: true });
}

async function undo(created, user, isNewUser) {
  for (const k of ['identity', 'team', 'org', 'ext', 'tenant']) {
    if (created[k]) await created[k].destroy({ useMasterKey: true }).catch(() => {});
  }
  try {
    if (isNewUser) {
      await user.destroy({ useMasterKey: true });
    } else {
      user.unset(CLAIM_FIELD);
      await user.save(null, { useMasterKey: true });
    }
  } catch (e) {
    console.error('bsSelfSignup: could not undo the claim', e?.message || e);
  }
}

/**
 * Make the account and link `vlad` to it. reuseUserId: the recipient _User
 * emailOwner() found, or null for a new one. Returns { userId }. Throws
 * SignupLost when another sign-in got there first, or an error if making it
 * failed (then nothing is left behind).
 */
export async function createAccountForVlad({ vlad, email, name, reuseUserId }) {
  let user;
  const isNewUser = !reuseUserId;
  if (reuseUserId) {
    user = await new Parse.Query(Parse.User).get(reuseUserId, { useMasterKey: true });
  } else {
    user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('name', name);
    // Never used: password sign-in is off (cloud/main.js beforeLogin).
    user.set('password', crypto.randomBytes(24).toString('hex'));
    try {
      await user.signUp(null, { useMasterKey: true });
    } catch (e) {
      if (e?.code === Parse.Error.USERNAME_TAKEN || e?.code === Parse.Error.EMAIL_TAKEN) {
        throw new SignupLost('busy');
      }
      throw e;
    }
    dropSession(user.getSessionToken());
  }

  user.increment(CLAIM_FIELD);
  await user.save(null, { useMasterKey: true });
  if (user.get(CLAIM_FIELD) !== 1) throw new SignupLost('busy');

  const created = {};
  try {
    // Someone may have made an account with this email since the lookup.
    if ((await extendedUsers(user.id, email)).length) throw new SignupLost('email_taken');
    await addAdminRecords(
      user.id,
      { name, email, company: name, role: 'contracts_Admin' },
      created,
      { rethrow: true }
    );
    created.tenant.set('BsSelfSignup', true);
    await created.tenant.save(null, { useMasterKey: true });
    await linkVlad(vlad, user.id, created);
    return { userId: user.id };
  } catch (e) {
    await undo(created, user, isNewUser);
    throw e;
  }
}
