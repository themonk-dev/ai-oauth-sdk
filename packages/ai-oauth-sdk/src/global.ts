/**
 * Entry point for the CDN (IIFE) build — everything is bundled in, and the
 * exports land on `window.AIOAuth`.
 *
 * Deliberately browser-only: the Node adapter imports `node:http`, which cannot
 * be bundled for a `<script>` tag.
 */
export * from '@ai-oauth-sdk/browser'
