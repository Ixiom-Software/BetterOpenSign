// Sign in person, assigned (cloud/parsefunction/inPersonAssign.js): a PDF
// with blank signature fields goes to a colleague in one of the sender's
// teams. It shows in their "Need your sign" list and in /api/v1, can't be
// signed in the browser, and their BetterID app finishes it with an upload.
import * as cantoo from '@cantoo/pdf-lib';
import {
  API,
  MASTER,
  PARSE,
  desktopSign,
  docRow,
  docsignStatement,
  getFile,
  identity,
  link,
  mkMember,
  mkTenant,
  ptr,
  req,
  signPdf,
  tag,
  tokenFor,
  upload,
  waitFor,
} from './support/lib.js';
import { verifier } from './support/verifier.js';
import { shared } from './support/setup.js';
import { mailer } from '../../cloud/customRoute/bsapi/notify.js';
import { cannotSign } from '../../cloud/parsefunction/bsPhoneSign.js';

const call = (who, fn, params = {}) =>
  req('POST', `${PARSE}/functions/${fn}`, { headers: who.session, body: params });

const make = async (className, body) => {
  const r = await req('POST', `${PARSE}/classes/${className}`, { headers: MASTER, body });
  if (!r.json?.objectId) throw new Error(`${className}: ${JSON.stringify(r.json)}`);
  return r.json.objectId;
};

// A PDF with blank signature fields named `names`, as the Sign in person page
// makes it.
async function preparedPdf(names = ['Customer', 'Technician']) {
  const doc = await cantoo.PDFDocument.create();
  const page = doc.addPage([600, 800]);
  names.forEach((name, i) => {
    const field = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        Rect: [50, 100 + i * 100, 230, 160 + i * 100],
        T: cantoo.PDFHexString.fromText(name),
        F: 4,
        P: page.ref,
      })
    );
    page.node.addAnnot(field);
    doc.getForm().acroForm.addField(field);
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// What the phone does for an In person field before sealing: the drawing,
// stamped into the field's box as an incremental update.
async function stampDrawing(base) {
  const doc = await cantoo.PDFDocument.load(base, {
    forIncrementalUpdate: true,
    updateMetadata: false,
  });
  doc.getPages()[0].drawLine({ start: { x: 60, y: 110 }, end: { x: 200, y: 150 } });
  return Buffer.from(await doc.save());
}

const fieldNames = async bytes =>
  (await cantoo.PDFDocument.load(bytes, { updateMetadata: false }))
    .getForm()
    .getFields()
    .map(f => f.getName());

describe('sign in person, assigned', () => {
  let sender;
  let tech;
  let subTech;
  let unlinked;
  let office;
  let parentOnly;
  let outsider;
  let disabled;
  let techId;
  let mail;

  beforeAll(async () => {
    const tenantId = await mkTenant();
    const org = await make('contracts_Organizations', {
      Name: `Org ${tag()}`,
      TenantId: ptr('partners_Tenant', tenantId),
      IsActive: true,
    });
    const otherOrg = await make('contracts_Organizations', {
      Name: `Other ${tag()}`,
      TenantId: ptr('partners_Tenant', tenantId),
      IsActive: true,
    });
    const team = async (Name, parents = [], organization = org) => {
      const id = await make('contracts_Teams', {
        Name,
        OrganizationId: ptr('contracts_Organizations', organization),
        IsActive: true,
        Ancestors: parents.map(p => ptr('contracts_Teams', p)),
      });
      return id;
    };
    const allUsers = await team('All Users');
    const field = await team('Field', [allUsers]);
    const fieldNorth = await team('Field North', [allUsers, field]);
    const officeTeam = await team('Office', [allUsers]);
    const otherField = await team('Field', [], otherOrg);

    const member = (teams, extra = {}, organization = org) =>
      mkMember(tenantId, 'contracts_User', {
        OrganizationId: ptr('contracts_Organizations', organization),
        TeamIds: teams.map(t => ptr('contracts_Teams', t)),
        ...extra,
      });
    sender = await member([field]);
    tech = await member([field]);
    subTech = await member([fieldNorth]);
    unlinked = await member([field]);
    office = await member([officeTeam]);
    parentOnly = await member([allUsers]);
    outsider = await member([otherField], {}, otherOrg);
    disabled = await member([field], { IsDisabled: true });

    techId = identity();
    verifier.register(techId);
    for (const m of [tech, subTech, office, parentOnly, outsider, disabled]) {
      await link(m === tech ? techId : identity(), m.userId);
    }
  });

  beforeEach(() => {
    verifier.mode = 'ok';
    mail = [];
    mailer.send = async params => mail.push(params);
  });

  const assign = async (to, pdf, name = `Work order ${tag()}`) =>
    call(sender, 'inpersonassign', {
      name,
      assigneeId: to.extId,
      pdf: (pdf || (await preparedPdf())).toString('base64'),
    });

  it('lists the members of the sender’s teams and teams under them', async () => {
    const r = await call(sender, 'inpersonassignees');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.result.map(m => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(
      [sender, tech, subTech, unlinked].map(m => m.extId).sort()
    );
    expect(byId[tech.extId]).toEqual(
      jasmine.objectContaining({ email: tech.email, teams: ['Field'], linked: true })
    );
    expect(byId[subTech.extId].teams).toEqual(['Field North']);
    expect(byId[unlinked.extId].linked).toBe(false);
  });

  it('refuses anyone outside the sender’s teams, disabled or without BetterID', async () => {
    for (const m of [office, parentOnly, outsider, disabled, unlinked]) {
      const r = await assign(m);
      expect(r.json.code).withContext(m.email).toBe(119);
    }
    expect(mail).toEqual([]);
  });

  it('refuses a PDF with no blank signature fields, or no PDF', async () => {
    expect((await assign(tech, await preparedPdf([]))).json.error).toMatch(/no blank signature/);
    expect((await assign(tech, Buffer.from('hello'))).json.error).toMatch(/isn’t a PDF/);
  });

  it('needs a signed-in user', async () => {
    const r = await req('POST', `${PARSE}/functions/inpersonassign`, {
      headers: { 'X-Parse-Application-Id': MASTER['X-Parse-Application-Id'] },
      body: {},
    });
    expect(r.json.code).toBe(209);
  });

  describe('once assigned', () => {
    let docId;
    let pdf;

    beforeAll(async () => {
      mail = [];
      mailer.send = async params => mail.push(params);
      pdf = await preparedPdf();
      const r = await assign(tech, pdf, 'Boiler service');
      expect(r.status).toBe(200);
      docId = r.json.result.id;
      expect(r.json.result.assignee.email).toBe(tech.email);
      // The request email, with a signing link to this document.
      expect(mail.length).toBe(1);
      expect(mail[0].recipient).toBe(tech.email);
      expect(mail[0].html).toContain('/login/');
      await waitFor(async () => (await docRow(docId)).ExpiryDate);
    });

    it('is an in-person document for the assignee, the PDF as uploaded', async () => {
      const row = await docRow(docId);
      expect(row.InPerson).toBe(true);
      expect(row.Name).toBe('Boiler service');
      expect(row.SignedUrl).toBe(row.URL);
      expect(row.Signers.length).toBe(1);
      expect(row.Placeholders.length).toBe(1);
      const contact = (
        await req('GET', `${PARSE}/classes/contracts_Contactbook/${row.Signers[0].objectId}`, {
          headers: MASTER,
        })
      ).json;
      expect(contact.UserId.objectId).toBe(tech.userId);
      expect(contact.CreatedBy.objectId).toBe(sender.userId);
      const auth = await tokenFor(techId);
      const file = await getFile(auth, docId);
      expect(Buffer.compare(file.bytes, pdf)).toBe(0);
    });

    it('reuses the sender’s contact for the assignee', async () => {
      const again = await assign(tech);
      const first = (await docRow(docId)).Signers[0].objectId;
      expect((await docRow(again.json.result.id)).Signers[0].objectId).toBe(first);
    });

    it('is in the assignee’s Need your sign list', async () => {
      const r = await call(tech, 'getReport', { reportId: '4Hhwbp482K', skip: 0, limit: 50 });
      expect(r.json.result.map(d => d.objectId)).toContain(docId);
    });

    it('is listed for the app, marked in person', async () => {
      const auth = await tokenFor(techId);
      const listed = await req(
        'GET',
        `${API}/api/v1/documents?role=signer&status=in_progress&inPerson=true`,
        { headers: auth }
      );
      const doc = listed.json.results.find(d => d.id === docId);
      expect(doc).toEqual(jasmine.objectContaining({ inPerson: true, canSign: true }));
      const others = await req('GET', `${API}/api/v1/documents?role=signer&inPerson=false`, {
        headers: auth,
      });
      expect(others.json.results.map(d => d.id)).not.toContain(docId);
      const bad = await req('GET', `${API}/api/v1/documents?role=signer&inPerson=yes`, {
        headers: auth,
      });
      expect(bad.status).toBe(400);
    });

    it('can’t be signed in the browser or with Sign on phone', async () => {
      const row = await docRow(docId);
      const r = await signPdf(docId, row.Signers[0].objectId, pdf);
      expect(r.json.code).toBe(119);
      expect(r.json.error).toMatch(/BetterID app/);
      const doc = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true });
      expect(cannotSign(doc, tech.userId)).toMatch(/BetterID app/);
    });

    it('can’t be changed back by a client', async () => {
      const r = await req('PUT', `${PARSE}/classes/contracts_Document/${docId}`, {
        headers: tech.session,
        body: { InPerson: false },
      });
      expect(r.json.code).toBe(119);
      expect((await docRow(docId)).InPerson).toBe(true);
    });

    it('is finished by the assignee’s app: drawings, then their signature', async () => {
      const auth = await tokenFor(techId);
      const base = (await getFile(auth, docId)).bytes;
      const signed = await desktopSign(await stampDrawing(base), 'tech', shared.p12);
      const r = await upload(auth, docId, signed, docsignStatement(techId, docId, base, signed));
      expect(r.status).toBe(201);
      const done = await waitFor(async () => {
        const row = await docRow(docId);
        return row.IsCompleted ? row : null;
      });
      expect(done).toBeTruthy();
      // Appended throughout: the in-person fields are still there.
      const final = (await getFile(auth, docId)).bytes;
      expect(await fieldNames(final)).toEqual(jasmine.arrayContaining(['Customer', 'Technician']));
    });
  });
});
