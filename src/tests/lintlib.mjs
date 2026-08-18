/**
 * Shared static-scan primitives for the hook lints. No dependencies — these files run as bare
 * .mjs from ~/.claude, so a real parser is not available and this is the honest substitute.
 *
 * Three customers so far: `receipt-lint-test.mjs` (this discipline clause 2), `undeclared-const-test.mjs`
 * (the strict-mode ReferenceError census) and `paths-test.mjs` (the hardcoded-root census). It
 * lives here rather than in any of them because the second one needed it, and a copy would have
 * been the very thing this discipline is about.
 */

/**
 * Blank comments and string/template literals to spaces, PRESERVING length and newlines, so a
 * scanner cannot be fooled by a `{` inside a string and offsets still map to line numbers.
 *
 * A CONTEXT STACK, not a flat mode — the first draft was flat and the self-check caught it within
 * a minute. `project.mjs:135` contains a NESTED template literal:
 *
 *     `- **[p${pri}]${kind ? ` (${kind})` : ''} ${title}** — ${hook}`
 *
 * A flat scanner takes the inner backtick as the CLOSE of the outer template, flips to code mode
 * mid-string, and counts the `{` of `${kind}` as a real block. Depth ends at 1, brace matching
 * walks off the end, and every catch in that file silently vanishes from the census — the lint
 * reporting "all clear" on a file it had entirely failed to read. The stack handles `${…}`
 * interpolations as genuine code contexts (a catch can legally live inside one) and nests freely.
 *
 * `{ strings: false }` KEEPS string and template bodies while still blanking comments — the mode a
 * census over string LITERALS needs. `paths-test.mjs` hunts `path.join(os.homedir(), '.claude',
 * 'vectros-memory')`, whose whole signal lives inside quotes, so the default would erase precisely
 * what it is looking for; but it must still lose comments, or every module header that DESCRIBES
 * the old path reads as a violation (measured: the census's first run flagged `config.mjs` for a
 * comment explaining why the literal had been removed from `config.mjs`).
 *
 * The flag suppresses the BLANKING, never the TRACKING: string state is still entered and exited
 * exactly as before, so a `//` inside a string is still not a comment. Anything less would trade
 * one false positive for a worse one.
 */
export function blank(src, { strings = true } = {}) {
  const out = src.split('');
  const n = src.length;
  const st = [{ type: 'code' }];
  let i = 0;
  while (i < n) {
    const t = st[st.length - 1];
    const c = src[i];
    const d = src[i + 1];
    if (t.type === 'code' || t.type === 'interp') {
      if (c === '/' && d === '/') { out[i] = out[i + 1] = ' '; st.push({ type: 'line' }); i += 2; continue; }
      if (c === '/' && d === '*') { out[i] = out[i + 1] = ' '; st.push({ type: 'block' }); i += 2; continue; }
      if (c === '"' || c === "'") { st.push({ type: 'str', q: c }); i++; continue; }
      if (c === '`') { st.push({ type: 'tmpl' }); i++; continue; }
      if (t.type === 'interp') {
        // `${` and its matching `}` are LEFT INTACT: they balance, so brace matching is
        // unaffected and code inside an interpolation stays scannable.
        if (c === '{') { t.depth++; i++; continue; }
        if (c === '}') { if (t.depth === 0) { st.pop(); i++; continue; } t.depth--; i++; continue; }
      }
      i++; continue;
    }
    if (t.type === 'line') {
      if (c === '\n') { st.pop(); i++; continue; }
      out[i] = ' '; i++; continue;
    }
    if (t.type === 'block') {
      if (c === '*' && d === '/') { out[i] = out[i + 1] = ' '; st.pop(); i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (t.type === 'str') {
      if (c === '\\') { if (strings) { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; } i += 2; continue; }
      if (c === t.q) { st.pop(); i++; continue; }
      if (strings && c !== '\n') out[i] = ' ';
      i++; continue;
    }
    // t.type === 'tmpl'
    if (c === '\\') { if (strings) { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; } i += 2; continue; }
    if (c === '$' && d === '{') { st.push({ type: 'interp', depth: 0 }); i += 2; continue; }
    if (c === '`') { st.pop(); i++; continue; }
    if (strings && c !== '\n') out[i] = ' ';
    i++;
  }
  return out.join('');
}

/**
 * TEMPLATE-INTERPOLATION-ONLY blanking: keeps `${…}` expressions as code and blanks the literal
 * text around them. `blank()` erases a template wholesale, which is right for brace matching and
 * wrong for identifier scanning — `${TIMEOUT_MS}` is a real reference to a real binding, and it
 * is exactly where the bug this exists to catch lived.
 */
export function codeWithInterps(src) {
  const out = blank(src).split('');
  const n = src.length;
  const st = [{ type: 'code' }];
  let i = 0;
  while (i < n) {
    const t = st[st.length - 1];
    const c = src[i];
    const d = src[i + 1];
    if (t.type === 'code' || t.type === 'interp') {
      if (c === '/' && d === '/') { st.push({ type: 'line' }); i += 2; continue; }
      if (c === '/' && d === '*') { st.push({ type: 'block' }); i += 2; continue; }
      if (c === '"' || c === "'") { st.push({ type: 'str', q: c }); i++; continue; }
      if (c === '`') { st.push({ type: 'tmpl' }); i++; continue; }
      if (t.type === 'interp') {
        if (c === '{') { t.depth++; i++; continue; }
        if (c === '}') { if (t.depth === 0) { st.pop(); i++; continue; } t.depth--; i++; continue; }
      }
      i++; continue;
    }
    if (t.type === 'line') { if (c === '\n') st.pop(); i++; continue; }
    if (t.type === 'block') { if (c === '*' && d === '/') { st.pop(); i += 2; continue; } i++; continue; }
    if (t.type === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === t.q) st.pop();
      i++; continue;
    }
    // tmpl: restore the interpolation body, which blank() erased
    if (c === '\\') { i += 2; continue; }
    if (c === '$' && d === '{') {
      st.push({ type: 'interp', depth: 0 });
      const start = i + 2;
      let dep = 0;
      let j = start;
      for (; j < n; j++) {
        if (src[j] === '{') dep++;
        else if (src[j] === '}') { if (dep === 0) break; dep--; }
      }
      for (let k = start; k < j && k < n; k++) out[k] = src[k];
      i += 2; continue;
    }
    if (c === '`') { st.pop(); i++; continue; }
    i++;
  }
  return out.join('');
}
