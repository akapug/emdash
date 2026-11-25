function exifOrientation(tiff: DataView): number | null {
	if (tiff.byteLength < 8) return null;
	const order = tiff.getUint16(0);
	if (order !== 0x4949 && order !== 0x4d4d) return null;
	const littleEndian = order === 0x4949;
	if (tiff.getUint16(2, littleEndian) !== 42) return null;

	const ifd = tiff.getUint32(4, littleEndian);
	if (ifd < 8 || ifd % 2 !== 0 || ifd + 2 > tiff.byteLength) return null;
	const count = tiff.getUint16(ifd, littleEndian);
	const end = ifd + 2 + 12 * count;
	if (end + 4 > tiff.byteLength) return null;

	let orientation = null;
	for (let entry = ifd + 2; entry < end; entry += 12) {
		if (tiff.getUint16(entry, littleEndian) !== 0x0112) continue;
		if (
			orientation !== null ||
			tiff.getUint16(entry + 2, littleEndian) !== 3 ||
			tiff.getUint32(entry + 4, littleEndian) !== 1
		) {
			return null;
		}
		orientation = tiff.getUint16(entry + 8, littleEndian);
	}
	return orientation;
}

/** Raw JPEG dimensions, only if the prefix proves EXIF transposes the axes. */
export function readAxisSwappedJpegDimensions(bytes: Uint8Array) {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	const jpeg = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let swapsAxes = false;
	let frame: { width: number; height: number } | null = null;
	for (let offset = 2; offset < bytes.length;) {
		if (bytes[offset++] !== 0xff) return null;
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (marker === undefined || marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd9)) {
			return null;
		}
		if (offset + 2 > bytes.length) return null;
		const length = jpeg.getUint16(offset);
		const end = offset + length;
		if (length < 2 || end > bytes.length) return null;
		const start = offset + 2;
		// The metadata scan ends at the first scan header, never in compressed pixels.
		if (marker === 0xda) {
			if (length < 8 || length !== 6 + 2 * jpeg.getUint8(start)) return null;
			return swapsAxes ? frame : null;
		}
		if (marker >= 0xc0 && marker <= 0xc2) {
			if (frame || length < 11 || length !== 8 + 3 * jpeg.getUint8(start + 5)) return null;
			const height = jpeg.getUint16(start + 1);
			const width = jpeg.getUint16(start + 3);
			if (!width || !height) return null;
			frame = { width, height };
		}
		if (marker === 0xe1 && length >= 6 && jpeg.getUint32(start) === 0x45786966) {
			// image-size accepts EXIF-like blocks without requiring APP1 or a valid TIFF header.
			if (swapsAxes || length < 8 || jpeg.getUint16(start + 4) !== 0) return null;
			const tiffAt = start + 6;
			const tiff = new DataView(bytes.buffer, bytes.byteOffset + tiffAt, end - tiffAt);
			const orientation = exifOrientation(tiff);
			if (orientation === null || orientation < 5 || orientation > 8) return null;
			swapsAxes = true;
		}
		offset = end;
	}
	return null;
}
