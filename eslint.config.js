const js = require('@eslint/js');

// This repo has no bundler/transpiler anywhere — server-side files are
// plain CommonJS Node, and public/*.js are plain browser <script>s (no
// import/export). Different global environments, so they get separate
// language-options blocks below rather than one shared list.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  module: 'writable',
  exports: 'writable',
  require: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  // Available as real globals since Node 18 — no `require('...')` needed
  // for these, which is exactly why ESLint doesn't know about them without
  // being told explicitly.
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
};

// public/*.js are loaded via plain <script> tags in index.html — no
// import/export, just ordinary browser globals. Deliberately doesn't
// include module/exports: neither actually exists in a real browser, and
// only client-helpers.js needs them (see the block below) — including them
// here too would let a stray `module.exports`/`require` typo in app.js pass
// lint clean while still throwing ReferenceError the moment the page loads.
const browserGlobals = {
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  document: 'readonly',
  window: 'readonly',
};

module.exports = [
  {
    // apps/* are separate, independently-owned projects (see README's note
    // on sub-apps keeping their own git repos/dependencies) — this repo's
    // lint rules aren't theirs to enforce. .github/** is YAML, not JS.
    ignores: ['node_modules/**', 'apps/**', '.github/**'],
  },
  js.configs.recommended,
  {
    // Repo-wide rules — these make just as much sense for public/*.js as
    // for the server-side files, so they're not scoped to `files` the way
    // languageOptions/globals below has to be.
    rules: {
      // Not enabled by eslint:recommended by default. Turned on here so the
      // disable directives already sitting in lib/process-manager.js (for a
      // couple of deliberately sequential polling loops) actually suppress
      // something, instead of silently no-op-ing against a rule that was
      // never on in the first place.
      'no-await-in-loop': 'warn',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Config objects with no `files` apply to every matched file, merging
    // additively with whatever public/**/*.js's own block below declares —
    // NOT replacing it. So this has to be scoped explicitly to the
    // server-side files; leaving it unscoped previously meant module/
    // require/__dirname/process/etc. were silently still available as
    // globals inside public/**/*.js too, regardless of what browserGlobals
    // did or didn't include.
    files: ['lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'server.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browserGlobals,
    },
  },
  {
    // app.js is loaded after client-helpers.js in index.html and consumes
    // its functions as plain globals; client-helpers.js defines them, so it
    // deliberately doesn't get this block too (that'd flag them as
    // no-redeclare — already-defined built-ins clashing with its own
    // function declarations).
    files: ['public/app.js'],
    languageOptions: {
      globals: { escapeHtml: 'readonly', gitBadge: 'readonly', nodeBadge: 'readonly' },
    },
  },
  {
    // The public/*.js files that are also require()'d from tests
    // (test/client-helpers.test.js, test/app.test.js), each guarded by a
    // `typeof module !== 'undefined'`/`typeof document !== 'undefined'`
    // check — see their own top-of-file comments.
    files: ['public/client-helpers.js', 'public/app.js'],
    languageOptions: {
      globals: { module: 'writable', exports: 'writable' },
    },
  },
];
