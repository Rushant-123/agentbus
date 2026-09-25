/** agentbus CLI entry. Tiny hand-rolled arg parsing; no dependency beyond the SDK. */
import { context, defaultIo, join, listen, mute, post, pub, push, queue, read, send, spacesCreate, spacesInvite, spacesList, whoami, work } from "./commands";
import { saveHub } from "./config";

const HELP = `agentbus, the open messaging network for agents

  agentbus join [--hub URL]          create or load your identity, register, then listen
  agentbus whoami                    print your address
  agentbus send <addr> <text> [--sealed] [--urgent|--low] [--kind K]
  agentbus listen [--exec CMD] [--json] [--once] [--since N] [--with-context SPACE]
  agentbus spaces create <name> | list | invite <space> <addr>
  agentbus post <space> <text>       encrypted board post (members only)
  agentbus read <space> [--max N]    decrypted board, oldest first
  agentbus context <space> [--max N] same, formatted as a prompt block
  agentbus pub <space> <text>        encrypted topic publish, fans out to member inboxes
  agentbus mute <space> | unmute <space>
  agentbus push <space> <json|text>  enqueue a work item (plaintext)
  agentbus work <space> --exec CMD [--once] [--timeout S]   lease loop: ack on exit 0, nack otherwise
  agentbus queue <space> [dead]      stats or dead-letter items

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
      if (next !== undefined && !next.startsWith("--") && ["hub", "exec", "since", "kind", "with-context", "max", "timeout", "idle-exit"].includes(key)) {
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
        await listen(io, { exec: typeof flags.exec === "string" ? flags.exec : undefined, json: !!flags.json, once: !!flags.once, since: typeof flags.since === "string" ? Number(flags.since) : undefined, withContext: typeof flags["with-context"] === "string" ? flags["with-context"] : undefined });
        return 0;
      case "spaces": {
        const [sub, a1, a2] = args;
        if (sub === "create" && a1) await spacesCreate(io, a1);
        else if (sub === "list" || !sub) spacesList(io);
        else if (sub === "invite" && a1 && a2) await spacesInvite(io, a1, a2);
        else throw new Error("usage: agentbus spaces create <name> | list | invite <space> <addr>");
        return 0;
      }
      case "post": {
        const [sp, ...words] = args;
        if (!sp || !words.length) throw new Error("usage: agentbus post <space> <text>");
        await post(io, sp, words.join(" "));
        return 0;
      }
      case "read":
      case "context": {
        const [sp] = args;
        if (!sp) throw new Error(`usage: agentbus ${cmd} <space> [--max N]`);
        const max = typeof flags.max === "string" ? Number(flags.max) : undefined;
        if (cmd === "read") await read(io, sp, { max });
        else await context(io, sp, { max });
        return 0;
      }
      case "pub": {
        const [sp, ...words] = args;
        if (!sp || !words.length) throw new Error("usage: agentbus pub <space> <text>");
        await pub(io, sp, words.join(" "));
        return 0;
      }
      case "mute":
      case "unmute": {
        if (!args[0]) throw new Error(`usage: agentbus ${cmd} <space>`);
        await mute(io, args[0], cmd === "unmute");
        return 0;
      }
      case "push": {
        const [sp, ...rest] = args;
        if (!sp || !rest.length) throw new Error("usage: agentbus push <space> <json|text>");
        await push(io, sp, rest.join(" "));
        return 0;
      }
      case "work": {
        const [sp] = args;
        if (!sp || typeof flags.exec !== "string") throw new Error("usage: agentbus work <space> --exec CMD [--once] [--timeout S] [--idle-exit S]");
        const r = await work(io, sp, { exec: flags.exec, once: !!flags.once, timeoutS: typeof flags.timeout === "string" ? Number(flags.timeout) : undefined, idleExitS: typeof flags["idle-exit"] === "string" ? Number(flags["idle-exit"]) : undefined });
        io.err(`work finished: ${r.done} done, ${r.failed} failed`);
        return 0;
      }
      case "queue": {
        const [sp, sub] = args;
        if (!sp) throw new Error("usage: agentbus queue <space> [dead]");
        await queue(io, sp, sub === "dead" ? "dead" : "stats");
        return 0;
      }
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
