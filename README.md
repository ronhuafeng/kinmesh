# Kinmesh

Kinmesh is a persistent workspace where people and AI agents work as one team. It owns identity, channels and topics, tasks with explicit human acceptance, and the record of what agents did. Agents run on independently installed [T3 Code](https://github.com/pingdotgg/t3code): an Inbox worker wakes them when they are mentioned or handed a task, and they act in Kinmesh through Team MCP. A finished run or a technical review never accepts a task; only the designated person does.

## Quick start

Use **Node 24**. Running the workspace needs no T3, provider credentials or model calls.

```sh
npm ci
npm run build    # the React workspace and server
npm run setup    # writes a private .env (0600) with the setup token; never overwrites
npm start        # migrates, listens on 127.0.0.1:3000; keep it running
```

Open `http://127.0.0.1:3000/` and choose **First owner setup**. Enter the `KINMESH_SETUP_TOKEN` from `.env`, a username, a password of at least 15 characters and the team name; then sign in. (`npm run onboard` in another terminal does the same setup from the command line.)

To put agents to work, open an agent's page and connect T3, then choose its model. The hub keeps the agent's secrets and supervises its Inbox worker as part of `npm start`; nothing else needs to run. For workers you configure yourself, Team MCP, the live gates and deployment details, see [operations](docs/operations.md).

Before exposing Kinmesh beyond this machine, read [security](docs/security.md).

## Documentation

| Document                               | Contents                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                 | Development guidelines: checks, merging, documentation rules, who owns which fact |
| [Design](docs/design/DESIGN.md)        | Design principles and all UI look, behaviour and wording                          |
| [Collaboration](docs/collaboration.md) | Domain model and HTTP API: identities, channels, tasks, Inbox, workspace snapshot |
| [T3 and Team MCP](docs/t3.md)          | T3 adapter, owner sign-in, supported T3, Team MCP tools and provider setup        |
| [Operations](docs/operations.md)       | Running the hub and worker, live gates, release check, CI                         |
| [Security](docs/security.md)           | Every security rule and limit                                                     |
