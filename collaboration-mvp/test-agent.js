#!/usr/bin/env node
'use strict';
// Deterministic local test fixture, never a model or a shell evaluator.
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin, terminal: false });
console.log('FIXTURE_AGENT_READY (fake agent; no AI/network)');
lines.on('line', line => console.log('FIXTURE_AGENT_GENERATED ' + JSON.stringify(line)));
