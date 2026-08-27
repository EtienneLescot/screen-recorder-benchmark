/**
 * Recordly with its experimental NVIDIA CUDA export path turned on.
 *
 * A separate row, never averaged with `recordly`. The product ships this off: it appears in the
 * export settings as a toggle labelled "NVIDIA CUDA" with an "Experimental" badge, defaulting
 * to false, so a fresh install exports without it and that is what the default row measures.
 * But it is a discoverable product feature rather than an internal flag, which makes the other
 * side of the toggle worth measuring too — the way `openscreen-cli` and `openscreen-gui` are
 * kept apart rather than merged.
 *
 * Everything else is the base adapter. The only difference is the value written to
 * `recordly.export.experimentalNvidiaCuda` before the editor reads it; the export action is
 * identical, and the app still chooses its own backend. Whether it actually took the CUDA path
 * is read back from its progress events rather than assumed.
 */
import base from "./recordly.mjs";

export default {
	...base,
	id: "recordly-cuda",
	displayName: "Recordly (CUDA)",
	useCuda: true,
};
