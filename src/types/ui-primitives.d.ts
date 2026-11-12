// Declaration of the @deepseek-ai/dsh-client-ui-primitives surface this plugin
// uses, copied from the published 0.2.2-rc.1 typings. The module is in the
// browser platform module table: the running page supplies the shared copy
// (and its stylesheet), so the plugin bundle never includes it.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, Component, InputHTMLAttributes, ReactElement, ReactNode, ReactPortal, RefAttributes, ForwardRefExoticComponent, AriaRole, JSX } from 'react'

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
  export function StateDot(props: { state: StateDotState; size?: number | undefined; className?: string | undefined; appearance?: 'dot' | 'step' }): JSX.Element

  export function HoverCard(props: {
    anchor: ReactNode
    content: ReactNode
    openDelayMs?: number
    disabled?: boolean
    grouped?: boolean
    copyText?: string | undefined
    copyLabel: string
    copiedLabel: string
  }): JSX.Element
  export function HoverCardGroup(props: { children: ReactNode; className?: string | undefined; as?: 'div' | 'span' }): JSX.Element

  export interface AnimatedRowsProps {
    children: ReactNode
    className: string
    role?: AriaRole
    label?: string
    rowKeys: readonly string[]
    ready: boolean
    resetKey: string
  }
  export class AnimatedRows extends Component<AnimatedRowsProps> {}

  export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'
  export function Tooltip(props: {
    label: string | (() => string)
    shortcutKeys?: readonly string[] | undefined
    side?: TooltipSide
    align?: 'center' | 'end'
    delayMs?: number
    disabled?: boolean
    portal?: boolean
    children: ReactElement
  }): JSX.Element

  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuEntry[]
  }
  export interface MenuSeparator { type: 'separator'; id: string }
  export interface MenuLabel { type: 'label'; id: string; text: string }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel
  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    selectedIds?: readonly string[] | undefined
    onSelect?: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    dense?: boolean
    contextual?: boolean
    getAnchorRect?: () => DOMRect | null
    listClassName?: string | undefined
  }): JSX.Element

  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    closeLabel: string
  }): ReactPortal | null

  export function Toast(props: { text: string; icon?: ReactNode; tone?: 'success'; holdMs?: number; onDone: () => void }): ReactPortal

  export function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string | undefined; className?: string | undefined }): JSX.Element

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export const Button: ForwardRefExoticComponent<{
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>>

  export const Input: ForwardRefExoticComponent<{ icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement> & RefAttributes<HTMLInputElement>>

  export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  export function relativeTime(at: number, now: number): { unit: RelativeTimeUnit; n: number }

  export interface IconProps { size?: number | undefined; className?: string | undefined }
  type Icon = (props: IconProps) => JSX.Element
  export const IconAlarmClockOutlineRegular: Icon
  export const IconArchiveCheckOutlineRegular: Icon
  export const IconArchiveOffOutlineRegular: Icon
  export const IconArchiveOutlineRegular: Icon
  export const IconCheckCircleOutlineRegular: Icon
  export const IconChecklistOutlineRegular: Icon
  export const IconCloseFillRegular: Icon
  export const IconEditOutlineRegular: Icon
  export const IconEllipsisOutlineRegular: Icon
  export const IconFlatListOutlineRegular: Icon
  export const IconFolderCloseRegular: Icon
  export const IconFolderOpenRegular: Icon
  export const IconNewChatOutlineRegular: Icon
  export const IconPinFillRegular: Icon
  export const IconPinOutlineRegular: Icon
  export const IconPlayOutlineRegular: Icon
  export const IconProjectAddOutlineRegular: Icon
  export const IconQueueOutlineRegular: Icon
  export const IconSearchOutlineRegular: Icon
  export const IconSettingsOutlineRegular: Icon
  export const IconSlidersTwoOutlineRegular: Icon
  export const IconTrashOutlineRegular: Icon
  export const IconTriangleRightFillRegular: Icon
  export const IconUnarchiveOutlineRegular: Icon
}
