// Exercises the real code inside public/apply.html and public/dashboard.html.
//
// Both pages are plain inline scripts with no build step, so there is nothing to
// import. Instead the script is loaded into a vm context with just enough DOM
// stubbed to let it run, and the actual functions are then called. This covers
// the parts that are pure logic — paging, validation, and the submit payload —
// which is where the bugs that matter live.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function inlineScript(page) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n;\n');
}

// A DOM stand-in: every element is a bag of properties that records what was
// set on it. Enough for scripts that assign innerHTML and wire handlers.
function fakeElement(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    querySelector: () => null, querySelectorAll: () => [],
    appendChild(){}, remove(){}, replaceWith(){}, focus(){}, select(){}, scrollTo(){}
  };
}

function makeContext({ search = '', fetchImpl, storage = {} } = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => fakeElement(tag),
    body: { appendChild(){} }
  };
  const ctx = {
    document,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
    FormData: class FormData {
      constructor(){ this.entries = []; }
      append(k, v, filename){ this.entries.push({ key: k, value: v, filename }); }
    },
    Blob: class Blob { constructor(parts, opts){ this.parts = parts; this.type = (opts||{}).type || ''; } },
    // dashboard.html boots itself on load (loadMe -> loadProjects -> render),
    // so the default stub has to answer those with realistically shaped data or
    // the boot sequence throws after the test has finished.
    fetch: fetchImpl || (async url => ({
      ok: true,
      json: async () => {
        if (String(url).includes('/me')) {
          return { tier: 'full', label: 'Full access', readOnly: false,
                   limits: { maxForms: null, maxResponsesPerForm: null }, usage: { forms: 0 } };
        }
        return [];
      }
    })),
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = v; },
      removeItem: k => { delete storage[k]; },
      clear: () => { for (const k of Object.keys(storage)) delete storage[k]; }
    },
    navigator: { clipboard: { writeText: async () => {} }, mediaDevices: {} },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame(){},
    __elements: elements
  };
  ctx.window = ctx;
  ctx.window.location = { search, origin: 'http://localhost:3000', href: '' };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

function loadApply(opts = {}) {
  const ctx = makeContext(opts);
  vm.runInContext(inlineScript('apply.html'), ctx);
  return ctx;
}

// Raw evaluation — returns cross-realm objects, so only use it for primitives
// and for calls whose result is awaited.
const run = (ctx, expr) => vm.runInContext(expr, ctx);

// Evaluate and bring the result back across the realm boundary as plain data.
// Objects created inside a vm context have that context's prototypes, which
// makes deepStrictEqual fail on identity alone.
const runJson = (ctx, expr) => JSON.parse(vm.runInContext(`JSON.stringify((${expr}))`, ctx));

// --- paging ----------------------------------------------------------------

const QUESTIONS = JSON.stringify([
  { id: 's1', type: 'section', text: 'About you', config: { description: 'Basics' } },
  { id: 'q1', type: 'short_text', text: 'Name', required: true, config: {} },
  { id: 'q2', type: 'audio', text: 'Say something', required: true, config: {} },
  { id: 's2', type: 'section', text: 'Details', config: {} },
  { id: 'q3', type: 'linear_scale', text: 'Rate', required: true, config: { min: 1, max: 5 } }
]);

test('sectioned layout groups every question up to the next section', () => {
  const ctx = loadApply();
  const pages = runJson(ctx, `buildPages(${QUESTIONS}, 'sectioned')`);
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(pages[0].items.map(q => q.id), ['q1', 'q2']);
  assert.strictEqual(pages[0].heading.title, 'About you');
  assert.strictEqual(pages[0].heading.description, 'Basics');
  assert.deepStrictEqual(pages[1].items.map(q => q.id), ['q3']);
  assert.strictEqual(pages[1].heading.title, 'Details');
});

test('one_per_page gives every question its own page — the pre-existing wizard', () => {
  const ctx = loadApply();
  const pages = runJson(ctx, `buildPages(${QUESTIONS}, 'one_per_page')`);
  assert.strictEqual(pages.length, 3);
  assert.deepStrictEqual(pages.map(p => p.items.map(q => q.id)), [['q1'], ['q2'], ['q3']]);
});

test('a form with no sections is a single page under sectioned layout', () => {
  const ctx = loadApply();
  const qs = JSON.stringify([
    { id: 'a', type: 'short_text', text: 'A', config: {} },
    { id: 'b', type: 'short_text', text: 'B', config: {} }
  ]);
  assert.strictEqual(run(ctx, `buildPages(${qs}, 'sectioned').length`), 1);
});

test('a trailing section with no questions does not create an empty page', () => {
  const ctx = loadApply();
  const qs = JSON.stringify([
    { id: 'a', type: 'short_text', text: 'A', config: {} },
    { id: 's', type: 'section', text: 'Nothing follows', config: {} }
  ]);
  const pages = runJson(ctx, `buildPages(${qs}, 'sectioned')`);
  assert.strictEqual(pages.length, 1);
  assert.deepStrictEqual(pages[0].items.map(q => q.id), ['a']);
});

// --- client-side validation -------------------------------------------------

function validate(ctx, questions, values, blobs = {}) {
  return runJson(ctx, `(() => {
    state.values = ${JSON.stringify(values)};
    state.blobs = ${JSON.stringify(blobs)};
    const page = { heading:null, items: ${JSON.stringify(questions)} };
    const ok = validatePage(page);
    return { ok, errors: state.errors };
  })()`);
}

test('required questions are caught before the page advances', () => {
  const ctx = loadApply();
  const r = validate(ctx, [{ id: 'q1', type: 'short_text', text: 'Name', required: true, config: {} }], { q1: '   ' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.q1, /required/i);
});

test('an optional blank question passes', () => {
  const ctx = loadApply();
  const r = validate(ctx, [{ id: 'q1', type: 'paragraph', text: 'Notes', required: false, config: {} }], { q1: '' });
  assert.strictEqual(r.ok, true);
});

test('the email rule runs client-side too', () => {
  const ctx = loadApply();
  const q = [{ id: 'q1', type: 'short_text', text: 'Email', config: { validation: { kind: 'email' } } }];
  assert.match(validate(ctx, q, { q1: 'nope' }).errors.q1, /valid email/i);
  assert.strictEqual(validate(ctx, q, { q1: 'a@b.co' }).ok, true);
});

test('a custom validation message wins over the default', () => {
  const ctx = loadApply();
  const q = [{ id: 'q1', type: 'short_text', text: 'Ref',
    config: { validation: { kind: 'regex', pattern: '^AB-\\d+$', message: 'Use AB-123' } } }];
  assert.strictEqual(validate(ctx, q, { q1: 'XX' }).errors.q1, 'Use AB-123');
});

test('scale answers outside the configured range are rejected', () => {
  const ctx = loadApply();
  const q = [{ id: 'q1', type: 'linear_scale', text: 'Rate', required: true, config: { min: 1, max: 5 } }];
  assert.match(validate(ctx, q, { q1: 9 }).errors.q1, /between 1 and 5/);
  assert.strictEqual(validate(ctx, q, { q1: 3 }).ok, true);
});

test('a required voice question needs a recording, not a value', () => {
  const ctx = loadApply();
  const q = [{ id: 'q1', type: 'audio', text: 'Speak', required: true, config: {} }];
  assert.match(validate(ctx, q, {}).errors.q1, /record an answer/i);
  assert.strictEqual(validate(ctx, q, {}, { q1: 'blob-stand-in' }).ok, true);
});

// --- submit payload ---------------------------------------------------------
// The shape here is the contract with routes/invite.js: files as answer_<id>,
// everything else as a JSON-encoded value_<id>.

test('submit posts JSON-encoded values and files under the right field names', async () => {
  let captured = null;
  const ctx = loadApply({
    fetchImpl: async (url, opts) => {
      captured = { url, body: opts.body };
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });

  run(ctx, `
    state.code = 'ABC123';
    state.name = '  Ada Lovelace  ';
    state.email = ' ada@example.com ';
    state.consentedAt = Date.now();
    state.values = { q1: 'Ada', q2: ['Vim','Emacs'], q3: 4, q4: '' };
    state.blobs = { q5: new Blob(['x'], { type: 'audio/webm' }) };
    state.pages = [{ heading:null, items: [
      { id:'q1', type:'short_text', config:{} },
      { id:'q2', type:'checkboxes', config:{} },
      { id:'q3', type:'linear_scale', config:{} },
      { id:'q4', type:'paragraph', config:{} },
      { id:'q5', type:'audio', config:{} }
    ]}];
  `);
  await run(ctx, 'submit()');

  assert.ok(captured, 'submit should have posted');
  assert.strictEqual(captured.url, '/api/invite/ABC123/submit');
  const entries = JSON.parse(JSON.stringify(captured.body.entries.map(e => ({ key: e.key, value: typeof e.value === 'string' ? e.value : null, filename: e.filename }))));
  const byKey = Object.fromEntries(entries.map(e => [e.key, e.value]));

  assert.strictEqual(byKey.candidateName, 'Ada Lovelace', 'name is trimmed');
  assert.strictEqual(byKey.respondentEmail, 'ada@example.com', 'email is trimmed');
  assert.strictEqual(byKey.consent, 'true');

  assert.strictEqual(byKey.value_q1, '"Ada"', 'strings are JSON-encoded');
  assert.deepStrictEqual(JSON.parse(byKey.value_q2), ['Vim', 'Emacs'], 'arrays survive');
  assert.strictEqual(JSON.parse(byKey.value_q3), 4, 'numbers stay numbers');
  assert.ok(!('value_q4' in byKey), 'a blank optional answer is omitted entirely');

  const file = entries.find(e => e.key === 'answer_q5');
  assert.ok(file, 'the recording rides as answer_<id>');
  assert.match(file.filename, /\.webm$/, 'filename extension follows the blob type');
});

test('consent is omitted on a form that records nothing', async () => {
  let captured = null;
  const ctx = loadApply({
    fetchImpl: async (url, opts) => { captured = opts.body; return { ok: true, json: async () => ({ ok: true }) }; }
  });
  run(ctx, `
    state.code = 'X'; state.name = 'A'; state.email = 'a@b.co';
    state.consentedAt = null;
    state.values = { q1: 'hi' };
    state.pages = [{ heading:null, items:[{ id:'q1', type:'short_text', config:{} }] }];
  `);
  await run(ctx, 'submit()');
  assert.ok(!captured.entries.some(e => e.key === 'consent'));
});

test('a closed-intake rejection at submit time swaps in the closed card', async () => {
  const ctx = loadApply({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ code: 'INTAKE_CLOSED', error: 'This form is no longer accepting responses.' })
    })
  });
  run(ctx, `
    state.code='X'; state.name='A'; state.email='a@b.co';
    state.form = { title:'T' };
    state.values={}; state.pages=[{heading:null,items:[]}];
  `);
  await run(ctx, 'submit()');
  const html = run(ctx, 'document.getElementById("stage").innerHTML');
  assert.match(html, /no longer accepting responses/);
});

test('server fieldErrors jump the respondent to the first offending page', async () => {
  const ctx = loadApply({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: 'Some answers need attention', fieldErrors: { q9: 'Enter a valid email address' } })
    })
  });
  run(ctx, `
    state.code='X'; state.name='A'; state.email='a@b.co';
    state.form = { title:'T', questions:[] };
    state.values = { q1:'a', q9:'bad' };
    state.pages = [
      { heading:null, items:[{ id:'q1', type:'short_text', config:{} }] },
      { heading:null, items:[{ id:'q9', type:'short_text', config:{} }] }
    ];
    state.page = 0;
  `);
  await run(ctx, 'submit()');
  assert.strictEqual(run(ctx, 'state.page'), 1, 'should land on the page holding the bad answer');
  assert.strictEqual(run(ctx, 'state.errors.q9'), 'Enter a valid email address');
});

// --- dashboard: config hygiene on type change -------------------------------

test('changing a question type drops config that no longer applies', () => {
  const ctx = makeContext({ storage: { token: 'test-token' } });
  vm.runInContext(inlineScript('dashboard.html'), ctx);

  // A choice question carrying options, switched to a scale.
  const after = runJson(ctx, `(() => {
    const q = { id:null, type:'linear_scale', text:'x', required:false,
                config:{ options:['a','b'], allowOther:true } };
    applyTypeDefaults(q);
    return q.config;
  })()`);
  assert.deepStrictEqual(after, { min: 1, max: 5 }, 'stale options must not survive');

  const choice = runJson(ctx, `(() => {
    const q = { id:null, type:'multiple_choice', text:'x', required:false, config:{} };
    applyTypeDefaults(q);
    return q.config;
  })()`);
  assert.deepStrictEqual(choice.options, ['Option 1'], 'a new choice question starts with one option');
});
