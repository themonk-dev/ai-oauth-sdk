import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import defaultMdxComponents from 'fumadocs-ui/mdx'

import { FeatureCards } from './feature-cards'
import { Execute, Install, InstallGlobal } from './install'
import { Mermaid } from './mermaid'
import { RuntimeCards } from './runtime-cards'

import type { MDXComponents } from 'mdx/types'

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Execute,
    FeatureCards,
    Install,
    InstallGlobal,
    Mermaid,
    RuntimeCards,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
