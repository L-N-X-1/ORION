.PHONY: up down logs seed test

up:
	cp -n .env.example .env || true
	docker compose up --build -d

down:
	docker compose down -v

logs:
	docker compose logs -f $(s)

seed:
	docker compose exec digital-twin python dataset_loader.py

test:
	docker compose run --rm ai-agent pytest tests/
