import { defineProvider } from './define.js'

/**
 * Qwen (Alibaba) — device flow, as used by qwen-code.
 *
 * Device-only in practice: the authorization endpoint is not registered for
 * third-party redirects. Use `client.deviceLogin()`.
 *
 * Alibaba discontinued the free Qwen OAuth tier in April 2026; existing
 * credentials keep working but new sign-ups may be refused, which surfaces as
 * a `device_flow_failed` error rather than anything this library can fix.
 */
export const qwen = defineProvider({
  id: 'qwen',
  label: 'Qwen (Alibaba)',
  authorizationUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
  deviceAuthorizationUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  scopes: ['openid', 'profile', 'email', 'model.completion'],
  redirect: { mode: 'custom' },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  experimental: true,
  note:
    'Supply a clientId — publicClientIds.qwen is the one qwen-code uses. Qwen ' +
    'supports the device flow only, so use client.deviceLogin(). The free ' +
    'OAuth tier was discontinued in April 2026, so new sign-ups may be refused.',
})
