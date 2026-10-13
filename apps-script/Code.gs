/**
 * ARABUSTA tasting survey backend (Google Apps Script, bound to the spreadsheet).
 *
 * setup()  — run once from the editor: creates the sheets, headers and the code list.
 * doGet()  — ?action=check&code=1234 → { ok, valid, samples, setType } (looked up in «Набори»).
 * doPost() — JSON answers from the form → one row in «Відповіді».
 *
 * The form never sees the code list; codes and their sample numbers live only in «Набори».
 * Each set picks its samples from dropdowns fed by the «Зразки» sheet.
 * A set's survey type is the number of filled sample columns: 3 or 5.
 */

var SHEETS = {
  responses: 'Відповіді',
  sets: 'Набори',
  samples: 'Зразки',
  analysis: 'Аналіз'
};

// Initial sticker codes; setup() writes them into «Набори» with DEFAULT_SAMPLES.
var INITIAL_CODES = [
  '3142', '5214', '2451', '4132', '1523', '5341', '2135', '4512', '1354', '3425',
  '5123', '2314', '4251', '1432', '3512', '5432', '2543', '1245', '4325', '3251',
  '5124', '2413', '4153', '1342', '3524', '5431', '2153', '4231', '1534', '3154',
  '5243', '2534', '4513', '1325', '3241', '5312', '2341', '4352', '1453', '3415'
];

// «Зразки»: sample numbers offered in the «Набори» dropdowns; the blend name is for the team only.
var SAMPLE_HEADERS = ['Номер зразка', 'Назва купажу (лише для команди)'];
var INITIAL_SAMPLE_COUNT = 5;

var MAX_SAMPLES = 5;
var DEFAULT_SAMPLES = ['№01', '№02', '№03'];
var SET_HEADERS = [
  'Код', 'Зразок 1', 'Зразок 2', 'Зразок 3', 'Зразок 4', 'Зразок 5',
  'Дата передачі', 'Кому передано', 'Тип отримувача', 'Відповідей', 'Остання відповідь', 'Статус'
];
var SET_COL = { code: 1, firstSample: 2, responses: 10, last: 11, status: 12 };
var SET_ROWS = 200;

var MAX_TEXT_LENGTH = 1000;
var MAX_SAMPLE_LENGTH = 20;

// ---------- Allowed answers (must match the option values in index.html) ----------

var LIKED = ['Аромат', 'Смак', 'Насиченість', "М'якість", 'Крема', 'Післясмак', 'Інше'];
var MISSING = ['Більше аромату', 'Більше насиченості', 'Більше крема', 'Менше гіркоти',
  'Менше кислинки', 'Більше солодкості', 'Нічого', 'Інше'];
var DRINK = ['Еспресо', 'Американо', 'Капучино', 'Лате', 'Інше'];
var WOULD_BUY = ['Так', 'Скоріше так', 'Можливо', 'Скоріше ні', 'Ні'];
var PRICE = ['200–250 грн', '250–300 грн', '300–350 грн', '350–400 грн', 'Понад 400 грн'];
var RATING = ['1', '2', '3', '4', '5'];
var RATING_ASPECTS = [['taste', 'смак'], ['aroma', 'аромат'], ['body', 'насиченість'], ['finish', 'післясмак']];

// Field rules for a set with the given sample numbers. kind: one | many | text.
function fieldRules(samples) {
  var setType = samples.length;
  var rules = {
    favorite: { kind: 'one', values: samples.concat(['Не можу визначитися', 'Жоден']), required: true },
    buy: { kind: 'one', values: samples.concat(['Жоден']), required: true },
    liked: { kind: 'many', values: LIKED, required: true },
    liked_other: { kind: 'text' }
  };
  if (setType === 3) {
    rules.missing = { kind: 'many', values: MISSING, required: true };
    rules.missing_other = { kind: 'text' };
    rules.drink = { kind: 'many', values: DRINK, required: true };
    rules.drink_other = { kind: 'text' };
    rules.would_buy = { kind: 'one', values: WOULD_BUY, required: true };
    rules.price = { kind: 'one', values: PRICE, required: true };
    rules.wish = { kind: 'text' };
    rules.advice = { kind: 'text' };
  } else {
    rules.change = { kind: 'many', values: MISSING, required: true };
    rules.change_other = { kind: 'text' };
    rules.comment = { kind: 'text' };
    for (var s = 1; s <= 5; s++) {
      RATING_ASPECTS.forEach(function (aspect) {
        rules['s' + s + '_' + aspect[0]] = { kind: 'one', values: RATING, required: true };
      });
    }
  }
  return rules;
}

// ---------- «Відповіді» columns ----------

// [header, getter(answers)]; "missing" (3 samples) and "change" (5 samples) share a column.
function responseColumns() {
  var cols = [
    ['Час', function (a) { return a._time; }],
    ['Код', function (a) { return a.test_id; }],
    ['Тип набору', function (a) { return a._setType; }],
    // S1…S5 ratings below follow the order of this list
    ['Зразки набору', function (a) { return a._samples; }],
    ['Найкращий зразок', function (a) { return a.favorite; }],
    ['Купив би', function (a) { return a.buy; }],
    ['Що сподобалось', function (a) { return a.liked; }],
    ['Що сподобалось: інше', function (a) { return a.liked_other; }],
    ['Чого не вистачає / що змінити', function (a) { return a.missing || a.change; }],
    ['Чого не вистачає: інше', function (a) { return a.missing_other || a.change_other; }],
    ['Як п\'є каву', function (a) { return a.drink; }],
    ['Як п\'є каву: інше', function (a) { return a.drink_other; }],
    ['Чи купив би', function (a) { return a.would_buy; }],
    ['Ціна за 250 г', function (a) { return a.price; }],
    ['Яку каву хотів би', function (a) { return a.wish; }],
    ['Порада ARABUSTA', function (a) { return a.advice; }],
    ['Коментар', function (a) { return a.comment; }]
  ];
  for (var s = 1; s <= 5; s++) {
    RATING_ASPECTS.forEach(function (aspect) {
      var key = 's' + s + '_' + aspect[0];
      cols.push(['S' + s + '_' + aspect[1], function (a) { return a[key] ? Number(a[key]) : ''; }]);
    });
  }
  return cols;
}

// ---------- Setup ----------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var headers = responseColumns().map(function (c) { return c[0]; });

  var responses = getOrCreateSheet_(ss, SHEETS.responses);
  if (responses.getLastRow() === 0) {
    responses.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    responses.setFrozenRows(1);
  }
  responses.getRange('B:B').setNumberFormat('@'); // keep codes like "0123" as text

  var sets = getOrCreateSheet_(ss, SHEETS.sets); // created first to keep the tab order
  var samplesSheet = getOrCreateSheet_(ss, SHEETS.samples);
  if (samplesSheet.getLastRow() === 0) {
    samplesSheet.getRange(1, 1, 1, SAMPLE_HEADERS.length).setValues([SAMPLE_HEADERS]).setFontWeight('bold');
    samplesSheet.setFrozenRows(1);
    samplesSheet.getRange('A:A').setNumberFormat('@');
    var numbers = [];
    for (var i = 1; i <= INITIAL_SAMPLE_COUNT; i++) numbers.push(['№' + (i < 10 ? '0' : '') + i]);
    samplesSheet.getRange(2, 1, numbers.length, 1).setValues(numbers);
    samplesSheet.autoResizeColumns(1, SAMPLE_HEADERS.length);
  }

  if (sets.getLastRow() === 0) {
    sets.getRange(1, 1, 1, SET_HEADERS.length).setValues([SET_HEADERS]).setFontWeight('bold');
    sets.setFrozenRows(1);
    sets.getRange('A:A').setNumberFormat('@');

    var n = INITIAL_CODES.length;
    sets.getRange(2, SET_COL.code, n, 1 + DEFAULT_SAMPLES.length)
      .setValues(INITIAL_CODES.map(function (code) { return [code].concat(DEFAULT_SAMPLES); }));

    // Rows prepared for codes added later: dropdowns and formulas already in place.
    var rows = SET_ROWS;

    // Sample dropdowns: only numbers listed in «Зразки» can be picked.
    var sampleRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(samplesSheet.getRange('A2:A'), true)
      .setAllowInvalid(false)
      .build();
    sets.getRange(2, SET_COL.firstSample, rows, MAX_SAMPLES).setDataValidation(sampleRule);

    // Apps Script always takes formulas with comma separators, whatever the sheet locale.
    var r = SHEETS.responses;
    var formulas = [];
    for (var row = 2; row < rows + 2; row++) {
      formulas.push([
        '=IF(A' + row + '="", "", COUNTIF(\'' + r + '\'!B:B, A' + row + '))',
        '=IF(N(J' + row + ')=0, "", MAXIFS(\'' + r + '\'!A:A, \'' + r + '\'!B:B, A' + row + '))',
        '=IF(A' + row + '="", "", IF(J' + row + '>0, "є відповідь", "очікує"))'
      ]);
    }
    sets.getRange(2, SET_COL.responses, rows, 3).setFormulas(formulas);
    sets.getRange(2, SET_COL.last, rows, 1).setNumberFormat('dd.mm.yyyy hh:mm');
    sets.autoResizeColumns(1, SET_HEADERS.length);
  }

  var analysis = getOrCreateSheet_(ss, SHEETS.analysis);
  if (analysis.getLastRow() === 0) {
    analysis.getRange('A1').setValue('Аналіз — буде налаштовано на кроці 4').setFontWeight('bold');
  }

  var defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('Аркуш1') || ss.getSheetByName('Лист1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// ---------- Web app ----------

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.action !== 'check') return json_({ ok: false, error: 'unknown_action' });
  var set = findSet_(String(params.code || ''));
  if (set && set.error) return json_({ ok: false, error: set.error });
  return json_({
    ok: true,
    valid: set !== null,
    samples: set ? set.samples : null,
    setType: set ? set.samples.length : null
  });
}

function doPost(e) {
  var answers;
  try {
    answers = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }

  var code = String(answers.test_id || '');
  var set = findSet_(code);
  if (set === null) return json_({ ok: false, error: 'unknown_code' });
  if (set.error) return json_({ ok: false, error: set.error });

  var clean = validateAnswers_(answers, set.samples);
  if (clean.error) return json_({ ok: false, error: clean.error });

  clean.values.test_id = code;
  clean.values._setType = set.samples.length;
  clean.values._samples = set.samples.join(', ');
  clean.values._time = new Date();
  var row = responseColumns().map(function (c) {
    var value = c[1](clean.values);
    return value === undefined || value === null ? '' : value;
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.responses);
    var target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
    target.offset(0, 1, 1, 1).setNumberFormat('@');
    target.setValues([row]);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

// Returns { samples } for a known code, { error } if its row is filled in wrong, null if unknown.
function findSet_(code) {
  if (!/^\d{4}$/.test(code)) return null;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.sets);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, SET_COL.code, sheet.getLastRow() - 1, 1 + MAX_SAMPLES).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0].trim() !== code) continue;
    var samples = parseSamples_(rows[i].slice(1));
    return samples ? { samples: samples } : { error: 'bad_samples_for_' + code };
  }
  return null;
}

// «Зразок 1…5» cells → ['№02', '№04', '№05']. Null unless 3 or 5 cells are filled
// from «Зразок 1» on without gaps, with no repeats.
function parseSamples_(cells) {
  var values = cells.map(function (s) { return String(s).trim(); });
  var count = values.indexOf('') === -1 ? values.length : values.indexOf('');
  if (values.slice(count).some(function (s) { return s; })) return null; // gap before a filled cell
  var samples = values.slice(0, count);
  if (samples.length !== 3 && samples.length !== 5) return null;
  for (var i = 0; i < samples.length; i++) {
    if (samples[i].length > MAX_SAMPLE_LENGTH || samples.indexOf(samples[i]) !== i) return null;
  }
  return samples;
}

// Keeps only known fields with allowed values; returns { values } or { error }.
function validateAnswers_(answers, samples) {
  var rules = fieldRules(samples);
  var values = {};
  for (var key in rules) {
    var rule = rules[key];
    var raw = answers[key] === undefined || answers[key] === null ? '' : String(answers[key]).trim();
    if (!raw) {
      if (rule.required) return { error: 'missing_' + key };
      continue;
    }
    if (rule.kind === 'one' && rule.values.indexOf(raw) === -1) return { error: 'invalid_' + key };
    if (rule.kind === 'many') {
      var parts = raw.split(', ');
      for (var i = 0; i < parts.length; i++) {
        if (rule.values.indexOf(parts[i]) === -1) return { error: 'invalid_' + key };
      }
    }
    if (rule.kind === 'text') raw = safeText_(raw);
    values[key] = raw;
  }
  return { values: values };
}

// Trims long input and stops text from being read as a spreadsheet formula.
function safeText_(text) {
  text = text.slice(0, MAX_TEXT_LENGTH);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
