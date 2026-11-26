/**
 * Unit tests for the selector healer — no browser needed.
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeSelector, healSelector } from '../src/healer.js';

const PAGE_ELEMENTS = [
  { tag: 'button', text: 'Add to cart', ariaLabel: '', label: '', testId: 'add-to-cart', role: '', id: 'checkout-btn-new', cls: 'primary', type: '', name: '', placeholder: '' },
  { tag: 'input', text: '', ariaLabel: 'Search products', label: '', testId: '', role: '', id: 'search', cls: '', type: 'text', name: 'search', placeholder: 'Try "headphones"' },
  { tag: 'input', text: '', ariaLabel: '', label: 'Quantity', testId: 'qty-input', role: '', id: 'qty', cls: '', type: 'text', name: 'qty', placeholder: 'How many?' },
  { tag: 'a', text: 'Example link', ariaLabel: '', label: '', testId: '', role: '', id: '', cls: '', type: '', name: '', placeholder: '' },
  { tag: 'h1', text: 'QA Pilot demo shop', ariaLabel: '', label: '', testId: '', role: '', id: '', cls: '', type: '', name: '', placeholder: '' },
  { tag: 'div', text: '', ariaLabel: '', label: '', testId: 'spinner', role: '', id: '', cls: 'spinner', type: '', name: '', placeholder: '' },
];

test('tokenizeSelector pulls ids, classes and tags out of a selector', () => {
  const tokens = tokenizeSelector('#checkout-btn.primary');
  assert.ok(tokens.has('checkout-btn'));
  assert.ok(tokens.has('primary'));
  // compound tokens are split too, so #search-box also matches "search"
  assert.ok(tokenizeSelector('#search-box').has('search'));
});

test('healSelector finds the renamed checkout button by its text', () => {
  const result = healSelector('#checkout-btn', PAGE_ELEMENTS);
  assert.equal(result.found, true);
  assert.ok(result.suggestions.length >= 1);
  const top = result.suggestions[0];
  assert.match(top.locator, /Add to cart/);
  assert.equal(top.kind, 'role'); // role + accessible name wins
  assert.ok(top.confidence >= 0.9);
});

test('healSelector suggests role+name for an input with an accessible name', () => {
  const result = healSelector('#search-box', PAGE_ELEMENTS);
  assert.equal(result.found, true);
  assert.equal(result.suggestions[0].kind, 'role');
  assert.match(result.suggestions[0].locator, /Search products/);
});

test('healSelector suggests label for an input with a real <label>', () => {
  const result = healSelector('#qty-field-old', PAGE_ELEMENTS);
  assert.equal(result.found, true);
  assert.equal(result.suggestions[0].kind, 'label');
  assert.match(result.suggestions[0].locator, /Quantity/);
});

test('healSelector suggests testid for an element with nothing else to grab', () => {
  const result = healSelector('[data-testid="spinner"]', PAGE_ELEMENTS);
  assert.equal(result.found, true);
  assert.equal(result.suggestions[0].kind, 'testid');
  assert.match(result.suggestions[0].locator, /spinner/);
});

test('healSelector returns found:false when nothing matches', () => {
  const result = healSelector('#zzzzz-qqqqq', PAGE_ELEMENTS);
  assert.equal(result.found, false);
  assert.equal(result.suggestions.length, 0);
  assert.match(result.reason, /Nothing on the page matches/);
});

test('healSelector handles an empty page gracefully', () => {
  const result = healSelector('#anything', []);
  assert.equal(result.found, false);
});
