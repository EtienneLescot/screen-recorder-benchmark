import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"],
		exclude: ["node_modules/**", "results/**", ".cache/**"],
	},
});
