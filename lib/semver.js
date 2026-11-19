const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:[-+].*)?$/;

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} negative, zero or positive, as a sorts before, with or after b
 */
function compare(a, b) {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * @param {number[]} version major, minor and patch
 * @param {string} comparator one comparator, such as `^1.2.3`, `>=4.8`, `5.x` or `*`
 * @returns {boolean | null} null when the comparator is not understood
 */
function matches(version, comparator) {
	const match = COMPARATOR.exec(comparator);
	if (!match) {
		return null;
	}
	const [, operator = '', ...rawParts] = match;
	const parts = rawParts.map((part) => (part === undefined || /^[xX*]$/.test(part) ? null : Number(part)));
	const given = parts.findIndex((part) => part === null);
	const precision = given === -1 ? 3 : given;
	const base = parts.map((part) => part ?? 0);
	if (precision === 0) {
		return true;
	}
	/**
	 * @param {number} keep how many leading parts to hold fixed
	 * @returns {number[]} the first version above everything that shares those leading parts
	 */
	const ceiling = (keep) =>
		base.map((part, index) => {
			if (index < keep - 1) {
				return part;
			}
			return index === keep - 1 ? part + 1 : 0;
		});
	switch (operator) {
		case '':
		case '=':
			return compare(version, base) >= 0 && compare(version, ceiling(precision)) < 0;
		case '^': {
			const significant = base.findIndex((part) => part !== 0);
			const keep = Math.min(significant === -1 ? precision : significant + 1, precision);
			return compare(version, base) >= 0 && compare(version, ceiling(keep)) < 0;
		}
		case '~':
			return compare(version, base) >= 0 && compare(version, ceiling(Math.min(precision, 2))) < 0;
		case '>=':
			return compare(version, base) >= 0;
		case '>':
			return compare(version, precision === 3 ? base : ceiling(precision)) >= (precision === 3 ? 1 : 0);
		case '<':
			return compare(version, base) < 0;
		case '<=':
			return compare(version, precision === 3 ? base : ceiling(precision)) < (precision === 3 ? 1 : 0);
		default:
			return null;
	}
}

/**
 * Checks a version against an npm range, without pre-release handling.
 * @param {string} version a plain version such as `7.0.2`
 * @param {string} range an npm range such as `>=4.8.4 <6.1.0` or `5.0.x || 5.1.x`
 * @returns {boolean | null} null when the range uses syntax this does not understand
 */
export function satisfies(version, range) {
	const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!parsed) {
		return null;
	}
	const target = parsed.slice(1).map(Number);
	let unknown = false;
	for (const alternative of range.split('||')) {
		const comparators = alternative
			.trim()
			.replaceAll(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
			.replace(/^(\S+)\s+-\s+(\S+)$/, '>=$1 <=$2')
			.split(/\s+/)
			.filter(Boolean);
		const results = comparators.map((comparator) => matches(target, comparator));
		if (results.includes(null)) {
			unknown = true;
		} else if (results.every(Boolean)) {
			return true;
		}
	}
	return unknown ? null : false;
}
