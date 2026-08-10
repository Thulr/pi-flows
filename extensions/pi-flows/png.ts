import { deflateSync } from "node:zlib";

/**
 * Minimal PNG encoder: an RGBA pixel buffer in, a standards-valid PNG out.
 * Generic plumbing — it knows nothing about flows; `ui-gantt.ts` draws into
 * the buffer and this module only packages it. Kept dependency-free on
 * purpose: node:zlib provides the one compression primitive PNG needs, so a
 * raster image costs no package weight beyond this file.
 */

/** One RGBA color, 0-255 per channel. */
export type Rgba = [number, number, number, number];

/** A mutable RGBA raster. Pixels are row-major, 4 bytes per pixel. */
export interface Raster {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export function createRaster(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): Raster {
	const pixels = new Uint8Array(width * height * 4);
	if (fill.some((channel) => channel !== 0)) {
		for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(fill, offset);
	}
	return { width, height, pixels };
}

/** Set one pixel; out-of-bounds writes are ignored so drawing needs no edge math. */
export function setPixel(raster: Raster, x: number, y: number, rgba: Rgba): void {
	if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
	raster.pixels.set(rgba, (y * raster.width + x) * 4);
}

export function fillRect(raster: Raster, x: number, y: number, width: number, height: number, rgba: Rgba): void {
	const x0 = Math.max(0, Math.floor(x));
	const y0 = Math.max(0, Math.floor(y));
	const x1 = Math.min(raster.width, Math.floor(x + width));
	const y1 = Math.min(raster.height, Math.floor(y + height));
	for (let row = y0; row < y1; row++) {
		for (let column = x0; column < x1; column++) raster.pixels.set(rgba, (row * raster.width + column) * 4);
	}
}

const CRC_TABLE = new Uint32Array(256).map((_value, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc;
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set([...type].map((character) => character.charCodeAt(0)), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** Encode the raster as a PNG (8-bit RGBA, no interlace) and return it base64-encoded. */
export function encodePng(raster: Raster): string {
	const { width, height, pixels } = raster;
	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, width);
	headerView.setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8); // 8-bit depth, color type 6 (RGBA)

	// Each scanline is prefixed with filter type 0 (None): the images drawn here
	// are flat-color charts, where zlib alone already compresses well.
	const scanlines = new Uint8Array(height * (1 + width * 4));
	for (let row = 0; row < height; row++) {
		scanlines.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), row * (1 + width * 4) + 1);
	}

	const png = Buffer.concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", new Uint8Array(deflateSync(scanlines))),
		chunk("IEND", new Uint8Array(0)),
	]);
	return png.toString("base64");
}
