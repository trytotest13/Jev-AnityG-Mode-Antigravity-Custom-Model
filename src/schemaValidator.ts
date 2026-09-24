/**
 * Schema Validator Module for Antigravity Proxy
 *
 * Validates custom model configuration objects.
 *
 * This module provides runtime validation to catch malformed
 * configs before they reach the frontend, improving stability
 * and preventing cryptic UI errors.
 */

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a custom model configuration object.
 */
export function validateCustomModel(model: unknown): ValidationResult {
  if (!model || typeof model !== 'object') {
    return { valid: false, error: 'Model is null or not an object' };
  }

  const m = model as Record<string, unknown>;
  const required = ['name', 'provider', 'apiUrl'];
  for (const field of required) {
    if (!m[field] || typeof m[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  const name = m.name as string;
  // Validate model name format: should start with "models/" or be a valid path
  if (!name.startsWith('models/') && !name.includes('/')) {
    return { valid: false, error: 'Model name must start with "models/"' };
  }

  const provider = m.provider as string;
  // Validate provider is one of the supported types
  const validProviders = [
    'openai',
    'anthropic',
    'google',
    'ollama',
    'custom',
    'openrouter',
    'deepseek',
    'groq',
    'mistral',
    'cerebras',
    'kimi',
    'fireworks',
    'lmstudio',
    'llamacpp',
    'nvidia',
    'free-router',
  ];
  if (!validProviders.includes(provider)) {
    return { valid: false, error: `Unsupported provider: ${provider}. Must be one of: ${validProviders.join(', ')}` };
  }

  const apiUrl = m.apiUrl as string;
  // Validate API URL format
  try {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'API URL must use http or https protocol' };
    }
  } catch (e) {
    return { valid: false, error: `Invalid API URL: ${(e as Error).message}` };
  }

  // Validate optional fields
  if (m.externalModelName && typeof m.externalModelName !== 'string') {
    return { valid: false, error: 'externalModelName must be a string' };
  }
  if (m.displayName && typeof m.displayName !== 'string') {
    return { valid: false, error: 'displayName must be a string' };
  }
  if (m.apiKey && typeof m.apiKey !== 'string') {
    return { valid: false, error: 'apiKey must be a string' };
  }
  if (m.allowUnauthorized !== undefined && typeof m.allowUnauthorized !== 'boolean') {
    return { valid: false, error: 'allowUnauthorized must be a boolean' };
  }
  if (m.disabled !== undefined && typeof m.disabled !== 'boolean') {
    return { valid: false, error: 'disabled must be a boolean' };
  }

  return { valid: true };
}
