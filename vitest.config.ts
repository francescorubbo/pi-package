import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Extensions import `@earendil-works/pi-tui`, which pi provides as a virtual
// module at runtime. It is not a direct dependency of this package, so it may
// be installed at the top level or nested under pi-coding-agent depending on
// npm's hoisting. Mirror the tsconfig path mapping so tests can load extension
// modules that use TUI components.
const candidates = [
    "node_modules/@earendil-works/pi-tui/dist/index.js",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
];

const resolvePiTui = (): string => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    for (const candidate of candidates) {
        const path = join(root, candidate);
        if (existsSync(path)) return path;
    }
    throw new Error(
        `Cannot locate @earendil-works/pi-tui. Run "npm install" first. Searched:\n${candidates.join("\n")}`,
    );
};

export default defineConfig({
    resolve: {
        alias: [{ find: /^@earendil-works\/pi-tui$/, replacement: resolvePiTui() }],
    },
});
