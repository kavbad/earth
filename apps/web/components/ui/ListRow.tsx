import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

import { cx } from './cx'

interface ListRowContent {
  readonly leading?: ReactNode
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly trailing?: ReactNode
  readonly className?: string | undefined
}

export type ListRowProps =
  | (ListRowContent & { readonly as?: 'div' })
  | (ListRowContent & { readonly as: 'button' } & Omit<
        ButtonHTMLAttributes<HTMLButtonElement>,
        'className' | 'title' | 'children'
      >)
  | (ListRowContent & { readonly as: 'a' } & Omit<
        AnchorHTMLAttributes<HTMLAnchorElement>,
        'className' | 'title' | 'children'
      >)

const ROW_CLASS =
  'flex w-full min-h-touch-target items-center gap-3 px-screen-margin py-2 text-left text-body text-text-primary transition-colors duration-fast ease-standard'

/** A compact row (chats, members, settings): 8–12 pt gaps, hairline separators from the list. */
export function ListRow(props: ListRowProps) {
  const body = (
    <>
      {props.leading !== undefined ? <span className="shrink-0">{props.leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{props.title}</span>
        {props.subtitle !== undefined ? (
          <span className="truncate text-secondary text-text-secondary">{props.subtitle}</span>
        ) : null}
      </span>
      {props.trailing !== undefined ? (
        <span className="shrink-0 text-secondary text-text-secondary">{props.trailing}</span>
      ) : null}
    </>
  )
  if (props.as === 'button') {
    const {
      as: _as,
      leading: _l,
      title: _t,
      subtitle: _s,
      trailing: _r,
      className,
      ...rest
    } = props
    return (
      <button type="button" className={cx(ROW_CLASS, 'hover:bg-subtle-fill', className)} {...rest}>
        {body}
      </button>
    )
  }
  if (props.as === 'a') {
    const {
      as: _as,
      leading: _l,
      title: _t,
      subtitle: _s,
      trailing: _r,
      className,
      ...rest
    } = props
    return (
      <a className={cx(ROW_CLASS, 'hover:bg-subtle-fill', className)} {...rest}>
        {body}
      </a>
    )
  }
  return <div className={cx(ROW_CLASS, props.className)}>{body}</div>
}

/** Wraps rows with hairline separators between them. */
export function List({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col [&>*+*]:hairline-t', className)} role="list">
      {children}
    </div>
  )
}
