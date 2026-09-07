# ── Build stage ───────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build tools only in the build stage
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy the application source
COPY . .

# Set PYTHONPATH so subpackages (shared, triage, root_cause, orchestrator)
# are importable without a top-level package install
ENV PYTHONPATH=/app

# Non-root user for security
RUN adduser --disabled-password --gecos "" auranet
USER auranet

# Health check — calls the /health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8003/health')"

EXPOSE 8003

CMD ["python", "-m", "orchestrator.langgraph_runner"]