/**
 * Parses JSON that may contain comments and trailing commas, as tsconfig files do.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
	let json = '';
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		const next = text[index + 1];
		if (char === '"') {
			const start = index;
			index++;
			while (index < text.length && text[index] !== '"') {
				index += text[index] === '\\' ? 2 : 1;
			}
			index++;
			json += text.slice(start, index);
		} else if (char === '/' && next === '/') {
			const end = text.indexOf('\n', index);
			index = end === -1 ? text.length : end;
		} else if (char === '/' && next === '*') {
			const end = text.indexOf('*/', index + 2);
			index = end === -1 ? text.length : end + 2;
		} else if (char === ',' && /^\s*[}\]]/.test(withoutLeadingComments(text.slice(index + 1)))) {
			index++;
		} else {
			json += char;
			index++;
		}
	}
	return JSON.parse(json);
}

/**
 * @param {string} text
 * @returns {string} text with any comments and whitespace at the start removed
 */
function withoutLeadingComments(text) {
	let rest = text;
	for (;;) {
		const trimmed = rest.trimStart();
		if (trimmed.startsWith('//')) {
			const end = trimmed.indexOf('\n');
			rest = end === -1 ? '' : trimmed.slice(end);
		} else if (trimmed.startsWith('/*')) {
			const end = trimmed.indexOf('*/');
			rest = end === -1 ? '' : trimmed.slice(end + 2);
		} else {
			return trimmed;
		}
	}
}
