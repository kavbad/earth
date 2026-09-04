'use client'

/**
 * The windowed message list (SCREEN 10/11). Rows are measured once rendered and estimated before;
 * only the rows around the viewport are mounted, so a thread of thousands stays light. The list
 * sticks to the bottom while the reader is there, keeps the anchor row in place when older
 * messages are prepended, and asks for older pages as the reader nears the top.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Spinner } from '../ui/Spinner'
import { cx } from '../ui/cx'
import { chatCopy } from './copy'
import {
  EMPTY_LAYOUT,
  type VirtualLayout,
  anchorDelta,
  buildLayout,
  isNearBottom,
  visibleRange,
} from './state/virtual'

export const ROW_HEIGHT_ESTIMATE = 56
export const OVERSCAN_PX = 600
export const BOTTOM_THRESHOLD_PX = 80
export const LOAD_OLDER_THRESHOLD_PX = 240

export interface VirtualRow {
  readonly key: string
}

export interface MessageListProps<Row extends VirtualRow> {
  readonly rows: readonly Row[]
  readonly renderRow: (row: Row) => ReactNode
  readonly hasOlder: boolean
  readonly loadingOlder: boolean
  readonly onLoadOlder: () => void
  readonly label: string
  /** Rendered above the first row (an empty-thread line, a "Say hello."). */
  readonly header?: ReactNode
  readonly className?: string | undefined
}

export function MessageList<Row extends VirtualRow>({
  rows,
  renderRow,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  label,
  header,
  className,
}: MessageListProps<Row>) {
  const container = useRef<HTMLDivElement>(null)
  // One Map for the life of the list, mutated by measurements; `measureVersion` re-lays out.
  const [heights] = useState(() => new Map<string, number>())
  const [measureVersion, setMeasureVersion] = useState(0)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })
  const stickToBottom = useRef(true)
  const previous = useRef<{ keys: readonly string[]; layout: VirtualLayout }>({
    keys: [],
    layout: EMPTY_LAYOUT,
  })
  const loadRequested = useRef(false)

  const keys = useMemo(() => rows.map((row) => row.key), [rows])
  const layout = useMemo(
    () => buildLayout(keys, heights, ROW_HEIGHT_ESTIMATE),
    // measureVersion is the signal that `heights` changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, heights, measureVersion],
  )
  const range = visibleRange(layout, viewport.scrollTop, viewport.height, OVERSCAN_PX)

  // Viewport size.
  useEffect(() => {
    const node = container.current
    if (node === null) return
    const update = () =>
      setViewport((current) =>
        current.height === node.clientHeight ? current : { ...current, height: node.clientHeight },
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Keep the bottom (new messages) or the anchor row (prepends) in place after layout changes.
  useLayoutEffect(() => {
    const node = container.current
    if (node === null) return
    const before = previous.current
    previous.current = { keys, layout }
    if (stickToBottom.current) {
      node.scrollTop = node.scrollHeight
      return
    }
    const anchor = before.keys[0]
    if (anchor !== undefined && keys[0] !== anchor) {
      const delta = anchorDelta(before.keys, before.layout, keys, layout, anchor)
      if (delta !== 0) node.scrollTop += delta
    }
  }, [keys, layout])

  useEffect(() => {
    if (!loadingOlder) loadRequested.current = false
  }, [loadingOlder])

  const onScroll = useCallback(() => {
    const node = container.current
    if (node === null) return
    const scrollTop = node.scrollTop
    stickToBottom.current = isNearBottom(
      scrollTop,
      node.clientHeight,
      node.scrollHeight,
      BOTTOM_THRESHOLD_PX,
    )
    setViewport((current) =>
      current.scrollTop === scrollTop ? current : { ...current, scrollTop },
    )
    if (
      scrollTop < LOAD_OLDER_THRESHOLD_PX &&
      hasOlder &&
      !loadingOlder &&
      !loadRequested.current
    ) {
      loadRequested.current = true
      onLoadOlder()
    }
  }, [hasOlder, loadingOlder, onLoadOlder])

  const measure = useCallback(
    (key: string, element: HTMLDivElement | null) => {
      if (element === null) return
      const height = element.offsetHeight
      if (height > 0 && heights.get(key) !== height) {
        heights.set(key, height)
        setMeasureVersion((version) => version + 1)
      }
    },
    [heights],
  )

  const visible = rows.slice(range.start, range.end)

  return (
    <div
      ref={container}
      onScroll={onScroll}
      role="log"
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions"
      className={cx('relative min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
    >
      <div className="flex min-h-touch-target items-center justify-center">
        {loadingOlder ? (
          <Spinner label={chatCopy.loadOlder} />
        ) : hasOlder ? (
          <button
            type="button"
            onClick={onLoadOlder}
            className="min-h-touch-target px-4 text-secondary text-text-secondary"
          >
            {chatCopy.loadOlder}
          </button>
        ) : (
          header
        )}
      </div>
      <div style={{ height: layout.total, position: 'relative' }}>
        {visible.map((row, index) => {
          const absolute = range.start + index
          return (
            <MeasuredRow
              key={row.key}
              rowKey={row.key}
              offset={layout.offsets[absolute] ?? 0}
              measure={measure}
            >
              {renderRow(row)}
            </MeasuredRow>
          )
        })}
      </div>
    </div>
  )
}

function MeasuredRow({
  rowKey,
  offset,
  measure,
  children,
}: {
  readonly rowKey: string
  readonly offset: number
  readonly measure: (key: string, element: HTMLDivElement | null) => void
  readonly children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    measure(rowKey, node)
    const observer = new ResizeObserver(() => measure(rowKey, node))
    observer.observe(node)
    return () => observer.disconnect()
  }, [rowKey, measure])
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        transform: `translateY(${offset}px)`,
      }}
    >
      {children}
    </div>
  )
}
