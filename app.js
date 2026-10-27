(function () {
  'use strict';

  // Google Apps Script web app URL (Deploy → Web app → URL ending in /exec).
  // Empty = demo mode: any 4-digit code is accepted, "5555" opens the 5-sample survey,
  // and answers are only logged to the console.
  var SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwn2M4GrhdwcI0EaGsnD-Kx2AJsWN37POL9TQWAmMX950JP5yAVxbWgQgoETnta1yOphw/exec';
  var DEMO = !SCRIPT_URL;
  var REQUEST_TIMEOUT_MS = 20000;
  var DEMO_SAMPLES = { 3: ['№01', '№02', '№03'], 5: ['№01', '№02', '№03', '№04', '№05'] };

  // Valid codes and their sample numbers live only in the «Набори» sheet; the script checks them.
  var CODE_LENGTH = 4;

  var MESSAGES = {
    testIdEmpty: 'Введіть код з коробки.',
    testIdLength: 'Код має складатися з чотирьох цифр.',
    testIdUnknown: 'Такого коду немає. Перевірте цифри на коробці.',
    testIdAnswered: 'За цим кодом анкету вже заповнено. Дякуємо!',
    checkFailed: 'Не вдалося перевірити код. Перевірте інтернет і спробуйте ще раз.',
    setMisconfigured: 'Цей набір ще не налаштовано. Будь ласка, зверніться до ARABUSTA.',
    alreadyAnswered: 'За цим кодом анкету вже заповнили раніше, тому ці відповіді не збережено.',
    submitFailed: 'Не вдалося надіслати відповіді. Перевірте інтернет і спробуйте ще раз.',
    radio: 'Оберіть варіант.',
    checkbox: 'Оберіть хоча б один варіант.',
    rating: 'Оцініть усі чотири параметри.',
    other: 'Уточніть, будь ласка.'
  };

  var form = document.getElementById('survey');
  var testIdInput = document.getElementById('test-id');
  var testIdError = document.getElementById('test-id-error');
  var nextButton = document.querySelector('#screen-test-id [data-action="next"]');
  var submitButton = form.querySelector('button[type="submit"]');
  var formStatus = document.getElementById('form-status');
  var sets = {
    3: document.getElementById('set-3'),
    5: document.getElementById('set-5')
  };

  var screens = ['screen-start', 'screen-test-id', 'screen-survey', 'screen-thanks']
    .map(function (id) { return document.getElementById(id); });

  var state = { screen: 0, testId: null, setType: null, busy: false };

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
    if (current.id === 'screen-test-id') checkTestId();
  }

  function goBack() {
    if (state.busy) return;
    if (state.screen > 1) showScreen(state.screen - 1);
  }

  // ---------- Server ----------

  function withTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, REQUEST_TIMEOUT_MS);
      promise.then(
        function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); }
      );
    });
  }

  function readJson(response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  // Resolves to { valid, answered, samples }; samples are the set's sample numbers, e.g. ['№02', '№04', '№05'].
  function requestCodeCheck(code) {
    if (DEMO) return Promise.resolve({ ok: true, valid: true, samples: DEMO_SAMPLES[code === '5555' ? 5 : 3] });
    var url = SCRIPT_URL + '?action=check&code=' + encodeURIComponent(code);
    return withTimeout(fetch(url).then(readJson)).then(function (result) {
      if (!result.ok) throw new Error(result.error || 'check_failed');
      return result;
    });
  }

  // text/plain avoids a CORS preflight, which Apps Script does not answer.
  function requestSubmit(answers) {
    if (DEMO) {
      console.log('Demo mode, answers not saved:', answers);
      return Promise.resolve({ ok: true });
    }
    return withTimeout(fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(answers)
    }).then(readJson)).then(function (result) {
      if (!result.ok) throw new Error(result.error || 'submit_failed');
      return result;
    });
  }

  function setBusy(button, busy, busyLabel) {
    state.busy = busy;
    button.disabled = busy;
    if (busy) {
      button.dataset.label = button.dataset.label || button.textContent;
      button.textContent = busyLabel;
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  }

  // ---------- Set code ----------

  // Keeps only digits, so pasted text with spaces or letters still works.
  function digitsOf(value) {
    return value.replace(/\D/g, '').slice(0, CODE_LENGTH);
  }

  // Format check only; whether the code exists is decided by the script.
  function normalizeTestId(value) {
    var digits = digitsOf(value);
    if (!digits) return { error: MESSAGES.testIdEmpty };
    if (digits.length !== CODE_LENGTH) return { error: MESSAGES.testIdLength };
    return { id: digits };
  }

  function showTestIdError(message) {
    testIdError.textContent = message;
    testIdInput.classList.add('is-invalid');
    testIdInput.focus();
  }

  function checkTestId() {
    if (state.busy) return;
    var result = normalizeTestId(testIdInput.value);
    if (result.error) return showTestIdError(result.error);

    setBusy(nextButton, true, 'Перевіряємо…');
    requestCodeCheck(result.id)
      .then(function (check) {
        setBusy(nextButton, false);
        if (!check.valid) return showTestIdError(MESSAGES.testIdUnknown);
        if (check.answered) return showTestIdError(MESSAGES.testIdAnswered); // one response per code
        var samples = check.samples || [];
        if (!sets[samples.length]) throw new Error('unexpected sample count: ' + samples.length);
        acceptTestId(result.id, samples);
        showScreen(2);
      })
      .catch(function (error) {
        console.error('Code check failed:', error);
        setBusy(nextButton, false);
        // The set's row in «Набори» is filled in wrong (not 3 or 5 samples): not a network problem.
        var misconfigured = /^(bad_samples|unexpected sample count)/.test(error.message);
        showTestIdError(misconfigured ? MESSAGES.setMisconfigured : MESSAGES.checkFailed);
      });
  }

  function acceptTestId(code, samples) {
    testIdError.textContent = '';
    testIdInput.classList.remove('is-invalid');
    state.testId = code;
    activateSet(samples.length);
    renderSamples(sets[samples.length], samples);
    document.querySelectorAll('[data-test-id-label]').forEach(function (el) {
      el.textContent = code;
    });
  }

  // Replaces the placeholder sample options (№01…) with this set's sample numbers.
  function renderSamples(set, samples) {
    set.querySelectorAll('.question').forEach(function (question) {
      var current = question.querySelectorAll('.option--sample');
      if (!current.length) return;
      var template = current[0].querySelector('input');
      var name = template.name;
      var type = template.type;
      var container = current[0].parentNode;
      var anchor = current[current.length - 1].nextSibling;
      current.forEach(function (option) { option.remove(); });
      samples.forEach(function (sample) {
        var label = document.createElement('label');
        label.className = 'option option--sample';
        var input = document.createElement('input');
        input.type = type;
        input.name = name;
        input.value = sample;
        var text = document.createElement('span');
        text.textContent = sample;
        label.append(input, text);
        container.insertBefore(label, anchor);
      });
    });

    // Rating cards: card N rates the N-th sample of the set.
    set.querySelectorAll('.sample-card').forEach(function (card, i) {
      card.querySelector('.sample-card__title').textContent = 'Зразок ' + samples[i];
      card.querySelectorAll('.rating').forEach(function (rating) {
        var aspect = rating.querySelector('.rating__label').textContent.toLowerCase();
        rating.setAttribute('aria-label', samples[i] + ' — ' + aspect);
      });
    });
  }

  testIdInput.addEventListener('input', function () {
    var digits = digitsOf(testIdInput.value);
    if (testIdInput.value !== digits) testIdInput.value = digits;
    if (testIdError.textContent) {
      testIdError.textContent = '';
      testIdInput.classList.remove('is-invalid');
    }
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

  // ---------- Answers ----------

  // Collects enabled fields into a flat object; multi-select values are joined with ", ".
  function collectAnswers() {
    var data = new FormData(form);
    var answers = { test_id: state.testId }; // the script takes the set type from «Набори»
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
    // Enter in the set number field submits the form: treat it as "Далі".
    var current = screens[state.screen];
    if (current.id !== 'screen-survey') return goNext();
    if (state.busy || !validateSection(current)) return;

    setStatus('');
    setBusy(submitButton, true, 'Надсилаємо…');
    requestSubmit(collectAnswers())
      .then(function () {
        setBusy(submitButton, false);
        showScreen(3);
      })
      .catch(function (error) {
        console.error('Submit failed:', error);
        setBusy(submitButton, false);
        // Someone else submitted this code first; retrying cannot help.
        if (error.message === 'already_answered') return setStatus(MESSAGES.alreadyAnswered, true);
        submitButton.textContent = 'Спробувати ще';
        setStatus(MESSAGES.submitFailed, true);
      });
  });

  function setStatus(message, isError) {
    formStatus.textContent = message;
    formStatus.classList.toggle('is-error', Boolean(isError));
  }

  // Enter in a survey text field must not submit the whole survey by accident.
  form.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.matches('#screen-survey input[type="text"]')) {
      event.preventDefault();
    }
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
  document.getElementById('demo-banner').hidden = !DEMO;
  showScreen(0);
})();
