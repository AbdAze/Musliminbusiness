/*
 * MIB MEMBERSHIP + RAZORPAY GOOGLE APPS SCRIPT BACKEND
 *
 * Flow:
 * Personal Info -> Business Info -> Terms -> Razorpay Payment
 * -> Server-side Verification -> Registration Saved -> Done
 *
 * SETUP:
 * 1. Paste this entire file into Google Apps Script.
 * 2. Put your Razorpay Key ID and Key Secret into the script properties
 *    using the setConfig() function below, then run setConfig() once.
 * 3. Optionally put an existing Google Spreadsheet ID in SPREADSHEET_ID.
 *    If left blank, the script creates a spreadsheet automatically.
 * 4. Deploy as Web app: Execute as Me, Who has access: Anyone.
 * 5. Put the deployed /exec URL into SCRIPT_URL in join.html.
 *
 * NEVER put the Razorpay Key Secret into your public HTML.
 */

const CONFIG = {
  // If you already have a registration spreadsheet, put its ID here.
  // Otherwise leave blank and the script will create one automatically.
  SPREADSHEET_ID: '',

  REGISTRATION_SHEET: 'Registrations',
  ORDERS_SHEET: 'PaymentOrders',
  DRIVE_FOLDER_NAME: 'MIB Member Uploads',

  INDIA_AMOUNT: 500000, // INR 5,000 in paise
  INDIA_CURRENCY: 'INR',

  INTERNATIONAL_AMOUNT: 10000, // USD 100 in cents
  INTERNATIONAL_CURRENCY: 'USD'
};


/* =========================
   ONE-TIME CONFIGURATION
   ========================= */

function setConfig() {
  // EDIT ONLY THESE TWO VALUES, run this function once, then remove them
  // from this function if you want an extra layer of safety.
  const RAZORPAY_KEY_ID = 'PASTE_RAZORPAY_KEY_ID_HERE';
  const RAZORPAY_KEY_SECRET = 'PASTE_RAZORPAY_KEY_SECRET_HERE';

  if (RAZORPAY_KEY_ID.includes('PASTE_') || RAZORPAY_KEY_SECRET.includes('PASTE_')) {
    throw new Error('Open setConfig(), paste your Razorpay Key ID and Key Secret, then run setConfig() again.');
  }

  PropertiesService.getScriptProperties().setProperties({
    RAZORPAY_KEY_ID: RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: RAZORPAY_KEY_SECRET
  }, true);

  Logger.log('Razorpay credentials saved to Script Properties.');
}


/* =========================
   WEB APP ENTRY POINTS
   ========================= */

function doGet() {
  return jsonResponse_({
    success: true,
    service: 'MIB Razorpay Membership Backend',
    status: 'online'
  });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ success: false, message: 'Empty request.' });
    }

    const data = JSON.parse(e.postData.contents);

    switch (data.action) {
      case 'createRazorpayOrder':
        return createRazorpayOrder_(data);

      case 'verifyPaymentAndSave':
        return verifyPaymentAndSave_(data);

      default:
        return jsonResponse_({
          success: false,
          message: 'Invalid action.'
        });
    }

  } catch (error) {
    console.error(error);
    return jsonResponse_({
      success: false,
      message: error && error.message ? error.message : 'Unexpected server error.'
    });
  }
}


/* =========================
   RAZORPAY ORDER CREATION
   ========================= */

function createRazorpayOrder_(data) {
  const credentials = getRazorpayCredentials_();

  const plan = String(data.membershipPlan || '').toLowerCase();

  // IMPORTANT: amount is decided here, not by the browser.
  const pricing = getPlanPricing_(plan);

  if (!data.customerName || !data.customerEmail || !data.customerPhone) {
    throw new Error('Customer name, email and phone are required.');
  }

  const receipt = 'MIB' + Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || 'Asia/Kolkata',
    'yyyyMMddHHmmss'
  ) + Math.floor(Math.random() * 1000);

  const orderPayload = {
    amount: pricing.amount,
    currency: pricing.currency,
    receipt: receipt,
    notes: {
      membership_plan: pricing.planName,
      customer_name: String(data.customerName).slice(0, 250),
      customer_email: String(data.customerEmail).slice(0, 250)
    },
    partial_payment: false,
    capture: 'automatic'
  };

  const response = razorpayFetch_('/v1/orders', 'post', orderPayload, credentials);
  const order = response.data;

  if (!order || !order.id) {
    throw new Error('Razorpay did not return an order ID.');
  }

  // Store the server-created order so verification never trusts the order ID
  // supplied by the browser as the source of truth.
  const sheet = getOrdersSheet_();
  sheet.appendRow([
    new Date(),
    order.id,
    pricing.planKey,
    pricing.planName,
    pricing.amount,
    pricing.currency,
    receipt,
    String(data.customerName || ''),
    String(data.customerEmail || ''),
    String(data.customerPhone || ''),
    'CREATED',
    '',
    '',
    ''
  ]);

  return jsonResponse_({
    success: true,
    keyId: credentials.keyId,
    orderId: order.id,
    amount: pricing.amount,
    currency: pricing.currency,
    plan: pricing.planKey,
    displayAmount: pricing.displayAmount
  });
}


/* =========================
   PAYMENT VERIFICATION + SAVE
   ========================= */

function verifyPaymentAndSave_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const credentials = getRazorpayCredentials_();

    const paymentId = String(data.razorpayPaymentId || '');
    const callbackOrderId = String(data.razorpayOrderId || '');
    const receivedSignature = String(data.razorpaySignature || '');

    if (!paymentId || !callbackOrderId || !receivedSignature) {
      throw new Error('Incomplete Razorpay payment response.');
    }

    // Find the order created by our server.
    const orderRecord = findOrderRecord_(callbackOrderId);

    if (!orderRecord) {
      throw new Error('Razorpay order could not be found on the server.');
    }

    const serverOrderId = orderRecord.orderId;
    const expectedAmount = Number(orderRecord.amount);
    const expectedCurrency = String(orderRecord.currency);

    // Idempotency: if this payment was already saved, do not create a duplicate registration.
    const existingRegistration = findRegistrationByPaymentId_(paymentId);
    if (existingRegistration) {
      return jsonResponse_({
        success: true,
        paymentVerified: true,
        registrationSaved: true,
        alreadySaved: true
      });
    }

    // Razorpay signature verification MUST use the order ID stored on the server,
    // not an untrusted order ID from the browser.
    const generatedSignature = generateHmacHex_(
      serverOrderId + '|' + paymentId,
      credentials.keySecret
    );

    if (!constantTimeEqual_(generatedSignature, receivedSignature)) {
      updateOrderStatus_(callbackOrderId, 'SIGNATURE_FAILED', paymentId, '', 'Invalid signature');
      throw new Error('Payment signature verification failed.');
    }

    // Fetch the payment from Razorpay and verify amount, currency and order.
    let payment = getRazorpayPayment_(paymentId, credentials);

    if (!payment || payment.order_id !== serverOrderId) {
      updateOrderStatus_(callbackOrderId, 'ORDER_MISMATCH', paymentId, '', 'Payment does not belong to server order');
      throw new Error('Payment/order mismatch.');
    }

    if (Number(payment.amount) !== expectedAmount || String(payment.currency) !== expectedCurrency) {
      updateOrderStatus_(callbackOrderId, 'AMOUNT_MISMATCH', paymentId, payment.status || '', 'Amount or currency mismatch');
      throw new Error('Payment amount or currency does not match the membership order.');
    }

    // If it is authorized, capture it using the server-stored amount.
    if (payment.status === 'authorized') {
      captureRazorpayPayment_(paymentId, expectedAmount, expectedCurrency, credentials);
      payment = getRazorpayPayment_(paymentId, credentials);
    }

    if (!payment || payment.status !== 'captured' || payment.captured !== true) {
      updateOrderStatus_(callbackOrderId, 'NOT_CAPTURED', paymentId, payment ? payment.status : '', 'Payment is not captured');
      throw new Error('Payment is genuine but has not reached the captured state yet. Please contact MIB support with Payment ID: ' + paymentId);
    }

    // Payment is now verified and captured. Save the registration only now.
    const registrationResult = saveRegistration_(data, orderRecord, payment);

    updateOrderStatus_(
      callbackOrderId,
      'PAID',
      paymentId,
      payment.status,
      registrationResult.rowNumber ? 'Registration saved' : ''
    );

    return jsonResponse_({
      success: true,
      paymentVerified: true,
      registrationSaved: true,
      paymentId: paymentId,
      orderId: serverOrderId,
      registrationRow: registrationResult.rowNumber
    });

  } finally {
    lock.releaseLock();
  }
}


/* =========================
   REGISTRATION STORAGE
   ========================= */

function saveRegistration_(data, orderRecord, payment) {
  const sheet = getRegistrationsSheet_();

  const photoUrl = saveDataUrlToDrive_(
    data.photoData,
    data.photoName,
    'Photo'
  );

  const logoUrl = saveDataUrlToDrive_(
    data.logoData,
    data.logoName,
    'Business Logo'
  );

  const row = [
    new Date(),

    data.referenceType || '',
    data.referenceName || '',
    data.referenceNumber || '',
    data.referencePlatform || '',

    data.fullName || '',
    data.email || '',
    data.dob || '',
    data.gender || '',
    data.mobile || '',
    data.whatsapp || '',
    data.address || '',
    data.country || '',
    data.city || '',
    photoUrl,

    data.businessName || '',
    data.businessType || '',
    data.industryType || '',
    data.businessPhone || '',
    data.businessAddress || '',
    data.businessEmailWeb || '',
    data.employees || '',
    data.yearsInBusiness || '',
    data.businessDescription || '',
    logoUrl,

    orderRecord.planName,
    orderRecord.amount,
    orderRecord.currency,

    payment.id || '',
    payment.order_id || '',
    payment.status || '',
    payment.method || '',
    payment.email || '',
    payment.contact || '',
    payment.international === true ? 'Yes' : 'No',

    'Verified',
    'Paid'
  ];

  sheet.appendRow(row);

  return {
    rowNumber: sheet.getLastRow()
  };
}


/* =========================
   GOOGLE SHEETS SETUP
   ========================= */

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let spreadsheetId = CONFIG.SPREADSHEET_ID;

  if (!spreadsheetId) {
    spreadsheetId = props.getProperty('SPREADSHEET_ID') || '';
  }

  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const ss = SpreadsheetApp.create('MIB Membership Registrations');
  props.setProperty('SPREADSHEET_ID', ss.getId());

  return ss;
}

function getRegistrationsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.REGISTRATION_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.REGISTRATION_SHEET);
  }

  ensureRegistrationHeaders_(sheet);
  return sheet;
}

function getOrdersSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.ORDERS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORDERS_SHEET);
  }

  ensureOrderHeaders_(sheet);
  return sheet;
}

function ensureRegistrationHeaders_(sheet) {
  if (sheet.getLastRow() > 0) return;

  sheet.appendRow([
    'Timestamp',
    'Reference Type',
    'Reference Name',
    'Reference Number',
    'Reference Platform',
    'Full Name',
    'Email',
    'Date of Birth',
    'Gender',
    'Mobile',
    'WhatsApp',
    'Residential Address',
    'Country',
    'City',
    'Photo URL',
    'Business Name',
    'Business Type',
    'Industry',
    'Business Phone',
    'Business Address',
    'Business Email / Website',
    'Employees',
    'Years in Business',
    'Business Description',
    'Business Logo URL',
    'Membership Plan',
    'Amount Subunit',
    'Currency',
    'Razorpay Payment ID',
    'Razorpay Order ID',
    'Payment Status',
    'Payment Method',
    'Payment Email',
    'Payment Contact',
    'International Payment',
    'Verification Status',
    'Registration Status'
  ]);

  sheet.setFrozenRows(1);
}

function ensureOrderHeaders_(sheet) {
  if (sheet.getLastRow() > 0) return;

  sheet.appendRow([
    'Created At',
    'Razorpay Order ID',
    'Plan Key',
    'Plan Name',
    'Amount Subunit',
    'Currency',
    'Receipt',
    'Customer Name',
    'Customer Email',
    'Customer Phone',
    'Status',
    'Payment ID',
    'Payment Status',
    'Notes'
  ]);

  sheet.setFrozenRows(1);
}


/* =========================
   ORDER RECORD HELPERS
   ========================= */

function findOrderRecord_(orderId) {
  const sheet = getOrdersSheet_();
  const values = sheet.getDataRange().getValues();

  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][1]) === orderId) {
      return {
        rowNumber: i + 1,
        createdAt: values[i][0],
        orderId: String(values[i][1]),
        planKey: String(values[i][2]),
        planName: String(values[i][3]),
        amount: Number(values[i][4]),
        currency: String(values[i][5]),
        receipt: String(values[i][6]),
        customerName: String(values[i][7]),
        customerEmail: String(values[i][8]),
        customerPhone: String(values[i][9]),
        status: String(values[i][10] || ''),
        paymentId: String(values[i][11] || '')
      };
    }
  }

  return null;
}

function updateOrderStatus_(orderId, status, paymentId, paymentStatus, notes) {
  const sheet = getOrdersSheet_();
  const record = findOrderRecord_(orderId);
  if (!record) return;

  sheet.getRange(record.rowNumber, 11).setValue(status);
  sheet.getRange(record.rowNumber, 12).setValue(paymentId || '');
  sheet.getRange(record.rowNumber, 13).setValue(paymentStatus || '');
  sheet.getRange(record.rowNumber, 14).setValue(notes || '');
}

function findRegistrationByPaymentId_(paymentId) {
  const sheet = getRegistrationsSheet_();
  const values = sheet.getDataRange().getValues();

  // Razorpay Payment ID is column 29 in the registration sheet.
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][28]) === paymentId) {
      return {
        rowNumber: i + 1
      };
    }
  }

  return null;
}


/* =========================
   RAZORPAY API HELPERS
   ========================= */

function getRazorpayCredentials_() {
  const props = PropertiesService.getScriptProperties();
  const keyId = props.getProperty('RAZORPAY_KEY_ID');
  const keySecret = props.getProperty('RAZORPAY_KEY_SECRET');

  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials are not configured. Run setConfig() once in Apps Script.');
  }

  return {
    keyId: keyId,
    keySecret: keySecret
  };
}

function razorpayFetch_(path, method, payload, credentials) {
  const auth = Utilities.base64Encode(
    credentials.keyId + ':' + credentials.keySecret
  );

  const options = {
    method: method || 'get',
    headers: {
      Authorization: 'Basic ' + auth
    },
    muteHttpExceptions: true
  };

  if (payload !== undefined && payload !== null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(
    'https://api.razorpay.com' + path,
    options
  );

  const code = response.getResponseCode();
  const text = response.getContentText();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }

  if (code < 200 || code >= 300) {
    const description = data && data.error && data.error.description
      ? data.error.description
      : 'Razorpay API request failed with HTTP ' + code;

    throw new Error(description);
  }

  return {
    statusCode: code,
    data: data
  };
}

function getRazorpayPayment_(paymentId, credentials) {
  return razorpayFetch_(
    '/v1/payments/' + encodeURIComponent(paymentId),
    'get',
    null,
    credentials
  ).data;
}

function captureRazorpayPayment_(paymentId, amount, currency, credentials) {
  return razorpayFetch_(
    '/v1/payments/' + encodeURIComponent(paymentId) + '/capture',
    'post',
    {
      amount: amount,
      currency: currency
    },
    credentials
  ).data;
}


/* =========================
   SECURITY HELPERS
   ========================= */

function generateHmacHex_(message, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    message,
    secret
  );

  return bytes.map(function(byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');

  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);

  for (let i = 0; i < max; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }

  return diff === 0;
}


/* =========================
   PRICING
   ========================= */

function getPlanPricing_(plan) {
  if (plan === 'india') {
    return {
      planKey: 'india',
      planName: 'India Membership',
      amount: CONFIG.INDIA_AMOUNT,
      currency: CONFIG.INDIA_CURRENCY,
      displayAmount: '₹5,000'
    };
  }

  if (plan === 'intl') {
    return {
      planKey: 'intl',
      planName: 'International Membership',
      amount: CONFIG.INTERNATIONAL_AMOUNT,
      currency: CONFIG.INTERNATIONAL_CURRENCY,
      displayAmount: '$100'
    };
  }

  throw new Error('Invalid membership plan.');
}


/* =========================
   DRIVE FILE STORAGE
   ========================= */

function saveDataUrlToDrive_(dataUrl, originalName, label) {
  if (!dataUrl) return '';

  if (String(dataUrl).indexOf('data:') !== 0) {
    throw new Error(label + ' upload is invalid.');
  }

  const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) {
    throw new Error(label + ' upload could not be decoded.');
  }

  const mimeType = match[1];
  const base64 = match[2];
  const bytes = Utilities.base64Decode(base64);

  const blob = Utilities.newBlob(
    bytes,
    mimeType,
    sanitizeFileName_(originalName || label)
  );

  const folder = getDriveFolder_();
  const file = folder.createFile(blob);

  return file.getUrl();
}

function getDriveFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folderId = props.getProperty('DRIVE_FOLDER_ID');

  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // Folder was deleted or inaccessible. Create a new one below.
    }
  }

  const folder = DriveApp.createFolder(CONFIG.DRIVE_FOLDER_NAME);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function sanitizeFileName_(name) {
  const clean = String(name)
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);

  return clean || 'upload';
}


/* =========================
   JSON RESPONSE
   ========================= */

function jsonResponse_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}
