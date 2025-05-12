# Strataline v0.1.0

**Strataline** is a structured migration runner for PostgreSQL that treats database changes as layered, resumable operations—built to scale from small projects to distributed, orchestrated systems.

The name **Strataline** comes from:

- **Strata**: representing the _layers_ of a database migration—schema changes, data backfills, and cleanup steps
- **Line**: reflecting the _path or flow_ each migration takes, whether inline or across job queues and workers

Unlike traditional migration tools that run everything synchronously or block during large data changes, Strataline separates each migration into three distinct phases:

- `beforeSchema`: transactional DDL changes before data work
- `migration`: data transformation logic—supports inline or deferred execution
- `afterSchema`: optional final cleanup (e.g. setting NOT NULL, dropping old columns)

## Development

Strataline is built with TypeScript and uses [Bun](https://bun.sh) for testing and running CLI scripts.

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun test

# Development mode with watch
bun run dev
```
