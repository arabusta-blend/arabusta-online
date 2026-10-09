(function () {
  'use strict';

  // Sets ТЕСТ 001…010 have 5 samples, ТЕСТ 011…040 have 3.
  var SET_MIN = 1;
  var SET_MAX = 40;
  var LAST_FIVE_SAMPLE_SET = 10;

  var MESSAGES = {
    testIdEmpty: 'Введіть цифри з наклейки.',
    testIdRange: 'Набору з таким номером немає. Перевірте цифри на наклейці (від 001 до 040).',
    radio: 'Оберіть варіант.',
    checkbox: 'Оберіть хоча б один варіант.',
    rating: 'Оцініть усі чотири параметри.',
    other: 'Уточніть, будь ласка.',
    consent: 'Підтвердіть згоду або очистіть поле контакту.'
  };

  var form = document.getElementById('survey');
  var testIdInput = document.getElementById('test-id');
  var testIdError = document.getElementById('test-id-error');
  var contactInput = document.getElementById('contact');
  var consentBlock = document.getElementById('consent-block');
  var consentInput = document.getElementById('consent');
  var sets = {
    3: document.getElementById('set-3'),
    5: document.getElementById('set-5')
  };

  var screens = ['screen-start', 'screen-test-id', 'screen-survey', 'screen-contact', 'screen-thanks']
    .map(function (id) { return document.getElementById(id); });

  var state = { screen: 0, testId: null, setType: null };

  // ---------- Screens ----------

  function showScreen(index) {
    screens.forEach(function (screen, i) { screen.hidden = i !== index; });
    state.screen = index;
    window.scrollTo(0, 0);
    var heading = screens[index].querySelector('h1, h2, .set:not([hidden]) .set__title');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  function goNext() {
    var current = screens[state.screen];
    if (current.id === 'screen-start') return showScreen(1);
    if (current.id === 'screen-test-id' && acceptTestId()) return showScreen(2);
    if (current.id === 'screen-survey' && validateSection(current)) return showScreen(3);
  }

  function goBack() {
    if (state.screen > 1) showScreen(state.screen - 1);
  }

  // ---------- Set number ----------

  // Keeps only digits, so "ТЕСТ 001", "TEST-001" and "001" all become "001".
  function digitsOf(value) {
    return value.replace(/\D/g, '').slice(0, 3);
  }

  function normalizeTestId(value) {
    var digits = digitsOf(value);
    if (!digits) return { error: MESSAGES.testIdEmpty };
    var number = parseInt(digits, 10);
    if (number < SET_MIN || number > SET_MAX) return { error: MESSAGES.testIdRange };
    return { id: 'ТЕСТ ' + String(number).padStart(3, '0'), number: number };
  }

  function acceptTestId() {
    var result = normalizeTestId(testIdInput.value);
    if (result.error) {
      testIdError.textContent = result.error;
      testIdInput.classList.add('is-invalid');
      testIdInput.focus();
      return false;
    }
    testIdError.textContent = '';
    testIdInput.classList.remove('is-invalid');
    testIdInput.value = result.id.slice(5);

    state.testId = result.id;
    activateSet(result.number <= LAST_FIVE_SAMPLE_SET ? 5 : 3);
    document.querySelectorAll('[data-test-id-label]').forEach(function (el) {
      el.textContent = result.id;
    });
    return true;
  }

  testIdInput.addEventListener('input', function () {
    var digits = digitsOf(testIdInput.value);
    if (testIdInput.value !== digits) testIdInput.value = digits;
    if (testIdError.textContent) {
      testIdError.textContent = '';
      testIdInput.classList.remove('is-invalid');
    }
  });

  // Pad to the sticker format on blur: "1" -> "001".
  testIdInput.addEventListener('blur', function () {
    var digits = digitsOf(testIdInput.value);
    if (digits) testIdInput.value = digits.padStart(3, '0');
  });

  // Both sets share field names; the inactive one is disabled so it is
  // skipped by validation and FormData.
  function activateSet(type) {
    if (state.setType && state.setType !== type) resetSet(sets[state.setType]);
    state.setType = type;
    Object.keys(sets).forEach(function (key) {
      var active = Number(key) === type;
      sets[key].hidden = !active;
      sets[key].disabled = !active;
    });
  }

  function resetSet(set) {
    set.querySelectorAll('input, textarea').forEach(function (field) {
      if (field.type === 'radio' || field.type === 'checkbox') field.checked = false;
      else field.value = '';
    });
    set.querySelectorAll('.is-invalid').forEach(clearError);
    syncConditionals(set);
  }

  // ---------- Conditional fields ----------

  function syncConditionals(root) {
    // "Інше" text field is shown only while the "Інше" option is checked.
    root.querySelectorAll('.question').forEach(function (question) {
      var trigger = question.querySelector('[data-other]');
      var input = question.querySelector('.input--other');
      if (!trigger || !input) return;
      input.hidden = !trigger.checked;
      if (!trigger.checked) {
        input.value = '';
        input.classList.remove('is-invalid');
      }
    });

    // "Яку каву Ви хотіли б отримати?" is shown only when "Жоден" is the favorite.
    root.querySelectorAll('[data-show-if-none]').forEach(function (block) {
      var set = block.closest('.set');
      var none = set.querySelector('[data-none]');
      block.hidden = !(none && none.checked);
      if (block.hidden) block.querySelector('textarea').value = '';
    });
  }

  // "Нічого" excludes every other option in its group, and vice versa.
  function syncExclusive(changed) {
    if (changed.type !== 'checkbox' || !changed.checked) return;
    var group = form.querySelectorAll('input[type="checkbox"][name="' + changed.name + '"]');
    group.forEach(function (box) {
      if (box === changed || box.disabled) return;
      if (changed.hasAttribute('data-exclusive') || box.hasAttribute('data-exclusive')) {
        box.checked = false;
      }
    });
  }

  form.addEventListener('change', function (event) {
    var target = event.target;
    syncExclusive(target);
    syncConditionals(form);
    var question = target.closest('[data-required]');
    if (question && question.classList.contains('is-invalid')) validateQuestion(question);
  });

  form.addEventListener('input', function (event) {
    if (event.target.classList.contains('input--other') && event.target.value.trim()) {
      event.target.classList.remove('is-invalid');
      var question = event.target.closest('[data-required]');
      if (question && question.classList.contains('is-invalid')) validateQuestion(question);
    }
  });

  // ---------- Validation ----------

  function setError(question, message) {
    question.classList.add('is-invalid');
    var error = question.querySelector('.field__error');
    if (error) error.textContent = message;
  }

  function clearError(question) {
    question.classList.remove('is-invalid');
    var error = question.querySelector('.field__error');
    if (error) error.textContent = '';
  }

  function validateQuestion(question) {
    var inputs = Array.prototype.slice.call(question.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    var names = inputs.map(function (i) { return i.name; })
      .filter(function (name, i, all) { return all.indexOf(name) === i; });

    var unanswered = names.filter(function (name) {
      return !question.querySelector('input[name="' + name + '"]:checked');
    });

    if (unanswered.length) {
      var message = question.classList.contains('sample-card') ? MESSAGES.rating
        : inputs[0].type === 'checkbox' ? MESSAGES.checkbox
        : MESSAGES.radio;
      setError(question, message);
      return false;
    }

    var other = question.querySelector('.input--other');
    if (other && !other.hidden && !other.value.trim()) {
      other.classList.add('is-invalid');
      setError(question, MESSAGES.other);
      return false;
    }

    clearError(question);
    return true;
  }

  function validateSection(section) {
    var firstInvalid = null;
    section.querySelectorAll('[data-required]').forEach(function (question) {
      if (question.matches(':disabled') || question.closest('[hidden]')) return;
      if (!validateQuestion(question) && !firstInvalid) firstInvalid = question;
    });
    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var focusTarget = firstInvalid.querySelector('.input--other.is-invalid') ||
        firstInvalid.querySelector('input');
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      return false;
    }
    return true;
  }

  // ---------- Contact consent ----------

  // Consent is asked only while a contact is entered; clearing the contact withdraws it.
  contactInput.addEventListener('input', function () {
    var hasContact = Boolean(contactInput.value.trim());
    consentBlock.hidden = !hasContact;
    if (!hasContact) {
      consentInput.checked = false;
      clearError(consentBlock);
    }
  });

  consentInput.addEventListener('change', function () {
    if (consentInput.checked) clearError(consentBlock);
  });

  function validateConsent() {
    if (!contactInput.value.trim() || consentInput.checked) return true;
    setError(consentBlock, MESSAGES.consent);
    consentBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
    consentInput.focus({ preventScroll: true });
    return false;
  }

  // ---------- Answers ----------

  // Collects enabled fields into a flat object; multi-select values are joined with ", ".
  function collectAnswers() {
    var data = new FormData(form);
    var answers = { test_id: state.testId, set_type: state.setType };
    data.forEach(function (value, key) {
      if (key === 'test_id') return;
      value = String(value).trim();
      if (!value) return;
      answers[key] = answers[key] ? answers[key] + ', ' + value : value;
    });
    return answers;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    // Enter in a text field submits the form: treat it as "Далі" before the last screen.
    if (screens[state.screen].id !== 'screen-contact') return goNext();
    if (!validateConsent()) return;

    var answers = collectAnswers();
    // TODO(step 3): send answers to Google Apps Script instead of logging.
    console.log('Survey answers', answers);
    showScreen(4);
  });

  // ---------- Buttons ----------

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]');
    if (!button) return;
    var action = button.getAttribute('data-action');
    if (action === 'start' || action === 'next') goNext();
    if (action === 'back') goBack();
  });

  // ---------- Init ----------

  activateSet(3);
  state.setType = null;
  syncConditionals(form);
  showScreen(0);
})();
