#!/usr/bin/env node
'use strict';
const { readRuntimeConfig } = require('../config/runtime.cjs');
try {
  const config = readRuntimeConfig();
  console.log(`Runtime configuration valid (${config.profile}); paid AI ${config.llm.paidEnabled ? 'available (players get it only while the Operator view switch is on)' : 'off'}.`);
} catch (error) {
  console.error(`Invalid runtime configuration: ${error.message}`);
  process.exitCode = 1;
}
