// Reference-counted body scroll lock. Stacked surfaces (a confirm on a modal
// on the lightbox) each lock on mount and unlock on unmount — and exits now
// defer unmounts, so naive save/restore pairs can restore out of order and
// leave the body permanently locked. The lock releases with the LAST
// unmounting surface, not the first.

let count = 0
let prevOverflow = ''
let prevPad = ''

export function lockBodyScroll(): void {
  if (count++ === 0) {
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    prevOverflow = document.body.style.overflow
    prevPad = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`
  }
}

export function unlockBodyScroll(): void {
  if (count === 0) return
  if (--count === 0) {
    document.body.style.overflow = prevOverflow
    document.body.style.paddingRight = prevPad
  }
}
