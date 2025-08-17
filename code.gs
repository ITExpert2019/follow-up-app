/***************************************
 *  Code.gs - النظام الخلفي النهائي
 *  يحافظ على منطق مستوى الإدارة والمركزي
 *  ويعتمد بنية شيت "emails" كما ذكرت:
 *  الادارة | البريد الاليكتروني | كلمة المرور | الجهة | original_password
 ***************************************/

/** ثابت معرف الشيت (كما أعطيت سابقاً) */
const SPREADSHEET_ID = "1YpfdFhM0DPMXqPjmTAdBzmn7GOhnV_IGT5icsIxZRds";

/** فتح المصنف */
function getSS() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/** قراءة رؤوس الأعمدة وتحويلها إلى خريطة {header: index0} */
function readHeaders(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || "").trim());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return { headers, map };
}

/** تنسيق التاريخ للخارج (HTML/JS) كـ yyyy-MM-dd */
function formatCellForClient(cell) {
  if (cell instanceof Date) return Utilities.formatDate(cell, "Africa/Cairo", "yyyy-MM-dd");
  return cell === undefined || cell === null ? "" : String(cell);
}

/** MD5 hash لكلمة المرور (كما كان مستخدماً في كودك) */
function hashPassword(password) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(password || "").trim())
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');
}

/*******************************
 * نقطة الدخول لعرض صفحات HTML
 * - تستخدم page param: welcome, login, edit_interface, central_dashboard, exit
 *******************************/
function doGet(e) {
  const page = (e.parameter && e.parameter.page) ? e.parameter.page : "welcome";
  const email = (e.parameter && e.parameter.email) ? e.parameter.email : "";
  const department = (e.parameter && e.parameter.department) ? e.parameter.department : "";

  if (page === "central_dashboard" && email) {
    const ss = getSS();
    const centralStaffSheet = ss.getSheetByName("central_staff");
    let userName = "";
    let userEntity = "";
    if (centralStaffSheet) {
      const { map } = readHeaders(centralStaffSheet);
      const data = centralStaffSheet.getRange(2, 1, Math.max(0, centralStaffSheet.getLastRow() - 1), centralStaffSheet.getLastColumn()).getValues();
      const emailLower = email.toLowerCase();
      for (let i = 0; i < data.length; i++) {
        if ((String(data[i][map["البريد الاليكتروني"]] || "").toLowerCase()) === emailLower) {
          userName = data[i][map["الاسم"]] || "";
          userEntity = data[i][map["الجهة"]] || "";
          break;
        }
      }
    }

    // جلب التعديلات قيد المراجعة للجهة الخاصة بالموظف
    const trackingSheet = ss.getSheetByName("المتابعة");
    let pendingUpdates = [];
    if (trackingSheet) {
      const { map: trackMap } = readHeaders(trackingSheet);
      const trackData = trackingSheet.getRange(2, 1, Math.max(0, trackingSheet.getLastRow() - 1), trackingSheet.getLastColumn()).getValues();
      for (let i = 0; i < trackData.length; i++) {
        const row = trackData[i];
        const rowEntity = String(row[trackMap["الجهة"]] || "").trim();
        const rowStatus = String(row[trackMap["حالة التعديل"]] || "").trim();
        if (rowEntity === userEntity && rowStatus === "قيد المراجعة") {
          pendingUpdates.push({
            rowNumber: i + 2,
            rowIndex: row[trackMap["rowIndex"]],
            date: row[trackMap["تاريخ التعديل"]],
            entity: rowEntity,
            department: row[trackMap["الادارة"]],
            operationName: row[trackMap["اسم العملية التفصيلية"]],
            fieldName: row[trackMap["اسم الحقل"]],
            oldValue: row[trackMap["القيمة القديمة"]],
            newValue: row[trackMap["القيمة الجديدة"]],
            status: rowStatus
          });
        }
      }
    }

    const t = HtmlService.createTemplateFromFile("central_dashboard");
    t.email = email;
    t.userName = userName;
    t.userEntity = userEntity;
    t.pendingUpdates = pendingUpdates;  // تمرير التعديلات المعلقة
    return t.evaluate().setTitle("لوحة تحكم المستوى المركزي").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // صفحة تعديل البيانات لموظف الإدارة (تمرر department)
  if (page === "edit_interface" && department) {
    const t = HtmlService.createTemplateFromFile("edit_interface");
    t.department = department;
    return t.evaluate().setTitle("تعديل البيانات").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // صفحة تسجيل الدخول
  if (page === "login") {
    return HtmlService.createHtmlOutputFromFile("login").setTitle("تسجيل الدخول").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // صفحة خروج
  if (page === "exit") {
    return HtmlService.createHtmlOutputFromFile("exit").setTitle("خروج").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // الصفحة الافتراضية: الترحيب
  return HtmlService.createHtmlOutputFromFile("welcome").setTitle("مرحبا بك").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/*******************************
 * التحقق من بيانات تسجيل الدخول
 * - يعتمد على شيت "emails"
 * - يتوقع رؤوس: "البريد الاليكتروني", "كلمة المرور", "الادارة", "الجهة"
 * - يقارن كلمات المرور بشكل MD5 (كما في كودك الأصلي)
 * - يعيد redirectUrl يشمل page=edit_interface&department=... أو page=central_dashboard&email=...
 *******************************/
function checkLogin(email, password) {
  try {
    const ss = getSS();
    const sh = ss.getSheetByName("emails");
    if (!sh) return { success: false, message: "❌ شيت 'emails' غير موجود" };

    const { map } = readHeaders(sh);
    const required = ["البريد الاليكتروني", "كلمة المرور", "الادارة", "الجهة"];
    for (const req of required) if (map[req] === undefined) return { success: false, message: `❌ خطأ في إعداد الأعمدة داخل شيت emails. مطلوب: ${required.join(", ")}` };

    const rows = sh.getRange(2, 1, Math.max(0, sh.getLastRow() - 1), sh.getLastColumn()).getValues();
    const inputEmail = String(email || "").trim().toLowerCase();
    const hashedInput = hashPassword(password);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const storedEmail = String(row[map["البريد الاليكتروني"]] || "").trim().toLowerCase();
      const storedHash = String(row[map["كلمة المرور"]] || "").trim();
      const department = String(row[map["الادارة"]] || "").trim();
      const entity = String(row[map["الجهة"]] || "").trim();

      if (storedEmail === inputEmail) {
        if (storedHash === hashedInput) {
          const base = getScriptUrl();
          if (entity === "مركزي") {
            // توجه لمستوى المركزي مع تمرير البريد لصفحة المركزي
            return { success: true, redirectUrl: base + `?page=central_dashboard&email=${encodeURIComponent(inputEmail)}` };
          } else {
            // توجه لمستوى الإدارة مع تمرير department
            return { success: true, department: department, redirectUrl: base + `?page=edit_interface&department=${encodeURIComponent(department)}` };
          }
        } else {
          return { success: false, message: "❌ كلمة المرور غير صحيحة." };
        }
      }
    }

    return { success: false, message: "❌ بيانات الدخول غير صحيحة" };
  } catch (err) {
    return { success: false, message: "❌ خطأ غير متوقع: " + err.message };
  }
}

/** إرجاع رابط السكربت (للاستخدام في الواجهات) */
function getScriptUrl() {
  return ScriptApp.getService().getUrl();
}

/*******************************
 * جلب قائمة العمليات التفصيلية لإدارة محددة
 * - يقرأ من Sheet1 (الشيت الرئيسي للبيانات)
 * - يُرجع مصفوفة أسماء العمليات (unique)
 *******************************/
function getOperations(department) {
  const ss = getSS();
  const sheet = ss.getSheetByName("Sheet1");
  if (!sheet) return [];
  const { map } = readHeaders(sheet);
  const lastRow = Math.max(1, sheet.getLastRow());
  const data = sheet.getRange(2, 1, Math.max(0, lastRow - 1), sheet.getLastColumn()).getValues();
  const operationsSet = new Set();

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][map["الادارة"]] || "").trim() === department) {
      const opName = String(data[i][map["اسم العملية التفصيلية"]] || "").trim();
      if (opName) operationsSet.add(opName);
    }
  }
  return Array.from(operationsSet);
}

/*******************************
 * جلب بيانات عملية تفصيلية (للعرض في واجهة التعديل)
 * - يعيد بقيم مطابقة لما تتوقعه الواجهة (الحقول المسماة بالعربية)
 *******************************/
function getOperationData(department, operationName) {
  const ss = getSS();
  const sheet = ss.getSheetByName("Sheet1");
  if (!sheet) return { error: "شيت Sheet1 غير موجود" };
  const { map } = readHeaders(sheet);
  const lastRow = Math.max(1, sheet.getLastRow());
  const data = sheet.getRange(2, 1, Math.max(0, lastRow - 1), sheet.getLastColumn()).getValues();

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][map["الادارة"]] || "").trim() === department &&
        String(data[i][map["اسم العملية التفصيلية"]] || "").trim() === operationName) {
      return {
        صرف: data[i][map["ما تم صرفه من بدء العمل حتي 2025/6/30"]] || '',
        تنفيذ: data[i][map["ما تم تنفيذه من بدء العمل حتي 2025/6/30"]] || '',
        متوقع: data[i][map["المتوقع صرفه للعام المالى 2026/2025"]] || '',
        تمويل_حالي: data[i][map["التمويل من 2025/7/1 حتي تاريخه"]] || '',
        صرف_حالي: data[i][map["المنصرف من 2025/7/1 حتي تاريخه"]] || '',
        تنفيذ_حالي: data[i][map["المنفذ من 2025/7/1 حتي تاريخه"]] || '',
        قيمة_تعاقدية: data[i][map["القيمة التعاقدية الحالية"]] || '',
        تعاقد_معدل: data[i][map["القيمة التعاقدية المعدلة"]] || '',
        نهو_مقرر: formatCellForClient(data[i][map["تاريخ النهو المقرر"]]),
        نهو_معدل: formatCellForClient(data[i][map["تاريخ النهو المعدل"]]),
        rowIndex: i + 2,
      };
    }
  }
  return { error: "لم يتم العثور على العملية" };
}


/*******************************
 * إنشاء ورقة المتابعة إذا لم تكن موجودة
 * رؤوس الأعمدة في ورقة المتابعة ثابتة كما نستخدمها في باقي الكود
 *******************************/
function createTrackingSheet() {
  const ss = getSS();
  let sheet = ss.getSheetByName("المتابعة");
  if (!sheet) {
    sheet = ss.insertSheet("المتابعة");
    sheet.appendRow([
      "rowIndex",               // رقم الصف في الشيت الرئيسي (Sheet1)
      "تاريخ التعديل",
      "الجهة",
      "الادارة",
      "اسم العملية التفصيلية",
      "اسم الحقل",
      "القيمة القديمة",
      "القيمة الجديدة",
      "حالة التعديل"
    ]);
  }
  return sheet;
}

/*******************************
 * تسجيل تعديل (سجل المتابعة)
 * - إذا الحقل "القيمة التعاقدية المعدلة" -> وضع الحالة "قيد المراجعة"
 * - بخلاف ذلك نسجل التغيير مع حالة فارغة (أو ما يناسب)
 *******************************/
function logTrackingChange(rowIndex, entity, department, operationName, fieldName, oldValue, newValue) {
  const sheet = createTrackingSheet();
  let status = "";
  if (fieldName === "القيمة التعاقدية المعدلة" || fieldName === "تاريخ النهو المعدل") {
    status = "قيد المراجعة";
  }
  sheet.appendRow([
    rowIndex,
    new Date(),
    entity,
    department,
    operationName,
    fieldName,
    oldValue,
    newValue,
    status
  ]);
}

/*******************************
 * تحديث بيانات عملية من واجهة الإدارة
 * توقيع الدالة: updateOperation(rowIndex, dataObject)
 * حيث dataObject = { "اسم_الحقل_كما_بالشيت": newValue, ... }
 *
 * قواعد التعديل (كما اتفقنا):
 * - ما تم صرفه حتى 30/6/2025، ما تم تنفيذه حتى 30/6/2025، المتوقع صرفه للعام المالي 2025/2026
 *   => يسمح بتعديلها فقط خلال شهر يوليو 2025، والقيمة الجديدة >= القديمة
 * - المنصرف من 1/7/2025 حتى تاريخه، المنفذ من 1/7/2025 حتى تاريخه
 *   => متاحة دائماً، والقيمة الجديدة >= القديمة
 * - القيمة التعاقدية المعدلة، تاريخ النهو المعدل
 *   => يسجل اقتراحًا في ورقة المتابعة بحالة "قيد المراجعة" (لا يحدث في الشيت الرئيسي مباشرة)
 *   => قيمة التعديل يجب أن تكون >= القيمة التعاقدية الحالية
 *   => تاريخ النهو المعدل يجب أن يكون >= تاريخ النهو المقرر
 *******************************/
function updateOperation(rowIndex, dataObject) {
  try {
    const ss = getSS();
    const sheet = ss.getSheetByName("Sheet1");
    if (!sheet) return { success: false, message: "شيت Sheet1 غير موجود" };

    const { headers, map } = readHeaders(sheet);
    const row = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];

    const entity = row[map["الجهة"]];
    const department = row[map["الادارة"]];
    const operationName = row[map["اسم العملية التفصيلية"]];

    const now = new Date();
    const julyStart = new Date("2025-07-01T00:00:00");
    const julyEnd = new Date("2025-07-31T23:59:59");

    function toNumberSafe(v) {
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    }
    function parseDateSafe(v) {
      if (!v) return null;
      if (v instanceof Date) return v;
      const d = new Date(String(v));
      return isNaN(d) ? null : d;
    }

    // الحقول التي يسمح تعديلها فقط خلال يوليو
    const julyFields = [
      "ما تم صرفه من بدء العمل حتى 2025/6/30",
      "ما تم تنفيذه من بدء العمل حتى 2025/6/30",
      "المتوقع صرفه للعام المالى 2026/2025"
    ];

    // الحقول المتاحة دائماً
    const alwaysFields = [
      "التمويل من 2025/7/1 حتي تاريخه",
      "المنصرف من 2025/7/1 حتي تاريخه",
      "المنفذ من 2025/7/1 حتي تاريخه"
    ];

    // 1) تحديث حقول يوليو (فقط إذا تغيرت القيمة)
    for (const field of julyFields) {
      if (dataObject.hasOwnProperty(field)) {
        const colIdx = map[field];
        if (colIdx === undefined) continue;
        const oldVal = toNumberSafe(row[colIdx]);
        const newVal = toNumberSafe(dataObject[field]);

        if (newVal === oldVal) continue; // لم يتغير، تخطى

        if (!(now >= julyStart && now <= julyEnd)) {
          return { success: false, message: `❌ لا يمكن تعديل الحقل '${field}' إلا خلال شهر يوليو 2025.` };
        }
        if (newVal < oldVal) {
          return { success: false, message: `❌ القيمة الجديدة لـ '${field}' لا يمكن أن تقل عن القيمة الحالية.` };
        }

        sheet.getRange(rowIndex, colIdx + 1).setValue(newVal);
        logTrackingChange(rowIndex, entity, department, operationName, field, oldVal, newVal);
      }
    }

    // 2) تحديث الحقول المتاحة دائماً (فقط إذا تغيرت القيمة)
    for (const field of alwaysFields) {
      if (dataObject.hasOwnProperty(field)) {
        const colIdx = map[field];
        if (colIdx === undefined) continue;
        const oldVal = toNumberSafe(row[colIdx]);
        const newVal = toNumberSafe(dataObject[field]);

        if (newVal === oldVal) continue; // لم يتغير، تخطى

        if (newVal < oldVal) {
          return { success: false, message: `❌ القيمة الجديدة لـ '${field}' لا يمكن أن تقل عن القيمة الحالية.` };
        }

        sheet.getRange(rowIndex, colIdx + 1).setValue(newVal);
        logTrackingChange(rowIndex, entity, department, operationName, field, oldVal, newVal);
      }
    }

    // 3) تاريخ النهو المعدل - اقتراح فقط (مقارنة مع تاريخ النهو المقرر)
    if (dataObject.hasOwnProperty("تاريخ النهو المعدل") && String(dataObject["تاريخ النهو المعدل"] || "").trim() !== "") {
      const newDateStr = dataObject["تاريخ النهو المعدل"];
      const oldDateStr = row[map["تاريخ النهو المقرر"]];
      const newDate = parseDateSafe(newDateStr);
      const oldDate = parseDateSafe(oldDateStr);

      if (!newDate) return { success: false, message: "❌ تاريخ النهو المعدل غير صالح." };
      if (!oldDate) return { success: false, message: "❌ تاريخ النهو المقرر غير صالح في الشيت الرئيسي." };

      if (newDate < oldDate) return { success: false, message: "❌ تاريخ النهو المعدل لا يمكن أن يكون أقل من تاريخ النهو المقرر." };

      // فقط إذا تغير التاريخ الفعلي
      if (newDateStr !== formatCellForClient(oldDateStr)) {
        logTrackingChange(rowIndex, entity, department, operationName, "تاريخ النهو المعدل", formatCellForClient(oldDateStr), formatCellForClient(newDateStr));
      }
    }

    // 4) القيمة التعاقدية المعدلة - اقتراح فقط (يجب أن تكون >= القيمة التعاقدية الحالية)
    if (dataObject.hasOwnProperty("القيمة التعاقدية المعدلة")) {
      const newVal = toNumberSafe(dataObject["القيمة التعاقدية المعدلة"]);
      const currentContractVal = toNumberSafe(row[map["القيمة التعاقدية الحالية"]]);
      const oldContractMod = toNumberSafe(row[map["القيمة التعاقدية المعدلة"]]);

      if (newVal < currentContractVal) {
        return { success: false, message: "❌ القيمة التعاقدية المعدلة لا يمكن أن تقل عن القيمة التعاقدية الحالية." };
      }

      if (newVal !== oldContractMod) {
        logTrackingChange(rowIndex, entity, department, operationName, "القيمة التعاقدية المعدلة", oldContractMod, newVal);
      }
    }

    return { success: true, message: "تم حفظ التعديلات (تم تسجيل ما استلزم المتابعة)." };
  } catch (err) {
    return { success: false, message: "❌ خطأ أثناء الحفظ: " + err.message };
  }
}

/*******************************
 * جلب التعديلات المقترحة المعلقة لموظف المستوى المركزي
 * - يُمرّر بريد المستخدم المركزي (userEmail) ليعرف أي "جهة" يشرف عليها
 * - تُعاد المصوفة من التعديلات بقيم واضحة
 *******************************/
function normalizeText(txt) {
  return String(txt || "").trim().replace(/\s+/g, " ");
}

function getPendingUpdatesForReviewer(userEmail) {
  const ss = getSS();
  const centralStaffSheet = ss.getSheetByName("central_staff");
  if (!centralStaffSheet) return [];

  const { map: csMap } = readHeaders(centralStaffSheet);
  const csData = centralStaffSheet.getRange(2, 1, Math.max(0, centralStaffSheet.getLastRow() - 1), centralStaffSheet.getLastColumn()).getValues();

  let userEntity = "";
  const emailLower = String(userEmail || "").toLowerCase();

  for (let i = 0; i < csData.length; i++) {
    const rowEmail = String(csData[i][csMap["البريد الاليكتروني"]] || "").toLowerCase();
    if (rowEmail === emailLower) {
      userEntity = normalizeText(csData[i][csMap["الجهة"]]);
      break;
    }
  }
  if (!userEntity) return [];

  const trackingSheet = ss.getSheetByName("المتابعة");
  if (!trackingSheet) return [];

  const { map: trackMap } = readHeaders(trackingSheet);
  const trackData = trackingSheet.getRange(2, 1, Math.max(0, trackingSheet.getLastRow() - 1), trackingSheet.getLastColumn()).getValues();

  const filtered = [];
  for (let i = 0; i < trackData.length; i++) {
    const row = trackData[i];
    const rowEntity = normalizeText(row[trackMap["الجهة"]]);
    const rowStatus = String(row[trackMap["حالة التعديل"]] || "").trim();
    if (rowEntity === userEntity && rowStatus === "قيد المراجعة") {
      filtered.push({
        rowNumber: i + 2, // رقم الصف في ورقة المتابعة
        rowIndex: row[trackMap["rowIndex"]], // رقم الصف في الشيت الرئيسي
        date: row[trackMap["تاريخ التعديل"]],
        entity: rowEntity,
        department: row[trackMap["الادارة"]],
        operationName: row[trackMap["اسم العملية التفصيلية"]],
        fieldName: row[trackMap["اسم الحقل"]],
        oldValue: row[trackMap["القيمة القديمة"]],
        newValue: row[trackMap["القيمة الجديدة"]],
        status: rowStatus
      });
    }
  }
  return filtered;
}

/*******************************
 * مراجعة تعديل في ورقة المتابعة
 * - rowNumber: رقم الصف في شيت المتابعة
 * - accept: Boolean (true => قبول، false => رفض)
 * إذا قُبل التعديل، يتم تحديث الشيت الرئيسي في العمود المطابق لاسم الحقل
 *******************************/
function reviewUpdate(rowNumber, accept) {
  const ss = getSS();
  const trackingSheet = ss.getSheetByName("المتابعة");
  if (!trackingSheet) return { success: false, message: "شيت المتابعة غير موجود" };

  const { map: trackMap } = readHeaders(trackingSheet);
  const lastRow = trackingSheet.getLastRow();
  if (rowNumber < 2 || rowNumber > lastRow) return { success: false, message: "رقم الصف غير صالح" };

  const rowData = trackingSheet.getRange(rowNumber, 1, 1, trackingSheet.getLastColumn()).getValues()[0];
  const statusCol = trackMap["حالة التعديل"] + 1;

  if (accept) {
    const mainRowIndex = rowData[trackMap["rowIndex"]];
    const fieldName = rowData[trackMap["اسم الحقل"]];
    const newValue = rowData[trackMap["القيمة الجديدة"]];

    const mainSheet = ss.getSheetByName("Sheet1");
    if (!mainSheet) return { success: false, message: "شيت البيانات الرئيسي غير موجود" };

    const { headers: mainHeaders } = readHeaders(mainSheet);
    const colIndex = mainHeaders.indexOf(fieldName);
    if (colIndex === -1) return { success: false, message: "اسم الحقل غير موجود في الشيت الرئيسي" };

    // تحديث الشيت الرئيسي بالقيمة الجديدة
    // حاول تحويل القيمة إلى تاريخ إن كانت تبدو كتاريخ بصيغة yyyy-mm-dd
    const parsedDate = (typeof newValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(newValue)) ? new Date(newValue) : null;
    if (parsedDate && !isNaN(parsedDate)) {
      mainSheet.getRange(mainRowIndex, colIndex + 1).setValue(parsedDate);
    } else {
      mainSheet.getRange(mainRowIndex, colIndex + 1).setValue(newValue);
    }

    // تحديث حالة في شيت المتابعة
    trackingSheet.getRange(rowNumber, statusCol).setValue("تم قبول التعديل");
    // إذا كان يوجد عمود لتاريخ المراجعة سنقوم بتعبئته (اختياري)
    const revDateIdx = trackMap["تاريخ مراجعة"];
    if (revDateIdx !== undefined) trackingSheet.getRange(rowNumber, revDateIdx + 1).setValue(new Date());

    return { success: true, message: "تم قبول التعديل وتحديث الشيت الرئيسي." };
  } else {
    // رفض التعديل
    trackingSheet.getRange(rowNumber, statusCol).setValue("تم رفض التعديل");
    const revDateIdx = trackMap["تاريخ مراجعة"];
    if (revDateIdx !== undefined) trackingSheet.getRange(rowNumber, revDateIdx + 1).setValue(new Date());
    return { success: true, message: "تم رفض التعديل." };
  }
}
