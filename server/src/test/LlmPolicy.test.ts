import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLlmRuntimePolicy,
  estimateLlmCostUsd,
  isModelAllowed,
} from '../llm/policy.js';

test('GPT-5.6 Luna and Terra are supported OpenAI seat models', () => {
  const policy = buildLlmRuntimePolicy({});

  assert.equal(isModelAllowed(policy, 'OPENAI', 'gpt-5.6-luna'), true);
  assert.equal(isModelAllowed(policy, 'OPENAI', 'gpt-5.6-terra'), true);
});

test('GPT-5.6 Luna and Terra usage is priced from token counts', () => {
  assert.equal(estimateLlmCostUsd({
    provider: 'OPENAI',
    model: 'gpt-5.6-luna',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), 7);
  assert.equal(estimateLlmCostUsd({
    provider: 'OPENAI',
    model: 'gpt-5.6-terra',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), 17.5);
});
