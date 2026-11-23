/**
 * Stable-first selector generation, element fingerprinting, and the vanilla JS
 * same-origin iframe picker script for @emdash-cms/plugin-design (emb/27).
 *
 * Selector priority (per visual-editor-plan-2026-09-26.md):
 *   1. Unique element `#id` (when valid CSS identifier)
 *   2. Shell slot / data attribute (`[data-embark-slot="..."]` or `[data-slot="..."]`)
 *   3. `nth-of-type` path under the nearest semantic landmark
 *      (`header`, `nav`, `main`, `footer`, `aside`, `section`, `article`)
 *
 * Fingerprint: `{ tag, textHash }` where `textHash` is a deterministic 8-hex
 * FNV-1a hash of normalized innerText. When the live DOM element matched by a
 * rule no longer has the recorded fingerprint, the rule is flagged
 * `element_changed` and never silently applied to a different element.
 */

import type { ElementFingerprint } from "./css.js";

export interface SelectorNodeInfo {
	tag: string;
	id?: string | null;
	slotAttr?: { name: "data-embark-slot" | "data-slot"; value: string } | null;
	nthOfType: number;
}

const LANDMARK_TAGS = new Set(["header", "nav", "main", "footer", "aside", "section", "article"]);
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SAFE_ATTR_VAL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Deterministic 32-bit FNV-1a hash of normalized text content (8 lowercase hex chars).
 */
export function hashElementText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim().slice(0, 256);
	let h = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i++) {
		h ^= normalized.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function computeFingerprint(tag: string, text: string): ElementFingerprint {
	return {
		tag: tag.trim().toLowerCase(),
		textHash: hashElementText(text),
	};
}

export function fingerprintsMatch(a: ElementFingerprint, b: ElementFingerprint): boolean {
	return a.tag.toLowerCase() === b.tag.toLowerCase() && a.textHash === b.textHash;
}

/**
 * Build the most stable selector from a leaf-to-root ancestor chain
 * (`chain[0]` is the clicked element, `chain[chain.length - 1]` is the highest ancestor).
 */
export function buildStableSelector(chain: readonly SelectorNodeInfo[]): string {
	if (chain.length === 0) return "";
	const leaf = chain[0]!;
	if (leaf.id && SAFE_IDENT_RE.test(leaf.id)) {
		return `#${leaf.id}`;
	}
	if (leaf.slotAttr && SAFE_ATTR_VAL_RE.test(leaf.slotAttr.value)) {
		return `[${leaf.slotAttr.name}="${leaf.slotAttr.value}"]`;
	}

	const parts: string[] = [];
	for (let i = 0; i < chain.length && parts.length < 6; i++) {
		const node = chain[i]!;
		const tag = node.tag.toLowerCase();
		if (i > 0 && node.id && SAFE_IDENT_RE.test(node.id)) {
			parts.unshift(`#${node.id}`);
			break;
		}
		if (i > 0 && node.slotAttr && SAFE_ATTR_VAL_RE.test(node.slotAttr.value)) {
			parts.unshift(`[${node.slotAttr.name}="${node.slotAttr.value}"]`);
			break;
		}
		if (i > 0 && LANDMARK_TAGS.has(tag)) {
			parts.unshift(node.nthOfType > 1 ? `${tag}:nth-of-type(${node.nthOfType})` : tag);
			break;
		}
		parts.unshift(`${tag}:nth-of-type(${Math.max(1, node.nthOfType)})`);
	}
	return parts.join(" > ");
}

/**
 * Vanilla JS picker script injected into the same-origin preview iframe by the
 * Design admin page. Communicates strictly over `window.location.origin`.
 */
export const PICKER_SCRIPT = `(function(){
  if (window.__embarkDesignPicker) return;
  window.__embarkDesignPicker = true;
  var ORIGIN = window.location.origin;
  var LANDMARKS = { header:1, nav:1, main:1, footer:1, aside:1, section:1, article:1 };
  var SAFE_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
  var SAFE_ATTR = /^[A-Za-z0-9_.:-]{1,64}$/;
  var hoverEl = null;
  var selectedEl = null;
  var overlay = document.createElement("div");
  overlay.setAttribute("data-embark-picker-ui", "1");
  overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #c25a1a;background:rgba(194,90,26,0.08);display:none;";
  document.documentElement.appendChild(overlay);

  function hashText(text) {
    var norm = String(text || "").replace(/\\s+/g, " ").trim().slice(0, 256);
    var h = 0x811c9dc5;
    for (var i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  function nthOfType(el) {
    var n = 1, p = el.previousElementSibling;
    while (p) { if (p.tagName === el.tagName) n++; p = p.previousElementSibling; }
    return n;
  }
  function selectorFor(el) {
    if (el.id && SAFE_ID.test(el.id)) return "#" + el.id;
    var s1 = el.getAttribute("data-embark-slot");
    if (s1 && SAFE_ATTR.test(s1)) return '[data-embark-slot="' + s1 + '"]';
    var s2 = el.getAttribute("data-slot");
    if (s2 && SAFE_ATTR.test(s2)) return '[data-slot="' + s2 + '"]';
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && parts.length < 6) {
      var tag = cur.tagName.toLowerCase();
      if (parts.length > 0 && cur.id && SAFE_ID.test(cur.id)) { parts.unshift("#" + cur.id); break; }
      var cs1 = cur.getAttribute("data-embark-slot");
      if (parts.length > 0 && cs1 && SAFE_ATTR.test(cs1)) { parts.unshift('[data-embark-slot="' + cs1 + '"]'); break; }
      var n = nthOfType(cur);
      if (parts.length > 0 && LANDMARKS[tag]) { parts.unshift(n > 1 ? tag + ":nth-of-type(" + n + ")" : tag); break; }
      parts.unshift(tag + ":nth-of-type(" + n + ")");
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  function placeOverlay(el) {
    if (!el) { overlay.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
  }
  document.addEventListener("mousemove", function(e) {
    var t = e.target;
    if (!t || t === overlay || (t.closest && t.closest("[data-embark-picker-ui]"))) return;
    hoverEl = t;
    placeOverlay(t);
  }, true);
  document.addEventListener("click", function(e) {
    var t = e.target;
    if (!t || t === overlay || (t.closest && t.closest("[data-embark-picker-ui]"))) return;
    e.preventDefault();
    e.stopPropagation();
    selectedEl = t;
    placeOverlay(t);
    var cs = window.getComputedStyle(t);
    window.parent.postMessage({
      type: "embark-design:select",
      selector: selectorFor(t),
      fingerprint: { tag: t.tagName.toLowerCase(), textHash: hashText(t.innerText || t.textContent || "") },
      styles: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        textAlign: cs.textAlign,
        padding: cs.padding,
        margin: cs.margin,
        display: cs.display
      }
    }, ORIGIN);
  }, true);
  window.addEventListener("message", function(e) {
    if (e.origin !== ORIGIN || !e.data || typeof e.data !== "object") return;
    if (e.data.type === "embark-design:preview-css" && typeof e.data.css === "string") {
      var st = document.querySelector("style[data-embark-design]");
      if (!st) { st = document.createElement("style"); st.setAttribute("data-embark-design", ""); document.head.appendChild(st); }
      st.textContent = e.data.css;
    }
    if (e.data.type === "embark-design:verify-rules" && Array.isArray(e.data.rules)) {
      var mismatched = [];
      for (var i = 0; i < e.data.rules.length; i++) {
        var r = e.data.rules[i];
        try {
          var found = document.querySelector(r.selector);
          if (!found) { mismatched.push(r.id); continue; }
          var fp = { tag: found.tagName.toLowerCase(), textHash: hashText(found.innerText || found.textContent || "") };
          if (!r.fingerprint || fp.tag !== r.fingerprint.tag || fp.textHash !== r.fingerprint.textHash) mismatched.push(r.id);
        } catch (_err) { mismatched.push(r.id); }
      }
      window.parent.postMessage({ type: "embark-design:verify-result", mismatchedIds: mismatched }, ORIGIN);
    }
  });
})();`;
