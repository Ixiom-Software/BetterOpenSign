import axios from 'axios';
import { cloudServerUrl, serverAppId } from '../../Utils.js';
const serverUrl = cloudServerUrl; //process.env.SERVER_URL;
const APPID = serverAppId;
const masterKEY = process.env.MASTER_KEY;
// `created` and `rethrow` are for BetterID self sign-up (utils/bsSelfSignup.js):
// it collects what was saved, and fails instead of logging, so a half-made
// account can be undone.
async function addTeamAndOrg(extUser, created = {}, { rethrow = false } = {}) {
  try {
    const extUserCls = new Parse.Query('contracts_Users');
    const updateUser = await extUserCls.get(extUser.objectId, { useMasterKey: true });
    if (updateUser && !updateUser?.get('OrganizationId')) {
      const orgCls = new Parse.Object('contracts_Organizations');
      orgCls.set('Name', extUser.Company);
      orgCls.set('IsActive', true);
      orgCls.set('ExtUserId', {
        __type: 'Pointer',
        className: 'contracts_Users',
        objectId: extUser?.objectId,
      });
      orgCls.set('CreatedBy', {
        __type: 'Pointer',
        className: '_User',
        objectId: extUser?.UserId?.objectId,
      });
      orgCls.set('TenantId', {
        __type: 'Pointer',
        className: 'partners_Tenant',
        objectId: extUser?.TenantId?.objectId,
      });

      const orgRes = await orgCls.save(null, { useMasterKey: true });
      created.org = orgRes;
      const teamCls = new Parse.Object('contracts_Teams');
      teamCls.set('Name', 'All Users');
      teamCls.set('OrganizationId', {
        __type: 'Pointer',
        className: 'contracts_Organizations',
        objectId: orgRes.id,
      });
      teamCls.set('IsActive', true);
      const teamRes = await teamCls.save(null, { useMasterKey: true });
      created.team = teamRes;
      // const updateUser = new Parse.Object('contracts_Users');
      // updateUser.id = extUser.objectId;
      updateUser.set('UserRole', 'contracts_Admin');
      updateUser.set('OrganizationId', {
        __type: 'Pointer',
        className: 'contracts_Organizations',
        objectId: orgRes.id,
      });
      updateUser.set('TeamIds', [
        {
          __type: 'Pointer',
          className: 'contracts_Teams',
          objectId: teamRes.id,
        },
      ]);
      const extUserRes = await updateUser.save(null, { useMasterKey: true });
    }
  } catch (err) {
    if (rethrow) throw err;
    console.log('err in add team, role, org', err);
  }
}

async function saveUser(userDetails) {
  const userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('username', userDetails.email?.toLowerCase()?.replace(/\s/g, ''));
  const userRes = await userQuery.first({ useMasterKey: true });

  if (userRes) {
    const url = `${serverUrl}/loginAs`;
    const axiosRes = await axios({
      method: 'POST',
      url: url,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'X-Parse-Application-Id': APPID,
        'X-Parse-Master-Key': masterKEY,
      },
      params: {
        userId: userRes.id,
      },
    });
    const login = await axiosRes.data;
    // console.log("login ", login);
    return { id: login.objectId, sessionToken: login.sessionToken };
  } else {
    const user = new Parse.User();
    user.set('username', userDetails.email?.toLowerCase()?.replace(/\s/g, ''));
    user.set('password', userDetails.password);
    user.set('email', userDetails.email?.toLowerCase()?.replace(/\s/g, ''));
    if (userDetails?.phone) {
      user.set('phone', userDetails.phone);
    }
    user.set('name', userDetails.name);

    const res = await user.signUp();
    // console.log("res ", res);
    return { id: res.id, sessionToken: res.getSessionToken() };
  }
}
// OpenSign's sign-up records for the _User `userId` (moved out of AddAdmin
// below, unchanged): its tenant (partners_Tenant), the extended user
// (contracts_Users, role userDetails.role), and the admin's organization and
// "All Users" team. Also used by BetterID self sign-up
// (utils/bsSelfSignup.js), which passes `created` (filled with what was saved)
// and `rethrow` (fail rather than log when the organization can't be made).
export async function addAdminRecords(userId, userDetails, created = {}, { rethrow = false } = {}) {
  const partnerQuery = new Parse.Object('partners_Tenant');
  partnerQuery.set('UserId', {
    __type: 'Pointer',
    className: '_User',
    objectId: userId,
  });

  if (userDetails?.phone) {
    partnerQuery.set('ContactNumber', userDetails.phone);
  }
  partnerQuery.set('TenantName', userDetails.company);
  partnerQuery.set('EmailAddress', userDetails.email?.toLowerCase()?.replace(/\s/g, ''));
  partnerQuery.set('IsActive', true);
  partnerQuery.set('CreatedBy', {
    __type: 'Pointer',
    className: '_User',
    objectId: userId,
  });
  if (userDetails && userDetails.pincode) {
    partnerQuery.set('PinCode', userDetails.pincode);
  }
  if (userDetails && userDetails.country) {
    partnerQuery.set('Country', userDetails.country);
  }
  if (userDetails && userDetails.state) {
    partnerQuery.set('State', userDetails.state);
  }
  if (userDetails && userDetails.city) {
    partnerQuery.set('City', userDetails.city);
  }
  if (userDetails && userDetails.address) {
    partnerQuery.set('Address', userDetails.address);
  }
  const tenantRes = await partnerQuery.save(null, { useMasterKey: true });
  created.tenant = tenantRes;
  // console.log("tenantRes ", tenantRes);
  const newObj = new Parse.Object('contracts_Users');
  newObj.set('UserId', {
    __type: 'Pointer',
    className: '_User',
    objectId: userId,
  });
  newObj.set('UserRole', userDetails.role);
  newObj.set('Email', userDetails.email?.toLowerCase()?.replace(/\s/g, ''));
  newObj.set('Name', userDetails.name);
  if (userDetails?.phone) {
    newObj.set('Phone', userDetails?.phone);
  }
  newObj.set('TenantId', {
    __type: 'Pointer',
    className: 'partners_Tenant',
    objectId: tenantRes.id,
  });
  if (userDetails && userDetails.company) {
    newObj.set('Company', userDetails.company);
  }
  if (userDetails && userDetails.jobTitle) {
    newObj.set('JobTitle', userDetails.jobTitle);
  }
  if (userDetails?.timezone) {
    newObj.set('Timezone', userDetails?.timezone);
  }
  const extRes = await newObj.save(null, { useMasterKey: true });
  created.ext = extRes;
  const extUser = {
    objectId: extRes.id,
    Name: userDetails.name,
    Email: userDetails.email?.toLowerCase()?.replace(/\s/g, ''),
    Phone: userDetails?.phone ? userDetails.phone : '',
    TenantId: { objectId: tenantRes.id },
    UserId: { objectId: userId },
    UserRole: userDetails.role,
    Company: userDetails.company,
    JobTitle: userDetails.jobTitle,
  };
  await addTeamAndOrg(extUser, created, { rethrow });
  return created;
}

export default async function AddAdmin(request) {
  const userDetails = request.params.userDetails;
  const user = await saveUser(userDetails);

  try {
    const extQuery = new Parse.Query('contracts_Users');
    extQuery.equalTo('UserId', {
      __type: 'Pointer',
      className: '_User',
      objectId: user.id,
    });
    const extUser = await extQuery.first({ useMasterKey: true });
    if (extUser) {
      return { message: 'User already exist' };
    } else {
      await addAdminRecords(user.id, userDetails);
      return { message: 'User sign up', sessionToken: user.sessionToken };
    }
  } catch (err) {
    console.log('Err ', err);
  }
}
