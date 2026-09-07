.PHONY: up down logs seed ui-dev ui-build ui-install

up:
	cp -n .env.example .env || true
	docker compose up --build -d

down:
	docker compose down -v

logs:
	docker compose logs -f $(s)

seed:
	docker compose exec digital-twin python dataset_loader.py

## Twin console (React) — run the Vite dev server against a stack that is
## already up. Proxies /api/twin -> localhost:8001 and Grafana -> localhost:3001.
ui-install:
	cd ui && npm install

ui-dev: ui-install
	cd ui && npm run dev

ui-build: ui-install
	cd ui && npm run build
