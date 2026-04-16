// Tiny DOM construction helpers for safe rendering.
// textContent/setAttribute auto-escape; inline event handlers are rejected;
// href values run through a scheme whitelist. No raw HTML from user data
// ever reaches innerHTML through these helpers.
//
// Phase 2 PR A: ESM rewrite of legacy dashboard/dom-utils.js. The legacy
// IIFE file still exists for now — render.test.js injects it into JSDOM as
// a <script> tag, and app.js still reads window.domUtils from it. Both go
// away in PR G once app.js is fully migrated to ESM.

type AttrValue = string | number | boolean | null | undefined;
type DatasetValue = Record<string, AttrValue>;
type AttrEntry = AttrValue | DatasetValue;
export type Attrs = Record<string, AttrEntry>;

type Child = Node | string | number | null | undefined | false;
export type Children = Child | Child[];

const PROPERTY_KEYS = new Set<string>([
  'className', 'id', 'textContent', 'style', 'hidden',
  'disabled', 'checked', 'value', 'type', 'src', 'alt',
]);

// Schemes allowed to stay on href attributes after sanitization. Anything
// outside this set (javascript:, data:, vbscript:, blob:, etc.) is
// downgraded to '#' so a malicious saved URL cannot run code when the
// anchor is clicked.
//
// chrome:, chrome-extension:, file: are intentionally allowed because
// this bundle runs inside a chrome-extension:// page where those schemes
// are legitimate targets: a user saving chrome://extensions/ or a
// file:// path is a supported flow. Click-to-open still goes through
// handlers.ts#handleOpenSaved (chrome.tabs.create), which bypasses the
// anchor navigation path entirely — keeping the href accurate matters
// for hover tooltips and right-click "copy link address".
const SAFE_HREF_RE = /^(https?:|mailto:|tel:|chrome:|chrome-extension:|file:|[/?#])/i;

export function sanitizeHref(raw: unknown): string {
  const val = String(raw == null ? '' : raw).trim();
  if (val === '' || SAFE_HREF_RE.test(val)) return val;
  return '#';
}

function isDatasetValue(val: AttrEntry): val is DatasetValue {
  return typeof val === 'object' && val !== null;
}

function appendChildren(parent: Node, children: Children): void {
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

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Children,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      let val = attrs[key];
      if (val === undefined || val === null) continue;

      if (key.startsWith('on')) {
        throw new Error(`dom-utils: inline handlers forbidden (${key}); use addEventListener`);
      }
      if (key === 'dataset' && isDatasetValue(val)) {
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
        (node as unknown as Record<string, unknown>)[key] = val;
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

// Parse a trusted SVG/HTML string literal. ONLY for developer-authored
// strings (e.g. ICONS), never user data.
export function svg(svgString: string): Element | null {
  const tmpl = document.createElement('template');
  tmpl.innerHTML = svgString;
  return tmpl.content.firstElementChild;
}

export function mount(target: Element, nodes: Node | Array<Node | null | undefined | false>): void {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const filtered = list.filter((n): n is Node => n != null && (n as unknown) !== false);
  target.replaceChildren(...filtered);
}
