/**
 * Mounting mobile screens in Vitest.
 *
 * `apps/web` renders its components with `renderToStaticMarkup` and asserts on the HTML; the
 * mobile client renders through react-test-renderer against the `react-native` double in
 * `test/native` and asserts on the same tree the device builds — host type, `accessibilityLabel`,
 * `accessibilityRole`, `accessibilityState` and the copy. Screens are mounted for real: a screen
 * that throws, loses its copy or drops an action fails here.
 */
import type { ReactElement } from 'react'
import {
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererNode,
  act,
  create,
} from 'react-test-renderer'

export interface Screen {
  readonly renderer: ReactTestRenderer
  readonly root: ReactTestInstance
  /** Every string in the rendered tree, in render order. */
  texts(): readonly string[]
  /** The rendered text as one blob — the mobile answer to the web tests' HTML string. */
  text(): string
  /** Host nodes carrying this `accessibilityLabel`. */
  byLabel(label: string): readonly ReactTestInstance[]
  /** Host nodes of this type (`'View'`, `'Text'`, `'Pressable'`, `'Modal'`, …). */
  byType(type: string): readonly ReactTestInstance[]
  /** Presses the single node labelled `label`; throws when there is not exactly one. */
  press(label: string): void
  /** Presses the single pressable whose rendered text is `label`. */
  pressText(label: string): void
  update(next: ReactElement): void
  unmount(): void
}

const stringsOf = (node: ReactTestRendererNode | null): string[] => {
  if (node === null) return []
  if (typeof node === 'string') return [node]
  return (node.children ?? []).flatMap(stringsOf)
}

const isHost = (node: ReactTestInstance): boolean => typeof node.type === 'string'

const textOf = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('')
    .trim()

const pressable = (node: ReactTestInstance): boolean =>
  isHost(node) && typeof node.props['onPress'] === 'function'

export function render(element: ReactElement): Screen {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(element)
  })
  if (renderer === null) throw new Error('render() produced no renderer')
  const instance: ReactTestRenderer = renderer

  const pressOne = (nodes: readonly ReactTestInstance[], what: string): void => {
    if (nodes.length !== 1) {
      throw new Error(`expected exactly one pressable ${what}, found ${String(nodes.length)}`)
    }
    const [node] = nodes
    if (node === undefined) throw new Error(`no pressable ${what}`)
    const onPress = node.props['onPress'] as () => void
    act(() => {
      onPress()
    })
  }

  const screen: Screen = {
    renderer: instance,
    root: instance.root,
    texts: () => {
      const json = instance.toJSON()
      const nodes = json === null ? [] : Array.isArray(json) ? json : [json]
      return nodes.flatMap(stringsOf)
    },
    text: () => screen.texts().join('\n'),
    byLabel: (label) =>
      instance.root.findAll((node) => isHost(node) && node.props['accessibilityLabel'] === label, {
        deep: true,
      }),
    byType: (type) => instance.root.findAll((node) => node.type === type, { deep: true }),
    press: (label) =>
      pressOne(screen.byLabel(label).filter(pressable), `labelled ${JSON.stringify(label)}`),
    pressText: (label) =>
      pressOne(
        instance.root.findAll((node) => pressable(node) && textOf(node) === label, { deep: true }),
        `reading ${JSON.stringify(label)}`,
      ),
    update: (next) => {
      act(() => {
        instance.update(next)
      })
    },
    unmount: () => {
      act(() => {
        instance.unmount()
      })
    },
  }
  return screen
}
