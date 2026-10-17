'use strict';

/**
 * Dialog focus helpers. Loading this file does not move focus and does not
 * observe the DOM. Wire the calls from hub.js; see
 * docs/integration-notes/W37-ux.md.
 */

var savedFocus = typeof WeakMap === 'function' ? new WeakMap() : null;
var savedFallback = null;

function tagNameOf(el) {
  return el && el.tagName ? String(el.tagName).toUpperCase() : '';
}

function tabindexOf(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  var raw = el.getAttribute('tabindex');
  if (raw == null || raw === '') return null;
  var n = Number(raw);
  return n === n ? n : null;
}

function hiddenElement(el) {
  if (!el) return true;
  if (el.hidden === true) return true;
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) return true;
  if (typeof el.getAttribute === 'function' && el.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

function isFocusable(el) {
  if (!el || el.nodeType !== 1 || el.disabled === true || hiddenElement(el)) return false;
  var tag = tagNameOf(el);
  var tab = tabindexOf(el);
  if (tab != null && tab < 0) return false;
  if (tag === 'INPUT' && String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase() === 'hidden') return false;
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'A' && el.getAttribute && el.getAttribute('href')) return true;
  if (tab != null && tab >= 0) return true;
  return false;
}

function listFocusable(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  var nodes = root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]');
  var out = [];
  var i;
  for (i = 0; i < nodes.length; i += 1) {
    if (isFocusable(nodes[i])) out.push(nodes[i]);
  }
  return out;
}

function focusDialog(dialog) {
  if (!dialog || typeof dialog.querySelectorAll !== 'function') return null;
  var previous = typeof document !== 'undefined' && document ? document.activeElement : null;
  if (previous && (previous === dialog || (typeof dialog.contains === 'function' && dialog.contains(previous)))) {
    previous = null;
  }
  if (savedFocus) savedFocus.set(dialog, previous || null);
  else savedFallback = previous || null;
  var list = listFocusable(dialog);
  var target = list.length ? list[0] : dialog;
  if (target === dialog && tabindexOf(dialog) == null && typeof dialog.setAttribute === 'function') {
    dialog.setAttribute('tabindex', '-1');
  }
  if (target && typeof target.focus === 'function') target.focus();
  return target;
}

function restoreDialogFocus(dialog) {
  var previous = null;
  if (savedFocus && dialog) previous = savedFocus.get(dialog) || null;
  else previous = savedFallback;
  if (savedFocus && dialog) savedFocus.delete(dialog);
  else savedFallback = null;
  if (!previous || typeof previous.focus !== 'function') return null;
  if (previous.isConnected === false) return null;
  try {
    previous.focus();
  } catch (err) {
    return null;
  }
  return previous;
}

var marustA11y = {
  focusDialog: focusDialog,
  restoreDialogFocus: restoreDialogFocus
};

if (typeof module === 'object' && module.exports) module.exports = marustA11y;
if (typeof window !== 'undefined') window.marustA11y = marustA11y;
