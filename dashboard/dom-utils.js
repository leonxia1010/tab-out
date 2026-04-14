'use strict';

/*
 * dom-utils.js — tiny DOM construction helpers for safe rendering.
 *
 * Three functions: el(), svg(), mount(). No templating, no escape function —
 * textContent and setAttribute auto-escape; no raw HTML from user data ever
 * reaches innerHTML through these helpers.
 *
 * Exposed globally (no modules): window.domUtils = { el, svg, mount }.
 */
(function () {
  const PROPERTY_KEYS = new Set([
    'className', 'id', 'textContent', 'style', 'hidden',
    'disabled', 'checked', 'value', 'type', 'src', 'alt',
  ]);

  // Allow http(s), mailto, tel, relative (/foo, ?q, #hash), and empty. Anything
  // else (javascript:, data:, vbscript:, file:) collapses to '#' — defense
  // against stored XSS via user-controlled `url` fields in the deferred_tabs
  // table.
  const SAFE_HREF_RE = /^(https?:|mailto:|tel:|[\/?#])/i;
  function sanitizeHref(raw) {
    const val = String(raw == null ? '' : raw).trim();
    if (val === '' || SAFE_HREF_RE.test(val)) return val;
    return '#';
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        let val = attrs[key];
        if (val === undefined || val === null) continue;

        if (key.startsWith('on')) {
          throw new Error(`dom-utils: inline handlers forbidden (${key}); use addEventListener`);
        }
        if (key === 'dataset') {
          for (const dk of Object.keys(val)) {
            const dv = val[dk];
            if (dv === undefined || dv === null) continue;
            node.dataset[dk] = String(dv);
          }
          continue;
        }
        if (key === 'href') {
          val = sanitizeHref(val);
        }
        if (PROPERTY_KEYS.has(key)) {
          node[key] = val;
        } else {
          node.setAttribute(key, String(val));
        }
      }
    }
    if (children !== undefined && children !== null) {
      appendChildren(node, children);
    }
    return node;
  }

  function appendChildren(parent, children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === undefined || child === null || child === false) continue;
      if (child instanceof Node) {
        parent.appendChild(child);
      } else {
        parent.appendChild(document.createTextNode(String(child)));
      }
    }
  }

  // Parse a trusted SVG/HTML string literal into an HTMLElement.
  // ONLY for developer-authored strings (e.g. ICONS), never user data.
  function svg(svgString) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = svgString;
    return tmpl.content.firstElementChild;
  }

  // Replace a target's children with a node or array of nodes.
  function mount(target, nodes) {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    target.replaceChildren(...list.filter(n => n != null && n !== false));
  }

  window.domUtils = { el, svg, mount };
})();
