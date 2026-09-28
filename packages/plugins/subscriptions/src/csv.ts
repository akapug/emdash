const LINE_BREAK = /\r?\n/;

/**
 * A CSV file as rows of fields (RFC 4180): quoted fields may hold the
 * delimiter, line breaks and doubled quotes. The delimiter is the one the
 * header line uses: a comma, a semicolon or a tab.
 */
export function parseCsv(text: string): string[][] {
	const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const firstLine = body.split(LINE_BREAK, 1)[0] ?? "";
	const delimiter = [",", ";", "\t"].reduce((best, d) =>
		firstLine.split(d).length > firstLine.split(best).length ? d : best,
	);
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < body.length; i++) {
		const c = body[i]!;
		if (quoted) {
			if (c === '"' && body[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
			continue;
		}
		if (c === '"' && field === "") quoted = true;
		else if (c === delimiter) {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && body[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((f) => f.trim() !== ""));
}
