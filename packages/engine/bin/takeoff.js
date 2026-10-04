#!/usr/bin/env node
// Shim: Node strips the TypeScript types of src/cli.ts at load time (no build step).
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2));
