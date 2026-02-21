// ============================================================
//  SPICE GARDEN — Google Apps Script Backend (v2.0)
//  Deploy as: Web App | Execute as: Me | Access: Anyone
//  Features: Row-locking, Email Notifications, Data Validation
// ============================================================

/*  ▼▼▼ PASTE YOUR GOOGLE SHEET ID HERE ▼▼▼  */
var SHEET_ID = "1Vzg24qhxg858tPeYjUvGtX0xVwupeFZvq-mNCX3fS4w";
var SHEET_NAME = "Bookings";

// ============================================================
//  COLUMN MAPPING & CONFIG
// ============================================================
var HEADERS = [
  "Booking Ref",      //  0
  "Employee No",      //  1
  "Customer Name",    //  2
  "Phone",            //  3
  "Email",            //  4
  "Table No.",        //  5
  "Table ID",         //  6
  "Date",             //  7
  "Time",             //  8
  "Guests",           //  9
  "Guest Orders",     // 10
  "Special Requests", // 11
  "Booking Type",     // 12
  "Status",           // 13
  "Submitted At"      // 14
];

var CFG = {
  lockWaitMs: 30000,    // Wait up to 30s for a lock
  slotDurationMin: 120, // 2 hours
  adminEmail: ""        // Optional: "admin@spicegarden.com"
};

// ============================================================
//  POST — CREATE BOOKING
// ============================================================
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 1. Try to acquire lock
    if (!lock.tryLock(CFG.lockWaitMs)) {
      return jsonResponse({ success: false, error: "System busy. Please try again in a moment." });
    }

    // 2. Parse Data
    var data = JSON.parse(e.postData.contents);
    var sheet = getSheet();

    // 3. Validation
    var validation = validateBooking(data);
    if (!validation.valid) {
      return jsonResponse({ success: false, error: validation.error });
    }

    // 4. Concurrency Check: Is table still free? (SKIP if Food Only)
    if (data.type !== "FOOD" && !isTableFree(sheet, data.table_id, data.date, data.time)) {
      return jsonResponse({ success: false, error: "This table has already been booked for this date and time slot. Please choose another table or time." });
    }

    // 4b. Employee Limit Check: One per specific time slot
    if (isEmployeeBooked(sheet, data.emp_no, data.date, data.time)) {
      return jsonResponse({ success: false, error: "You already have a booking for this specific time slot. Please choose another time or table." });
    }

    // 5. Prepare Row Data
    var guestOrders = "";
    if (Array.isArray(data.guest_dishes) && data.guest_dishes.length) {
      guestOrders = data.guest_dishes.join(" | ");
    } else if (data.menu) {
      guestOrders = data.menu;
    }

    var row = [
      data.ref,
      data.emp_no,
      data.name,
      "'" + data.phone, // Force string to prevent scientific notation
      data.email,
      data.table,
      data.table_id,
      data.date,
      data.time,
      data.guests,
      guestOrders,
      data.special,
      data.type || "BOTH",
      "Confirmed",
      new Date().toLocaleString()
    ];

    // 6. Write to Sheet
    sheet.appendRow(row);

    // 7. (Email Removed)
    // sendConfirmationEmail(data);

    return jsonResponse({ success: true, ref: data.ref });

  } catch (err) {
    return jsonResponse({ success: false, error: "Server Error: " + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  GET — READ / UPDATE
// ============================================================
function doGet(e) {
  var lock = LockService.getScriptLock();
  try {
    var params = e.parameter;
    var action = params.action || "all";

    /* ---- USER REGISTER ---- (no Bookings sheet needed) */
    if (action === "register") {
      var name = (params.name || "").trim();
      var mobile = (params.mobile || "").trim();
      var pass = (params.password || "").trim();
      if (!name || !mobile || !pass) {
        return jsonResponse({ success: false, error: "Name, Mobile and Password are required." });
      }
      var userSheet = getUserSheet();
      var uData = getUserData(userSheet);
      var exists = uData.some(function (u) { return u["Mobile"] === mobile; });
      if (exists) {
        return jsonResponse({ success: false, error: "Mobile number already registered." });
      }
      userSheet.appendRow([name, mobile, pass, new Date().toISOString()]);
      return jsonResponse({ success: true, name: name, mobile: mobile });
    }

    /* ---- USER LOGIN ---- (no Bookings sheet needed) */
    if (action === "login") {
      var mobile = (params.mobile || "").trim();
      var pass = (params.password || "").trim();
      if (!mobile || !pass) {
        return jsonResponse({ success: false, error: "Mobile and Password are required." });
      }
      var userSheet = getUserSheet();
      var uData = getUserData(userSheet);
      var user = uData.find(function (u) { return u["Mobile"] === mobile && u["Password"] === pass; });
      if (user) {
        return jsonResponse({ success: true, name: user["Name"], mobile: user["Mobile"] });
      } else {
        return jsonResponse({ success: false, error: "Invalid mobile or password." });
      }
    }

    /* ---- All other actions need the Bookings sheet ---- */
    var sheet = getSheet();

    /* ---- UPDATE (Atomic) ---- */
    if (action === "update") {
      if (!lock.tryLock(10000)) return jsonResponse({ success: false, error: "Busy" });
      try {
        var updateData = JSON.parse(params.data);
        return jsonResponse(updateRow(sheet, params.ref, updateData));
      } finally { lock.releaseLock(); }
    }

    /* ---- STATUS (Atomic) ---- */
    if (action === "status") {
      if (!lock.tryLock(10000)) return jsonResponse({ success: false, error: "Busy" });
      try {
        var res = updateStatus(sheet, params.ref, params.status);
        return jsonResponse(res);
      } finally { lock.releaseLock(); }
    }

    /* ---- CANCEL (Legacy, redirects to status) ---- */
    if (action === "cancel") {
      if (!lock.tryLock(10000)) return jsonResponse({ success: false, error: "Busy" });
      try {
        var res = updateStatus(sheet, params.ref, "Cancelled");
        return jsonResponse(res);
      } finally { lock.releaseLock(); }
    }

    /* ---- DELETE (Atomic) ---- */
    if (action === "delete") {
      if (!lock.tryLock(10000)) return jsonResponse({ success: false, error: "Busy" });
      try {
        return jsonResponse(deleteRow(sheet, params.ref));
      } finally { lock.releaseLock(); }
    }

    /* ---- READ Operations (No Lock needed) ---- */
    var rows = getData(sheet);
    var nowT = params.time || getCurrentTimeString();
    var today = params.date || getTodayString();

    if (action === "today") {
      var targetDate = formatDateString(today);
      // Return ALL bookings for this date so frontend can calc slots
      var booked = rows.filter(function (b) {
        return formatDateString(b["Date"]) == targetDate && b["Status"] !== "Cancelled";
      });
      return jsonResponse({ success: true, bookings: booked });
    }

    if (action === "history") {
      // Accept phone (new) or emp (legacy fallback)
      var phoneQuery = (params.phone || params.emp || "").toLowerCase().trim().replace(/^'+/, "");
      var history = rows.filter(function (b) {
        var rowPhone = String(b["Phone"]).toLowerCase().trim().replace(/^'+/, "");
        var rowEmp = String(b["Employee No"]).toLowerCase().trim();
        return rowPhone === phoneQuery || rowEmp === phoneQuery;
      });
      // Sort newest first
      history.sort(function (a, b) {
        var d1 = new Date(formatDateString(a["Date"]) + " " + (a["Time"] || "00:00"));
        var d2 = new Date(formatDateString(b["Date"]) + " " + (b["Time"] || "00:00"));
        return d2 - d1;
      });
      return jsonResponse({ success: true, bookings: history });
    }

    // Default: action=all
    return jsonResponse({ success: true, bookings: rows });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}


// ============================================================
//  CORE LOGIC
// ============================================================

function getSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold").setBackground("#F0F4F8");
  }
  return sheet;
}

/* ---- Users Sheet helpers ---- */
var USER_HEADERS = ["Name", "Mobile", "Password", "Created At"];

function getUserSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName("Users");
  if (!sheet) {
    sheet = ss.insertSheet("Users");
    sheet.appendRow(USER_HEADERS);
    sheet.getRange(1, 1, 1, USER_HEADERS.length).setFontWeight("bold").setBackground("#E8F5E9");
  }
  return sheet;
}

function getUserData(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, USER_HEADERS.length).getValues();
  return data.map(function (row) {
    var obj = {};
    USER_HEADERS.forEach(function (h, i) { obj[h] = String(row[i] || "").trim(); });
    return obj;
  });
}


function getData(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  return data.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function isTableFree(sheet, tableId, date, time) {
  var rows = getData(sheet);
  var targetDate = formatDateString(date);

  for (var i = 0; i < rows.length; i++) {
    var b = rows[i];
    if (b["Status"] === "Cancelled") continue;
    if (String(b["Table ID"]) != String(tableId)) continue;

    // Format sheet date to YYYY-MM-DD string for safe comparison
    var sheetDate = formatDateString(b["Date"]);
    if (sheetDate != targetDate) continue;

    var t1 = timeToMinutes(time);
    var t2 = timeToMinutes(b["Time"]);
    if (Math.abs(t1 - t2) < CFG.slotDurationMin) {
      return false; // Collision
    }
  }
  return true;
}

function isEmployeeBooked(sheet, empNo, date, time) {
  var rows = getData(sheet);
  var emp = String(empNo).toLowerCase().trim();
  var targetDate = formatDateString(date);

  for (var i = 0; i < rows.length; i++) {
    var b = rows[i];
    if (b["Status"] === "Cancelled") continue;

    var sheetDate = formatDateString(b["Date"]);
    var isSameEmp = String(b["Employee No"]).toLowerCase().trim() === emp;
    var isSameDate = sheetDate == targetDate;
    var isSameTime = b["Time"] == time;

    if (isSameEmp && isSameDate && isSameTime) {
      return true;
    }
  }
  return false;
}

// Global date formatter to ensure string comparison (YYYY-MM-DD)
// This avoids timezone shifts inherent in new Date() or Utilities.formatDate
function formatDateString(val) {
  if (!val) return "";

  // Case 1: Already a Date object (from sheet)
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = ("0" + (val.getMonth() + 1)).slice(-2);
    var d = ("0" + val.getDate()).slice(-2);
    return y + "-" + m + "-" + d;
  }

  // Case 2: String - normalize to YYYY-MM-DD
  var s = String(val).trim();
  var isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3];

  // Case 3: Other string formats (try fallback but carefully)
  var fallbackDate = new Date(val);
  if (!isNaN(fallbackDate.getTime())) {
    var yf = fallbackDate.getFullYear();
    var mf = ("0" + (fallbackDate.getMonth() + 1)).slice(-2);
    var df = ("0" + fallbackDate.getDate()).slice(-2);
    return yf + "-" + mf + "-" + df;
  }

  return s;
}

function isSlotActive(bookingTimeStr, nowTimeStr) {
  var bMin = timeToMinutes(bookingTimeStr);
  var nMin = timeToMinutes(nowTimeStr);
  if (bMin < 0 || nMin < 0) return true;
  return nMin >= bMin && nMin < (bMin + CFG.slotDurationMin);
}

function validateBooking(d) {
  if (!d.emp_no) return { valid: false, error: "Missing Employee No" };
  if (!d.name) return { valid: false, error: "Missing Name" };
  if (!d.date) return { valid: false, error: "Missing Date" };
  if (!d.time) return { valid: false, error: "Missing Time" };
  if (timeToMinutes(d.time) === -1) return { valid: false, error: "Invalid Time" };
  return { valid: true };
}

// ============================================================
//  EMAIL NOTIFICATIONS (REMOVED)
// ============================================================
// Functions sendConfirmationEmail and sendCancellationEmail 
// have been removed to avoid permission issues.

// ============================================================
//  DB OPERATIONS
// ============================================================
function updateStatus(sheet, ref, newStatus) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, error: "No data" };

  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  var rowIdx = -1;

  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i]) === String(ref)) {
      rowIdx = i + 2;
      break;
    }
  }

  if (rowIdx === -1) return { success: false, error: "Ref not found" };

  // Get full row data to return it (for email)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rowData = sheet.getRange(rowIdx, 1, 1, sheet.getLastColumn()).getValues()[0];
  var booking = {};
  headers.forEach(function (h, i) { booking[h] = rowData[i]; });

  // Update Status
  var statusCol = headers.indexOf("Status") + 1;
  sheet.getRange(rowIdx, statusCol).setValue(newStatus);

  return { success: true, ref: ref, status: newStatus, booking: booking };
}

function deleteRow(sheet, ref) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, error: "No data" };
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();

  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i]) === String(ref)) {
      sheet.deleteRow(i + 2);
      return { success: true, ref: ref };
    }
  }
  return { success: false, error: "Ref not found" };
}


function updateRow(sheet, ref, data) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rowIdx = getRowByRef(sheet, ref);
  if (rowIdx === -1) return { success: false, error: "Ref not found" };

  for (var key in data) {
    var colIdx = headers.indexOf(key) + 1;
    if (colIdx > 0) {
      var val = data[key];
      // Force string for phone if needed
      if (key === "Phone" && val && val.toString().charAt(0) !== "'") val = "'" + val;
      sheet.getRange(rowIdx, colIdx).setValue(val);
    }
  }
  return { success: true, ref: ref };
}

function getRowByRef(sheet, ref) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i]) === String(ref)) return i + 2;
  }
  return -1;
}

// ============================================================
//  HELPERS
// ============================================================
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function timeToMinutes(str) {
  if (!str) return -1;
  // Handle slots like "05:00 PM - 07:00 PM" by taking the start time
  var s = str.toString().split("-")[0].trim();
  var ampm = s.match(/([AP]M)/i);
  s = s.replace(/[APM\s]/gi, "");
  var p = s.split(":").map(Number);
  if (p.length < 2 || isNaN(p[0])) return -1;
  var h = p[0], m = p[1];
  if (ampm) {
    if (ampm[1].toUpperCase() === "PM" && h !== 12) h += 12;
    if (ampm[1].toUpperCase() === "AM" && h === 12) h = 0;
  }
  return h * 60 + m;
}

function getTodayString() {
  var d = new Date();
  // Adjust for India Time if not set in Sheet settings, but usually Date() follows robust logic
  // For safety, force YYYY-MM-DD
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function getCurrentTimeString() {
  var d = new Date();
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "HH:mm");
}
