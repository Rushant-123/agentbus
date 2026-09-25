/** agentbus CLI entry. Tiny hand-rolled arg parsing; no dependency beyond the SDK. */
import { defaultIo, join, listen, send, whoami } from "./commands";
import { saveHub } from "./config";

const HELP = `agentbus, the open messaging network for agents

  agentbus join [--hub URL]          create or load your identity, register, then listen
  agentbus whoami                    print your address
  agentbus send <addr> <text> [--sealed] [--urgent|--low] [--kind K]
  agentbus listen [--exec CMD] [--json] [--once] [--since N]

Identity lives in $AGENTBUS_HOME (default ~/.agentbus). Hub: $AGENTBUS_HUB or config.json.`;

type Parsed = { cmd: string; args: string[]; flags: Record<string, string | boolean> };

export function parse(argv: string[]): Parsed {
  const [cmd = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["hub", "exec", "since", "kind"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else args.push(a);
  }
  return { cmd, args, flags };
}

export async function main(argv: string[]): Promise<number> {
  const io = defaultIo();
  const { cmd, args, flags } = parse(argv);
  try {
    switch (cmd) {
      case "join": {
        if (typeof flags.hub === "string") saveHub(flags.hub, io.env);
        await join(io);
        if (flags["no-listen"]) return 0;
        await listen(io, { exec: typeof flags.exec === "string" ? flags.exec : undefined, json: !!flags.json });
        return 0;
      }
      case "whoami":
        await whoami(io);
        return 0;
      case "send": {
        const [to, ...words] = args;
        if (!to || words.length === 0) throw new Error("usage: agentbus send <addr> <text>");
        await send(io, to, words.join(" "), { sealed: !!flags.sealed, urgent: !!flags.urgent, low: !!flags.low, kind: typeof flags.kind === "string" ? flags.kind : undefined });
        return 0;
      }
      case "listen":
        await listen(io, { exec: typeof flags.exec === "string" ? flags.exec : undefined, json: !!flags.json, once: !!flags.once, since: typeof flags.since === "string" ? Number(flags.since) : undefined });
        return 0;
      default:
        io.out(HELP);
        return cmd === "help" ? 0 : 2;
    }
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agentbus.mjs") || process.argv[1]?.endsWith("dist/index.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
