/**
 * healer.js — selector self-healing.
 *
 * A broken selector usually fails for a boring reason: the id changed, a
 * class was renamed, the element moved. The healer does not guess — it
 * looks at what is actually on the page right now and ranks resilient
 * replacements the way Playwright's own docs recommend:
 *
 *   getByRole  >  getByLabel  >  getByText  >  getByTestId  >  CSS
 *
 * Pure functions where possible, so the scoring is unit-testable without
 * a browser. `healSelector(brokenSelector, elements)` takes the element
 * facts collected from the live page (see browser.collectElements) and
 * returns up to 3 ranked suggestions with a confidence score and a reason.
 */

const ROLE_BY_TAG = {
  button: 'button',
  a: 'link',
  input: 'textbox',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  nav: 'navigation',
  form: 'form',
  table: 'table',
  ul: 'list',
  ol: 'list',
};

/** Pull the meaningful tokens out of a CSS selector: ids, classes, tag, text-ish bits. */
export function tokenizeSelector(selector) {
  const tokens = new Set();
  if (!selector || typeof selector !== 'string') return tokens;
  for (const m of selector.matchAll(/#([\w-]+)/g)) tokens.add(m[1].toLowerCase());
  for (const m of selector.matchAll(/\.([\w-]+)/g)) tokens.add(m[1].toLowerCase());
  for (const m of selector.matchAll(/\[([^\]=~|^$*]+)/g)) tokens.add(m[1].toLowerCase());
  const tag = selector.trim().match(/^([a-zA-Z][\w-]*)/);
  if (tag) tokens.add(tag[1].toLowerCase());
  // bare words (e.g. text=Submit, "submit") can also hint at the target
  for (const m of selector.matchAll(/['"]([^'"]+)['"]/g)) {
    for (const w of m[1].toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 2) tokens.add(w);
  }
  // split compound tokens too: #search-box should also match "search"
  for (const t of [...tokens]) {
    for (const part of t.split(/[-_]/)) if (part.length > 2) tokens.add(part);
  }
  return tokens;
}

function scoreElement(el, tokens) {
  const haystacks = [
    el.id,
    el.cls.replace(/\./g, ' '),
    el.text,
    el.ariaLabel,
    el.label || '',
    el.testId,
    el.name,
    el.placeholder,
    el.tag,
  ].map((s) => (s || '').toLowerCase());
  const joined = haystacks.join(' ');
  let score = 0;
  let matched = [];
  for (const t of tokens) {
    if (joined.includes(t)) {
      score += 1;
      matched.push(t);
    }
  }
  // an exact id or testid match is worth more than a passing word match
  if (tokens.size && el.id && tokens.has(el.id.toLowerCase())) score += 3;
  if (tokens.size && el.testId && tokens.has(el.testId.toLowerCase())) score += 3;
  // prefer elements the user can actually see and interact with — but only
  // once at least one token matched, or every text element would score
  if (matched.length > 0 && (el.text || el.ariaLabel)) score += 0.5;
  return { score, matched };
}

function toPlaywrightLocator(el) {
  const name = (el.ariaLabel || el.text || '').trim();
  const role = el.role || ROLE_BY_TAG[el.tag] || null;

  if (role && name) {
    return { locator: `page.getByRole('${role}', { name: '${name.replace(/'/g, "\\'")}' })`, kind: 'role', confidence: 0.95 };
  }
  if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') {
    // real <label> text or aria-label — getByLabel only matches those
    const label = el.ariaLabel || el.label;
    if (label) {
      return { locator: `page.getByLabel('${label.replace(/'/g, "\\'")}')`, kind: 'label', confidence: 0.9 };
    }
    if (el.testId) {
      return { locator: `page.getByTestId('${el.testId}')`, kind: 'testid', confidence: 0.85 };
    }
    if (el.placeholder) {
      return { locator: `page.getByPlaceholder('${el.placeholder.replace(/'/g, "\\'")}')`, kind: 'placeholder', confidence: 0.7 };
    }
  }
  if (el.text) {
    return { locator: `page.getByText('${el.text.slice(0, 40).replace(/'/g, "\\'")}')`, kind: 'text', confidence: 0.75 };
  }
  if (el.testId) {
    return { locator: `page.getByTestId('${el.testId}')`, kind: 'testid', confidence: 0.85 };
  }
  if (el.id) {
    return { locator: `page.locator('#${el.id}')`, kind: 'css-id', confidence: 0.6 };
  }
  if (el.cls) {
    return { locator: `page.locator('${el.tag}.${el.cls.split('.').join('.')}')`, kind: 'css-class', confidence: 0.5 };
  }
  return { locator: `page.locator('${el.tag}')`, kind: 'css-tag', confidence: 0.3 };
}

/**
 * Heal a broken selector against the elements currently on the page.
 * @param {string} brokenSelector — the selector that stopped matching
 * @param {Array} elements — element facts from browser.collectElements()
 * @returns {{ found: boolean, suggestions: Array, reason: string }}
 */
export function healSelector(brokenSelector, elements) {
  const tokens = tokenizeSelector(brokenSelector);
  if (!elements || elements.length === 0) {
    return { found: false, suggestions: [], reason: 'No elements found on the page to match against.' };
  }
  const scored = elements
    .map((el) => ({ el, ...scoreElement(el, tokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      found: false,
      suggestions: [],
      reason: `Nothing on the page matches any part of "${brokenSelector}". The element may have been removed, or the page may not have loaded yet.`,
    };
  }

  const suggestions = scored.slice(0, 3).map(({ el, score, matched }) => {
    const loc = toPlaywrightLocator(el);
    return {
      ...loc,
      score,
      matchedTokens: matched,
      element: {
        tag: el.tag,
        text: el.text,
        ariaLabel: el.ariaLabel,
        testId: el.testId,
        id: el.id,
      },
      reason:
        loc.kind === 'role'
          ? 'Role + accessible name — the most resilient locator Playwright recommends.'
          : loc.kind === 'label'
            ? 'Label-based — survives id and class renames.'
            : loc.kind === 'placeholder'
              ? 'Placeholder-based — works, but weaker than a real label.'
              : loc.kind === 'text'
                ? 'Text-based — good when the visible label is stable.'
                : loc.kind === 'testid'
                  ? 'Test id — stable by design, if the app keeps using it.'
                  : 'CSS fallback — works, but breaks again on the next rename.',
    };
  });

  return {
    found: true,
    suggestions,
    reason: `Found ${scored.length} candidate(s) sharing tokens with "${brokenSelector}". Top match scored ${suggestions[0].score}.`,
  };
}
