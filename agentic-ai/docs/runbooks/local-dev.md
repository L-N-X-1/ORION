# Local Dev Runbook

ORION is two independent stacks now — `digital-twin/` and `agentic-ai/` — each
with its own `docker-compose.yml`, `.env.example`, and `Makefile`. They are
not networked together (see the correlation TODO in the root README), so run
whichever one(s) you're working on.

## Start the agentic-ai stack
```bash
cd agentic-ai
make up
```

## Start the digital-twin stack
```bash
cd digital-twin
make up
```

## Tear down
```bash
make down    # from inside either stack's folder
```

## View logs for a service
```bash
docker compose logs -f ai-agent    # from agentic-ai/
docker compose logs -f digital-twin # from digital-twin/
```

## Seed the Italian Telecom dataset (digital-twin only)
```bash
cd digital-twin
make seed
```

## Run the agent test suite (agentic-ai only)
```bash
cd agentic-ai
make test
```
