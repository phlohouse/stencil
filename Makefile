.PHONY: help install install-py install-editor \
       dev dev-editor dev-app \
       build build-py build-editor build-app \
       test test-py lint-editor \
       clean clean-py clean-editor

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Install ──────────────────────────────────────────────

install: install-py install-editor ## Install both projects

install-py: ## Install stencilpy in editable mode with dev deps
	cd stencilpy && uv sync --all-extras

install-editor: ## Install editor npm dependencies
	cd editor && npm install

# ── Dev ──────────────────────────────────────────────────

dev: dev-editor ## Start editor dev server (alias)

dev-editor: ## Start editor dev server
	cd editor && npm run dev

dev-app: ## Start editor as desktop app (dev mode)
	cd editor && npm run tauri:dev

# ── Build ────────────────────────────────────────────────

build: build-py build-editor ## Build both projects

build-py: ## Build stencilpy wheel
	cd stencilpy && uv build

build-editor: ## Build editor for production
	cd editor && npm run build

build-app: ## Build desktop app (.dmg / .exe)
	cd editor && npm run tauri:build

# ── Test / Lint ──────────────────────────────────────────

test: test-py ## Run all tests

test-py: ## Run stencilpy tests
	cd stencilpy && uv run pytest tests/ -v

test-cov: ## Run stencilpy tests with coverage
	cd stencilpy && uv run pytest tests/ -v --cov=stencilpy --cov-report=term-missing

lint-editor: ## Lint editor source
	cd editor && npm run lint

# ── Clean ────────────────────────────────────────────────

clean: clean-py clean-editor ## Clean all build artifacts

clean-py: ## Clean stencilpy build artifacts
	rm -rf stencilpy/dist stencilpy/build stencilpy/src/*.egg-info

clean-editor: ## Clean editor build artifacts
	rm -rf editor/dist editor/node_modules/.vite
