import { describe, expect, it } from "vitest";
import { prependRemotePath, REMOTE_PATH_DIRS } from "../extensions/ssh-remote-env.js";

describe("prependRemotePath", () => {
	it("prepends ~/.local/bin ahead of the inherited PATH by default", () => {
		expect(prependRemotePath("uv run pytest")).toBe(
			'export PATH="$HOME/.local/bin:$PATH"; uv run pytest',
		);
	});

	it("does not touch the command when there are no dirs", () => {
		expect(prependRemotePath("ls -la", [])).toBe("ls -la");
	});

	it("preserves dir order and the existing PATH", () => {
		expect(prependRemotePath("uv sync", ["/opt/bin", "$HOME/.local/bin"])).toBe(
			'export PATH="/opt/bin:$HOME/.local/bin:$PATH"; uv sync',
		);
	});

	it("works for non-shell-operation commands too", () => {
		expect(prependRemotePath('cat "/tmp/x"')).toBe(
			'export PATH="$HOME/.local/bin:$PATH"; cat "/tmp/x"',
		);
	});

	it("defaults to the exported REMOTE_PATH_DIRS", () => {
		expect(prependRemotePath("pwd")).toBe(prependRemotePath("pwd", REMOTE_PATH_DIRS));
	});
});
