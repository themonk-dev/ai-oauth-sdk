import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'

const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const

const installCommand: Record<(typeof MANAGERS)[number], string> = {
  npm: 'npm install',
  pnpm: 'pnpm add',
  yarn: 'yarn add',
  bun: 'bun add',
}

const executeCommand: Record<(typeof MANAGERS)[number], string> = {
  npm: 'npx',
  pnpm: 'pnpm dlx',
  yarn: 'yarn dlx',
  bun: 'bunx',
}

function CommandTabs({ commands }: { commands: Record<string, string> }) {
  return (
    <Tabs groupId="package-manager" persist items={[...MANAGERS]}>
      {MANAGERS.map((manager) => (
        <Tab key={manager} value={manager}>
          <CodeBlock lang="bash" keepBackground>
            <Pre>{commands[manager]}</Pre>
          </CodeBlock>
        </Tab>
      ))}
    </Tabs>
  )
}

/**
 * `pnpm` is what this repository uses, but the docs should not assume it of a
 * reader. The tab choice is remembered across every block on the site.
 */
export function Install({ packages, dev = false }: { packages: string; dev?: boolean }) {
  const flag = dev ? ' -D' : ''

  return (
    <CommandTabs
      commands={Object.fromEntries(
        MANAGERS.map((manager) => [manager, `${installCommand[manager]}${flag} ${packages}`]),
      )}
    />
  )
}

export function InstallGlobal({ packages }: { packages: string }) {
  return (
    <CommandTabs
      commands={{
        npm: `npm install -g ${packages}`,
        pnpm: `pnpm add -g ${packages}`,
        yarn: `yarn global add ${packages}`,
        bun: `bun add -g ${packages}`,
      }}
    />
  )
}

export function Execute({ command }: { command: string }) {
  return (
    <CommandTabs
      commands={Object.fromEntries(
        MANAGERS.map((manager) => [manager, `${executeCommand[manager]} ${command}`]),
      )}
    />
  )
}
