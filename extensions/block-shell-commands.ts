import { ExtensionAPI, ExtensionContext, ToolCallEvent, isToolCallEventType, CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

class BlockShellCommands {
    private projectAllowlist: Set<string> = new Set();
    private globalAllowlist: Set<string> = new Set();
    private projectAllowlistFile: string;
    private globalAllowlistFile: string;

    constructor(cwd: string) {
        const configDir = join(cwd, CONFIG_DIR_NAME);
        this.projectAllowlistFile = join(configDir, "shell-allowlist.json");
        this.globalAllowlistFile = join(getAgentDir(), "shell-allowlist.json");
        this.loadAllowlists();
    }

    private loadAllowlists(): void {
        this.projectAllowlist = this.loadFile(this.projectAllowlistFile);
        this.globalAllowlist = this.loadFile(this.globalAllowlistFile);
    }

    private loadFile(path: string): Set<string> {
        try {
            if (existsSync(path)) {
                const data = readFileSync(path, "utf-8");
                const list = JSON.parse(data);
                return new Set(list);
            }
        } catch (e) {
            console.error(`Failed to load shell allowlist from ${path}:`, e);
        }
        return new Set();
    }

    private saveFile(path: string, list: Set<string>): void {
        try {
            const dir = join(path, "..");
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(path, JSON.stringify(Array.from(list), null, 2));
        } catch (e) {
            console.error(`Failed to save shell allowlist to ${path}:`, e);
        }
    }

    public async shouldBlock(command: string, ctx: ExtensionContext): Promise<{ block: boolean; reason?: string }> {
        const firstToken = command.trim().split(/\s+/)[0];
        
        if (this.projectAllowlist.has(firstToken) || this.globalAllowlist.has(firstToken)) {
            return { block: false };
        }

        const response = await ctx.ui.select(
            `Shell command blocked: "${command}"\nAllow once or add "${firstToken}" to allowlist?`,
            ["Allow once", "Always allow (Project)", "Always allow (Global)", "Block"]
        );

        if (response === "Always allow (Project)") {
            this.projectAllowlist.add(firstToken);
            this.saveFile(this.projectAllowlistFile, this.projectAllowlist);
            return { block: false };
        } else if (response === "Always allow (Global)") {
            this.globalAllowlist.add(firstToken);
            this.saveFile(this.globalAllowlistFile, this.globalAllowlist);
            return { block: false };
        } else if (response === "Allow once") {
            return { block: false };
        }

        return { block: true, reason: "Blocked by user" };
    }

    public add(token: string, global: boolean = false) {
        if (global) {
            this.globalAllowlist.add(token);
            this.saveFile(this.globalAllowlistFile, this.globalAllowlist);
        } else {
            this.projectAllowlist.add(token);
            this.saveFile(this.projectAllowlistFile, this.projectAllowlist);
        }
    }
}

export default function (pi: ExtensionAPI) {
    // Initialize lazily on session_start to get the correct CWD
    let blocker: BlockShellCommands;

    pi.on("session_start", (event, ctx) => {
        blocker = new BlockShellCommands(ctx.cwd);
    });

    pi.on("tool_call", async (event, ctx) => {
        if (isToolCallEventType("bash", event)) {
            const command = (event as any).input.command;
            const result = await blocker.shouldBlock(command, ctx);
            if (result.block) {
                return result as any;
            }
        }
    });

    pi.registerCommand("allow-cmd", {
        description: "Add a command (first token) to the shell allowlist. Use --global for global allowlist.",
        handler: async (args: string, ctx: ExtensionContext) => {
            const parts = args?.trim().split(/\s+/);
            const isGlobal = parts?.includes("--global");
            const token = parts?.filter(p => p !== "--global")[0];

            if (token) {
                blocker.add(token, isGlobal);
                ctx.ui.notify(`Added "${token}" to ${isGlobal ? "global" : "project"} allowlist`, "info");
            } else {
                ctx.ui.notify("Usage: /allow-cmd <command> [--global]", "error");
            }
        },
    });
}
