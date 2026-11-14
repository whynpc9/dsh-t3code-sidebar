// Shared transport for tests driven against an isolated Harness Web host.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { chromium } from 'playwright-core'

export const launchChromium = () => chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE ?? `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
})

export async function rpc(page, method, args = {}) {
  const response = await page.request.post(new URL(`/api/${method}`, page.url()).href, {
    data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } },
  })
  if (response.status() !== 200) throw new Error(`${method}: HTTP ${response.status()}`)
  const { result } = await response.json()
  if (!result?.ok) throw new Error(`${method}: ${JSON.stringify(result?.error)}`)
  return result.value
}

// Keep the one-time launcher token out of shell output and report files.
export async function hostUrl(logPath) {
  const text = await readFile(logPath, 'utf8')
  const url = text.match(/http:\/\/127\.0\.0\.1:\d+\/\S*token=[^\s]+/)?.[0]
  if (url === undefined) throw new Error('Harness launch URL not found')
  return url
}
