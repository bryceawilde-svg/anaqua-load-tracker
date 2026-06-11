// Anaqua Farms — Load Tracker v3
// Fuzzy matching + correct buyer extraction

const SHEET_ID = '12cNhf1pJVf48H82zGv2eis08sN32MAdmk1Qn4jL48Xs';
const ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');

const TABS = { PENDING: 'Pending Field Tickets', DELIVERED_PENDING: 'Pending Delivered Tickets', LOG: 'Load Log', MASTER_LISTS: 'Master Lists' };

const PENDING_HEADERS = [
  'Ticket #', 'Date', 'Producer', 'Deliver To', 'Field / Lot',
  'Crop', 'Farm', 'Harvested By', 'Truck Owner', 'Driver',
  'Remarks', 'Is Split', 'Split Description', 'Captured At'
];

const DELIVERED_PENDING_HEADERS = [
  'Ticket #', 'Date', 'Buyer', 'Gross Weight', 'Tare Weight',
  'Net Weight', 'Moisture', 'Bushel Weight', 'Field Lot',
  'Driver', 'Field Ticket Ref', 'Captured At'
];

const LOG_HEADERS = [
  'Load #', 'Matched At', 'Field Date', 'Delivered Date',
  'Field Ticket #', 'Delivered Ticket #',
  'Driver', 'Truck Owner', 'Crop', 'Farm',
  'Field / Lot', 'Delivered Lot', 'Producer', 'Buyer',
  'Gross Weight', 'Tare Weight', 'Net Weight',
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
    if (action === 'deletePending')          return respond(deletePending(payload.row));
    if (action === 'deleteDeliveredPending') return respond(deleteDeliveredPending(payload.row));
    if (action === 'deleteLog')              return respond(deleteLog(payload.row));
    if (action === 'getMasterLists')         return respond(getMasterLists());
    if (action === 'init')                   return respond(initSheets());
    if (action === 'getCandidates')          return respond(getCandidatesForDelivered(payload));
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function callClaude(parts) {
  return callClaudeModel('claude-haiku-4-5-20251001', parts);
}

function callClaudeSonnet(parts) {
  return callClaudeModel('claude-sonnet-4-5', parts);
}

function callClaudeModel(model, parts) {
  const requestBody = {
    model: model,
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

function parseDate(val) {
  if (!val) return null;
  const s = val.toString().trim();
  const mo = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  // Named month: "June 10, 2025" or "June 10 2025"
  const named = s.match(/([a-zA-Z]{3,})\s+(\d{1,2})[,\s]+(\d{2,4})/);
  if (named) {
    const m = mo[named[1].toLowerCase().slice(0, 3)];
    if (m) {
      let y = parseInt(named[3], 10); if (y < 100) y += 2000;
      return m * 100000000 + parseInt(named[2], 10) * 1000000 + y;
    }
  }
  // Numeric: M/D/YY, MM/DD/YYYY, MM-DD-YY, etc.
  const num = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (num) {
    let y = parseInt(num[3], 10); if (y < 100) y += 2000;
    return parseInt(num[1], 10) * 100000000 + parseInt(num[2], 10) * 1000000 + y;
  }
  return null;
}

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

  // 4. Ticket # — exact after stripping leading zeros
  const pt = (pending['Ticket #'] || '').toString().trim().replace(/^0+/, '');
  const dt = (extractFieldTicketNum(delivered.field_ticket_ref || '') || '').replace(/^0+/, '');
  if (pt && dt) {
    if (pt === dt) { score++; matched.push('Ticket #'); }
    else flags.push('Ticket #: "' + pt + '" vs "' + dt + '"');
  }

  // 5. Date — normalized across format variations (06/10/2025, 6-10-25, June 10 2025, etc.)
  const pdate = parseDate(pending['Date']), ddate = parseDate(delivered.date);
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
    d.driver || '', d.field_ticket_ref || '', new Date().toLocaleDateString('en-US')
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
  const masterLists = getMasterLists();
  const buyerList = masterLists.buyers.length ? 'Known buyers (match deliver_to to the closest one): ' + masterLists.buyers.join(', ') + '. ' : '';
  const prompt = 'You are reading a handwritten FIELD TICKET from Anaqua Farms, Willacy County, Texas. ' +
    'The ticket has printed labels with handwritten values filled in next to or below each label. ' +
    'Read each label carefully and extract the handwritten value next to it. Labels you will see: ' +
    '"Date" (handwritten date), "Producer" (always Anaqua Farms), "Deliver To" (handwritten buyer name), ' +
    '"Field ID #" or "Field ID" (handwritten field/lot number), "Crop" (handwritten crop name), ' +
    '"Harvested By" (always Self), "Truck Owner" (handwritten), "Driver" (handwritten), ' +
    '"Ticket #" or ticket number printed/stamped on the ticket, "Remarks" (any extra handwritten notes). ' +
    'Crop normalization: milo/yellow sorghum/sorghum/gr sorghum/milo maize = "Grain Sorghum". Yellow corn/yell corn/corn = "Corn". ' +
    'Return ONLY raw JSON, no markdown, no backticks. ' +
    'Structure: {"ticket_number":"","date":"","producer":"","deliver_to":"","field_lot":"","crop":"","farm":"","harvested_by":"","truck_owner":"","driver":"","remarks":""} ' +
    'deliver_to is the BUYER — the grain elevator or gin receiving the load. ' +
    buyerList +
    (masterLists.buyers.length
      ? 'For deliver_to: pick the closest matching buyer from the known buyers list above and use that exact name. Even if the handwriting is messy or partially misread, choose the best match from the list. '
      : 'deliver_to should be the grain elevator or gin name written on the ticket. ') +
    'Anaqua Farms is the producer, never the buyer. Capture remarks exactly as written. ' +
    'Field IDs can vary: 3-4 digit number alone, number + location name, number + location + suffix, or two numbers with a dash. Examples: "678", "6788", "6788 HomePlace 3C", "6664 800 North Willacy", "4662-4255". Read every digit carefully — do not drop or add digits. Always return something for field IDs, never null. ' +
    'Common handwriting misreads to watch for in field IDs: 8 can look like 6, A can look like 4, 1 can look like 7, 2 can look like Z, B can look like 8. Look at the full context of the field ID and choose the most consistent interpretation. ' +
    'For ticket_number: look for a stamped, pre-printed, or handwritten number labeled "Ticket #", "Ticket No", "No.", or similar — typically a 4–6 digit integer, often in a box at the top of the ticket. Read every digit carefully. Do NOT confuse with field IDs, dates, or reference numbers. SELF-CHECK: should be a plain 4–6 digit integer. ' +
    'For the date: it is handwritten next to the "Date:" label, read it carefully (format may be M/D/YY or M/D/YYYY). ' +
    'For the driver: look for a handwritten name on the "Driver" line — it is a person\'s name, not a company. ' +
    'Use null only for fields that are truly blank or completely unreadable.';

  const f = JSON.parse(callClaudeSonnet([
    { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: imageB64 } },
    { type: 'text', text: prompt }
  ]));

  if (f.ticket_number) f.ticket_number = parseInt(f.ticket_number.toString().replace(/^0+/, ''), 10) || f.ticket_number;

  const split = extractSplitInfo(f.remarks || '');

  f.farm         = 'Anaqua Farms';
  f.harvested_by = 'Self';
  if (f.driver) f.driver = normalizeName(f.driver, masterLists.drivers);
  if (f.deliver_to && masterLists.buyers.length) {
    const normalized = normalizeBuyer(f.deliver_to, masterLists.buyers);
    // If normalizeBuyer found a match (returned a known buyer), use it.
    // If it returned the original unrecognized value, clear it.
    f.deliver_to = masterLists.buyers.some(b => norm(b) === norm(normalized)) ? normalized : '';
  }

  // Duplicate check — reject if ticket number OR (field+date) already exists in pending or log
  const pendingSheetDup = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const pendingLastDup = pendingSheetDup.getLastRow();
  const logSheetDup = getOrCreateTab(TABS.LOG, LOG_HEADERS);
  const logLastDup = logSheetDup.getLastRow();

  if (f.ticket_number) {
    // Check by ticket number
    const dupNum = String(f.ticket_number).trim().replace(/^0+/, '');
    if (pendingLastDup > 1) {
      const existing = pendingSheetDup.getRange(2, 1, pendingLastDup - 1, 1).getValues().flat();
      if (existing.some(t => String(t).trim().replace(/^0+/, '') === dupNum))
        return { success: false, duplicate: true, message: 'Ticket #' + f.ticket_number + ' is already in Pending Field Tickets.' };
    }
    if (logLastDup > 1) {
      const logTickets = logSheetDup.getRange(2, 5, logLastDup - 1, 1).getValues().flat();
      if (logTickets.some(t => String(t).trim().replace(/^0+/, '') === dupNum))
        return { success: false, duplicate: true, message: 'Ticket #' + f.ticket_number + ' has already been logged.' };
    }
  }

  // Fallback: check by field_lot + date in case ticket number wasn't read
  if (f.field_lot && f.date) {
    const nfl = norm(f.field_lot), ndt = norm(f.date);
    if (pendingLastDup > 1) {
      const pRows = pendingSheetDup.getRange(2, 1, pendingLastDup - 1, PENDING_HEADERS.length).getValues();
      // col 1 = Ticket#, col 2 = Date, col 5 = Field/Lot
      if (pRows.some(r => norm(r[4]) === nfl && norm(r[1]) === ndt))
        return { success: false, duplicate: true, message: 'A ticket for field "' + f.field_lot + '" on ' + f.date + ' is already pending.' };
    }
    if (logLastDup > 1) {
      const lRows = logSheetDup.getRange(2, 1, logLastDup - 1, LOG_HEADERS.length).getValues();
      // col 3 = Field Date, col 11 = Field/Lot
      if (lRows.some(r => norm(r[10]) === nfl && norm(r[2]) === ndt))
        return { success: false, duplicate: true, message: 'A ticket for field "' + f.field_lot + '" on ' + f.date + ' has already been logged.' };
    }
  }

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
      if (ticketMatch || otherMatches >= 3) {
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
    'Crop normalization: milo/yellow sorghum/sorghum/gr sorghum/milo maize = "Grain Sorghum". Yellow corn/yell corn/corn = "Corn". ' +
    'Return ONLY raw JSON, no markdown, no backticks. ' +
    'Structure: {"ticket_number":"","date":"","buyer":"","gross_weight":"","tare_weight":"","net_weight":"","moisture":"","bushel_weight":"","field_lot":"","driver":"","field_ticket_ref":"","crop":""} ' +
    'For field_lot on Willamar Cotton & Grain tickets: find the line with "Sheet #:" — it contains a 6-digit sheet number followed by the field lot (e.g. "Sheet #: 400142 6552-1750" → field_lot = "6552-1750"). Capture only the value after the 6-digit number. ' +
    'For Dirt-Tech Farms / DIRT-TECH FARMS, LLC tickets: buyer = "Dirt-Tech Farms" (the elevator name in the top-left Elevator Section). field_lot = the value under "Lot #". crop = the value under "Product". field_ticket_ref = the value under "OrgTicket". driver = the name in the Transport Section (e.g. BUBBA). ticket_number = the number in the "Ticket In" box. bushel_weight = the value in the "Test Weight" box. ' +
    'For ELKINS GRAIN, LLC. / GSI INTL tickets (look for "Elevator Section" in the top-LEFT with "ELKINS GRAIN, LLC." or "GSI INTL"): buyer = "Elkins Grain". field_lot = the value under "ORGWEIGHT". field_ticket_ref = the value under "Org Ticket". Note: the "Lot Number" field on these tickets identifies the producer — do NOT use it as field_lot. ' +
    'Field IDs on these tickets can vary in format. They may be a 3 or 4 digit number alone, a number followed by a location name, a number followed by a location name and letter/number suffix, or two numbers separated by a dash. Examples: "678", "6788", "6788 HomePlace 3C", "6664 800 North Willacy", "4662-4255". Read every digit carefully and completely — do not drop or add digits. If a digit is unclear, make your best guess based on the surrounding context and handwriting style. Always return something rather than null for field IDs. ' +
    'For field_ticket_ref: find any of these — ANAQ followed by digits (e.g. ANAQ4520), or a value next to Ref:, ORG Ticket, Field Ticket, or Load #. Capture full raw text. ' +
    'For ticket_number: find the scale ticket number — a 4–6 digit integer in a prominent box or field labeled "Ticket #", "Ticket No.", "Scale Ticket", "Ticket In", or similar near the top of the ticket. Read every digit carefully. Do NOT confuse with lot numbers, sheet numbers, org ticket references, weight scale IDs, or any other number on the ticket. SELF-CHECK: should be a plain 4–6 digit integer with no letters or special characters. ' +
    'For gross_weight, tare_weight, and net_weight: these are weights in pounds — always large whole numbers with no decimal point. Read each value DIRECTLY from the ticket by finding its specific label — gross_weight is next to "GROSS" or "GROSS WEIGHT", tare_weight is next to "TARE" or "TARE WEIGHT", net_weight is next to "NET" or "NET WEIGHT" or "NET WT". Do NOT compute net_weight by subtracting tare from gross — the ticket prints all three and you must read each one independently from its own label. Gross is typically 55,000–85,000, tare 25,000–35,000 (never less than 20,000), net 30,000–65,000. They are printed with a comma thousands separator (e.g. "74,780" or "74780"). The comma is NOT a decimal point — return "74780", never "74.78". SELF-CHECK: if gross or net is less than 1,000, or if tare is less than 20,000, or if any weight contains a decimal point, you have misread it — re-examine the ticket and correct it before returning. ' +
    'For moisture: a small decimal percentage, always between 10.0 and 25.0 (e.g. 15.4, not 154 or 15400). If you read a value over 25, you have likely misread a decimal point — re-examine and correct it. ' +
    'For bushel_weight: look for a value labeled "Test Weight", "Bushel Weight", "Lbs/Bu", "TW", or "Test Wt". A small decimal number, always between 50.0 and 65.0 (e.g. 60.2, not 602 or 60200). If you read a value over 65, you have likely misread a decimal point — re-examine and correct it. ' +
    'For driver: look for a person\'s name labeled as driver, hauler, or trucker. Never use weight labels (Tare, Gross, Net, WT), dates, ticket numbers, or field labels as the driver name. Use null if no clear driver name is present. ' +
    'For the date: today is ' + new Date().toLocaleDateString('en-US') + '. This ticket was issued very recently — the date should be within the last 1–2 days. Use this as context if any part of the date is unclear or the year/month is ambiguous. ' +
    'Use null for unreadable fields. Never guess numbers.';

  const d = JSON.parse(callClaude([
    { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: imageB64 } },
    { type: 'text', text: prompt }
  ]));

  if (d.ticket_number) d.ticket_number = parseInt(d.ticket_number.toString().replace(/^0+/, ''), 10) || d.ticket_number;

  const masterLists = getMasterLists();
  if (d.driver) d.driver = normalizeName(d.driver, masterLists.drivers);
  if (d.buyer)  d.buyer  = normalizeBuyer(d.buyer, masterLists.buyers);

  // Duplicate check — reject if ticket number already exists in pending delivered or log
  if (d.ticket_number) {
    const dupNum = String(d.ticket_number).trim().replace(/^0+/, '');
    const dpDupSheet = getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS);
    const dpDupLast = dpDupSheet.getLastRow();
    if (dpDupLast > 1) {
      const existing = dpDupSheet.getRange(2, 1, dpDupLast - 1, 1).getValues().flat();
      if (existing.some(t => String(t).trim().replace(/^0+/, '') === dupNum))
        return { success: false, duplicate: true, message: 'Delivered ticket #' + d.ticket_number + ' is already in Pending Delivered.' };
    }
    const logDupSheet = getOrCreateTab(TABS.LOG, LOG_HEADERS);
    const logDupLast = logDupSheet.getLastRow();
    if (logDupLast > 1) {
      const logTickets = logDupSheet.getRange(2, 6, logDupLast - 1, 1).getValues().flat();
      if (logTickets.some(t => String(t).trim().replace(/^0+/, '') === dupNum))
        return { success: false, duplicate: true, message: 'Delivered ticket #' + d.ticket_number + ' has already been logged.' };
    }
  }

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
    if (ticketMatch || otherMatches >= 3) {
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
  if (payload.deliveredPendingRow) deleteDeliveredPending(payload.deliveredPendingRow);
  const sheet = getOrCreateTab(TABS.LOG, LOG_HEADERS);
  const loadNum = sheet.getLastRow();
  const buyer = (d.buyer && !norm(d.buyer).includes('anaqua')) ? d.buyer : '';
  sheet.appendRow([
    loadNum, new Date().toLocaleDateString('en-US'),
    '', d.date || '',
    '', d.ticket_number || '',
    d.driver || '', '',
    d.crop || '', '',
    '', d.field_lot || '',
    '', buyer,
    d.gross_weight || '', d.tare_weight || '',
    d.net_weight || '',
    d.moisture || '', d.bushel_weight || '',
    'No', '',
    0, 'manual', '', 'No field ticket — needs review', 'No'
  ]);
  const row = sheet.getLastRow();
  sheet.getRange(row, 1, 1, LOG_HEADERS.length).setBackground('#fde8e8');
  return { success: true, row };
}

function getCandidatesForDelivered(payload) {
  const dpSheet = getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS);
  const rowData = dpSheet.getRange(payload.deliveredPendingRow, 1, 1, DELIVERED_PENDING_HEADERS.length).getValues()[0];
  const dp = {};
  DELIVERED_PENDING_HEADERS.forEach((h, i) => { dp[h] = rowData[i]; });
  const delivered = {
    driver: dp['Driver'], buyer: dp['Buyer'], field_lot: dp['Field Lot'],
    field_ticket_ref: dp['Field Ticket Ref'], date: dp['Date'], ticket_number: dp['Ticket #']
  };
  const pendingSheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const lastRow = pendingSheet.getLastRow();
  if (lastRow <= 1) return { success: true, candidates: [] };
  const pendingData = pendingSheet.getRange(2, 1, lastRow - 1, PENDING_HEADERS.length).getValues();
  const pending = pendingData.map((row, i) => {
    const obj = {};
    PENDING_HEADERS.forEach((h, j) => { obj[h] = row[j]; });
    obj._row = i + 2;
    return obj;
  });
  const scored = pending.map(p => ({ pending: p, ...scoreMatch(p, delivered) })).sort((a, b) => b.score - a.score);
  return { success: true, candidates: scored.slice(0, 5).map(s => ({ pending: s.pending, score: s.score, matched: s.matched, flags: s.flags })) };
}

function manualMatch(payload) {
  const { pendingRow, deliveredData, matchedFields, flags, deliveredPendingRow } = payload;
  const pendingSheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const rowData = pendingSheet.getRange(pendingRow, 1, 1, PENDING_HEADERS.length).getValues()[0];
  const pending = {};
  PENDING_HEADERS.forEach((h, i) => { pending[h] = rowData[i]; });
  pending._row = pendingRow;
  const loadRow = writeMatchedLoad(pending, deliveredData, matchedFields || [], flags || ['Manually matched'], 0);
  deletePendingRow(pendingSheet, pendingRow);
  if (deliveredPendingRow) deleteDeliveredPending(deliveredPendingRow);
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
    pending['Ticket #'] || '', delivered.ticket_number || '',
    pending['Driver'] || delivered.driver || '', pending['Truck Owner'] || '',
    delivered.crop || '', pending['Farm'] || '',
    pending['Field / Lot'] || '', delivered.field_lot || '',
    pending['Producer'] || '', buyer || '',
    delivered.gross_weight || '', delivered.tare_weight || '',
    delivered.net_weight || '',
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

function deletePending(row) {
  getOrCreateTab(TABS.PENDING, PENDING_HEADERS).deleteRow(row);
  return { success: true };
}

function deleteDeliveredPending(row) {
  getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS).deleteRow(row);
  return { success: true };
}

function deleteLog(row) {
  getOrCreateTab(TABS.LOG, LOG_HEADERS).deleteRow(row);
  return { success: true };
}

function getMasterLists() {
  const sheet = getOrCreateTab(TABS.MASTER_LISTS, ['Drivers', 'Buyers', 'Fields']);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { drivers: [], buyers: [], fields: [] };
  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  return {
    drivers: data.map(r => r[0]).filter(Boolean),
    buyers:  data.map(r => r[1]).filter(Boolean),
    fields:  data.map(r => r[2]).filter(Boolean)
  };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) { dp[i] = [i]; for (let j = 1; j <= n; j++) dp[i][j] = 0; }
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

function ocrTolerance(minLen) {
  return minLen <= 5 ? 2 : Math.max(1, Math.floor(minLen / 5));
}

function normalizeName(raw, masterList) {
  if (!raw || !masterList || !masterList.length) return raw;
  const n = norm(raw);
  for (const name of masterList) { if (norm(name) === n) return name; }
  for (const name of masterList) { if (fuzzyName(n, norm(name))) return name; }
  // Levenshtein on full name — short strings (≤5 chars) allow 2 edits to catch codes like UREI→URIEL
  for (const name of masterList) {
    const nn = norm(name);
    if (levenshtein(n, nn) <= ocrTolerance(Math.min(n.length, nn.length))) return name;
  }
  // Word-level Levenshtein — catches "bobba"→"Bubba Castillo", "micky"→"Mickey Ramirez"
  for (const name of masterList) {
    const words = norm(name).split(/\s+/).filter(w => w.length >= 4);
    for (const word of words) {
      if (levenshtein(n, word) <= ocrTolerance(Math.min(n.length, word.length))) return name;
    }
  }
  return raw;
}

function normalizeBuyer(raw, buyerList) {
  if (!raw || !buyerList || !buyerList.length) return raw;
  const n = norm(raw);
  for (const name of buyerList) { if (norm(name) === n) return name; }
  for (const name of buyerList) { if (fuzzyBuyer(n, norm(name))) return name; }
  // Levenshtein on noise-stripped versions — use a generous tolerance for buyers
  // since OCR can badly mangle short words (e.g. "Dirt Bedi" → "Dirt-Tech Farms")
  const sn = stripNoise(raw);
  if (sn) {
    let bestName = null, bestDist = Infinity;
    for (const name of buyerList) {
      const snn = stripNoise(name);
      if (!snn) continue;
      const dist = levenshtein(sn, snn);
      const tol = Math.max(3, Math.floor(Math.min(sn.length, snn.length) / 2));
      if (dist <= tol && dist < bestDist) { bestDist = dist; bestName = name; }
    }
    if (bestName) return bestName;
  }
  return raw;
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

function initSheets() {
  getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  getOrCreateTab(TABS.DELIVERED_PENDING, DELIVERED_PENDING_HEADERS);
  getOrCreateTab(TABS.LOG, LOG_HEADERS);
  getOrCreateTab(TABS.MASTER_LISTS, ['Drivers', 'Buyers']);
  return { success: true };
}

function testDuplicateCheck() {
  const ticketNum = '4902'; // Change this to a ticket number that IS in your sheet
  const dupNum = String(ticketNum).trim().replace(/^0+/, '');

  const pendingSheet = getOrCreateTab(TABS.PENDING, PENDING_HEADERS);
  const pendingLast = pendingSheet.getLastRow();
  Logger.log('Pending rows: ' + (pendingLast - 1));
  if (pendingLast > 1) {
    const existing = pendingSheet.getRange(2, 1, pendingLast - 1, 1).getValues().flat();
    Logger.log('Pending ticket numbers: ' + JSON.stringify(existing.map(t => String(t).trim())));
    Logger.log('Looking for: "' + dupNum + '"');
    Logger.log('Match found in pending: ' + existing.some(t => String(t).trim().replace(/^0+/, '') === dupNum));
  }

  const logSheet = getOrCreateTab(TABS.LOG, LOG_HEADERS);
  const logLast = logSheet.getLastRow();
  Logger.log('Log rows: ' + (logLast - 1));
  if (logLast > 1) {
    const logTickets = logSheet.getRange(2, 5, logLast - 1, 1).getValues().flat();
    Logger.log('Log field ticket numbers: ' + JSON.stringify(logTickets.map(t => String(t).trim())));
    Logger.log('Match found in log: ' + logTickets.some(t => String(t).trim().replace(/^0+/, '') === dupNum));
  }
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