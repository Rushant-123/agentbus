/** Hub client used by the CLI, the MCP server, and tests. Fetch is injectable. */
import { address, pubFromJson, pubToJson, seal, sign, toB64, type Keys, type PublicIdentity } from "./crypto";
import { build, canonical, type Body, type Envelope, type Priority } from "./envelope";
import { signedHeaders } from "./auth";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SendOptions = { kind?: string; priority?: Priority; reply_to?: string; sealed?: boolean };
export type InboxPage = { messages: { seq: number; envelope: Envelope }[]; next: number };

export class HubError extends Error {
  constructor(public status: number, message: string) {
    super(`hub ${status}: ${message}`);
  }
}

export class HubClient {
  constructor(public hub: string, public keys: Keys, private fetchImpl: FetchLike = fetch) {
    this.hub = hub.replace(/\/$/, "");
  }

  get address(): string {
    return address(this.keys.pub);
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new HubError(res.status, text.slice(0, 300));
    return JSON.parse(text) as T;
  }

  private signed(method: string, path: string): Record<string, string> {
    return { ...signedHeaders(this.keys, method, path), "content-type": "application/json" };
  }

  async register(): Promise<{ address: string; created: boolean }> {
    const pub = pubToJson(this.keys.pub);
    const sig = toB64(sign(this.keys, new TextEncoder().encode(canonical(pub))));
    const res = await this.fetchImpl(`${this.hub}/v1/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...pub, sig }) });
    const body = await this.json<{ address: string }>(res);
    return { address: body.address, created: res.status === 201 };
  }

  async lookup(addr: string): Promise<{ address: string; pub: PublicIdentity; profile?: unknown }> {
    const res = await this.fetchImpl(`${this.hub}/v1/agents/${addr}`);
    const body = await this.json<{ address: string; verify_key: string; box_key: string; profile?: unknown }>(res);
    return { address: body.address, pub: pubFromJson(body), profile: body.profile };
  }

  /** Send a DM. `payload` is any JSON; with `sealed`, it is encrypted to the recipient's box key. */
  async send(to: string, payload: unknown, opts: SendOptions = {}): Promise<{ id: string; seq: number }> {
    let body: Body;
    if (opts.sealed) {
      const { pub } = await this.lookup(to);
      body = { sealed: toB64(seal(pub, new TextEncoder().encode(JSON.stringify(payload)))) };
    } else {
      body = { plain: payload };
    }
    const env = build(this.keys, { to, kind: opts.kind ?? "dm", priority: opts.priority, reply_to: opts.reply_to, body });
    return this.sendEnvelope(env);
  }

  async sendEnvelope(env: Envelope): Promise<{ id: string; seq: number }> {
    const res = await this.fetchImpl(`${this.hub}/v1/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
    return this.json(res);
  }

  async poll(since = 0, limit = 50): Promise<InboxPage> {
    const path = "/v1/inbox";
    const res = await this.fetchImpl(`${this.hub}${path}?since=${since}&limit=${limit}`, { headers: this.signed("GET", path) });
    return this.json(res);
  }

  wsUrl(since = 0): string {
    const h = signedHeaders(this.keys, "GET", "/v1/inbox/ws");
    const qs = new URLSearchParams({ agent: h["x-agent"], ts: h["x-ts"], sig: h["x-sig"], since: String(since) });
    return `${this.hub.replace(/^http/, "ws")}/v1/inbox/ws?${qs}`;
  }
}
