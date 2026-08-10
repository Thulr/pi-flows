import { deflateSync } from "node:zlib";

/**
 * Minimal raster kit: an RGBA pixel buffer, the drawing and color primitives
 * to fill it (rects, hatching, HSL conversion), and a standards-valid PNG
 * encoder out. Generic plumbing — it knows nothing about flows; `ui-gantt.ts`
 * decides what to draw and this module owns how pixels are set and packaged.
 * Kept dependency-free on purpose: node:zlib provides the one compression
 * primitive PNG needs, so a raster image costs no package weight beyond this
 * file.
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

/** The same color at a different alpha. */
export function withAlpha(rgba: Rgba, alpha: number): Rgba {
	return [rgba[0], rgba[1], rgba[2], alpha];
}

/**
 * Cross-hatched rectangle: a translucent base with solid 45° stripes. A
 * texture, not just a tint, so whatever it marks stays distinguishable under
 * any color-vision deficit.
 */
export function hatchRect(raster: Raster, x: number, y: number, width: number, height: number, rgba: Rgba): void {
	fillRect(raster, x, y, width, height, withAlpha(rgba, 110));
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	for (let row = y0; row < y0 + height; row++) {
		for (let column = x0; column < x0 + width; column++) {
			if ((((column + row) % 12) + 12) % 12 < 4) setPixel(raster, column, row, rgba);
		}
	}
}

/** HSL (h in degrees, s/l in 0–1) to an opaque RGBA color. */
export function hslToRgb(h: number, s: number, l: number): Rgba {
	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - chroma / 2;
	const sector = Math.floor(h / 60) % 6;
	const [r, g, b] = [
		[chroma, x, 0],
		[x, chroma, 0],
		[0, chroma, x],
		[0, x, chroma],
		[x, 0, chroma],
		[chroma, 0, x],
	][sector]!;
	return [Math.round((r! + m) * 255), Math.round((g! + m) * 255), Math.round((b! + m) * 255), 255];
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
