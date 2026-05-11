// Anaqua Farms — Load Tracker v3
// Fuzzy matching + correct buyer extraction

const SHEET_ID = '12cNhf1pJVf48H82zGv2eis08sN32MAdmk1Qn4jL48Xs';
const ANTHROPIC_API_KEY = 'PropertiesService.getScriptProperties().getProperty(ANTHROPIC_API_KEY_PLACEHOLDER)';

const TABS = { PENDING: 'Pending Field Tickets', DELIVERED_PENDING: 'Pending Delivered Tickets', LOG: 'Load Log' };

const PENDING_HEADERS = [
  'Ticket #', 'Date', 'Producer', 'Deliver To', 'Field / Lot',
  'Crop', 'Farm', 'Harvested By', 'Truck Owner', 'Driver',
  'Remarks', 'Is Split', 'Split Description', 'Captured At'
];

const DELIVERED_PENDING_HEADERS = [
  'Ticket #', 'Date', 'Buyer', 'Gross Weight', 'Tare Weight',
  'Net Weight', 'Moisture', 'Bushel Weight', 'Field Lot',
  'Driver', 'Metric Tons', 'Contract #', 'Field Ticket Ref', 'Captured At'
];

const LOG_HEADERS = [
  'Load #', 'Matched At', 'Field Date', 'Delivered Date',
  'Field Ticket #', 'Delivered Ticket #', 'Contract #',
  'Driver', 'Truck Owner', 'Crop', 'Farm',
  'Field / Lot', 'Delivered Lot', 'Producer', 'Buyer',
  'Gross Weight', 'Tare Weight', 'Net Weight', 'Metric Tons',
  'Moisture', 'Bushel Weight',
  'Is Split', 'Split Description',
  'Match Score', 'Match Confidence', 'Matched On', 'Flags', 'Reviewed'
];

function doGet() {
  return HtmlService.createHtmlOutput('<p>Anaqua Load Tracker v3 running.</p>').setTitle('Anaqua Load Tracker');
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    if (action === 'captureField')        return respond(captureFieldTicket(payload));
    if (action === 'matchDelivered')      return respond(matchDeliveredTicket(payload));
    if (action === 'getPending')          return respond(getPending());
    if (action === 'getDeliveredPending') return respond(getDeliveredPending());
    if (action === 'holdDelivered')       return respond(holdDelivered(payload));
    if (action === 'getLogs')             return respond(getLogs(payload));
    if (action === 'manualMatch')         return respond(manualMatch(payload));
    if (action === 'markReviewed')        return respond(markReviewed(payload.row));
    if (action === 'saveUnmatched')       return respond(saveUnmatched(payload));
    if (action === 'deletePending')       return respond(deletePending(payload.row));
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function callClaude(parts) {
  const requestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: parts }]
  };
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (result.error) throw new Error(result.error.message);
  return result.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
}

function extractSplitInfo(remarks) {
  if (!remarks) return { isSplit: false, splitDescription: '' };
  const idx = remarks.toLowerCase().indexOf('split');
  if (idx === -1) return { isSplit: false, splitDescription: '' };
  return { isSplit: true, splitDescription: remarks.substring(idx + 5).replace(/^[\s\-:,]+/, '').trim() };
}

function extractFieldTicketNum(refStr) {
  if (!refStr) return null;
  const str = String(refStr);
  const m = str.match(/ANAQ\s*(\d+)/i);
  if (m) return m[1];
  const n = str.match(/(\d{3,6})/);
  return n ? n[1] : null;
}

function norm(str) { return (str || '').toString().toLowerCase().trim(); }

function stripNoise(str) {
  return norm(str)
    .replace(/\b(cotton|grain|co|llc|inc|ltd|farms|farm|el|de|la|and|progresso|valley|elevator|gin|milling)\b/g, '')
    .replace(/[^a-z0-9]/g, '').trim();
}

function fuzzyName(a, b) {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const min = Math.min(a.length, b.length);
  if (min >= 4 && a.slice(0, Math.min(6, min)) === b.slice(0, Math.min(6, min))) return true;
  const wa = a.split(/\s+/), wb = b.split(/\s+/);
  return wa.some(x => x.length >= 4 && wb.some(y => y.startsWith(x) || x.startsWith(y)));
}

function fuzzyBuyer(a, b) {
  if (!a || !b) return false;
  const ca = stripNoise(a), cb = stripNoise(b);
  if (!ca || !cb) return false;
  if (ca.includes(cb) || cb.includes(ca)) return true;
  const shorter = ca.length <= cb.length ? ca : cb;
  const longer  = ca.length <= cb.length ? cb : ca;
  return shorter.length >= 5 && longer.includes(shorter.slice(0, 5));
}

function scoreMatch(pending, delivered) {
  let score = 0;
  const matched = [], flags = [];

  // 1. Driver
  const pd = norm(pending['Driver']), dd = norm(delivered.driver);
  if (pd && dd) {
    if (fuzzyName(pd, dd)) { score++; matched.push('Driver'); }
    else flags.push('Driver: "' + pending['Driver'] + '" vs "' + delivered.driver + '"');
  }

  // 2. Buyer — Deliver To on field ticket vs buyer on delivered ticket
  // Never treat Anaqua as the buyer
  const pb = norm(pending['Deliver To']);
  const db = norm(delivered.buyer);
  const isAnaqua = s => s.includes('anaqua');
  if (pb && db && !isAnaqua(pb)) {
    if (isAnaqua(db)) {
      // Delivered ticket misread buyer as Anaqua — skip this field, don't penalize
    } else if (fuzzyBuyer(pb, db)) {
      score++; matched.push('Buyer');
    } else {
      flags.push('Buyer: "' + pending['Deliver To'] + '" vs "' + delivered.buyer + '"');
    }
  }

  // 3. Field / Lot
  const pf = norm(pending['Field / Lot']).replace(/[\s\-_]/g, '');
  const df = norm(delivered.field_lot).replace(/[\s\-_]/g, '');
  if (pf && df) {
    if (pf.includes(df) || df.includes(pf)) { score++; matched.push('Field / Lot'); }
    else flags.push('Field ID: "' + pending['Field / Lot'] + '" vs "' + delivered.field_lot + '"');
  }

  // 4. Ticket # — exact
  const pt = (pending['Ticket #'] || '').toString().trim();
  const dt = extractFieldTicketNum(delivered.field_ticket_ref || '');
  if (pt && dt) {
    if (pt === dt) { score++; matched.push('Ticket #'); }
    else flags.push('Ticket #: "' + pt + '" vs "' + dt + '"');
  }

  // 5. Date — exact
  const pdate = norm(pending['Date']), ddate = norm(delivered.date);
  if (pdate && ddate && pdate === ddate) { score++; matched.push('Date'); }

  return { score, matched, flags };
}

function holdDelivered(payload) {
  const d = payload.deliveredData || {};
  const sheet = getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS);
  sheet.appendRow([
    d.ticket_number || '', d.date || '', d.buyer || '',
    d.gross_weight || '', d.tare_weight || '', d.net_weight || '',
    d.moisture || '', d.bushel_weight || '', d.field_lot || '',
    d.driver || '', d.metric_tons || '', d.contract_number || '',
    d.field_ticket_ref || '', new Date().toLocaleDateString('en-US')
  ]);
  sheet.getRange(sheet.getLastRow(), 1, 1, DELIVERED_PENDING_HEADERS.length).setBackground('#E6F1FB');
  return { success: true, row: sheet.getLastRow() };
}

function getDeliveredPending() {
  const sheet = getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { pending: [] };
  const data = sheet.getRange(2, 1, lastRow - 1, DELIVERED_PENDING_HEADERS.length).getValues();
  return {
    pending: data.map((row, i) => {
      const obj = {};
      DELIVERED_PENDING_HEADERS.forEach((h, j) => { obj[h] = row[j]; });
      obj._row = i + 2;
      return obj;
    }).reverse()
  };
}

function scoreDeliveredMatch(fieldTicket, deliveredPending) {
  // Reuse same scoring but map delivered pending fields to delivered format
  const delivered = {
    driver: deliveredPending['Driver'],
    buyer: deliveredPending['Buyer'],
    field_lot: deliveredPending['Field Lot'],
    field_ticket_ref: deliveredPending['Field Ticket Ref'],
    date: deliveredPending['Date']
  };
  return scoreMatch(fieldTicket, delivered);
}

function captureFieldTicket(payload) {
  const { imageB64, mime } = payload;
  const prompt = 'You are reading a handwritten FIELD TICKET from Anaqua Farms, Willacy County, Texas. ' +
    'Crop normalization: milo/yellow sorghum/sorghum/gr sorghum/milo maize = "Grain Sorghum". Yellow corn/yell corn/corn = "Corn". ' +
    'Return ONLY raw JSON, no markdown, no backticks. ' +
    'Structure: {"ticket_number":"","date":"","producer":"","deliver_to":"","field_lot":"","crop":"","farm":"","harvested_by":"","truck_owner":"","driver":"","remarks":""} ' +
    'deliver_to is the BUYER — the grain elevator or gin receiving the load (e.g. Texas Valley Grain, Willamar, Chapa). ' +
    'Anaqua Farms is the producer, never the buyer. Capture remarks exactly as written. Use null for unreadable fields.';

  const f = JSON.parse(callClaude([
    { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: imageB64 } },
    { type: 'text', text: prompt }
  ]));

  const split = extractSplitInfo(f.remarks || '');

  // Save to pending field tickets
  const sheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  sheet.appendRow([
    f.ticket_number || '', f.date || '', f.producer || '', f.deliver_to || '',
    f.field_lot || '', f.crop || '', f.farm || '', f.harvested_by || '',
    f.truck_owner || '', f.driver || '', f.remarks || '',
    split.isSplit ? 'Yes' : 'No', split.splitDescription || '',
    new Date().toLocaleDateString('en-US')
  ]);
  const row = sheet.getLastRow();
  if (split.isSplit) sheet.getRange(row, 1, 1, PENDING_HEADERS.length).setBackground('#fff9e6');

  // Build field ticket object for matching
  const fieldTicketObj = {
    'Ticket #': f.ticket_number || '',
    'Date': f.date || '',
    'Deliver To': f.deliver_to || '',
    'Field / Lot': f.field_lot || '',
    'Driver': f.driver || '',
    'Is Split': split.isSplit ? 'Yes' : 'No',
    'Split Description': split.splitDescription || '',
    'Crop': f.crop || '',
    'Farm': f.farm || '',
    'Producer': f.producer || '',
    'Truck Owner': f.truck_owner || '',
    '_row': row
  };

  // Check pending delivered tickets for a match
  const deliveredPendingSheet = getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS);
  const lastRow = deliveredPendingSheet.getLastRow();
  let autoMatchedDelivered = null;

  if (lastRow > 1) {
    const dpData = deliveredPendingSheet.getRange(2, 1, lastRow - 1, DELIVERED_PENDING_HEADERS.length).getValues();
    const dpPending = dpData.map((r, i) => {
      const obj = {};
      DELIVERED_PENDING_HEADERS.forEach((h, j) => { obj[h] = r[j]; });
      obj._row = i + 2;
      return obj;
    });

    const scored = dpPending
      .map(dp => ({ dp, ...scoreDeliveredMatch(fieldTicketObj, dp) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best) {
      const ticketMatch = best.matched.includes('Ticket #');
      const otherMatches = best.matched.filter(m => m !== 'Ticket #').length;
      if (ticketMatch || otherMatches >= 2) {
        // Auto-match: write to log, remove from delivered pending, remove from field pending
        const deliveredData = {
          ticket_number: best.dp['Ticket #'],
          date: best.dp['Date'],
          buyer: best.dp['Buyer'],
          gross_weight: best.dp['Gross Weight'],
          tare_weight: best.dp['Tare Weight'],
          net_weight: best.dp['Net Weight'],
          moisture: best.dp['Moisture'],
          bushel_weight: best.dp['Bushel Weight'],
          field_lot: best.dp['Field Lot'],
          driver: best.dp['Driver'],
          metric_tons: best.dp['Metric Tons'],
          contract_number: best.dp['Contract #'],
          field_ticket_ref: best.dp['Field Ticket Ref']
        };
        writeMatchedLoad(fieldTicketObj, deliveredData, best.matched, best.flags, best.score);
        deliveredPendingSheet.deleteRow(best.dp._row);
        sheet.deleteRow(row);
        autoMatchedDelivered = { score: best.score, matched: best.matched, delivered: deliveredData };
      }
    }
  }

  return { success: true, field: f, split, row, autoMatchedDelivered };
}

function matchDeliveredTicket(payload) {
  const { imageB64, mime } = payload;
  const prompt = 'You are reading a DELIVERED/SCALE TICKET from a grain elevator or buyer in Texas. ' +
    'The company name printed at the TOP of the ticket is the BUYER (the elevator or gin) — e.g. Texas Valley Grain, Willamar Cotton & Grain, Chapa Grain. ' +
    'Anaqua Farms is the CUSTOMER or ACCOUNT on the ticket — they are NOT the buyer. ' +
    'Return ONLY raw JSON, no markdown, no backticks. ' +
    'Structure: {"ticket_number":"","date":"","buyer":"","gross_weight":"","tare_weight":"","net_weight":"","moisture":"","bushel_weight":"","field_lot":"","driver":"","metric_tons":"","contract_number":"","field_ticket_ref":""} ' +
    'For field_ticket_ref: find any of these — ANAQ followed by digits (e.g. ANAQ4520), or a value next to Ref:, ORG Ticket, Field Ticket, or Load #. Capture full raw text. ' +
    'For driver: look for vehicle driver or truck driver name. ' +
    'Use null for unreadable fields. Never guess numbers.';

  const d = JSON.parse(callClaude([
    { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: imageB64 } },
    { type: 'text', text: prompt }
  ]));

  const pendingSheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const lastRow = pendingSheet.getLastRow();
  if (lastRow <= 1) return { success: true, delivered: d, matchResult: 'no_pending', candidates: [] };

  const pendingData = pendingSheet.getRange(2, 1, lastRow - 1, PENDING_HEADERS.length).getValues();
  const pending = pendingData.map((row, i) => {
    const obj = {};
    PENDING_HEADERS.forEach((h, j) => { obj[h] = row[j]; });
    obj._row = i + 2;
    return obj;
  });

  const scored = pending.map(p => ({ pending: p, ...scoreMatch(p, d) })).sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best) {
    const ticketMatch = best.matched.includes('Ticket #');
    const otherMatches = best.matched.filter(m => m !== 'Ticket #').length;
    if (ticketMatch || otherMatches >= 2) {
      const loadRow = writeMatchedLoad(best.pending, d, best.matched, best.flags, best.score);
      deletePendingRow(pendingSheet, best.pending._row);
      return { success: true, delivered: d, matchResult: 'auto', score: best.score, matched: best.matched, flags: best.flags, field: best.pending, loadRow };
    }
  }

  return {
    success: true, delivered: d, matchResult: 'manual',
    candidates: scored.slice(0, 5).map(s => ({ pending: s.pending, score: s.score, matched: s.matched, flags: s.flags }))
  };
}

function saveUnmatched(payload) {
  const d = payload.deliveredData || {};
  const sheet = getOrCreateTab(TABS.LOG, LOG_HEADERS);
  const loadNum = sheet.getLastRow();
  const buyer = (d.buyer && !norm(d.buyer).includes('anaqua')) ? d.buyer : '';
  sheet.appendRow([
    loadNum, new Date().toLocaleDateString('en-US'),
    '', d.date || '',
    '', d.ticket_number || '', d.contract_number || '',
    d.driver || '', '',
    '', '',
    '', d.field_lot || '',
    '', buyer,
    d.gross_weight || '', d.tare_weight || '',
    d.net_weight || '', d.metric_tons || '',
    d.moisture || '', d.bushel_weight || '',
    'No', '',
    0, 'manual', '', 'No field ticket — needs review', 'No'
  ]);
  const row = sheet.getLastRow();
  sheet.getRange(row, 1, 1, LOG_HEADERS.length).setBackground('#fde8e8');
  return { success: true, row };
}

function manualMatch(payload) {
  const { pendingRow, deliveredData, matchedFields, flags } = payload;
  const pendingSheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const rowData = pendingSheet.getRange(pendingRow, 1, 1, PENDING_HEADERS.length).getValues()[0];
  const pending = {};
  PENDING_HEADERS.forEach((h, i) => { pending[h] = rowData[i]; });
  pending._row = pendingRow;
  const loadRow = writeMatchedLoad(pending, deliveredData, matchedFields || [], flags || ['Manually matched'], 0);
  deletePendingRow(pendingSheet, pendingRow);
  return { success: true, loadRow };
}

function writeMatchedLoad(pending, delivered, matched, flags, score) {
  const sheet = getOrCreateTab(TABS.LOG, LOG_HEADERS);
  const loadNum = sheet.getLastRow();
  const isSplit = pending['Is Split'] === 'Yes';
  const conf = score >= 4 ? 'high' : score >= 3 ? 'medium' : 'manual';
  const buyer = (delivered.buyer && !norm(delivered.buyer).includes('anaqua')) ? delivered.buyer : pending['Deliver To'];

  sheet.appendRow([
    loadNum, new Date().toLocaleDateString('en-US'),
    pending['Date'] || '', delivered.date || '',
    pending['Ticket #'] || '', delivered.ticket_number || '', delivered.contract_number || '',
    pending['Driver'] || delivered.driver || '', pending['Truck Owner'] || '',
    pending['Crop'] || '', pending['Farm'] || '',
    pending['Field / Lot'] || '', delivered.field_lot || '',
    pending['Producer'] || '', buyer || '',
    delivered.gross_weight || '', delivered.tare_weight || '',
    delivered.net_weight || '', delivered.metric_tons || '',
    delivered.moisture || '', delivered.bushel_weight || '',
    isSplit ? 'Yes' : 'No', pending['Split Description'] || '',
    score || 0, conf, matched.join(', '), flags.join('; '), 'No'
  ]);

  const row = sheet.getLastRow();
  if (isSplit) sheet.getRange(row, 1, 1, LOG_HEADERS.length).setBackground('#fff9e6');
  if (conf === 'manual') sheet.getRange(row, 1, 1, LOG_HEADERS.length).setBackground('#fef2f2');
  return row;
}

function getOrCreateTab(name, headers) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    const r = sheet.getRange(1, 1, 1, headers.length);
    r.setFontWeight('bold'); r.setBackground('#1a1a18'); r.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function deletePendingRow(sheet, rowNum) { sheet.deleteRow(rowNum); }

function deletePending(payload) {
  getOrCreateTab(TABS.PENDING, PENDING_HEADERS).deleteRow(payload.row);
  return { success: true };
}

function getPending() {
  const sheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { pending: [] };
  const data = sheet.getRange(2, 1, lastRow - 1, PENDING_HEADERS.length).getValues();
  return { pending: data.map((row, i) => { const obj = {}; PENDING_HEADERS.forEach((h,j) => { obj[h]=row[j]; }); obj._row=i+2; return obj; }).reverse() };
}

function getLogs(payload) {
  const sheet = getOrCreateTab(TABS.LOG, LOG_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { loads: [] };
  const data = sheet.getRange(2, 1, lastRow - 1, LOG_HEADERS.length).getValues();
  const loads = data.map((row, i) => { const obj = {}; LOG_HEADERS.forEach((h,j) => { obj[h]=row[j]; }); obj._row=i+2; return obj; }).reverse();
  const { driver, crop, lot } = payload || {};
  return { loads: loads.filter(l => {
    if (driver && !norm(l['Driver']).includes(norm(driver))) return false;
    if (crop && !norm(l['Crop']).includes(norm(crop))) return false;
    if (lot && !norm(l['Field / Lot']).includes(norm(lot))) return false;
    return true;
  })};
}

function markReviewed(rowNum) {
  getOrCreateTab(TABS.LOG, LOG_HEADERS).getRange(rowNum, LOG_HEADERS.indexOf('Reviewed') + 1).setValue('Yes');
  return { success: true };
}

function testClaude() {
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 50, messages: [{ role: 'user', content: 'Say hello.' }] }),
    muteHttpExceptions: true
  });
  Logger.log(r.getContentText());
}