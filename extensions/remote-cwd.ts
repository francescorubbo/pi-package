// Shared contract between the ssh and strip-cwd-prefix extensions.
//
// The two extensions are loaded as independent jiti modules (jiti is created
// with `moduleCache: false`), so they cannot share mutable module state.
// They coordinate through pi's shared event bus instead. This module only
// holds constants/types, so a separate copy per extension is harmless.

/** Event-bus channel on which the ssh extension publishes its remote cwd. */
export const REMOTE_CWD_CHANNEL = "pi:remote-cwd";

export interface RemoteCwdEvent {
	/** Absolute directory bash commands execute in on the remote host. */
	cwd: string;
	/** SSH target, e.g. `user@host`. */
	remote: string;
}
