/**
 * Recordly with its experimental NVIDIA CUDA export path turned on.
 *
 * A separate row, never averaged with `recordly`. The product ships this off: it appears in the
 * export settings as a switch labelled "NVIDIA CUDA" with an "Experimental" badge, defaulting
 * to false, so a fresh install exports without it and that is what the default row measures.
 * But it is a discoverable product feature rather than an internal flag, which makes the other
 * side of the switch worth measuring too — the way `openscreen-cli` and `openscreen-gui` are
 * kept apart rather than merged.
 *
 * Everything else is the base adapter. The only difference is the state the export panel's
 * switch is set to; the export action is identical, and the app still chooses its own backend.
 * Whether it actually took the CUDA path is read back rather than assumed — see `setCuda` in
 * the base adapter, and `observed.cudaApplied` on every run record.
 *
 * MEASURED 2026-08-27, and this row currently reports nothing new. On the Lightning pipeline,
 * with the switch verified on, Recordly announces the same route as with it off —
 * "WebGPU + Breeze (h264-stream-copy)" — and writes a byte-identical file: sha256 d64c3467…
 * across four runs spanning both settings, at overlapping times (63.6-64.1s off, 62.5-64.3s on).
 * The opt-in is real and it persists, but nothing downstream of it changes on this path.
 *
 * That is a finding about *this scenario*, not about the feature. `getNativeExportCapabilities`
 * reports the CUDA wrapper under the app's **native** export, and the base adapter deliberately
 * does not drive `nativeStaticLayoutExport` — a project carrying zoom regions is not a static
 * layout. A scenario with no zooms may well route differently, which is the reason to keep this
 * adapter rather than delete it. Until a run shows the two rows differ, publishing both as a
 * comparison would be reporting one measurement twice.
 */
import base from "./recordly.mjs";

export default {
	...base,
	id: "recordly-cuda",
	displayName: "Recordly (CUDA)",
	useCuda: true,
};
