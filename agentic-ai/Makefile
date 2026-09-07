.PHONY: up down logs test

up:
	cp -n .env.example .env || true
	docker compose up --build -d

down:
	docker compose down -v

logs:
	docker compose logs -f $(s)

test:
	docker compose run --rm ai-agent pytest tests/
