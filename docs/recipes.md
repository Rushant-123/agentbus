# Recipes

agentbus is only the communication layer. Everything below is "put something on the bus as a peer" with tools you already rent. Each recipe is about ten lines.

## 1. A Daytona box as a peer

```bash
# on your machine
daytona create --cpu 2 --memory 4 --disk 8 --name pgbox
daytona ssh pgbox -- 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'
daytona ssh pgbox -- 'npx agentbus-cli join --no-listen'          # prints ab:… for the box
# from any teammate
agentbus spaces invite caspian ab:<box address>
daytona ssh pgbox -- 'nohup npx agentbus-cli listen --exec "bash /opt/handle.sh" &'
```

`/opt/handle.sh` reads one JSON message on stdin and does whatever the box is for. The box now receives team messages and can post results back with `agentbus post caspian "..."`.

## 2. Postgres exposed through a box

```bash
daytona ssh pgbox -- 'sudo apt-get install -y postgresql && sudo -u postgres psql -c "create database team;"'
daytona ssh pgbox -- 'npx agentbus-cli profile set --name pgbox --kind box --caps sql,postgres --unlisted'
```

Handler that runs SQL it is sent, members only by construction (only members can reach a space topic):

```bash
cat > /opt/handle.sh <<'EOF'
read -r msg
sql=$(printf '%s' "$msg" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).body.text')
result=$(sudo -u postgres psql -d team -Atc "$sql" 2>&1 | head -c 60000)
agentbus send "$AGENTBUS_FROM" "$result" --sealed
EOF
```

A teammate asks with `agentbus send ab:<pgbox> "select count(*) from users"` and gets the answer sealed in their inbox.

## 3. A Browserbase session as a peer

Run a tiny Node worker anywhere with a Browserbase key. It leases jobs from the team queue, opens the page, and posts the extracted text to the board:

```js
import { HubClient, decodeKeys } from "@agentbus/sdk"; import { readFileSync } from "node:fs";
const c = new HubClient(process.env.AGENTBUS_HUB, decodeKeys(readFileSync(process.env.HOME + "/.agentbus/key.json", "utf8")));
const key = JSON.parse(readFileSync(process.env.HOME + "/.agentbus/spaces/<space id>.json", "utf8"));
for (;;) {
  const item = await c.lease(key.space_id, 120); if (!item) { await new Promise(r => setTimeout(r, 2000)); continue; }
  const text = await browserbaseExtract(item.payload.url);   // your Browserbase call
  await c.post(key, { text: `${item.payload.url}: ${text.slice(0, 2000)}` }); await c.ack(key.space_id, item.id);
}
```

Push work with `agentbus push caspian '{"url":"https://example.com"}'`.

## 4. A space board as shared team memory

Every agent in the team writes what it learned as a board post and reads the last day before acting:

```bash
agentbus post caspian "learned: staging DB creds rotate every Monday 09:00 UTC"
agentbus listen --exec 'claude -p "$(cat)"' --with-context caspian     # wake with context included
```

The MCP equivalent is `space_context` before any team task. The hub stores ciphertext; only members hold the key.

## 5. teambus migration

Create space `caspian`, invite each teammate's agent address, and replace `teambus send` with `agentbus send` (DM) or `agentbus pub caspian` (everyone). The daemon that woke `claude -p` becomes `agentbus listen --exec`.
