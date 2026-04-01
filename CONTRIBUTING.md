# Contributing to Round Table

Thanks for your interest in contributing! 🏰

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USER/roundtable.git`
3. **Create a branch**: `git checkout -b feat/your-feature`
4. **Make changes** and write tests
5. **Submit a PR** against `main`

## Development Setup

### Prerequisites

- Go 1.26+
- Docker
- kubectl + a Kubernetes cluster (kind, minikube, etc.)
- [kubebuilder](https://book.kubebuilder.io/) (for CRD generation)
- NATS CLI (`nats`) — optional, for debugging

### Build & Test

```bash
# Build the operator
make build

# Run tests
make test

# Generate CRDs after type changes
make manifests generate

# Run locally against a cluster
make run

# Build Docker image
make docker-build IMG=roundtable-operator:dev
```

### Helm Chart

```bash
# Install from local chart
helm install roundtable charts/roundtable-operator \
  --namespace roundtable --create-namespace

# Upgrade
helm upgrade roundtable charts/roundtable-operator \
  --namespace roundtable
```

## What to Work On

- Check [open issues](https://github.com/dapperdivers/roundtable/issues) — look for `good first issue` labels
- Bug fixes are always welcome
- Feature ideas? Open an issue first to discuss

## Code Style

- Follow standard Go conventions (`gofmt`, `go vet`)
- Write tests for new functionality
- Keep CRD types well-documented with `// +kubebuilder` markers
- Use structured logging (`logf.FromContext(ctx)`)

## CRD Changes

When modifying types in `api/v1alpha1/`:

1. Update the Go types
2. Run `make manifests generate` to regenerate CRDs and DeepCopy
3. Update Helm chart CRDs: `cp config/crd/bases/* charts/roundtable-operator/crds/`
4. Bump chart version in `Chart.yaml`

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add warm pool support for instant mission assembly
fix: prevent race condition in warm knight claiming
docs: add architecture overview
test: add chain controller integration tests
chore: bump Go to 1.26
```

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include tests
- Update documentation if behavior changes
- Link related issues

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
