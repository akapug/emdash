/**
 * Admin page for @emdash-cms/plugin-design (emb/27):
 * Same-origin preview iframe + vanilla JS element picker + sidebar controls
 * (color, background/gradient, font size/weight, alignment, spacing, hide, undo).
 */

import type { PluginAdminExports } from "emdash";
import { apiFetch } from "emdash/plugin-utils";
import * as React from "react";

import type { DesignRule, ElementFingerprint } from "./css.js";
import { PICKER_SCRIPT } from "./picker.js";

interface SelectedTarget {
	selector: string;
	fingerprint: ElementFingerprint;
	styles: Record<string, string>;
}

function DesignEditorPage() {
	const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
	const [pagePath, setPagePath] = React.useState("/");
	const [rules, setRules] = React.useState<DesignRule[]>([]);
	const [historyCount, setHistoryCount] = React.useState(0);
	const [selected, setSelected] = React.useState<SelectedTarget | null>(null);
	const [color, setColor] = React.useState("");
	const [background, setBackground] = React.useState("");
	const [fontSize, setFontSize] = React.useState("");
	const [fontWeight, setFontWeight] = React.useState("");
	const [textAlign, setTextAlign] = React.useState("");
	const [padding, setPadding] = React.useState("");
	const [margin, setMargin] = React.useState("");
	const [hidden, setHidden] = React.useState(false);
	const [status, setStatus] = React.useState<string | null>(null);

	const postToFrame = React.useCallback((msg: Record<string, unknown>) => {
		iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
	}, []);

	const loadRules = React.useCallback(async () => {
		const res = await apiFetch("/_emdash/api/plugins/design/rules/list", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pagePath }),
		});
		if (!res.ok) return;
		const data = (await res.json()) as { rules?: DesignRule[]; historyCount?: number; css?: string };
		const nextRules = data.rules ?? [];
		setRules(nextRules);
		setHistoryCount(data.historyCount ?? 0);
		if (typeof data.css === "string") {
			postToFrame({ type: "embark-design:preview-css", css: data.css });
		}
		postToFrame({ type: "embark-design:verify-rules", rules: nextRules });
	}, [pagePath, postToFrame]);

	React.useEffect(() => {
		void loadRules();
	}, [loadRules]);

	React.useEffect(() => {
		const onMessage = async (event: MessageEvent) => {
			if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
			const msg = event.data as Record<string, unknown>;
			if (msg.type === "embark-design:select" && typeof msg.selector === "string" && msg.fingerprint) {
				setSelected({
					selector: msg.selector,
					fingerprint: msg.fingerprint as ElementFingerprint,
					styles: (msg.styles as Record<string, string>) ?? {},
				});
				setHidden(false);
				setStatus(null);
			}
			if (msg.type === "embark-design:verify-result" && Array.isArray(msg.mismatchedIds) && msg.mismatchedIds.length > 0) {
				await apiFetch("/_emdash/api/plugins/design/rules/flag-mismatch", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids: msg.mismatchedIds }),
				});
				void loadRules();
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [loadRules]);

	const handleFrameLoad = () => {
		const doc = iframeRef.current?.contentDocument;
		if (!doc) return;
		const script = doc.createElement("script");
		script.textContent = PICKER_SCRIPT;
		doc.head.appendChild(script);
		void loadRules();
	};

	const saveRule = async () => {
		if (!selected) return;
		const declarations: Record<string, string> = {};
		if (color.trim()) declarations.color = color.trim();
		if (background.trim()) declarations.background = background.trim();
		if (fontSize.trim()) declarations["font-size"] = fontSize.trim();
		if (fontWeight.trim()) declarations["font-weight"] = fontWeight.trim();
		if (textAlign.trim()) declarations["text-align"] = textAlign.trim();
		if (padding.trim()) declarations.padding = padding.trim();
		if (margin.trim()) declarations.margin = margin.trim();
		if (hidden) declarations.display = "none";

		const res = await apiFetch("/_emdash/api/plugins/design/rules/upsert", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				selector: selected.selector,
				fingerprint: selected.fingerprint,
				pagePath,
				declarations,
			}),
		});
		const data = (await res.json()) as { ok?: boolean; error?: string; rules?: DesignRule[]; historyCount?: number; css?: string };
		if (!data.ok) {
			setStatus(data.error ?? "Could not save rule");
			return;
		}
		setRules(data.rules ?? []);
		setHistoryCount(data.historyCount ?? 0);
		if (typeof data.css === "string") postToFrame({ type: "embark-design:preview-css", css: data.css });
		setStatus("Saved design tweak.");
	};

	const undo = async () => {
		const res = await apiFetch("/_emdash/api/plugins/design/rules/undo", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const data = (await res.json()) as { rules?: DesignRule[]; historyCount?: number; css?: string };
		setRules(data.rules ?? []);
		setHistoryCount(data.historyCount ?? 0);
		if (typeof data.css === "string") postToFrame({ type: "embark-design:preview-css", css: data.css });
	};

	const removeRule = async (id: string) => {
		const res = await apiFetch("/_emdash/api/plugins/design/rules/delete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const data = (await res.json()) as { rules?: DesignRule[]; historyCount?: number; css?: string };
		setRules(data.rules ?? []);
		setHistoryCount(data.historyCount ?? 0);
		if (typeof data.css === "string") postToFrame({ type: "embark-design:preview-css", css: data.css });
	};

	return (
		<div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, height: "calc(100vh - 96px)" }}>
			<aside style={{ overflowY: "auto", padding: 12, borderRight: "1px solid #e5e7eb" }}>
				<h2 style={{ margin: "0 0 8px" }}>Design Tweaks</h2>
				<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
					<input
						aria-label="Page path"
						value={pagePath}
						onChange={(e) => setPagePath(e.target.value)}
						style={{ flex: 1, padding: "4px 8px" }}
					/>
					<button type="button" onClick={undo} disabled={historyCount === 0}>
						Undo ({historyCount})
					</button>
				</div>

				{selected ? (
					<div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
						<code style={{ fontSize: 12, wordBreak: "break-all" }}>{selected.selector}</code>
						<input placeholder="Color (e.g. #1a2b3c)" value={color} onChange={(e) => setColor(e.target.value)} />
						<input placeholder="Background / gradient" value={background} onChange={(e) => setBackground(e.target.value)} />
						<input placeholder="Font size (e.g. 18px)" value={fontSize} onChange={(e) => setFontSize(e.target.value)} />
						<input placeholder="Font weight (e.g. 600)" value={fontWeight} onChange={(e) => setFontWeight(e.target.value)} />
						<input placeholder="Text align (left|center|right)" value={textAlign} onChange={(e) => setTextAlign(e.target.value)} />
						<input placeholder="Padding (e.g. 16px 24px)" value={padding} onChange={(e) => setPadding(e.target.value)} />
						<input placeholder="Margin (e.g. 0 auto)" value={margin} onChange={(e) => setMargin(e.target.value)} />
						<label>
							<input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hide element
						</label>
						<button type="button" onClick={saveRule}>Save tweak</button>
						{status && <p style={{ fontSize: 12, margin: 0 }}>{status}</p>}
					</div>
				) : (
					<p style={{ fontSize: 13, color: "#6b7280" }}>Click any element in the preview to tweak its style.</p>
				)}

				<h3 style={{ margin: "12px 0 8px", fontSize: 14 }}>Saved rules ({rules.length})</h3>
				<ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
					{rules.map((r) => (
						<li key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, fontSize: 12 }}>
							<div style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{r.selector}</div>
							{r.status === "element_changed" && (
								<div style={{ color: "#b45309", marginTop: 4 }}>Element changed — rule paused</div>
							)}
							<button type="button" onClick={() => removeRule(r.id)} style={{ marginTop: 6 }}>
								Delete
							</button>
						</li>
					))}
				</ul>
			</aside>
			<iframe
				ref={iframeRef}
				title="Site design preview"
				src={pagePath}
				onLoad={handleFrameLoad}
				style={{ width: "100%", height: "100%", border: "1px solid #e5e7eb", borderRadius: 8 }}
			/>
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/design": DesignEditorPage,
};
