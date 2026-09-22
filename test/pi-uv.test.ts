import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteCommand, type ProjectFileSystem } from "../extensions/pi-uv-core.js";

/**
 * In-memory probe describing a tree by the directories that contain a
 * `uv.lock`. Used to simulate the remote host without running SSH.
 */
function makeProbe(lockDirs: readonly string[]): ProjectFileSystem {
	const locks = new Set(lockDirs.map((dir) => join(dir, "uv.lock")));
	return {
		exists: async (path) => locks.has(path),
		readdir: async (path) => {
			const children = new Set<string>();
			for (const lock of locks) {
				const prefix = `${path}/`;
				if (lock.startsWith(prefix)) {
					children.add(lock.slice(prefix.length).split("/")[0]);
				}
			}
			return [...children];
		},
	};
}

describe("rewriteCommand", () => {
	// `cwd` has a uv.lock itself; the rest are containers for project detection.
	let cwd: string;
	let repo: string;
	let scanRepo: string;
	let spaceRepo: string;
	const created: string[] = [];

	function makeRoot(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		created.push(dir);
		return dir;
	}

	beforeAll(() => {
		cwd = makeRoot("pi-uv-cwd-");
		writeFileSync(join(cwd, "uv.lock"), "");

		repo = makeRoot("pi-uv-repo-");
		mkdirSync(join(repo, "project-a"), { recursive: true });
		writeFileSync(join(repo, "project-a", "uv.lock"), "");

		scanRepo = makeRoot("pi-uv-scan-");
		mkdirSync(join(scanRepo, "solo"), { recursive: true });
		writeFileSync(join(scanRepo, "solo", "uv.lock"), "");

		spaceRepo = makeRoot("pi-uv-space-");
		mkdirSync(join(spaceRepo, "project space"), { recursive: true });
		writeFileSync(join(spaceRepo, "project space", "uv.lock"), "");
	});

	afterAll(() => {
		for (const dir of created) rmSync(dir, { recursive: true, force: true });
	});

	describe("with a uv project at the CWD", () => {
		it.each([
			["python main.py", "uv run --project . python main.py"],
			[".venv/bin/python main.py", "uv run --project . python main.py"],
			["/usr/bin/python3 script.py", "uv run --project . python3 script.py"],
			["python3.12 app.py", "uv run --project . python3.12 app.py"],
			["pytest -q", "uv run --project . pytest -q"],
			["FOO=bar python x.py", "FOO=bar uv run --project . python x.py"],
			[
				"cd sub && .venv/bin/python main.py",
				"cd sub && uv run --project . python main.py",
			],
			[
				"python a.py && pytest",
				"uv run --project . python a.py && uv run --project . pytest",
			],
			[
				"python3 - <<'PY'\nprint(1)\nPY",
				"uv run --project . python3 - <<'PY'\nprint(1)\nPY",
			],
		])("rewrites %j", async (command, expected) => {
			expect(await rewriteCommand(command, cwd)).toBe(expected);
		});

		it.each([
			["git status"],
			["echo python"],
			["uv run --project . python x.py"],
			["uvx ruff check"],
		])("leaves %j untouched", async (command) => {
			expect(await rewriteCommand(command, cwd)).toBeNull();
		});
	});

	describe("project detection", () => {
		it("uses a path argument to find the project root", async () => {
			expect(await rewriteCommand("python project-a/main.py", repo)).toBe(
				"uv run --project project-a python project-a/main.py",
			);
		});

		it("scans subdirectories when the path argument has no separator", async () => {
			expect(
				await rewriteCommand("cd solo && .venv/bin/python main.py", scanRepo),
			).toBe("cd solo && uv run --project solo python main.py");
		});

		it("quotes a project path containing spaces", async () => {
			expect(await rewriteCommand('python "project space/main.py"', spaceRepo)).toBe(
				'uv run --project "project space" python "project space/main.py"',
			);
		});
	});

	describe("remote filesystem probe (SSH sessions)", () => {
		const localCwd = "/Users/me/checkout/powercluster";
		const remoteCwd = "/home/ubuntu/powercluster";

		it("detects uv.lock on the remote tree", async () => {
			const fs = makeProbe([remoteCwd]);
			expect(await rewriteCommand("python main.py", remoteCwd, fs)).toBe(
				"uv run --project . python main.py",
			);
		});

		it("does not resolve against the local filesystem when a probe is given", async () => {
			// The local checkout has no uv.lock, so nothing to rewrite — even
			// though the remote tree does. Passing the remote probe with the
			// local cwd must not silently fall back to the local filesystem.
			const fs = makeProbe([remoteCwd]);
			expect(await rewriteCommand("python main.py", localCwd, fs)).toBeNull();
		});

		it("uses a remote path argument to find a subproject", async () => {
			const fs = makeProbe([join(remoteCwd, "project-a")]);
			expect(await rewriteCommand("python project-a/main.py", remoteCwd, fs)).toBe(
				"uv run --project project-a python project-a/main.py",
			);
		});

		it("scans remote subdirectories for a project root", async () => {
			const fs = makeProbe([join(remoteCwd, "solo")]);
			expect(
				await rewriteCommand("cd solo && .venv/bin/python main.py", remoteCwd, fs),
			).toBe("cd solo && uv run --project solo python main.py");
		});

		it("leaves the command untouched when the remote tree has no uv.lock", async () => {
			const fs = makeProbe([]);
			expect(await rewriteCommand("python main.py", remoteCwd, fs)).toBeNull();
		});
	});
});
