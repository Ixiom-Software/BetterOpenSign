import { PDFDocument, PDFString, rgb } from 'pdf-lib';
import fs from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { formatDateTime } from '../../../Utils.js';
import { fingerprint } from '../../customRoute/bsapi/certs.js';

const formatDateStr = (dateStr, DateFormat, timezone, Is12Hr) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return formatDateTime(date, DateFormat, timezone, Is12Hr);
};

// A VLAD shortened for display: its start and end.
const shortVlad = vlad => (vlad.length > 24 ? `${vlad.slice(0, 12)}...${vlad.slice(-8)}` : vlad);

// Lines of `str` at most `maxWidth` wide: broken at spaces, and inside a word
// (a fingerprint, a URL) only when the word alone is too wide.
export function wrapText(str, font, size, maxWidth) {
  const fits = t => font.widthOfTextAtSize(t, size) <= maxWidth;
  const lines = [];
  let line = '';
  for (const word of String(str).split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    let rest = word;
    while (!fits(rest)) {
      // The longest prefix that fits (at least one character), by bisection.
      let lo = 1;
      let hi = rest.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(rest.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      lines.push(rest.slice(0, lo));
      rest = rest.slice(lo);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The completion certificate.
 *
 * @param {object} docDetails - the completed contracts_Document (JSON)
 * @param {object} [opts]
 * @param {object[]|null} [opts.signatures] - the signed PDF's digital
 *   signatures (bsapi/certs.js signaturesForCertificate); when present, a
 *   "Digital signatures" section lists them
 */
export default async function GenerateCertificate(docDetails, { signatures } = {}) {
  const timezone = docDetails?.ExtUserPtr?.Timezone || '';
  const Is12Hr = docDetails?.ExtUserPtr?.Is12HourTime || false;
  const DateFormat = docDetails?.ExtUserPtr?.DateFormat || 'MM/DD/YYYY';
  const pdfDoc = await PDFDocument.create();
  // `fontBytes` is used to embed custom font in pdf
  const fontBytes = fs.readFileSync('./font/times.ttf'); //
  pdfDoc.registerFontkit(fontkit);
  const timesRomanFont = await pdfDoc.embedFont(fontBytes, { subset: true });
  const pngUrl = fs.readFileSync('./images/logo.png').buffer;
  const naSignUrl = fs.readFileSync('./images/na_sign.png').buffer;
  const nasign = await pdfDoc.embedPng(naSignUrl);
  const pngImage = await pdfDoc.embedPng(pngUrl);
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const startX = 15;
  const startY = 15;
  const borderColor = rgb(0.12, 0.12, 0.12);
  const titleColor = rgb(0, 0.2, 0.4); //rgb(0, 0.53, 0.71);
  const titleUnderline = rgb(0, 0.2, 0.4); // rgb(0.12, 0.12, 0.12);
  const title = 25;
  const subtitle = 16;
  const text = 13;
  const signertext = 13;
  const timeText = 11;
  const textKeyColor = rgb(0.12, 0.12, 0.12);
  const textValueColor = rgb(0.3, 0.3, 0.3);
  const completedAt = docDetails?.completedAt ? new Date(docDetails?.completedAt) : new Date();
  const completedAtperTimezone = formatDateStr(completedAt, DateFormat, timezone, Is12Hr);
  const completedUTCtime = completedAtperTimezone;
  const signersCount = docDetails?.Signers?.length || 1;
  const generateAt = docDetails?.completedAt ? new Date(docDetails?.completedAt) : new Date();
  const generatedAtperTimezone = formatDateTime(generateAt, DateFormat, timezone, Is12Hr);
  const generatedUTCTime = generatedAtperTimezone;
  const generatedOn = 'Generated On ' + generatedUTCTime;
  const textWidth = timesRomanFont.widthOfTextAtSize(generatedOn, 12);
  const margin = 30;
  const maxX = width - margin - textWidth; // Ensures text stays inside the border with 30px margin
  const OriginIp = docDetails?.OriginIp || '';
  const company = docDetails?.ExtUserPtr?.Company || '';
  const documentHash = docDetails?.DocumentHash || '';
  const createdAt = docDetails?.DocSentAt?.iso || docDetails.createdAt;
  const createdAtperTimezone = formatDateStr(createdAt, DateFormat, timezone, Is12Hr);
  const IsEnableOTP = docDetails?.IsEnableOTP || false;
  const placeholders = Array.isArray(docDetails?.Placeholders) ? docDetails.Placeholders : [];
  const filteredaudit = docDetails?.AuditTrail?.filter(x => {
    if (!x?.UserPtr?.objectId) return false;
    return true;
  });
  const toTs = v => {
    if (!v) return 0;
    if (typeof v === 'object' && v?.iso) return new Date(v.iso).getTime() || 0;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const auditTrail =
    docDetails?.Signers?.length > 0
      ? filteredaudit?.map(x => {
          const data = docDetails.Signers.find(y => y.objectId === x.UserPtr.objectId);
          return {
            ...data,
            ipAddress: x.ipAddress,
            SignedOn: x?.SignedOn || generatedUTCTime,
            ViewedOn: x?.ViewedOn || x?.SignedOn || generatedUTCTime,
            Signature: x?.Signature || '',
            _signedOnTs: toTs(x?.SignedOn),
          };
        })
      : [
          {
            ...docDetails.ExtUserPtr,
            ipAddress: filteredaudit[0].ipAddress,
            SignedOn: filteredaudit[0]?.SignedOn || generatedUTCTime,
            ViewedOn: filteredaudit[0]?.ViewedOn || filteredaudit[0]?.SignedOn || generatedUTCTime,
            Signature: filteredaudit[0]?.Signature || '',
            _signedOnTs: toTs(filteredaudit[0]?.SignedOn),
          },
        ];
  if (Array.isArray(auditTrail)) {
    auditTrail.sort((a, b) => (a?._signedOnTs || 0) - (b?._signedOnTs || 0));
  }

  const ownerName = docDetails?.SenderName || docDetails.ExtUserPtr?.Name || 'n/a';
  const ownerEmail = docDetails?.SenderMail || docDetails.ExtUserPtr?.Email || 'n/a';
  const half = width / 2;
  // Draw a border
  page.drawRectangle({
    x: startX,
    y: startY,
    width: width - 2 * startX,
    height: height - 2 * startY,
    borderColor: borderColor,
    borderWidth: 1,
  });
  page.drawImage(pngImage, {
    x: 30,
    y: 790,
    width: 100,
    height: 25,
  });

  page.drawText(generatedOn, {
    x: Math.max(startX, maxX), // Adjusts dynamically 320
    y: 810,
    size: 12,
    font: timesRomanFont,
    color: rgb(0.12, 0.12, 0.12),
  });

  page.drawText('Certificate of Completion', {
    x: 160,
    y: 755,
    size: title,
    font: timesRomanFont,
    color: titleColor,
  });

  const underlineY = 745;
  page.drawLine({
    start: { x: 30, y: underlineY },
    end: { x: width - 30, y: underlineY },
    color: titleUnderline,
    thickness: 1,
  });

  page.drawText('Summary', {
    x: 30,
    y: 727,
    size: subtitle,
    font: timesRomanFont,
    color: titleColor,
  });

  page.drawText('Document Id :', {
    x: 30,
    y: 710,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(docDetails.objectId, {
    x: 110,
    y: 710,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });

  page.drawText('Document Name :', {
    x: 30,
    y: 690,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(docDetails?.Name, {
    x: 130,
    y: 690,
    size: docDetails?.Name?.length >= 78 ? 12 : text,
    font: timesRomanFont,
    color: textValueColor,
  });

  if (documentHash) {
    page.drawText('Document hash (sha256) :', {
      x: 30,
      y: 670,
      size: text,
      font: timesRomanFont,
      color: textKeyColor,
    });

    page.drawText(documentHash, {
      x: 170,
      y: 670,
      size: text,
      font: timesRomanFont,
      color: textValueColor,
    });
  }

  const organizationY = documentHash ? 650 : 670;
  const createdOnY = organizationY - 20;
  const completedOnY = createdOnY - 20;
  const signersY = completedOnY - 20;
  const originatorHeaderY = signersY - 20;
  const nameY = originatorHeaderY - 17;
  const emailY = nameY - 20;
  const ipY = emailY - 20;

  page.drawText('Organization :', {
    x: 30,
    y: organizationY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(company, {
    x: 110,
    y: organizationY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Created on :', {
    x: 30,
    y: createdOnY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(`${createdAtperTimezone}`, {
    x: 97,
    y: createdOnY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Completed on :', {
    x: 30,
    y: completedOnY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(`${completedUTCtime}`, {
    x: 115,
    y: completedOnY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Signers :', {
    x: 30,
    y: signersY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });

  page.drawText(`${signersCount}`, {
    x: 80,
    y: signersY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Document originator', {
    x: 30,
    y: originatorHeaderY,
    size: 17,
    font: timesRomanFont,
    color: titleColor,
  });
  page.drawText('Name :', {
    x: 60,
    y: nameY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });
  page.drawText(ownerName, {
    x: 105,
    y: nameY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('Email :', {
    x: 60,
    y: emailY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });
  page.drawText(ownerEmail, {
    x: 105,
    y: emailY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });
  page.drawText('IP address :', {
    x: 60,
    y: ipY,
    size: text,
    font: timesRomanFont,
    color: textKeyColor,
  });
  page.drawText(`${OriginIp}`, {
    x: 125,
    y: ipY,
    size: text,
    font: timesRomanFont,
    color: textValueColor,
  });

  page.drawLine({
    start: { x: 30, y: ipY - 6 },
    end: { x: width - 30, y: ipY - 6 },
    color: rgb(0.12, 0.12, 0.12),
    thickness: 0.5,
  });
  let yPosition1 = ipY - 21;
  let yPosition2 = yPosition1 - 14;
  let yPosition3 = yPosition2 - 20;
  let yPosition4 = yPosition3 - 20;
  let yPosition5 = yPosition4 - 20;
  let yPosition6 = yPosition5 - 20;
  let yPosition7 = yPosition6 - 20;
  let yPosition8 = yPosition7 - 35;

  // A signer/approver block spans from yPosition1 down to yPosition8 (the
  // separator line at the bottom of the block). The signature image's
  // bottom edge sits at yPosition7 - 30 and must remain inside the page
  // border (whose bottom edge is at startY). Use the lowest of those two
  // values when deciding whether the next block fits on the current page.
  const minY = startY + 5;
  const blockBottom = () => Math.min(yPosition7 - 30, yPosition8);

  // Helper that resets the y-positions to the top of a freshly added page so
  // the next block starts cleanly under the border.
  const startNewPage = () => {
    const newPage = pdfDoc.addPage();
    newPage.drawRectangle({
      x: startX,
      y: startY,
      width: width - 2 * startX,
      height: height - 2 * startY,
      borderColor: borderColor,
      borderWidth: 1,
    });
    yPosition1 = newPage.getHeight() - 40;
    yPosition2 = yPosition1 - 20;
    yPosition3 = yPosition2 - 20;
    yPosition4 = yPosition3 - 20;
    yPosition5 = yPosition4 - 20;
    yPosition6 = yPosition5 - 20;
    yPosition7 = yPosition6 - 20;
    yPosition8 = yPosition7 - 35;
    return newPage;
  };

  let currentPage = page;
  for (let i = 0; i < auditTrail.length; i++) {
    const x = auditTrail[i];
    // If the next block would overflow the bottom border, move to a new page.
    if (blockBottom() < minY) {
      currentPage = startNewPage();
    }
    const embedPng = x.Signature ? await pdfDoc.embedPng(x.Signature) : nasign;
    const headerLabel = `${i + 1}. ${'Signer'}`;
    const signedOnLabel = 'Signed on :';

    currentPage.drawText(headerLabel, {
      x: 30,
      y: yPosition1,
      size: subtitle,
      font: timesRomanFont,
      color: titleColor,
    });
    currentPage.drawText('Name :', {
      x: 30,
      y: yPosition2,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(x?.Name || '', {
      x: 75,
      y: yPosition2,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    if (IsEnableOTP) {
      currentPage.drawText('Security level :', {
        x: half + 120,
        y: yPosition2,
        size: timeText,
        font: timesRomanFont,
        color: textKeyColor,
      });
      currentPage.drawText('Email, OTP Auth', {
        x: half + 190,
        y: yPosition2,
        size: timeText,
        font: timesRomanFont,
        color: textValueColor,
      });
    }

    currentPage.drawText('Email :', {
      x: 30,
      y: yPosition3,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(x?.Email || '', {
      x: 75,
      y: yPosition3,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText('Viewed on :', {
      x: 30,
      y: yPosition4,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(`${formatDateStr(x?.ViewedOn, DateFormat, timezone, Is12Hr)}`, {
      x: 97,
      y: yPosition4,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText(signedOnLabel, {
      x: 30,
      y: yPosition5,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    const signedOnValueX = 30 + timesRomanFont.widthOfTextAtSize(signedOnLabel, signertext) + 5;
    currentPage.drawText(`${formatDateStr(x?.SignedOn, DateFormat, timezone, Is12Hr)}`, {
      x: signedOnValueX,
      y: yPosition5,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText('IP address :', {
      x: 30,
      y: yPosition6,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawText(x?.ipAddress || '', {
      x: 95,
      y: yPosition6,
      size: signertext,
      font: timesRomanFont,
      color: textValueColor,
    });

    currentPage.drawText('Signature :', {
      x: 30,
      y: yPosition7,
      size: signertext,
      font: timesRomanFont,
      color: textKeyColor,
    });
    currentPage.drawRectangle({
      x: 98,
      y: yPosition7 - 30,
      width: 104,
      height: 44,
      borderColor: rgb(0.22, 0.18, 0.47),
      borderWidth: 1,
    });
    if (embedPng) {
      currentPage.drawImage(embedPng, {
        x: 100,
        y: yPosition7 - 27,
        width: 100,
        height: 40,
      });
    }
    currentPage.drawLine({
      start: { x: 30, y: yPosition8 },
      end: { x: width - 30, y: yPosition8 },
      color: rgb(0.12, 0.12, 0.12),
      thickness: 0.5,
    });

    yPosition1 = yPosition8 - 20;
    yPosition2 = yPosition1 - 20;
    yPosition3 = yPosition2 - 20;
    yPosition4 = yPosition3 - 20;
    yPosition5 = yPosition4 - 20;
    yPosition6 = yPosition5 - 20;
    yPosition7 = yPosition6 - 20;
    yPosition8 = yPosition8 - 174;
  }

  // The signed PDF's digital signatures, as bs-service-identity read them
  // (bsapi/certs.js), with links to the published root certificates.
  if (Array.isArray(signatures) && signatures.length > 0) {
    const keyX = 30;
    const valueX = 60;
    const lineGap = 14;
    const smallText = 10;
    const maxWidth = width - 30 - valueX;
    let y = yPosition1;
    // Room for `h` more points on this page, or a new page.
    const ensure = h => {
      if (y - h < minY) {
        currentPage = startNewPage();
        y = yPosition1;
      }
    };
    const link = (lineText, size, x, url) => {
      const w = timesRomanFont.widthOfTextAtSize(lineText, size);
      const annot = pdfDoc.context.register(
        pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [x, y - 2, x + w, y + size],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
        })
      );
      currentPage.node.addAnnot(annot);
    };
    // "Label :" then its value, wrapped under it when it doesn't fit beside it.
    const field = (label, value, { url, size = timeText } = {}) => {
      const key = `${label} :`;
      const besideX = keyX + timesRomanFont.widthOfTextAtSize(key, timeText) + 5;
      const beside = wrapText(value, timesRomanFont, size, width - 30 - besideX);
      const lines = beside.length === 1 ? beside : wrapText(value, timesRomanFont, size, maxWidth);
      ensure(lineGap * (lines.length + (beside.length === 1 ? 0 : 1)));
      currentPage.drawText(key, {
        x: keyX,
        y,
        size: timeText,
        font: timesRomanFont,
        color: textKeyColor,
      });
      if (beside.length !== 1) y -= lineGap;
      const x = beside.length === 1 ? besideX : valueX;
      for (const l of lines) {
        const color = url ? titleColor : textValueColor;
        currentPage.drawText(l, { x, y, size, font: timesRomanFont, color });
        if (url) link(l, size, x, url);
        y -= lineGap;
      }
    };
    const separator = () => {
      ensure(12);
      currentPage.drawLine({
        start: { x: keyX, y: y + 6 },
        end: { x: width - 30, y: y + 6 },
        color: rgb(0.12, 0.12, 0.12),
        thickness: 0.5,
      });
      y -= 12;
    };
    const dateOf = d => (d ? formatDateStr(d, DateFormat, timezone, Is12Hr) : 'not stated');
    // `intact`: the CMS digest matches the bytes it covers. The signature
    // value isn't checked here, so this never says "verified".
    const status = s => {
      if (!s.intact) return 'Not confirmed unchanged since signing';
      return s.coversWholeFile
        ? 'Unchanged since signing; covers the whole document'
        : 'Unchanged since signing; later revisions (other signatures, the seal) came after it';
    };

    ensure(50);
    currentPage.drawText('Digital signatures', {
      x: keyX,
      y,
      size: subtitle,
      font: timesRomanFont,
      color: titleColor,
    });
    y -= 16;
    for (const l of wrapText(
      'Read from the signed document. A PDF reader shows a signature as valid once it trusts ' +
        'its root certificate: download it below and follow the steps on its page.',
      timesRomanFont,
      smallText,
      width - 60
    )) {
      currentPage.drawText(l, {
        x: keyX,
        y,
        size: smallText,
        font: timesRomanFont,
        color: textValueColor,
      });
      y -= 13;
    }
    y -= 8;

    signatures.forEach((s, i) => {
      ensure(60);
      const name = s.certificateIncluded === false ? 'Signer unknown' : s.signerName;
      currentPage.drawText(`${i + 1}. ${name || 'Unnamed signer'}`, {
        x: keyX,
        y,
        size: signertext + 1,
        font: timesRomanFont,
        color: titleColor,
      });
      y -= lineGap + 2;
      if (s.certificateIncluded === false) {
        field('Certificate', 'not included in the signature', { size: smallText });
        field('Signed at', dateOf(s.signingTime), { size: smallText });
        field('Status', status(s), { size: smallText });
        separator();
        return;
      }
      field('Issued by', s.rootName || 'unknown');
      field('Signer certificate SHA-256', fingerprint(s.signerSha256), { size: smallText });
      if (s.rootSha256 && s.rootSha256 !== s.signerSha256) {
        field('Root certificate SHA-256', fingerprint(s.rootSha256), { size: smallText });
      }
      field('Valid', `${dateOf(s.notBefore)} to ${dateOf(s.notAfter)}`, { size: smallText });
      field('Signed at', dateOf(s.signingTime), { size: smallText });
      field('Status', status(s), { size: smallText });
      if (s.vlad) field('BetterID identity (VLAD)', shortVlad(s.vlad), { size: smallText });
      if (s.rootDownloadUrl) {
        field('Root certificate', s.rootDownloadUrl, { url: s.rootDownloadUrl, size: smallText });
      }
      if (s.pageUrl) {
        field('Trust it in Acrobat', s.pageUrl, { url: s.pageUrl, size: smallText });
      }
      separator();
    });
  }

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}
