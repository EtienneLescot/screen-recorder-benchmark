import { describe, expect, it } from "vitest";
import { contentBoxAgainstBorder } from "./visualCheck.mjs";

/**
 * A frame shaped like a real export: a wallpaper, a soft drop shadow, and the recording inside.
 *
 * `bg(x, y)` lets a test choose the wallpaper, which is the whole point — the detector regressed
 * because it was only ever tried against a light, flat one.
 */
function frame({ W = 400, H = 300, box, content = [22, 26, 34], shadow = 14, bg }) {
	const data = Buffer.alloc(W * H * 3);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const inside =
				x >= box.left && x <= box.right && y >= box.top && y <= box.bottom ? content : null;
			let c = inside ?? bg(x, y);
			if (!inside && shadow) {
				// How far outside the box this pixel is, so the shadow ramps in over `shadow` px.
				const d = Math.max(box.left - x, x - box.right, box.top - y, y - box.bottom, 0);
				if (d < shadow) {
					const k = (1 - d / shadow) * 0.35;
					c = c.map((v) => Math.round(v * (1 - k)));
				}
			}
			const i = (y * W + x) * 3;
			data[i] = c[0];
			data[i + 1] = c[1];
			data[i + 2] = c[2];
		}
	}
	return { data, width: W, height: H };
}

describe("contentBoxAgainstBorder", () => {
	const box = { left: 60, top: 45, right: 339, bottom: 254 };

	it("finds the recording against a flat light wallpaper", () => {
		const m = contentBoxAgainstBorder(frame({ box, bg: () => [253, 255, 255] }));
		expect(m.left).toBeCloseTo(box.left, -1);
		expect(m.top).toBeCloseTo(box.top, -1);
		expect(m.right).toBeCloseTo(box.right, -1);
		expect(m.bottom).toBeCloseTo(box.bottom, -1);
	});

	/**
	 * The regression this detector exists for. OpenScreen composites its own dark red gradient,
	 * whose darkest corner sits 85 from the editor inside it — under the absolute tolerance of 90
	 * the previous version compared against — while drifting 78 across the same span. Scanning
	 * from a fixed reference crossed the whole recording without seeing it and returned a box one
	 * pixel wide, which calibration then read as a 0.28% inset.
	 */
	it("finds it against a dark gradient whose drift exceeds the content step", () => {
		const m = contentBoxAgainstBorder(
			frame({
				box,
				bg: (x, y) => {
					const t = (x / 400) * 0.5 + (y / 300) * 0.5;
					return [Math.round(90 - 52 * t), Math.round(20 - 12 * t), Math.round(45 - 14 * t)];
				},
			}),
		);
		expect(m.left).toBeCloseTo(box.left, -1);
		expect(m.top).toBeCloseTo(box.top, -1);
		expect(m.width).toBeGreaterThan(200);
	});

	/**
	 * The box has to land on the recording, not partway up its shadow: the corner-radius probes
	 * sample one pixel inside the box and one a little along its edge, and a box sitting in the
	 * shadow puts both on the same ramp.
	 */
	it("lands on the recording rather than in its drop shadow", () => {
		const m = contentBoxAgainstBorder(frame({ box, shadow: 16, bg: () => [253, 255, 255] }));
		expect(m.top).toBeGreaterThanOrEqual(box.top - 2);
		expect(m.left).toBeGreaterThanOrEqual(box.left - 2);
	});

	/**
	 * A recording that fills the frame has no inset, and has to be reported as having none. The
	 * previous scan returned its own loop bound when it found no edge, so a full-frame export
	 * measured a 1916px inset and passed the padding check it should have failed.
	 */
	it("reports zero inset when the recording reaches the frame edge", () => {
		const W = 400;
		const H = 300;
		const m = contentBoxAgainstBorder(
			frame({ W, H, box: { left: 0, top: 0, right: W - 1, bottom: H - 1 }, bg: () => [0, 0, 0] }),
		);
		expect(m.left).toBe(0);
		expect(m.top).toBe(0);
		expect(m.right).toBe(W - 1);
		expect(m.bottom).toBe(H - 1);
	});
});
