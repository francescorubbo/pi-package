import { ExtensionAPI, ExtensionContext, ToolCallEvent, isToolCallEventType, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

class BlockShellCommands {
    private allowlist: Set<string> = new Set();
    private allowlistFile: string;

    constructor(cwd: string) {
        const configDir = join(cwd, CONFIG_DIR_NAME);
        this.allowlistFile = join(configDir, "shell-allowlist.json");
        this.loadAllowlist();
    }

    private loadAllowlist(): void {
        try {
            if (existsSync(this.allowlistFile)) {
                const data = readFileSync(this.allowlistFile, "utf-8");
                const list = JSON.parse(data);
                this.allowlist = new Set(list);
            }
        } catch (e) {
            console.error("Failed to load shell allowlist:", e);
        }
    }

    private saveAllowlist(): void {
        try {
            const dir = join(this.allowlistFile, "..");
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.allowlistFile, JSON.stringify(Array.from(this.allowlist), null, 2));
        } catch (e) {
            console.error("Failed to save shell allowlist:", e);
        }
    }

    public async shouldBlock(command: string, ctx: ExtensionContext): Promise<{ block: boolean; reason?: string }> {
        const firstToken = command.trim().split(/\s+/)[0];
        
        if (this.allowlist.has(firstToken)) {
            return { block: false };
        }

        const response = await ctx.ui.select(
            `Shell command blocked: "${command}"\nAllow once or add "${firstToken}" to allowlist?`,
            ["Allow once", "Always allow", "Block"]
        );

        if (response === "Always allow") {
            this.allowlist.add(firstToken);
            this.saveAllowlist();
            return { block: false };
        } else if (response === "Allow once") {
            return { block: false };
        }

        return { block: true, reason: "Blocked by user" };
    }

    public add(token: string) {
        this.allowlist.add(token);
        this.saveAllowlist();
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
            const command = event.input.command;
            const result = await blocker.shouldBlock(command, ctx);
            if (result.block) {
                return result;
            }
        }
    });

    pi.registerCommand("allow-cmd", {
        description: "Add a command (first token) to the shell allowlist",
        handler: async (args: string, ctx: ExtensionContext) => {
            const token = args?.trim().split(/\s+/)[0];
            if (token) {
                blocker.add(token);
                ctx.ui.notify(`Added "${token}" to allowlist`, "info");
            } else {
                ctx.ui.notify("Usage: /allow-cmd <command>", "error");
            }
        },
    });
}
