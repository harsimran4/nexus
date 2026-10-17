// Shared motion vocabulary — the app's one place for spring presets and the
// enter/exit variant pairs overlays use. House style (per the apple-design
// skill): critically damped springs by default (no overshoot, graceful
// settle); bounce is reserved for moments that follow real momentum.
// Reduced motion swaps every variant set for a short opacity cross-fade.

import { useReducedMotion, type Transition, type Variants } from 'motion/react'

export const SPRING = {
  /** Menus, modals, toasts — fast, critically damped. */
  snappy: { type: 'spring', stiffness: 500, damping: 45 },
  /** Drawer, sheets, floating trays. */
  smooth: { type: 'spring', stiffness: 320, damping: 36 },
  /** Only for moments following a real flick/drop — cut before adding twice. */
  bouncy: { type: 'spring', stiffness: 460, damping: 34 },
} satisfies Record<string, Transition>

export type SpringPreset = keyof typeof SPRING

/** Cross-fade length under prefers-reduced-motion. */
const REDUCE_S = 0.16

/** Transition for a given preset, swapped for the reduced-motion cross-fade
 *  when the OS asks. Motion animates from live values either way, so
 *  interrupts stay smooth in both modes. */
export function useOverlayTransition(preset: SpringPreset = 'snappy'): Transition {
  const reduce = useReducedMotion()
  return reduce ? { duration: REDUCE_S, ease: 'easeOut' } : SPRING[preset]
}

/** Variant set for a surface that materializes in — scale + rise + fade,
 *  "a real material arriving, not an opacity fade" — and leaves along the
 *  same path (symmetric, per spatial consistency). Pair with
 *  `initial="hidden" animate="shown" exit="exit"` and `useOverlayTransition`. */
export function useMaterialVariants(preset: SpringPreset = 'snappy'): {
  variants: Variants
  transition: Transition
} {
  const reduce = useReducedMotion()
  const transition = useOverlayTransition(preset)
  const variants: Variants = reduce
    ? { hidden: { opacity: 0 }, shown: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        hidden: { opacity: 0, scale: 0.96, y: 8 },
        shown: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.97, y: 4 },
      }
  return { variants, transition }
}
