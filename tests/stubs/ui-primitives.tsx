// Test stand-in for @deepseek-ai/dsh-client-ui-primitives (the running page
// supplies the real module): inert components and the relative-time helper.
import { Component, type InputHTMLAttributes, type ReactNode } from 'react'

const Inert = (): null => null
const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
const Anchor = ({ anchor }: { anchor?: ReactNode }) => <>{anchor}</>

export const StateDot = Inert
export const Toast = Inert
// Minimal interactive stand-ins so component tests can press, type and toggle.
export const Switch = ({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label?: string }) =>
  <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => { onChange(event.target.checked) }} />
export const Button = ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) =>
  <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
export const Input = ({ size: _size, ...props }: InputHTMLAttributes<HTMLInputElement> & { size?: unknown }) => <input {...props} />
export const Modal = Passthrough
export const Tooltip = Passthrough
export const HoverCardGroup = Passthrough
export const HoverCard = Anchor
export const Menu = Anchor
export class AnimatedRows extends Component<{ children?: ReactNode }> {
  override render() { return <>{this.props.children}</> }
}
export function relativeTime(at: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; n: number } {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return { unit: 'now', n: 0 }
  if (minutes < 60) return { unit: 'minutes', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', n: hours }
  return { unit: 'days', n: Math.floor(hours / 24) }
}
export const IconAlarmClockOutlineRegular = Inert
export const IconArchiveCheckOutlineRegular = Inert
export const IconArchiveOffOutlineRegular = Inert
export const IconArchiveOutlineRegular = Inert
export const IconCheckCircleOutlineRegular = Inert
export const IconChecklistOutlineRegular = Inert
export const IconCloseFillRegular = Inert
export const IconEditOutlineRegular = Inert
export const IconEllipsisOutlineRegular = Inert
export const IconFlatListOutlineRegular = Inert
export const IconFolderCloseRegular = Inert
export const IconFolderOpenRegular = Inert
export const IconNewChatOutlineRegular = Inert
export const IconPinFillRegular = Inert
export const IconPinOutlineRegular = Inert
export const IconPlayOutlineRegular = Inert
export const IconProjectAddOutlineRegular = Inert
export const IconQueueOutlineRegular = Inert
export const IconSearchOutlineRegular = Inert
export const IconSettingsOutlineRegular = Inert
export const IconSlidersTwoOutlineRegular = Inert
export const IconTrashOutlineRegular = Inert
export const IconTriangleRightFillRegular = Inert
export const IconUnarchiveOutlineRegular = Inert
