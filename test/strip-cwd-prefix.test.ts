import { describe, expect, it } from "vitest";
import { stripRedundantCwdPrefix } from "../extensions/strip-cwd-prefix-core.js";

const CWD = "/home/me/proj";

describe("stripRedundantCwdPrefix", () => {
	describe("strips a no-op cd into the cwd", () => {
		it.each([
			[`cd ${CWD} && ls`, "ls"],
			[`cd ${CWD}&& ls`, "ls"],
			[`cd ${CWD} &&ls`, "ls"],
			[`cd ${CWD} &&   ls -la`, "ls -la"],
			[`  cd ${CWD} && ls`, "ls"],
			[`cd "${CWD}" && ls`, "ls"],
			[`cd '${CWD}' && ls`, "ls"],
			[`cd ${CWD}/ && ls`, "ls"],
			[`cd ${CWD}/../proj && ls`, "ls"],
			[`cd . && ls`, "ls"],
			[`cd ./ && ls`, "ls"],
			[`cd -- ${CWD} && ls`, "ls"],
			[`cd "$PWD" && ls`, "ls"],
			[`cd \${PWD} && ls`, "ls"],
			[`cd ${CWD}; ls`, "ls"],
			[`cd ${CWD}\nls`, "ls"],
			[`cd ${CWD} &&\nls`, "ls"],
		])("rewrites %j", (command, expected) => {
			expect(stripRedundantCwdPrefix(command, CWD)).toBe(expected);
		});
	});

	describe("strips a chain of no-op cd prefixes", () => {
		it("removes every leading cd back into cwd", () => {
			expect(stripRedundantCwdPrefix(`cd ${CWD} && cd . && ls`, CWD)).toBe("ls");
		});
	});

	describe("leaves intentional or ambiguous commands untouched", () => {
		it.each([
			[`cd /somewhere/else && ls`],
			[`cd ~ && ls`],
			[`cd .. && ls`],
			[`cd "" && ls`],
			[`cd - && ls`],
			[`cd ${CWD}`],
			[`cd ${CWD} &&`],
			[`cd ${CWD} || echo nope`],
			[`cd ${CWD} & ls`],
			[`ls && cd ${CWD}`],
			[`echo "cd ${CWD} && ls"`],
			[`(cd ${CWD} && ls)`],
			[""],
			["   "],
		])("passes through %j", (command) => {
			expect(stripRedundantCwdPrefix(command, CWD)).toBeNull();
		});

		it("removes only the leading prefix, not later cds", () => {
			expect(stripRedundantCwdPrefix(`cd ${CWD} && ls && cd /elsewhere`, CWD)).toBe(
				"ls && cd /elsewhere",
			);
		});

		it("does not match a symlinked path that only resolves lexically", () => {
			// resolve() is lexical, so `/link` is not treated as `/home/me/proj`.
			expect(stripRedundantCwdPrefix("cd /link && ls", CWD)).toBeNull();
		});
	});
});
