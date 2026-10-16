/**
 * ARABUSTA tasting survey backend (Google Apps Script, bound to the spreadsheet).
 *
 * setup()          — run once from the editor: creates the sheets, headers, code list and analysis.
 * repairFormulas() — rewrites formulas and formats only (no data); fixes #ERROR! cells.
 * setupAnalysis()  — rebuilds only «Аналіз» (and its hidden helper sheet); safe to re-run.
 * doGet()  — ?action=check&code=1234 → { ok, valid, answered, samples, setType } (looked up in «Набори»).
 * doPost() — JSON answers from the form → one row in «Відповіді». One response per code:
 *            a code that already has a row is rejected with 'already_answered'.
 *
 * The form never sees the code list; codes and their sample numbers live only in «Набори».
 * Each set picks its samples from dropdowns fed by the «Зразки» sheet.
 * A set's survey type is the number of filled sample columns: 3 or 5.
 */

var SHEETS = {
  responses: 'Відповіді',
  sets: 'Набори',
  samples: 'Зразки',
  analysis: 'Аналіз',
  helper: 'Дані для аналізу' // hidden; per-response lookups that «Аналіз» formulas build on
};

// Box codes in print order; setup() writes them into «Набори» with DEFAULT_SAMPLES.
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
// The first 10 INITIAL_CODES are on black boxes: 5-sample sets. The other 30 (white boxes) have 3.
var FIVE_SAMPLE_SET_COUNT = 10;
var DEFAULT_SAMPLES = { 3: ['№01', '№02', '№03'], 5: ['№01', '№02', '№03', '№04', '№05'] };
var SET_HEADERS = [
  'Код', 'Зразок 1', 'Зразок 2', 'Зразок 3', 'Зразок 4', 'Зразок 5',
  'Дата передачі', 'Кому передано', 'Тип отримувача', 'Відповідей', 'Остання відповідь', 'Статус'
];
var SET_COL = { code: 1, firstSample: 2, handedOver: 7, recipientType: 9, responses: 10, last: 11 };
var SET_ROWS = 200;
var RECIPIENT_TYPES = ['Кавова точка', 'Професійний дегустатор', 'Приватна особа', 'Інше'];

// «Аналіз» formulas cover this many responses (rows 2…ANALYSIS_ROWS + 1 of «Відповіді»).
var ANALYSIS_ROWS = 2000;

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
// "exclusive" options of a "many" field may only be chosen on their own.
function fieldRules(samples) {
  var setType = samples.length;
  var rules = {
    favorite: { kind: 'many', values: samples.concat(['Не можу визначитися', 'Жоден']),
      exclusive: ['Не можу визначитися', 'Жоден'], required: true },
    buy: { kind: 'many', values: samples.concat(['Жоден']), exclusive: ['Жоден'], required: true },
    liked: { kind: 'many', values: LIKED, required: true },
    liked_other: { kind: 'text' }
  };
  if (setType === 3) {
    rules.missing = { kind: 'many', values: MISSING, exclusive: ['Нічого'], required: true };
    rules.missing_other = { kind: 'text' };
    rules.drink = { kind: 'many', values: DRINK, required: true };
    rules.drink_other = { kind: 'text' };
    rules.would_buy = { kind: 'one', values: WOULD_BUY, required: true };
    rules.price = { kind: 'one', values: PRICE, required: true };
    rules.wish = { kind: 'text' };
    rules.advice = { kind: 'text' };
  } else {
    rules.change = { kind: 'many', values: MISSING, exclusive: ['Нічого'], required: true };
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

// Date formats: literal dots, otherwise a comma-decimal locale (uk_UA) shows "13,10,2026".
var DATE_FORMAT = 'dd"."mm"."yyyy';
var DATE_TIME_FORMAT = 'dd"."mm"."yyyy hh:mm';

function setup() {
  withEnglishLocale_(setup_);
}

// Rewrites only formulas and formats («Набори» counters, «Аналіз», hidden helper) without
// touching data. Run after a script update or if formulas show #ERROR!.
function repairFormulas() {
  withEnglishLocale_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    formatResponses_(ss.getSheetByName(SHEETS.responses));
    writeSetFormulas_(ss.getSheetByName(SHEETS.sets));
    buildAnalysisSheets_();
  });
}

// Formulas below use English function names and comma separators. A spreadsheet in a
// comma-decimal locale (e.g. uk_UA) expects ";" and would show #ERROR!, so the locale is
// switched to en_US while they are written and restored afterwards; stored formulas are
// locale-independent and then display with the sheet's own separators.
function withEnglishLocale_(fn) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var original = ss.getSpreadsheetLocale();
  if (original === 'en_US') return fn();
  ss.setSpreadsheetLocale('en_US');
  SpreadsheetApp.flush();
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    ss.setSpreadsheetLocale(original);
  }
}

function formatResponses_(responses) {
  responses.getRange('A:A').setNumberFormat(DATE_TIME_FORMAT);
  responses.getRange('B:B').setNumberFormat('@'); // keep codes like "0123" as text
}

// «Відповідей», «Остання відповідь», «Статус» for SET_ROWS rows, blank while the code cell is empty.
function writeSetFormulas_(sets) {
  var r = SHEETS.responses;
  var formulas = [];
  for (var row = 2; row < SET_ROWS + 2; row++) {
    formulas.push([
      '=IF(A' + row + '="", "", COUNTIF(\'' + r + '\'!B:B, A' + row + '))',
      '=IF(N(J' + row + ')=0, "", MAXIFS(\'' + r + '\'!A:A, \'' + r + '\'!B:B, A' + row + '))',
      '=IF(A' + row + '="", "", IF(J' + row + '>0, "є відповідь", "очікує"))'
    ]);
  }
  sets.getRange(2, SET_COL.responses, SET_ROWS, 3).setFormulas(formulas);
  sets.getRange(2, SET_COL.handedOver, SET_ROWS, 1).setNumberFormat(DATE_FORMAT);
  sets.getRange(2, SET_COL.last, SET_ROWS, 1).setNumberFormat(DATE_TIME_FORMAT);
}

function setup_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var headers = responseColumns().map(function (c) { return c[0]; });

  var responses = getOrCreateSheet_(ss, SHEETS.responses);
  if (responses.getLastRow() === 0) {
    responses.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    responses.setFrozenRows(1);
  }
  formatResponses_(responses);

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
    sets.getRange(2, SET_COL.code, n, 1 + MAX_SAMPLES).setValues(INITIAL_CODES.map(function (code, i) {
      var samples = DEFAULT_SAMPLES[i < FIVE_SAMPLE_SET_COUNT ? 5 : 3];
      return [code].concat(samples, ['', ''].slice(0, MAX_SAMPLES - samples.length));
    }));

    // Rows prepared for codes added later: dropdowns and formulas already in place.
    var rows = SET_ROWS;

    // Sample dropdowns: only numbers listed in «Зразки» can be picked.
    var sampleRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(samplesSheet.getRange('A2:A'), true)
      .setAllowInvalid(false)
      .build();
    sets.getRange(2, SET_COL.firstSample, rows, MAX_SAMPLES).setDataValidation(sampleRule);

    // Recipient type dropdown: the same values the «Аналіз» filter offers.
    var recipientRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(RECIPIENT_TYPES, true)
      .setAllowInvalid(false)
      .build();
    sets.getRange(2, SET_COL.recipientType, rows, 1).setDataValidation(recipientRule);

    writeSetFormulas_(sets);
    sets.autoResizeColumns(1, SET_HEADERS.length);
  }

  var analysis = ss.getSheetByName(SHEETS.analysis);
  if (!analysis || analysis.getLastRow() === 0) buildAnalysisSheets_();

  var defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('Аркуш1') || ss.getSheetByName('Лист1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureRows_(sheet, count) {
  var missing = count - sheet.getMaxRows();
  if (missing > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missing);
}

// ---------- Analysis ----------
//
// «Дані для аналізу» (hidden) holds one formula row per response: the code, the recipient type
// looked up in «Набори», a 0/1 "matches the filters" flag, the set's samples split into five
// columns, and comma-wrapped multi-select answers for "contains" counting.
// «Аналіз» counts and averages over those columns. Every range spans the same rows
// (2…ANALYSIS_ROWS + 1) so COUNTIFS/SUMIFS can mix both sheets.

var ANALYSIS_LAYOUT = {
  recipientFilter: 'B4',
  codeFilter: 'B5',
  tableHeaderRow: 13,
  tableFirstRow: 14,
  chartRows: 30, // sample rows covered by the charts
  sideColumn: 13 // M
};

function setupAnalysis() {
  withEnglishLocale_(buildAnalysisSheets_);
}

function buildAnalysisSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureRows_(ss.getSheetByName(SHEETS.responses), ANALYSIS_ROWS + 1);

  // Both sheets must exist before formulas reference each other.
  var sheet = getOrCreateSheet_(ss, SHEETS.analysis);
  var helper = getOrCreateSheet_(ss, SHEETS.helper);
  [sheet, helper].forEach(function (s) {
    s.getCharts().forEach(function (chart) { s.removeChart(chart); });
    s.clear();
    s.getRange(1, 1, s.getMaxRows(), s.getMaxColumns()).clearDataValidations();
  });
  ensureRows_(helper, ANALYSIS_ROWS + 1);

  buildHelper_(helper);
  buildAnalysis_(sheet);
  helper.hideSheet();
}

function colLetter_(n) {
  var s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// 'Відповіді'!E2:E2001 for a «Відповіді» header.
function respRange_(header) {
  var index = responseColumns().map(function (c) { return c[0]; }).indexOf(header);
  if (index === -1) throw new Error('Unknown response column: ' + header);
  var col = colLetter_(index + 1);
  return "'" + SHEETS.responses + "'!" + col + '2:' + col + (ANALYSIS_ROWS + 1);
}

// Helper sheet columns: A code, B recipient type, C in-filter flag, D–H samples 1–5,
// I samples wrapped, J liked wrapped, K missing/change wrapped, L drink wrapped,
// M favorite wrapped, N would-buy samples wrapped (both multi-select).
var HELPER = { code: 'A', recipient: 'B', inFilter: 'C', sampleCols: ['D', 'E', 'F', 'G', 'H'],
  samples: 'I', liked: 'J', missing: 'K', drink: 'L', favorite: 'M', buy: 'N' };

function helperRange_(col) {
  return "'" + SHEETS.helper + "'!" + col + '2:' + col + (ANALYSIS_ROWS + 1);
}

function buildHelper_(helper) {
  var last = ANALYSIS_ROWS + 1;
  var codes = 'A2:A' + last;
  var analysis = "'" + SHEETS.analysis + "'!";
  var recipientFilter = analysis + '$' + ANALYSIS_LAYOUT.recipientFilter.replace(/(\d+)/, '$$$1');
  var codeFilter = analysis + '$' + ANALYSIS_LAYOUT.codeFilter.replace(/(\d+)/, '$$$1');
  var wrap = function (header) {
    return '=ARRAYFORMULA(IF(' + codes + '="", "", ", "&' + respRange_(header) + '&","))';
  };

  helper.getRange(1, 1, 1, 14).setValues([[
    'Код', 'Тип отримувача', 'У вибірці', 'Зразок 1', 'Зразок 2', 'Зразок 3', 'Зразок 4', 'Зразок 5',
    'Зразки', 'Сподобалось', 'Не вистачає', "Як п'є", 'Найкращий', 'Купив би'
  ]]);
  helper.getRange('A2').setFormula(
    '=ARRAYFORMULA(IF(' + respRange_('Код') + '="", "", ' + respRange_('Код') + '))');
  helper.getRange('B2').setFormula(
    '=ARRAYFORMULA(IF(' + codes + '="", "", IFERROR(VLOOKUP(' + codes + ", '" + SHEETS.sets + "'!A:" +
    colLetter_(SET_COL.recipientType) + ', ' + SET_COL.recipientType + ', FALSE), "")))');
  helper.getRange('C2').setFormula(
    '=ARRAYFORMULA(IF(' + codes + '="", 0, SIGN((' + recipientFilter + '="Усі")+(B2:B' + last + '=' +
    recipientFilter + '))*SIGN((' + codeFilter + '="")+(' + codes + '=' + codeFilter + '))))');
  HELPER.sampleCols.forEach(function (col, k) {
    // k-th entry of ", №02, №04, №05," — the samples in «Зразок 1…5» order.
    var pattern = '^' + (k ? '(?:, [^,]+){' + k + '}' : '') + ', ([^,]+),';
    helper.getRange(col + '2').setFormula(
      '=ARRAYFORMULA(IF(' + codes + '="", "", IFERROR(REGEXEXTRACT(", "&' + respRange_('Зразки набору') +
      '&",", "' + pattern + '"), "")))');
  });
  helper.getRange('I2').setFormula(wrap('Зразки набору'));
  helper.getRange('J2').setFormula(wrap('Що сподобалось'));
  helper.getRange('K2').setFormula(wrap('Чого не вистачає / що змінити'));
  helper.getRange('L2').setFormula(wrap("Як п'є каву"));
  helper.getRange('M2').setFormula(wrap('Найкращий зразок'));
  helper.getRange('N2').setFormula(wrap('Купив би'));
}

function buildAnalysis_(sheet) {
  var L = ANALYSIS_LAYOUT;
  var inFilter = helperRange_(HELPER.inFilter);
  var first = L.tableFirstRow;
  var col = function (c) { return c + first + ':' + c; };

  sheet.getRange('A1').setValue('Аналіз дегустацій ARABUSTA').setFontWeight('bold').setFontSize(14);

  // Filters
  sheet.getRange('A3').setValue('Фільтри').setFontWeight('bold');
  sheet.getRange('A4:A5').setValues([['Тип отримувача'], ['Код набору (порожньо — усі)']]);
  sheet.getRange(L.recipientFilter).setValue('Усі').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Усі'].concat(RECIPIENT_TYPES), true)
      .setAllowInvalid(false).build());
  var codeCell = sheet.getRange(L.codeFilter);
  codeCell.setNumberFormat('@').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.sets).getRange('A2:A'), true)
      .setAllowInvalid(false).build());
  sheet.getRange('B4:B5').setBackground('#fff4dc');

  // Summary
  var count = function (header, value) {
    return '=COUNTIFS(' + inFilter + ', 1, ' + respRange_(header) + ', ' + value + ')';
  };
  sheet.getRange('A7:B11').setValues([
    ['Відповідей у вибірці', '=SUM(' + inFilter + ')'],
    ['з них набори на 3 зразки', count('Тип набору', 3)],
    ['з них набори на 5 зразків', count('Тип набору', 5)],
    ['Найкращий — «Жоден»', count('Найкращий зразок', '"Жоден"')],
    ['Найкращий — «Не можу визначитися»', count('Найкращий зразок', '"Не можу визначитися"')]
  ]);

  // Per-sample table: one row per number listed in «Зразки».
  sheet.getRange(L.tableHeaderRow, 1, 1, 11).setValues([[
    'Зразок', 'Дегустували', 'Найкращий', 'Купив би', 'Найкращий, %', 'Купив би, %',
    'Смак', 'Аромат', 'Насиченість', 'Післясмак', 'Середня оцінка'
  ]]).setFontWeight('bold').setWrap(true);
  var samples = col('A');
  var guard = function (expr) { return '=ARRAYFORMULA(IF(' + samples + '="", "", ' + expr + '))'; };
  var row = sheet.getRange(first, 1, 1, 11);
  var ratingAverage = function (aspect) {
    var sums = [], counts = [];
    HELPER.sampleCols.forEach(function (sampleCol, k) {
      var ratings = respRange_('S' + (k + 1) + '_' + aspect);
      var sampleRange = helperRange_(sampleCol);
      sums.push('SUMIFS(' + ratings + ', ' + sampleRange + ', ' + samples + ', ' + inFilter + ', 1)');
      counts.push('COUNTIFS(' + sampleRange + ', ' + samples + ', ' + inFilter + ', 1, ' + ratings + ', ">0")');
    });
    return guard('IFERROR((' + sums.join('+') + ')/(' + counts.join('+') + '), "")');
  };
  row.setFormulas([[
    "=FILTER('" + SHEETS.samples + "'!A2:A, '" + SHEETS.samples + "'!A2:A<>\"\")",
    guard('COUNTIFS(' + inFilter + ', 1, ' + helperRange_(HELPER.samples) + ', "*, "&' + samples + '&",*")'),
    // Several samples may be named as best / would buy, so count answers that contain the sample.
    guard('COUNTIFS(' + inFilter + ', 1, ' + helperRange_(HELPER.favorite) + ', "*, "&' + samples + '&",*")'),
    guard('COUNTIFS(' + inFilter + ', 1, ' + helperRange_(HELPER.buy) + ', "*, "&' + samples + '&",*")'),
    guard('IF(' + col('B') + '=0, "", ' + col('C') + '/' + col('B') + ')'),
    guard('IF(' + col('B') + '=0, "", ' + col('D') + '/' + col('B') + ')'),
    ratingAverage('смак'),
    ratingAverage('аромат'),
    ratingAverage('насиченість'),
    ratingAverage('післясмак'),
    guard('IFERROR((' + col('G') + '+' + col('H') + '+' + col('I') + '+' + col('J') + ')/4, "")')
  ]]);
  sheet.getRange('E' + first + ':F' + (first + 200)).setNumberFormat('0%');
  sheet.getRange('G' + first + ':K' + (first + 200)).setNumberFormat('0.0');
  sheet.getRange('A' + (first - 2)).setValue('Середні оцінки — лише з наборів на 5 зразків').setFontStyle('italic');

  // Side blocks: how often each option was chosen (within the filters).
  var r = 3;
  var side = L.sideColumn;
  var block = function (title, options, criterion) {
    sheet.getRange(r, side, 1, 3).setValues([[title, 'Разів', '% відповідей']]).setFontWeight('bold');
    r++;
    options.forEach(function (option) {
      var countCell = colLetter_(side + 1) + r;
      sheet.getRange(r, side, 1, 3).setValues([[option, criterion(option),
        '=IF($B$7=0, "", ' + countCell + '/$B$7)']]);
      sheet.getRange(r, side + 2).setNumberFormat('0%');
      r++;
    });
    r++;
  };
  var contains = function (helperCol) {
    return function (option) {
      return '=COUNTIFS(' + inFilter + ', 1, ' + helperRange_(helperCol) + ', "*, ' + option + ',*")';
    };
  };
  var equals = function (header) {
    return function (option) {
      return '=COUNTIFS(' + inFilter + ', 1, ' + respRange_(header) + ', "' + option + '")';
    };
  };
  block('Що сподобалось', LIKED, contains(HELPER.liked));
  block('Чого не вистачає / що змінити', MISSING, contains(HELPER.missing));
  block("Як п'ють каву (набори на 3)", DRINK, contains(HELPER.drink));
  block('Чи купили б (набори на 3)', WOULD_BUY, equals('Чи купив би'));
  block('Ціна за 250 г (набори на 3)', PRICE, equals('Ціна за 250 г'));

  // Responses per recipient type, ignoring the filters.
  sheet.getRange(r, side, 1, 2).setValues([['Відповіді за типом отримувача (без фільтрів)', 'Відповідей']])
    .setFontWeight('bold');
  r++;
  RECIPIENT_TYPES.concat(['(не вказано)']).forEach(function (type) {
    var criterion = type === '(не вказано)' ? '""' : '"' + type + '"';
    sheet.getRange(r, side, 1, 2).setValues([[type,
      '=COUNTIFS(' + helperRange_(HELPER.code) + ', "?*", ' + helperRange_(HELPER.recipient) + ', ' + criterion + ')']]);
    r++;
  });

  // Charts next to the side blocks.
  var lastChartRow = L.tableHeaderRow + L.chartRows;
  var chartCol = side + 4;
  sheet.insertChart(sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange('A' + L.tableHeaderRow + ':A' + lastChartRow))
    .addRange(sheet.getRange('C' + L.tableHeaderRow + ':D' + lastChartRow))
    .setNumHeaders(1)
    .setOption('title', 'Найкращий і «купив би» за зразками')
    .setPosition(3, chartCol, 0, 0)
    .build());
  sheet.insertChart(sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange('A' + L.tableHeaderRow + ':A' + lastChartRow))
    .addRange(sheet.getRange('K' + L.tableHeaderRow + ':K' + lastChartRow))
    .setNumHeaders(1)
    .setOption('title', 'Середня оцінка за зразками (1–5)')
    .setOption('vAxis.minValue', 0)
    .setOption('vAxis.maxValue', 5)
    .setPosition(22, chartCol, 0, 0)
    .build());

  sheet.setColumnWidth(1, 230);
  sheet.setColumnWidth(side, 260);
}

// ---------- Web app ----------

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.action !== 'check') return json_({ ok: false, error: 'unknown_action' });
  var code = String(params.code || '');
  var set = findSet_(code);
  if (set && set.error) return json_({ ok: false, error: set.error });
  return json_({
    ok: true,
    valid: set !== null,
    answered: set !== null && hasResponse_(code),
    samples: set ? set.samples : null,
    setType: set ? set.samples.length : null
  });
}

// One response per code: true if «Відповіді» already has a row for it.
function hasResponse_(code) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.responses);
  if (!sheet || sheet.getLastRow() < 2) return false;
  var codes = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (var i = 0; i < codes.length; i++) {
    if (codes[i][0].trim() === code) return true;
  }
  return false;
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
    // Checked under the lock so two simultaneous submissions cannot both pass.
    if (hasResponse_(code)) return json_({ ok: false, error: 'already_answered' });
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.responses);
    ensureRows_(sheet, sheet.getLastRow() + 1);
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
        if (rule.values.indexOf(parts[i]) === -1 || parts.indexOf(parts[i]) !== i) return { error: 'invalid_' + key };
        if (parts.length > 1 && (rule.exclusive || []).indexOf(parts[i]) !== -1) return { error: 'invalid_' + key };
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
