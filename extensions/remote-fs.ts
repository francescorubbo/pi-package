// Shared contract between the ssh and pi-uv extensions.
//
// The two extensions are loaded as independent jiti modules (jiti is created
// with `moduleCache: false`), so they cannot share mutable module state. They
// coordinate through pi's shared event bus instead: the ssh extension
// publishes an async filesystem probe for the remote host, and pi-uv runs its
// `uv.lock` project detection against that probe so it never injects a
// `uv run --project <path>` that only exists on the local machine.

/** Event-bus channel on which the ssh extension publishes its remote probes. */
export const REMOTE_FS_CHANNEL = "pi:remote-fs";

/** Async filesystem probe into a (possibly remote) host. */
export interface RemoteFileSystem {
	/** True when `path` exists. */
	exists(path: string): Promise<boolean>;
	/** Immediate child names of directory `path`, or `[]` when unreadable. */
	readdir(path: string): Promise<string[]>;
}

export interface RemoteFsEvent {
	/** Absolute directory bash commands execute in on the remote host. */
	cwd: string;
	/** SSH target, e.g. `user@host`. */
	remote: string;
	/** Filesystem probe for the remote host. */
	fs: RemoteFileSystem;
}
