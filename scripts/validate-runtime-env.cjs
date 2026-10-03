#!/usr/bin/env node
'use strict';
const { readRuntimeConfig, assertRuntimeReady } = require('../config/runtime.cjs');
try {
  const config = readRuntimeConfig();
  assertRuntimeReady(config);
  console.log(`Runtime configuration valid (${config.profile}); paid AI ${config.llm.paidEnabled ? 'requested' : 'disabled'}.`);
} catch (error) {
  console.error(`Invalid runtime configuration: ${error.message}`);
  process.exitCode = 1;
}
