// Remote environment setup for the ssh extension.
//
// `ssh host <command>` runs the command through the login shell's `-c`
// *without* sourcing an interactive profile, so directories that the user's
// interactive shell adds to PATH (notably `~/.local/bin`, where the uv
// installer places `uv`) are missing. As a result, commands that work
// locally — `uv run ...` in particular — fail on the remote with
// "command not found" unless every call is prefixed with a PATH export.
//
// Rather than making callers (or the model) remember that, the ssh extension
// prepends the conventional user-local bin directories to every remote
// command. Kept free of pi-coding-agent imports so it can be unit-tested.

/**
 * Directories prepended to the remote `PATH`, in order, ahead of the
 * inherited `PATH`. `$HOME` is expanded by the remote shell.
 */
export const REMOTE_PATH_DIRS: readonly string[] = ["$HOME/.local/bin"];

/**
 * Prefix a remote shell command with an `export PATH=...` that puts
 * `dirs` ahead of the inherited remote `PATH`.
 *
 * @param command Shell command to run remotely.
 * @param dirs Directories to prepend; defaults to {@link REMOTE_PATH_DIRS}.
 * @returns The command unchanged when `dirs` is empty, otherwise the
 *   prefixed command.
 */
export function prependRemotePath(
	command: string,
	dirs: readonly string[] = REMOTE_PATH_DIRS,
): string {
	if (dirs.length === 0) return command;
	const path = `${dirs.map((dir) => `${dir}:`).join("")}$PATH`;
	return `export PATH="${path}"; ${command}`;
}
